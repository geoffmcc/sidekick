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

const MAX_FILE_CONTENT_BYTES = 50 * 1024 * 1024;
const MAX_READ_OUTPUT_BYTES = 1024 * 1024;

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
  const items = fs.readdirSync(dirPath, { withFileTypes: true });
  const lines = items.map(i => {
    const type = i.isDirectory() ? "DIR" : i.isFile() ? "FILE" : "OTHER";
    let stat = null;
    try { stat = fs.statSync(path.join(dirPath, i.name)); } catch (e) {}
    const size = stat ? stat.size : 0;
    const date = stat ? stat.mtime.toISOString().slice(0, 19).replace("T", " ") : "";
    return type.padEnd(5) + " " + String(size).padStart(10) + " " + date + " " + i.name;
  });
  return { content: [{ type: "text", text: redactSensitive(lines.join("\n") || "(empty directory)") }] };
}

function nodeSearch(pattern, targetPath, include) {
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

  function visit(current, depth) {
    if (results.length >= maxResults || depth > 20) return;
    let stat;
    try { stat = fs.lstatSync(current); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      if (includeMatcher && !includeMatcher.test(path.basename(current))) return;
      let content;
      try {
        const read = readTextBounded(current, { maxBytes: MAX_READ_OUTPUT_BYTES });
        content = read.content;
        if (read.truncated) truncatedFiles++;
      } catch { return; }
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (matcher.test(line)) {
          results.push(`${current}:${index + 1}:${line}`);
          if (results.length >= maxResults) return;
        }
      }
      return;
    }
    if (!stat.isDirectory()) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      visit(path.join(current, entry.name), depth + 1);
    }
  }

  visit(targetPath, 0);
  const text = results.join("\n") || "(no matches)";
  const notice = truncatedFiles ? `\n[partial search: scanned the first ${MAX_READ_OUTPUT_BYTES} bytes of ${truncatedFiles} oversized file(s)]` : "";
  return { content: [{ type: "text", text: redactSensitive(text + notice) }] };
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
  const maxLines = max_lines || 50;
  const strat = strategy || "head";
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
  const lines = content.split("\n");
  let summary;
  if (strat === "head") {
    summary = lines.slice(0, maxLines).join("\n");
  } else if (strat === "tail") {
    summary = lines.slice(-maxLines).join("\n");
  } else if (strat === "grep") {
    if (!pattern) return { content: [{ type: "text", text: "pattern required for grep strategy" }], isError: true };
    const re = new BoundedRegex(pattern, "i");
    const matched = [];
    for (let i = 0; i < lines.length && matched.length < maxLines; i++) {
      if (re.test(lines[i])) {
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length, i + 2);
        for (let j = start; j < end; j++) {
          if (!matched.includes(lines[j])) matched.push(lines[j]);
        }
      }
    }
    summary = matched.join("\n");
  } else if (strat === "stats") {
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    summary = [
      "File: " + filePath,
      "Size: " + stat.size + " bytes",
      "Total lines: " + lines.length,
      "Non-empty lines: " + nonEmpty.length,
      "First line: " + (lines[0] || "(empty)"),
      "Last line: " + (lines[lines.length - 1] || "(empty)")
    ].join("\n");
  } else {
    return { content: [{ type: "text", text: "Invalid strategy. Use: head, tail, grep, stats" }], isError: true };
  }
  const header = "[Summary: " + lines.length + " lines, strategy=" + strat + (strat === "grep" ? ", pattern=" + pattern : "") + "]\n";
  return { content: [{ type: "text", text: redactSensitive(header + summary) }] };
}

async function sidekick_filter({ path: targetPath, pattern, after, before, max_results }) {
  const authError = requireToolExecution({ tool: "filesystem.read" }, "tools.execute", "filter");
  if (authError) return authError;
  const maxResults = max_results || 50;
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
    const lines = content.split("\n");
    const re = pattern ? new BoundedRegex(pattern, "i") : null;
    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      if (!re || re.test(lines[i])) results.push({ line: i + 1, text: lines[i].substring(0, 200) });
    }
  } else if (stat.isDirectory()) {
    const afterDate = after ? new Date(after).getTime() : 0;
    const beforeDate = before ? new Date(before).getTime() : Infinity;
    const re = pattern ? new BoundedRegex(pattern, "i") : null;
    function walkDir(dir, depth) {
      if (depth > 5 || results.length >= maxResults) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const fullPath = path.join(dir, entry.name);
        try {
          const s = fs.statSync(fullPath);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith(".") && entry.name !== "node_modules") walkDir(fullPath, depth + 1);
          } else if (entry.isFile() && s.mtimeMs >= afterDate && s.mtimeMs <= beforeDate && (!re || re.test(entry.name))) {
            results.push({ path: fullPath, size: s.size, modified: s.mtime.toISOString().slice(0, 19) });
          }
        } catch (e) {}
      }
    }
    walkDir(targetPath, 0);
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  const stat = fs.statSync(filePath);
  return { content: [{ type: "text", text: "Written " + stat.size + " bytes to " + filePath }] };
}

async function sidekick_find({ path: searchPath, name, modified_after, modified_before, size_min, size_max, content, max_results }) {
  const authError = requireToolExecution({ tool: "filesystem.read" }, "tools.execute", "find");
  if (authError) return authError;
  const maxResults = max_results || 50;
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
  function walk(dir, depth) {
    if (depth > 8 || results.length >= maxResults) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const s = fs.statSync(fullPath);
        if (entry.isDirectory()) walk(fullPath, depth + 1);
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
  walk(searchPath, 0);
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
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
      max_lines: z.number().optional().describe("Maximum lines to return (default: 50)"),
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
      max_results: z.number().optional().describe("Maximum results to return (default: 50)"),
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
    schema: z.object({ path: z.string().describe("Absolute path to write to"), content: z.string().describe("File content to write") }),
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
      max_results: z.number().optional().describe("Maximum results (default: 50)"),
    }),
    args: { path: "string (directory to search)", name: "string (optional, glob pattern e.g. '*.js')", modified_after: "string (optional, ISO date)", modified_before: "string (optional, ISO date)", size_min: "string (optional, e.g. '1KB', '1MB')", size_max: "string (optional, e.g. '10MB')", content: "string (optional, regex pattern to match file contents)", max_results: "number (optional, default 50)" },
    risk: "medium",
    category: "Efficiency",
    source: "builtin",
    family: "filesystem",
    handler: sidekick_find,
  }),
]);

module.exports = { descriptors, sidekick_read, sidekick_list, sidekick_search, sidekick_summarize, sidekick_filter, sidekick_write, sidekick_diff_files, sidekick_find, buildSearchArgs };
