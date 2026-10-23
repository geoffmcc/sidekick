"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { childProcessEnv } = require("../../security/child-process");
const { resolveCommandOnPath } = require("../../security/command-lookup");
const { z } = require("zod");
const { redactSensitive } = require("../../redact");
const { enforcePathPolicy } = require("../path-policy");
const { requireToolExecution } = require("../read-authorization");
const { BoundedRegex } = require("../../core/bounded-regex");
const { readTextBounded, DEFAULT_FILE_READ_BYTES } = require("../../core/bounded-file-read");
const { writeTextFile } = require("../../core/json-file-store");

const MAX_FILE_CONTENT_BYTES = 50 * 1024 * 1024;
const MAX_READ_OUTPUT_BYTES = 1024 * 1024;
const MAX_DIRECTORY_LIST_ENTRIES = 500;
const MAX_SEARCH_SCAN_ENTRIES = 10000;
const MAX_FIND_RESULTS = 500;
const MAX_FIND_SCAN_ENTRIES = 10000;
const MAX_FILTER_RESULTS = 500;
const MAX_FILTER_SCAN_ENTRIES = 10000;
const MAX_SUMMARY_LINES = 500;

function boundedResultLimit(value, max = MAX_FIND_RESULTS) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : 50;
}

function* iterateTextLines(content) {
  let offset = 0;
  let line = 1;
  while (offset <= content.length) {
    const newline = content.indexOf("\n", offset);
    const end = newline < 0 ? content.length : newline;
    yield { number: line, text: content.slice(offset, end) };
    if (newline < 0) return;
    offset = newline + 1;
    line++;
  }
}

function displayLine(line) { return String(line || "").slice(0, 200); }

function globToRegexSource(glob) {
  return Array.from(String(glob), character => {
    if (character === "*") return ".*";
    if (character === "?") return ".";
    return /[\\^$.*+?()[\]{}|]/.test(character) ? "\\" + character : character;
  }).join("");
}

