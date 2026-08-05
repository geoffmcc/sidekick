"use strict";

const { z } = require("zod");
const dbStore = require("../../db");
const { redactSensitive } = require("../../redact");
const toolContext = require("../context");

const PROJECT_RE = /^[a-z][a-z0-9_]*$/;

function getCurrentSource() {
  return toolContext.getExecutionSource() || "unknown";
}

async function sidekick_store({ key, value, project, category }) {
  if (project !== undefined && project !== null && !PROJECT_RE.test(project)) {
    return { content: [{ type: "text", text: "Invalid project name. Must match /^[a-z][a-z0-9_]*$/" }], isError: true };
  }

  const existing = dbStore.getKV(key);
  dbStore.setKV(key, value, project !== undefined ? project : (existing?.project || null), getCurrentSource(), category !== undefined ? category : (existing?.category || null));

  return { content: [{ type: "text", text: "Stored key \"" + key + "\" (" + value.length + " chars)" }] };
}

async function sidekick_get({ key }) {
  const entry = dbStore.getKV(key);
  if (!entry) {
    return { content: [{ type: "text", text: "Key not found: " + key }], isError: true };
  }
  const value = (typeof entry === "object" && entry !== null && "value" in entry) ? entry.value : entry;
  return { content: [{ type: "text", text: redactSensitive(value) }] };
}

async function sidekick_delete({ key }) {
  const existing = dbStore.getKV(key);
  if (!existing) {
    return { content: [{ type: "text", text: "Key not found: " + key }], isError: true };
  }
  dbStore.deleteKV(key);
  return { content: [{ type: "text", text: "Deleted key \"" + key + "\"" }] };
}

async function sidekick_list_projects() {
  const projects = dbStore.listKVProjects();
  return { content: [{ type: "text", text: JSON.stringify(projects) }] };
}

async function sidekick_get_by_project({ project }) {
  const allKV = dbStore.getAllKV();
  const results = [];
  for (const [key, entry] of Object.entries(allKV)) {
    if (typeof entry === "object" && entry !== null && "project" in entry) {
      if (entry.project === project) {
        results.push({ key, value: entry.value });
      }
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(results) }] };
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "store",
    description: "Store a value persistently in KV storage",
    schema: z.object({
      key: z.string().describe("Storage key"),
      value: z.string().describe("Value to store"),
      project: z.string().optional().describe("Project name (lowercase, underscores only)"),
      category: z.string().optional().describe("Category tag for filtering (e.g. 'mcp', 'tool', 'config')"),
    }),
    args: { key: "string", value: "string", project: "string (optional)" },
    risk: "low",
    category: "Storage",
    source: "builtin",
    family: "storage",
    handler: sidekick_store,
  }),
  Object.freeze({
    name: "get",
    description: "Retrieve a stored value from KV storage",
    schema: z.object({ key: z.string().describe("Storage key to retrieve") }),
    args: { key: "string" },
    risk: "low",
    category: "Storage",
    source: "builtin",
    family: "storage",
    handler: sidekick_get,
  }),
  Object.freeze({
    name: "delete",
    description: "Delete a stored value from KV storage by key",
    schema: z.object({ key: z.string().describe("Storage key to delete") }),
    args: { key: "string" },
    risk: "low",
    category: "Storage",
    source: "builtin",
    family: "storage",
    handler: sidekick_delete,
  }),
  Object.freeze({
    name: "list_projects",
    description: "List all unique project names in KV storage",
    schema: z.object({}),
    args: {},
    risk: "low",
    category: "Storage",
    source: "builtin",
    family: "storage",
    handler: sidekick_list_projects,
  }),
  Object.freeze({
    name: "get_by_project",
    description: "Get all keys and values for a specific project",
    schema: z.object({ project: z.string().describe("Project name to filter by") }),
    args: { project: "string" },
    risk: "low",
    category: "Storage",
    source: "builtin",
    family: "storage",
    handler: sidekick_get_by_project,
  }),
]);

module.exports = { descriptors, sidekick_store, sidekick_get, sidekick_delete, sidekick_list_projects, sidekick_get_by_project };
