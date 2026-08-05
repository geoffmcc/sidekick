"use strict";

const fs = require("fs");
const { execFileSync } = require("child_process");
const { z } = require("zod");
const dbStore = require("../../db");
const { redactSensitive } = require("../../redact");
const { enforcePathPolicy } = require("../path-policy");

async function sidekick_tail({ source, pattern, lines, since }) {
  const maxLines = lines || 50;
  const re = pattern ? new RegExp(pattern, "i") : null;
  let content;
  if (source === "log.jsonl" || source === "log") {
    let parsed = dbStore.readToolLogs(1000);
    let filtered = parsed;
    if (since) {
      const sinceDate = new Date(since).getTime();
      filtered = parsed.filter(l => new Date(l.t).getTime() >= sinceDate);
    }
    if (re) {
      filtered = filtered.filter(l => re.test(l.n) || re.test(l.s) || re.test(l.a));
    }
    content = filtered.slice(-maxLines).map(l =>
      l.t.slice(11, 19) + " [" + (l.ok ? "OK" : "ERR") + "] " + l.n + ": " + l.s
    ).join("\n");
  } else if (source === "journalctl") {
    try {
      const svc = pattern || "sidekick-mcp";
      const stdout = execFileSync("journalctl", ["-u", svc, "-n", String(maxLines), "--no-pager"], {
        timeout: 10000, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024
      });
      content = stdout;
    } catch (e) {
      content = e.stdout || e.message;
    }
  } else {
    const policyError = enforcePathPolicy(source, "read");
    if (policyError) return policyError;
    if (!fs.existsSync(source)) {
      return { content: [{ type: "text", text: "File not found: " + source }], isError: true };
    }
    const allLines = fs.readFileSync(source, "utf-8").split("\n");
    let filtered = allLines;
    if (re) filtered = allLines.filter(l => re.test(l));
    content = filtered.slice(-maxLines).join("\n");
  }
  return { content: [{ type: "text", text: redactSensitive(content || "(no matching entries)") }] };
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "tail",
    description: "Tail recent log entries with filtering. Sources: log.jsonl (sidekick logs), journalctl, or any file.",
    schema: z.object({
      source: z.string().describe("Source: log.jsonl, journalctl, or file path"),
      pattern: z.string().optional().describe("Regex filter (for journalctl: service name)"),
      lines: z.number().optional().describe("Number of lines to return (default: 50)"),
      since: z.string().optional().describe("Filter entries since this date (ISO date or relative: 1h, 1d)"),
    }),
    args: { source: "string (log.jsonl, journalctl, or file path)", pattern: "string (optional, regex filter - for journalctl: service name)", lines: "number (optional, default 50)", since: "string (optional, ISO date or relative like 1h, 1d)" },
    risk: "medium",
    category: "Efficiency",
    source: "builtin",
    family: "monitoring",
    handler: sidekick_tail,
  }),
]);

module.exports = { descriptors, sidekick_tail };