async function sidekick_read({ path: filePath, offset = 0 }) {
  const authError = requireToolExecution({ tool: "filesystem.read" }, "tools.execute", "read");
  if (authError) return authError;
  const policyError = enforcePathPolicy(filePath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(filePath)) {
    return { content: [{ type: "text", text: "File not found: " + filePath }], isError: true };
  }
  try {
    const read = readTextBounded(filePath, { maxBytes: MAX_READ_OUTPUT_BYTES, offset });
    const truncationNotice = read.truncated
      ? `\n\n[truncated: returned ${read.bytesRead} bytes at offset ${offset} of ${read.size}; continue with offset ${offset + read.bytesRead}]`
      : "";
    return { content: [{ type: "text", text: redactSensitive(read.content + truncationNotice) }] };
  } catch (error) {
    const message = error.code === "FILE_READ_NOT_REGULAR"
      ? "Path does not refer to a regular file"
      : `Unable to read file: ${error.message}`;
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

async function sidekick_list({ path: dirPath }) {
  const authError = requireToolExecution({ tool: "filesystem.read" }, "tools.execute", "list");
  if (authError) return authError;
  const policyError = enforcePathPolicy(dirPath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(dirPath)) {
    return { content: [{ type: "text", text: "Path not found: " + dirPath }], isError: true };
  }
  const items = [];
  let truncated = false;
  try {
    const directory = await fs.promises.opendir(dirPath);
    for await (const item of directory) {
      if (items.length >= MAX_DIRECTORY_LIST_ENTRIES) {
        truncated = true;
        break;
      }
      items.push(item);
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Unable to list directory: ${error.message}` }], isError: true };
  }
  const lines = items.map(i => {
    const type = i.isDirectory() ? "DIR" : i.isFile() ? "FILE" : "OTHER";
    let stat = null;
    try { stat = fs.lstatSync(path.join(dirPath, i.name)); } catch (e) {}
    const size = stat ? stat.size : 0;
    const date = stat ? stat.mtime.toISOString().slice(0, 19).replace("T", " ") : "";
    return type.padEnd(5) + " " + String(size).padStart(10) + " " + date + " " + i.name;
  });
  const notice = truncated ? `\n[truncated: showing the first ${MAX_DIRECTORY_LIST_ENTRIES} entries]` : "";
  return { content: [{ type: "text", text: redactSensitive((lines.join("\n") || "(empty directory)") + notice) }] };
}

async function nodeSearch(pattern, targetPath, include) {
  let matcher;
  try {
    matcher = new BoundedRegex(pattern);
  } catch (error) {
    return { content: [{ type: "text", text: "Search error: " + error.message }], isError: true };
  }

  const includeMatcher = include
    ? new BoundedRegex("^" + globToRegexSource(include) + "$")
    : null;
  const results = [];
  const maxResults = 100;
  let truncatedFiles = 0;
  let scannedEntries = 0;
  let scanLimited = false;
  let resultLimited = false;

  async function visit(current, depth) {
    if (results.length >= maxResults || depth > 20) return;
    if (scannedEntries >= MAX_SEARCH_SCAN_ENTRIES) { scanLimited = true; return; }
    let stat;
    try { stat = fs.lstatSync(current); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      if (includeMatcher && !includeMatcher.test(path.basename(current))) return;
      let content;
      try {
        const read = readTextBounded(current, { maxBytes: MAX_READ_OUTPUT_BYTES, noFollow: true });
        content = read.content;
        if (read.truncated) truncatedFiles++;
      } catch { return; }
      for (const line of iterateTextLines(content)) {
        const text = line.text.endsWith("\r") ? line.text.slice(0, -1) : line.text;
        if (matcher.test(text)) {
          results.push(`${current}:${line.number}:${text.slice(0, 200)}`);
          if (results.length >= maxResults) { resultLimited = true; return; }
        }
      }
      return;
    }
    if (!stat.isDirectory()) return;
    let directory;
    try { directory = await fs.promises.opendir(current); } catch { return; }
    for await (const entry of directory) {
      if (results.length >= maxResults) return;
      if (scannedEntries >= MAX_SEARCH_SCAN_ENTRIES) { scanLimited = true; return; }
      scannedEntries++;
      await visit(path.join(current, entry.name), depth + 1);
    }
  }

  try { await visit(targetPath, 0); }
  catch (error) { return { content: [{ type: "text", text: "Search error: " + error.message }], isError: true }; }
  const text = results.join("\n") || "(no matches)";
  const notices = [];
  if (resultLimited) notices.push(`[partial search: result limit of ${maxResults} reached]`);
  if (truncatedFiles) notices.push(`[partial search: scanned the first ${MAX_READ_OUTPUT_BYTES} bytes of ${truncatedFiles} oversized file(s)]`);
  if (scanLimited) notices.push(`[partial search: stopped after ${MAX_SEARCH_SCAN_ENTRIES} entries]`);
  return { content: [{ type: "text", text: redactSensitive([text, ...notices].join("\n")) }] };
}

function buildSearchArgs(searchCommand, pattern, targetPath, include) {
  if (path.basename(searchCommand).toLowerCase().startsWith("rg")) {
    const args = ["--json", "--max-count", "100"];
    if (include) args.push("-g", include);
    // Without `--`, an attacker-controlled pattern such as `--pre=...` is
    // parsed as a ripgrep option and can execute a preprocessor command.
    args.push("--", pattern, targetPath);
    return args;
  }

  const args = ["-rn", "--max-count=100"];
  if (include) args.push("--include=" + include);
  args.push("--", pattern, targetPath);
  return args;
}

async function sidekick_search({ pattern, path: searchPath, include }) {
  const authError = requireToolExecution({ tool: "filesystem.read" }, "tools.execute", "search");
  if (authError) return authError;
  const targetPath = searchPath || ".";
  const policyError = enforcePathPolicy(targetPath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(targetPath)) {
    return { content: [{ type: "text", text: "Path not found: " + targetPath }], isError: true };
  }

  const searchCommand = resolveCommandOnPath("rg") || resolveCommandOnPath("grep");
  if (!searchCommand) return nodeSearch(pattern, targetPath, include);

  try {
    let stdout;
    if (path.basename(searchCommand).toLowerCase().startsWith("rg")) {
      const args = buildSearchArgs(searchCommand, pattern, targetPath, include);
      stdout = execFileSync(searchCommand, args, { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, env: childProcessEnv() });
    } else {
      const args = buildSearchArgs(searchCommand, pattern, targetPath, include);
      stdout = execFileSync(searchCommand, args, { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, env: childProcessEnv() });
    }
    return { content: [{ type: "text", text: redactSensitive(stdout || "(no matches)") }] };
  } catch (e) {
    if (e.status === 1) return { content: [{ type: "text", text: "No matches found" }] };
    return { content: [{ type: "text", text: "Search error: " + (e.stderr || e.message) }], isError: true };
  }
}

async function sidekick_summarize({ path: filePath, max_lines, strategy, pattern }) {
  const authError = requireToolExecution({ tool: "filesystem.read" }, "tools.execute", "summarize");
  if (authError) return authError;
  const maxLines = boundedResultLimit(max_lines, MAX_SUMMARY_LINES);
  const strat = strategy || "head";
  if (!["head", "tail", "grep", "stats"].includes(strat)) {
    return { content: [{ type: "text", text: "Invalid strategy. Use: head, tail, grep, stats" }], isError: true };
  }
  if (strat === "grep" && !pattern) return { content: [{ type: "text", text: "pattern required for grep strategy" }], isError: true };
  let re = null;
  try { if (strat === "grep") re = new BoundedRegex(pattern, "i"); }
  catch (error) { return { content: [{ type: "text", text: `Invalid pattern: ${error.message}` }], isError: true }; }
  const policyError = enforcePathPolicy(filePath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(filePath)) {
    return { content: [{ type: "text", text: "File not found: " + filePath }], isError: true };
  }
  let read;
  try { read = readTextBounded(filePath, { maxBytes: MAX_FILE_CONTENT_BYTES, requireComplete: true }); }
  catch (error) {
      return { content: [{ type: "text", text: error.code === "FILE_READ_TOO_LARGE" ? `File too large to summarize (>50MB): ${filePath}` : `Unable to read file: ${error.message}` }], isError: true };
  }
  const stat = { size: read.size };
  const content = read.content;
  const selected = [];
  const includedLines = new Set();
  let totalLines = 0;
  let nonEmptyLines = 0;
  let firstLine = null;
  let lastLine = null;
  let previousLine = null;
  let includeFollowingLine = false;
  let matches = 0;
  const addGrepLine = line => {
    if (!line || includedLines.has(line.number)) return;
    includedLines.add(line.number);
    selected.push(displayLine(line.text));
  };
  for (const line of iterateTextLines(content)) {
    totalLines++;
    if (line.text.trim()) nonEmptyLines++;
    if (firstLine === null) firstLine = line.text;
    lastLine = line.text;
    if (strat === "head" && selected.length < maxLines) selected.push(displayLine(line.text));
    else if (strat === "tail") {
      selected.push(displayLine(line.text));
      if (selected.length > maxLines) selected.shift();
    } else if (strat === "grep") {
      if (includeFollowingLine) addGrepLine(line);
      if (matches < maxLines && re.test(line.text)) {
        matches++;
        addGrepLine(previousLine);
        addGrepLine(line);
        includeFollowingLine = true;
      } else includeFollowingLine = false;
    }
    previousLine = line;
  }

  let summary;
  if (strat === "stats") {
    summary = [
      "File: " + filePath,
      "Size: " + stat.size + " bytes",
      "Total lines: " + totalLines,
      "Non-empty lines: " + nonEmptyLines,
      "First line: " + (displayLine(firstLine) || "(empty)"),
      "Last line: " + (displayLine(lastLine) || "(empty)")
    ].join("\n");
  } else summary = selected.join("\n");
  const header = "[Summary: " + totalLines + " lines, strategy=" + strat + (strat === "grep" ? ", pattern=" + pattern : "") + "]\n";
  return { content: [{ type: "text", text: redactSensitive(header + summary) }] };
}

async function sidekick_filter({ path: targetPath, pattern, after, before, max_results }) {
  const authError = requireToolExecution({ tool: "filesystem.read" }, "tools.execute", "filter");
  if (authError) return authError;
  const maxResults = boundedResultLimit(max_results, MAX_FILTER_RESULTS);
  const policyError = enforcePathPolicy(targetPath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(targetPath)) {
    return { content: [{ type: "text", text: "Path not found: " + targetPath }], isError: true };
  }
  const stat = fs.statSync(targetPath);
  const results = [];
  if (stat.isFile()) {
    let content;
    try { content = readTextBounded(targetPath, { maxBytes: MAX_FILE_CONTENT_BYTES, requireComplete: true }).content; }
    catch (error) {
      return { content: [{ type: "text", text: error.code === "FILE_READ_TOO_LARGE" ? `File exceeds the ${MAX_FILE_CONTENT_BYTES}-byte filter limit` : `Unable to read file: ${error.message}` }], isError: true };
    }
    const re = pattern ? new BoundedRegex(pattern, "i") : null;
    let offset = 0;
    let lineNumber = 1;
    let resultLimited = false;
    while (offset <= content.length && results.length < maxResults) {
      const newline = content.indexOf("\n", offset);
      const end = newline < 0 ? content.length : newline;
      const line = content.slice(offset, end);
      if (!re || re.test(line)) results.push({ line: lineNumber, text: line.substring(0, 200) });
      if (newline < 0) break;
      offset = newline + 1;
      lineNumber++;
    }
    resultLimited = results.length >= maxResults && offset < content.length;
    const response = [{ type: "text", text: redactSensitive(JSON.stringify(results, null, 2)) }];
    if (resultLimited) response.push({ type: "text", text: `[partial filter: result limit of ${maxResults} reached]` });
    return { content: response };
  } else if (stat.isDirectory()) {
    const afterDate = after ? new Date(after).getTime() : 0;
    const beforeDate = before ? new Date(before).getTime() : Infinity;
    const re = pattern ? new BoundedRegex(pattern, "i") : null;
    let scannedEntries = 0;
    let resultLimited = false;
    let scanLimited = false;
    async function walkDir(dir, depth) {
      if (depth > 5) return;
      if (results.length >= maxResults) { resultLimited = true; return; }
      if (scannedEntries >= MAX_FILTER_SCAN_ENTRIES) { scanLimited = true; return; }
      let directory;
      try { directory = await fs.promises.opendir(dir); } catch { return; }
      for await (const entry of directory) {
        if (results.length >= maxResults) { resultLimited = true; break; }
        if (scannedEntries >= MAX_FILTER_SCAN_ENTRIES) { scanLimited = true; break; }
        scannedEntries++;
        const fullPath = path.join(dir, entry.name);
        try {
          const s = fs.lstatSync(fullPath);
          if (s.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (!entry.name.startsWith(".") && entry.name !== "node_modules") await walkDir(fullPath, depth + 1);
          } else if (entry.isFile() && s.mtimeMs >= afterDate && s.mtimeMs <= beforeDate && (!re || re.test(entry.name))) {
            results.push({ path: fullPath, size: s.size, modified: s.mtime.toISOString().slice(0, 19) });
          }
        } catch (e) {}
      }
    }
    await walkDir(targetPath, 0);
    const response = [{ type: "text", text: redactSensitive(JSON.stringify(results, null, 2)) }];
    if (resultLimited) response.push({ type: "text", text: `[partial filter: result limit of ${maxResults} reached]` });
    if (scanLimited) response.push({ type: "text", text: `[partial filter: stopped after ${MAX_FILTER_SCAN_ENTRIES} entries]` });
    return { content: response };
  }
  return { content: [{ type: "text", text: redactSensitive(JSON.stringify(results, null, 2)) }] };
}

async function sidekick_diff_files({ path_a, path_b, format }) {
  const authError = requireToolExecution({ tool: "filesystem.read" }, "tools.execute", "diff_files");
  if (authError) return authError;
  const policyErrorA = enforcePathPolicy(path_a, "read");
  if (policyErrorA) return policyErrorA;
  const policyErrorB = enforcePathPolicy(path_b, "read");
  if (policyErrorB) return policyErrorB;
  if (!fs.existsSync(path_a)) return { content: [{ type: "text", text: "File not found: " + path_a }], isError: true };
  if (!fs.existsSync(path_b)) return { content: [{ type: "text", text: "File not found: " + path_b }], isError: true };
  let contentA;
  let contentB;
  try {
    contentA = readTextBounded(path_a, { maxBytes: MAX_FILE_CONTENT_BYTES, requireComplete: true }).content;
    contentB = readTextBounded(path_b, { maxBytes: MAX_FILE_CONTENT_BYTES, requireComplete: true }).content;
  } catch (error) {
    return { content: [{ type: "text", text: error.code === "FILE_READ_TOO_LARGE" ? `Files exceed the ${MAX_FILE_CONTENT_BYTES}-byte per-file diff limit` : `Unable to read files: ${error.message}` }], isError: true };
  }
  if (format === "summary") {
    const linesA = contentA.split("\n");
    const linesB = contentB.split("\n");
    let added = 0, removed = 0, changed = 0;
    const maxLen = Math.max(linesA.length, linesB.length);
    for (let i = 0; i < maxLen; i++) {
      const a = linesA[i] || "";
      const b = linesB[i] || "";
      if (a === b) continue;
      if (i >= linesA.length) added++;
      else if (i >= linesB.length) removed++;
      else changed++;
    }
    return { content: [{ type: "text", text: JSON.stringify({ file_a: path_a, file_b: path_b, lines_a: linesA.length, lines_b: linesB.length, added, removed, changed }) }] };
  }
  const linesA = contentA.split("\n");
  const linesB = contentB.split("\n");
  const diffLines = [];
  let diffCount = 0;
  const maxLen = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < maxLen && diffCount < 100; i++) {
    const a = linesA[i];
    const b = linesB[i];
    if (a !== b) {
      diffCount++;
      if (a !== undefined) diffLines.push("- " + (i + 1) + ": " + a.substring(0, 200));
      if (b !== undefined) diffLines.push("+ " + (i + 1) + ": " + b.substring(0, 200));
    }
  }
  const header = "--- " + path_a + "\n+++ " + path_b + "\n";
  return { content: [{ type: "text", text: redactSensitive(header + diffLines.join("\n")) }] };
}

async function sidekick_write({ path: filePath, content }) {
  const authError = requireToolExecution({ tool: "filesystem.write" }, "tools.execute_critical", "write");
  if (authError) return authError;
  const policyError = enforcePathPolicy(filePath, "write");
  if (policyError) return policyError;
  if (typeof content !== "string") {
    return { content: [{ type: "text", text: "File content must be text" }], isError: true, code: "invalid_argument" };
  }
  const byteSize = Buffer.byteLength(content, "utf8");
  if (byteSize > MAX_FILE_CONTENT_BYTES) {
    return { content: [{ type: "text", text: `File content exceeds the ${MAX_FILE_CONTENT_BYTES}-byte write limit` }], isError: true, code: "size_limit_exceeded" };
  }

  let mode = 0o666;
  try {
    const existing = fs.lstatSync(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      return { content: [{ type: "text", text: "Write target must be a regular, non-symlink file" }], isError: true, code: "invalid_path" };
    }
    mode = existing.mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") {
      return { content: [{ type: "text", text: `Unable to inspect write target: ${error.message}` }], isError: true, code: "write_failed" };
    }
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const recheckedPolicyError = enforcePathPolicy(filePath, "write");
    if (recheckedPolicyError) return recheckedPolicyError;
    // Atomic replacement prevents readers from observing a truncated or
    // partially-written file. The helper creates a unique exclusive temp file,
    // enforces the byte cap again, and publishes with rename.
    writeTextFile(filePath, content, { maxBytes: MAX_FILE_CONTENT_BYTES, mode });
    return { content: [{ type: "text", text: `Written ${byteSize} bytes to ${filePath}` }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Unable to write file: ${error.message}` }], isError: true, code: "write_failed" };
  }
}

