"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { childProcessEnv } = require("../../security/child-process");
const { z } = require("zod");
const { redactSensitive } = require("../../redact");
const { enforcePathPolicy } = require("../path-policy");

async function sidekick_read({ path: filePath }) {
  const policyError = enforcePathPolicy(filePath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(filePath)) {
    return { content: [{ type: "text", text: "File not found: " + filePath }], isError: true };
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return { content: [{ type: "text", text: redactSensitive(content) }] };
}

async function sidekick_list({ path: dirPath }) {
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

async function sidekick_search({ pattern, path: searchPath, include }) {
  const targetPath = searchPath || ".";
  const policyError = enforcePathPolicy(targetPath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(targetPath)) {
    return { content: [{ type: "text", text: "Path not found: " + targetPath }], isError: true };
  }

  let useRg = false;
  try {
    execFileSync("which", ["rg"], { stdio: "ignore", env: childProcessEnv() });
    useRg = true;
  } catch (e) {}

  try {
    let stdout;
    if (useRg) {
      const args = ["--json", "--max-count", "100"];
      if (include) args.push("-g", include);
      args.push(pattern, targetPath);
      stdout = execFileSync("rg", args, { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, env: childProcessEnv() });
    } else {
      const args = ["-rn", "--max-count=100"];
      if (include) args.push("--include=" + include);
      args.push(pattern, targetPath);
      stdout = execFileSync("grep", args, { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, env: childProcessEnv() });
    }
    return { content: [{ type: "text", text: redactSensitive(stdout || "(no matches)") }] };
  } catch (e) {
    if (e.status === 1) return { content: [{ type: "text", text: "No matches found" }] };
    return { content: [{ type: "text", text: "Search error: " + (e.stderr || e.message) }], isError: true };
  }
}

async function sidekick_summarize({ path: filePath, max_lines, strategy, pattern }) {
  const maxLines = max_lines || 50;
  const strat = strategy || "head";
  const policyError = enforcePathPolicy(filePath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(filePath)) {
    return { content: [{ type: "text", text: "File not found: " + filePath }], isError: true };
  }
  const stat = fs.statSync(filePath);
  if (stat.size > 50 * 1024 * 1024) {
    return { content: [{ type: "text", text: "File too large to summarize (>50MB): " + filePath }], isError: true };
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  let summary;
  if (strat === "head") {
    summary = lines.slice(0, maxLines).join("\n");
  } else if (strat === "tail") {
    summary = lines.slice(-maxLines).join("\n");
  } else if (strat === "grep") {
    if (!pattern) return { content: [{ type: "text", text: "pattern required for grep strategy" }], isError: true };
    const re = new RegExp(pattern, "i");
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
  const maxResults = max_results || 50;
  const policyError = enforcePathPolicy(targetPath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(targetPath)) {
    return { content: [{ type: "text", text: "Path not found: " + targetPath }], isError: true };
  }
  const stat = fs.statSync(targetPath);
  const results = [];
  if (stat.isFile()) {
    const content = fs.readFileSync(targetPath, "utf-8");
    const lines = content.split("\n");
    const re = pattern ? new RegExp(pattern, "i") : null;
    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      if (!re || re.test(lines[i])) results.push({ line: i + 1, text: lines[i].substring(0, 200) });
    }
  } else if (stat.isDirectory()) {
    const afterDate = after ? new Date(after).getTime() : 0;
    const beforeDate = before ? new Date(before).getTime() : Infinity;
    const re = pattern ? new RegExp(pattern, "i") : null;
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
  const policyErrorA = enforcePathPolicy(path_a, "read");
  if (policyErrorA) return policyErrorA;
  const policyErrorB = enforcePathPolicy(path_b, "read");
  if (policyErrorB) return policyErrorB;
  if (!fs.existsSync(path_a)) return { content: [{ type: "text", text: "File not found: " + path_a }], isError: true };
  if (!fs.existsSync(path_b)) return { content: [{ type: "text", text: "File not found: " + path_b }], isError: true };
  const contentA = fs.readFileSync(path_a, "utf-8");
  const contentB = fs.readFileSync(path_b, "utf-8");
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
  const policyError = enforcePathPolicy(filePath, "write");
  if (policyError) return policyError;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  const stat = fs.statSync(filePath);
  return { content: [{ type: "text", text: "Written " + stat.size + " bytes to " + filePath }] };
}

async function sidekick_find({ path: searchPath, name, modified_after, modified_before, size_min, size_max, content, max_results }) {
  const maxResults = max_results || 50;
  const policyError = enforcePathPolicy(searchPath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(searchPath)) return { content: [{ type: "text", text: "Path not found: " + searchPath }], isError: true };
  const afterMs = modified_after ? new Date(modified_after).getTime() : 0;
  const beforeMs = modified_before ? new Date(modified_before).getTime() : Infinity;
  const sizeMin = size_min ? parseSize(size_min) : 0;
  const sizeMax = size_max ? parseSize(size_max) : Infinity;
  const nameRe = name ? new RegExp("^" + name.replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i") : null;
  const contentRe = content ? new RegExp(content, "i") : null;
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
              const fileContent = fs.readFileSync(fullPath, "utf-8").substring(0, 1024 * 1024);
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
    description: "Read a file from the remote filesystem",
    schema: z.object({ path: z.string().describe("Absolute path to the file to read") }),
    args: { path: "string" },
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
    risk: "low",
    category: "Core",
    source: "builtin",
    family: "filesystem",
    handler: sidekick_list,
  }),
  Object.freeze({
    name: "search",
    description: "Search file contents using ripgrep or grep",
    schema: z.object({
      pattern: z.string().describe("Regex pattern to search for"),
      path: z.string().optional().describe("Directory to search in (defaults to current directory)"),
      include: z.string().optional().describe("File pattern to include (e.g. '*.js', '*.ts')"),
    }),
    args: { pattern: "string", path: "string (optional)", include: "string (optional)" },
    risk: "low",
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
      pattern: z.string().optional().describe("Regex pattern for grep strategy"),
    }),
    args: { path: "string (file path)", max_lines: "number (optional, default 50)", strategy: "string (optional, head|tail|grep|stats - default head)", pattern: "string (optional, regex for grep strategy)" },
    risk: "low",
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
      pattern: z.string().optional().describe("Regex pattern to match"),
      after: z.string().optional().describe("ISO date: include files modified after this date"),
      before: z.string().optional().describe("ISO date: include files modified before this date"),
      max_results: z.number().optional().describe("Maximum results to return (default: 50)"),
    }),
    args: { path: "string (file or directory path)", pattern: "string (optional, regex pattern)", after: "string (optional, ISO date for files modified after)", before: "string (optional, ISO date for files modified before)", max_results: "number (optional, default 50)" },
    risk: "low",
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
    risk: "low",
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
      name: z.string().optional().describe("File name glob pattern (e.g. '*.js')"),
      modified_after: z.string().optional().describe("ISO date: files modified after"),
      modified_before: z.string().optional().describe("ISO date: files modified before"),
      size_min: z.string().optional().describe("Minimum file size (e.g. '1KB', '1MB')"),
      size_max: z.string().optional().describe("Maximum file size (e.g. '10MB')"),
      content: z.string().optional().describe("Regex pattern to match file contents"),
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

module.exports = { descriptors, sidekick_read, sidekick_list, sidekick_search, sidekick_summarize, sidekick_filter, sidekick_write, sidekick_diff_files, sidekick_find };
