"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
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
    execFileSync("which", ["rg"], { stdio: "ignore" });
    useRg = true;
  } catch (e) {}

  try {
    let stdout;
    if (useRg) {
      const args = ["--json", "--max-count", "100"];
      if (include) args.push("-g", include);
      args.push(pattern, targetPath);
      stdout = execFileSync("rg", args, { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
    } else {
      const args = ["-rn", "--max-count=100"];
      if (include) args.push("--include=" + include);
      args.push(pattern, targetPath);
      stdout = execFileSync("grep", args, { timeout: 30000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
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
]);

module.exports = { descriptors, sidekick_read, sidekick_list, sidekick_search, sidekick_summarize };