async function sidekick_find({ path: searchPath, name, modified_after, modified_before, size_min, size_max, content, max_results }) {
  const authError = requireToolExecution({ tool: "filesystem.read" }, "tools.execute", "find");
  if (authError) return authError;
  const maxResults = boundedResultLimit(max_results, MAX_FIND_RESULTS);
  const policyError = enforcePathPolicy(searchPath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(searchPath)) return { content: [{ type: "text", text: "Path not found: " + searchPath }], isError: true };
  const afterMs = modified_after ? new Date(modified_after).getTime() : 0;
  const beforeMs = modified_before ? new Date(modified_before).getTime() : Infinity;
  const sizeMin = size_min ? parseSize(size_min) : 0;
  const sizeMax = size_max ? parseSize(size_max) : Infinity;
  const namePattern = name ? "^" + globToRegexSource(name) + "$" : null;
  const nameRe = namePattern ? new BoundedRegex(namePattern, "i") : null;
  const contentRe = content ? new BoundedRegex(content, "i") : null;
  const results = [];
  let scannedEntries = 0;
  let resultLimited = false;
  let scanLimited = false;
  async function walk(dir, depth) {
    if (depth > 8) return;
    if (results.length >= maxResults) { resultLimited = true; return; }
    if (scannedEntries >= MAX_FIND_SCAN_ENTRIES) { scanLimited = true; return; }
    let directory;
    try { directory = await fs.promises.opendir(dir); } catch { return; }
    for await (const entry of directory) {
      if (results.length >= maxResults) { resultLimited = true; break; }
      if (scannedEntries >= MAX_FIND_SCAN_ENTRIES) { scanLimited = true; break; }
      scannedEntries++;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const s = fs.lstatSync(fullPath);
        if (s.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(fullPath, depth + 1);
        else if (entry.isFile()) {
          if (nameRe && !nameRe.test(entry.name)) continue;
          if (s.mtimeMs < afterMs || s.mtimeMs > beforeMs) continue;
          if (s.size < sizeMin || s.size > sizeMax) continue;
          if (contentRe) {
            try {
              const fileContent = readTextBounded(fullPath, { maxBytes: DEFAULT_FILE_READ_BYTES }).content;
              if (!contentRe.test(fileContent)) continue;
            } catch (e) { continue; }
          }
          results.push({ path: fullPath, size: s.size, modified: s.mtime.toISOString().slice(0, 19) });
        }
      } catch (e) {}
    }
  }
  await walk(searchPath, 0);
  const response = [{ type: "text", text: JSON.stringify(results, null, 2) }];
  if (resultLimited) response.push({ type: "text", text: `[partial search: result limit of ${maxResults} reached]` });
  if (scanLimited) response.push({ type: "text", text: `[partial search: stopped after ${MAX_FIND_SCAN_ENTRIES} entries]` });
  return { content: response };
}

