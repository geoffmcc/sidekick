"use strict";

const { z } = require("zod");
const dbStore = require("../../db");
const redisStore = require("../../redis");
const { redactSensitive } = require("../../redact");
const toolContext = require("../context");
const { PROJECT_RE } = require("../../core/project-identity");

const sessionCache = new Map();

function parseDuration(str) {
  if (!str) return 300000;
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 300000;
  const val = parseInt(match[1], 10);
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return val * (multipliers[match[2]] || 60000);
}

function getCurrentSource() {
  return toolContext.getExecutionSource() || "unknown";
}

function currentScope() {
  const context = toolContext.getExecutionContext();
  const principalId = context.authIdentity?.principal_id || null;
  const project = context.project || null;
  return { principalId, project };
}

// Legacy KV predates identity ownership columns. Keep installation-wide legacy
// callers compatible, but bind authenticated callers to a namespace that they
// cannot name or enumerate outside their own principal/project scope.
function scopedKey(key, project = currentScope().project) {
  const { principalId } = currentScope();
  if (!principalId) return key;
  return `__sidekick_principal_v1:${encodeURIComponent(principalId)}:${encodeURIComponent(project || "global")}:${key}`;
}

function scopedPrefix(project = currentScope().project) {
  const { principalId } = currentScope();
  return principalId
    ? `__sidekick_principal_v1:${encodeURIComponent(principalId)}:${encodeURIComponent(project || "global")}:`
    : "";
}

async function sidekick_store({ key, value, project, category }) {
  if (project !== undefined && project !== null && !PROJECT_RE.test(project)) {
    return { content: [{ type: "text", text: "Invalid project name. Must match /^[a-z][a-z0-9_]*$/" }], isError: true };
  }

  const scope = currentScope();
  const effectiveProject = project !== undefined ? project : scope.project;
  const storageKey = scopedKey(key, effectiveProject);
  const existing = dbStore.getKV(storageKey);
  dbStore.setKV(storageKey, value, effectiveProject !== undefined ? effectiveProject : (existing?.project || null), getCurrentSource(), category !== undefined ? category : (existing?.category || null));

  return { content: [{ type: "text", text: "Stored key \"" + key + "\" (" + value.length + " chars)" }] };
}

async function sidekick_get({ key }) {
  const entry = dbStore.getKV(scopedKey(key));
  if (!entry) {
    return { content: [{ type: "text", text: "Key not found: " + key }], isError: true };
  }
  const value = (typeof entry === "object" && entry !== null && "value" in entry) ? entry.value : entry;
  return { content: [{ type: "text", text: redactSensitive(value) }] };
}

async function sidekick_delete({ key }) {
  const storageKey = scopedKey(key);
  const existing = dbStore.getKV(storageKey);
  if (!existing) {
    return { content: [{ type: "text", text: "Key not found: " + key }], isError: true };
  }
  dbStore.deleteKV(storageKey);
  return { content: [{ type: "text", text: "Deleted key \"" + key + "\"" }] };
}

async function sidekick_list_projects() {
  const { principalId } = currentScope();
  const projects = principalId
    ? [...new Set(Object.entries(dbStore.getAllKV()).flatMap(([key]) => {
      const prefix = "__sidekick_principal_v1:" + encodeURIComponent(principalId) + ":";
      if (!key.startsWith(prefix)) return [];
      const remainder = key.slice(prefix.length);
      const separator = remainder.indexOf(":");
      return separator < 0 ? [] : [decodeURIComponent(remainder.slice(0, separator))];
    }))]
    : dbStore.listKVProjects();
  return { content: [{ type: "text", text: JSON.stringify(projects) }] };
}

async function sidekick_get_by_project({ project }) {
  const allKV = dbStore.getAllKV();
  const results = [];
  const prefix = scopedPrefix(project);
  for (const [key, entry] of Object.entries(allKV)) {
    if (prefix && !key.startsWith(prefix)) continue;
    if (typeof entry === "object" && entry !== null && "project" in entry) {
      if (entry.project === project) {
        results.push({ key: prefix ? key.slice(prefix.length) : key, value: entry.value });
      }
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(results) }] };
}

