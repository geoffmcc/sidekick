"use strict";

// Resume tool family: resume.
//
// Extracted from src/tools-legacy.js. Depends only on zod, the shared db
// store, the redaction utility, and the shared id generator — never on
// tools-legacy.js. PROJECT_RE is duplicated per the storage-family precedent.
// Risk (low) preserved from src/tools/metadata.js.

const { z } = require("zod");
const dbStore = require("../../db");
const { redactSensitive } = require("../../redact");
const { generateId } = require("../../core/ids");
const { PROJECT_RE } = require("../../core/project-identity");

const RESUME_DOCUMENT = "resume";

function loadResumeDocument() {
  const doc = dbStore.loadDocument(RESUME_DOCUMENT, { items: {} });
  if (!doc || typeof doc !== "object") return { items: {} };
  doc.items = doc.items && typeof doc.items === "object" ? doc.items : {};
  return doc;
}

function saveResumeDocument(doc) {
  dbStore.setDocument(RESUME_DOCUMENT, {
    version: 1,
    updated_at: new Date().toISOString(),
    items: doc.items || {}
  });
}

function activeResumeItems(doc, includeCleared = false) {
  const items = Object.values(doc.items || {});
  if (includeCleared) return items;
  return items.filter(item => !["cleared", "done", "complete"].includes(item.status));
}

function formatResumeItem(item) {
  return [
    `Project: ${item.project}`,
    `Status: ${item.status}`,
    item.plan_name ? `Plan: ${item.plan_name}` : null,
    item.current_phase ? `Current phase: ${item.current_phase}` : null,
    `Summary: ${item.summary || "(none)"}`,
    `Next step: ${item.next_step || "(none)"}`,
    item.branch ? `Branch: ${item.branch}` : null,
    item.url ? `URL: ${item.url}` : null,
    item.notes ? `Notes: ${item.notes}` : null,
    `Updated: ${item.updated_at}`
  ].filter(Boolean).join("\n");
}

async function sidekick_resume({ action, project, summary, next_step, status, branch, url, notes, plan_name, current_phase, include_cleared, format }) {
  const selectedAction = action || "check";
  const selectedFormat = format || "text";
  const doc = loadResumeDocument();

  if (selectedAction === "list") {
    const items = activeResumeItems(doc, include_cleared === true)
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    const payload = { count: items.length, items };
    const text = selectedFormat === "json"
      ? JSON.stringify(payload, null, 2)
      : (items.length ? items.map(formatResumeItem).join("\n\n---\n\n") : "No pending resume items");
    return { content: [{ type: "text", text }] };
  }

  if (!project || !PROJECT_RE.test(project)) {
    return { content: [{ type: "text", text: "project required and must match /^[a-z][a-z0-9_]*$/" }], isError: true };
  }

  if (selectedAction === "check") {
    const item = doc.items[project];
    if (!item || ["cleared", "done", "complete"].includes(item.status)) {
      return { content: [{ type: "text", text: `No pending resume item for project: ${project}` }] };
    }
    const text = selectedFormat === "json" ? JSON.stringify(item, null, 2) : formatResumeItem(item);
    return { content: [{ type: "text", text }] };
  }

  if (selectedAction === "set") {
    if (!summary && !next_step) {
      return { content: [{ type: "text", text: "summary or next_step required for action=set" }], isError: true };
    }
    const now = new Date().toISOString();
    const existing = doc.items[project] || {};
    const item = {
      id: existing.id || generateId("resume"),
      project,
      status: status || "active",
      summary: summary !== undefined ? redactSensitive(summary) : existing.summary || null,
      next_step: next_step !== undefined ? redactSensitive(next_step) : existing.next_step || null,
      branch: branch !== undefined ? redactSensitive(branch) : existing.branch || null,
      url: url !== undefined ? redactSensitive(url) : existing.url || null,
      notes: notes !== undefined ? redactSensitive(notes) : existing.notes || null,
      plan_name: plan_name !== undefined ? redactSensitive(plan_name) : existing.plan_name || null,
      current_phase: current_phase !== undefined ? current_phase : existing.current_phase || null,
      created_at: existing.created_at || now,
      updated_at: now
    };
    doc.items[project] = item;
    saveResumeDocument(doc);
    const text = selectedFormat === "json" ? JSON.stringify(item, null, 2) : `Resume set for project: ${project} (${item.id})`;
    return { content: [{ type: "text", text }] };
  }

  if (selectedAction === "clear") {
    const item = doc.items[project];
    if (!item) {
      return { content: [{ type: "text", text: `No resume item found for project: ${project}` }], isError: true };
    }
    const now = new Date().toISOString();
    item.status = "cleared";
    item.cleared_at = now;
    item.updated_at = now;
    if (notes !== undefined) item.notes = redactSensitive(notes);
    saveResumeDocument(doc);
    const text = selectedFormat === "json" ? JSON.stringify(item, null, 2) : `Resume cleared for project: ${project}`;
    return { content: [{ type: "text", text }] };
  }

  return { content: [{ type: "text", text: "Invalid action. Use: check, set, clear, list" }], isError: true };
}

const SCHEMAS = {
  resume: z.object({
    action: z.enum(["check", "set", "clear", "list"]).optional().default("check").describe("Resume action"),
    project: z.string().optional().describe("Project name for check/set/clear"),
    summary: z.string().optional().describe("Short pending-work summary for action=set"),
    next_step: z.string().optional().describe("Concrete next step for action=set"),
    status: z.string().optional().describe("Resume status for action=set (default active)"),
    branch: z.string().optional().describe("Related branch name for action=set"),
    url: z.string().optional().describe("Related PR/issue URL for action=set"),
    notes: z.string().optional().describe("Additional notes for set/clear"),
    plan_name: z.string().optional().describe("Descriptive handoff plan name for action=set"),
    current_phase: z.number().int().positive().optional().describe("Current phase number within the named plan for action=set"),
    include_cleared: z.boolean().optional().describe("Include cleared/done items for action=list"),
    format: z.enum(["text", "json"]).optional().default("text").describe("Output format")
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "resume",
    description: "Manage first-class project resume handoffs stored in the resume document. Use to check, set, clear, or list pending work without relying on ad hoc KV keys.",
    schema: SCHEMAS.resume,
    args: { action: "string (check|set|clear|list - default check)", project: "string (required for check/set/clear)", summary: "string (optional, for set)", next_step: "string (optional, for set)", status: "string (optional, for set - default active)", branch: "string (optional, for set)", url: "string (optional, for set)", notes: "string (optional)", plan_name: "string (optional, for set - descriptive handoff plan name)", current_phase: "number (optional, for set - current phase number within the named plan)", include_cleared: "boolean (optional, for list)", format: "string (optional, text|json - default text)" },
    risk: "low",
    category: "Storage",
    source: "builtin",
    family: "resume",
    handler: sidekick_resume,
  }),
]);

module.exports = { descriptors, sidekick_resume };