function parseSize(str) {
  if (typeof str === "number") return str;
  const match = String(str).match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = (match[2] || "B").toUpperCase();
  const multipliers = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 };
  return Math.floor(val * (multipliers[unit] || 1));
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "read",
    description: "Read up to 1 MiB from a file on the remote filesystem; use offset to continue a larger file",
    schema: z.object({
      path: z.string().describe("Absolute path to the file to read"),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().default(0).describe("Byte offset for reading the next bounded file segment"),
    }),
    args: { path: "string", offset: "number (optional, byte offset; default 0)" },
    risk: "medium",
    category: "Core",
    source: "builtin",
    family: "filesystem",
    handler: sidekick_read,
  }),
  Object.freeze({
    name: "list",
    description: "List files and directories on the remote machine",
    schema: z.object({ path: z.string().optional().default("/home/sidekick").describe("Directory path to list") }),
    args: { path: "string" },
    risk: "medium",
    category: "Core",
    source: "builtin",
    family: "filesystem",
    handler: sidekick_list,
  }),
  Object.freeze({
    name: "search",
    description: "Search file contents using ripgrep or grep",
    schema: z.object({
      pattern: z.string().max(512).describe("Regex pattern to search for (maximum 512 characters)"),
      path: z.string().optional().describe("Directory to search in (defaults to current directory)"),
      include: z.string().max(512).optional().describe("File pattern to include (e.g. '*.js', '*.ts')"),
    }),
    args: { pattern: "string", path: "string (optional)", include: "string (optional)" },
    risk: "medium",
    category: "Core",
    source: "builtin",
    family: "filesystem",
    handler: sidekick_search,
  }),
  Object.freeze({
    name: "summarize",
    description: "Summarize large files before returning to reduce token usage. Strategies: head, tail, grep, stats.",
    schema: z.object({
      path: z.string().describe("File path to summarize"),
      max_lines: z.number().int().min(1).max(MAX_SUMMARY_LINES).optional().describe(`Maximum lines or matches to return (default: 50, maximum: ${MAX_SUMMARY_LINES})`),
      strategy: z.enum(["head", "tail", "grep", "stats"]).optional().describe("Summarization strategy (default: head)"),
      pattern: z.string().max(512).optional().describe("Regex pattern for grep strategy (maximum 512 characters)"),
    }),
    args: { path: "string (file path)", max_lines: "number (optional, default 50)", strategy: "string (optional, head|tail|grep|stats - default head)", pattern: "string (optional, regex for grep strategy)" },
    risk: "medium",
    category: "Efficiency",
    source: "builtin",
    family: "filesystem",
    handler: sidekick_summarize,
  }),
  Object.freeze({
    name: "filter",
    description: "Filter file contents or directory listings by pattern, date, or size before returning.",
    schema: z.object({
      path: z.string().describe("File or directory path to filter"),
      pattern: z.string().max(512).optional().describe("Regex pattern to match (maximum 512 characters)"),
      after: z.string().optional().describe("ISO date: include files modified after this date"),
      before: z.string().optional().describe("ISO date: include files modified before this date"),
      max_results: z.number().int().min(1).max(MAX_FILTER_RESULTS).optional().describe(`Maximum results to return (default: 50, maximum: ${MAX_FILTER_RESULTS})`),
    }),
    args: { path: "string (file or directory path)", pattern: "string (optional, regex pattern)", after: "string (optional, ISO date for files modified after)", before: "string (optional, ISO date for files modified before)", max_results: "number (optional, default 50)" },
    risk: "medium",
    category: "Efficiency",
    source: "builtin",
    family: "filesystem",
    handler: sidekick_filter,
  }),
  Object.freeze({
    name: "diff_files",
    description: "Compare two files directly without reading both into context. Returns unified diff or summary.",
    schema: z.object({
      path_a: z.string().describe("First file path"),
      path_b: z.string().describe("Second file path"),
      format: z.enum(["unified", "summary"]).optional().describe("Output format (default: unified)"),
    }),
    args: { path_a: "string (first file path)", path_b: "string (second file path)", format: "string (optional, unified|summary - default unified)" },
    risk: "medium",
    category: "Data Pipeline",
    source: "builtin",
    family: "filesystem",
    handler: sidekick_diff_files,
  }),
  Object.freeze({
    name: "write",
    description: "Write content to a file on the remote machine",
    schema: z.object({ path: z.string().describe("Absolute path to write to"), content: z.string().max(MAX_FILE_CONTENT_BYTES).describe(`File content (maximum ${MAX_FILE_CONTENT_BYTES} characters; 50 MiB UTF-8 write limit)`) }),
    args: { path: "string", content: "string" },
    risk: "critical",
    category: "Core",
    source: "builtin",
    family: "filesystem",
    handler: sidekick_write,
  }),
  Object.freeze({
    name: "find",
    description: "Advanced file finder: search by name pattern, date range, size range, and content pattern.",
    schema: z.object({
      path: z.string().describe("Directory to search in"),
      name: z.string().max(512).optional().describe("File name glob pattern (e.g. '*.js')"),
      modified_after: z.string().optional().describe("ISO date: files modified after"),
      modified_before: z.string().optional().describe("ISO date: files modified before"),
      size_min: z.string().optional().describe("Minimum file size (e.g. '1KB', '1MB')"),
      size_max: z.string().optional().describe("Maximum file size (e.g. '10MB')"),
      content: z.string().max(512).optional().describe("Regex pattern to match file contents (maximum 512 characters)"),
      max_results: z.number().int().min(1).max(MAX_FIND_RESULTS).optional().describe(`Maximum results (default: 50, maximum: ${MAX_FIND_RESULTS})`),
    }),
    args: { path: "string (directory to search)", name: "string (optional, glob pattern e.g. '*.js')", modified_after: "string (optional, ISO date)", modified_before: "string (optional, ISO date)", size_min: "string (optional, e.g. '1KB', '1MB')", size_max: "string (optional, e.g. '10MB')", content: "string (optional, regex pattern to match file contents)", max_results: "number (optional, default 50)" },
    risk: "medium",
    category: "Efficiency",
    source: "builtin",
    family: "filesystem",
    handler: sidekick_find,
  }),
]);

module.exports = { descriptors, sidekick_read, sidekick_list, sidekick_search, sidekick_summarize, sidekick_filter, sidekick_write, sidekick_diff_files, sidekick_find, buildSearchArgs, boundedResultLimit, MAX_DIRECTORY_LIST_ENTRIES, MAX_SEARCH_SCAN_ENTRIES, MAX_FIND_RESULTS, MAX_FIND_SCAN_ENTRIES, MAX_FILTER_RESULTS, MAX_FILTER_SCAN_ENTRIES, MAX_SUMMARY_LINES };