async function sidekick_cache({ action, key, ttl, value }) {
  const now = Date.now();
  const cacheKey = scopedKey(key || "", null);
  const cachePrefix = scopedPrefix(null);
  let useRedis = false;
  try {
    const conn = await redisStore.testConnection();
    useRedis = conn.connected;
  } catch (e) {
    useRedis = false;
  }

  if (action === "clear") {
    if (useRedis) {
      if (key) {
        await redisStore.del(`cache:${cacheKey}`);
        return { content: [{ type: "text", text: "Cleared cache: " + key + " (redis)" }] };
      }
      const keys = await redisStore.keys(`cache:${cachePrefix || ""}*`);
      if (keys.length > 0) await Promise.all(keys.map(k => redisStore.del(k)));
      return { content: [{ type: "text", text: "Cleared " + keys.length + " cache entries (redis)" }] };
    }
    if (key) {
      sessionCache.delete(cacheKey);
      return { content: [{ type: "text", text: "Cleared cache: " + key }] };
    }
    const matching = [...sessionCache.keys()].filter(k => !cachePrefix || k.startsWith(cachePrefix));
    for (const k of matching) sessionCache.delete(k);
    const count = matching.length;
    return { content: [{ type: "text", text: "Cleared " + count + " cache entries" }] };
  }

  if (action === "list") {
    if (useRedis) {
      const keys = await redisStore.keys(`cache:${cachePrefix || ""}*`);
      const entries = [];
      for (const k of keys) {
        const ttlVal = await redisStore.ttl(k);
        entries.push({ key: k.slice(("cache:" + cachePrefix).length), expires_in_seconds: ttlVal > 0 ? ttlVal : null });
      }
      return { content: [{ type: "text", text: JSON.stringify(entries) }] };
    }
    const entries = [];
    for (const [k, v] of sessionCache) if (!cachePrefix || k.startsWith(cachePrefix)) entries.push({ key: cachePrefix ? k.slice(cachePrefix.length) : k, expires_in_ms: v.expires - now, size: v.value.length });
    return { content: [{ type: "text", text: JSON.stringify(entries) }] };
  }

  if (action === "get") {
    if (!key) return { content: [{ type: "text", text: "key required" }], isError: true };
    if (useRedis) {
      const val = await redisStore.get(`cache:${cacheKey}`);
      if (val === null) return { content: [{ type: "text", text: "Cache miss: " + key }], isError: true };
      return { content: [{ type: "text", text: redactSensitive(val) }] };
    }
    const entry = sessionCache.get(cacheKey);
    if (!entry || entry.expires < now) {
      if (entry) sessionCache.delete(cacheKey);
      return { content: [{ type: "text", text: "Cache miss: " + key }], isError: true };
    }
    return { content: [{ type: "text", text: redactSensitive(entry.value) }] };
  }

  if (action === "set") {
    if (!key || value === undefined) return { content: [{ type: "text", text: "key and value required" }], isError: true };
    const duration = parseDuration(ttl);
    const ttlSeconds = Math.ceil(duration / 1000);
    if (useRedis) {
      await redisStore.set(`cache:${cacheKey}`, String(value), ttlSeconds);
      return { content: [{ type: "text", text: "Cached " + key + " (TTL: " + ttl + ", redis)" }] };
    }
    sessionCache.set(cacheKey, { value: String(value), expires: now + duration });
    return { content: [{ type: "text", text: "Cached " + key + " (TTL: " + ttl + ")" }] };
  }

  return { content: [{ type: "text", text: "Invalid action. Use: get, set, clear, list" }], isError: true };
}

async function sidekick_redis({ action, key, value, ttl, pattern }) {
  try {
    const conn = await redisStore.testConnection();
    if (!conn.connected) return { content: [{ type: "text", text: `Error: Redis not available (${conn.error}). Start with: sudo systemctl start sidekick-redis` }], isError: true };
    if (action === "get") {
      if (!key) return { content: [{ type: "text", text: "Error: key is required for get" }], isError: true };
      const val = await redisStore.get(key);
      return { content: [{ type: "text", text: val !== null ? val : "(nil)" }] };
    }
    if (action === "set") {
      if (!key || value === undefined) return { content: [{ type: "text", text: "Error: key and value are required for set" }], isError: true };
      const ttlSec = ttl ? parseInt(ttl) : undefined;
      await redisStore.set(key, value, ttlSec);
      return { content: [{ type: "text", text: `OK${ttlSec ? ` (TTL: ${ttlSec}s)` : ""}` }] };
    }
    if (action === "del") {
      if (!key) return { content: [{ type: "text", text: "Error: key is required for del" }], isError: true };
      const deleted = await redisStore.del(key);
      return { content: [{ type: "text", text: `Deleted: ${deleted}` }] };
    }
    if (action === "keys") return { content: [{ type: "text", text: JSON.stringify(await redisStore.keys(pattern || "*"), null, 2) }] };
    if (action === "ttl") {
      if (!key) return { content: [{ type: "text", text: "Error: key is required for ttl" }], isError: true };
      return { content: [{ type: "text", text: `${await redisStore.ttl(key)}` }] };
    }
    if (action === "info") return { content: [{ type: "text", text: JSON.stringify(await redisStore.info(), null, 2) }] };
    if (action === "flush") {
      await redisStore.flush();
      return { content: [{ type: "text", text: "Redis database flushed" }] };
    }
    return { content: [{ type: "text", text: "Error: unknown action. Use: get, set, del, keys, ttl, info, flush" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
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
  Object.freeze({
    name: "cache",
    description: "Session-scoped caching to avoid redundant operations. Store and retrieve values with TTL.",
    schema: z.object({
      action: z.enum(["get", "set", "clear", "list"]).describe("Cache action"),
      key: z.string().optional().describe("Cache key"),
      ttl: z.string().optional().describe("Time-to-live: 30s, 5m, 1h (default: 5m)"),
      value: z.string().optional().describe("Value to cache (for set action)"),
    }),
    args: { action: "string (get|set|clear|list)", key: "string (cache key)", ttl: "string (optional, e.g. 30s, 5m, 1h - default 5m)", value: "string (value to cache, for set action)" },
    risk: "low",
    category: "Efficiency",
    source: "builtin",
    family: "storage",
    handler: sidekick_cache,
  }),
  Object.freeze({
    name: "redis",
    description: "Redis operations: get, set, del, keys, ttl, info, flush. Requires sidekick-redis service.",
    schema: z.object({
      action: z.enum(["get", "set", "del", "keys", "ttl", "info", "flush"]).describe("Redis action"),
      key: z.string().optional().describe("Redis key"),
      value: z.string().optional().describe("Value for set action"),
      ttl: z.string().optional().describe("TTL in seconds for set action"),
      pattern: z.string().optional().describe("Pattern for keys action (default '*')"),
    }),
    args: { action: "string (get|set|del|keys|ttl|info|flush)", key: "string (optional, Redis key)", value: "string (optional, value for set)", ttl: "string (optional, TTL in seconds for set)", pattern: "string (optional, pattern for keys - default '*')" },
    risk: "medium",
    category: "Storage",
    source: "builtin",
    family: "storage",
    handler: sidekick_redis,
  }),
]);

module.exports = { descriptors, sidekick_store, sidekick_get, sidekick_delete, sidekick_list_projects, sidekick_get_by_project, sidekick_cache, sidekick_redis };
