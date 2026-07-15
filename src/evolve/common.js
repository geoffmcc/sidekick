const crypto = require("crypto");
const { redactSensitive } = require("../redact");

const SECRET_KEY_RE = /(password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential)/i;
const PATH_RE = /^(?:[A-Za-z]:\\|\/|\.\/|\.\.\/)/;
const HOST_RE = /^(?:https?:\/\/)?[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i;

function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function normalizeScalar(value, key = "") {
  if (value === null || value === undefined) return value;
  if (SECRET_KEY_RE.test(key)) return "[REDACTED]";
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isInteger(value) ? "<int>" : "<number>";
  const text = redactSensitive(String(value));
  if (text !== String(value)) return "[REDACTED]";
  if (/^\d+$/.test(text)) return "<int>";
  if (/^\d+\.\d+$/.test(text)) return "<number>";
  if (PATH_RE.test(text)) return "<path>";
  if (/^\d{1,5}$/.test(text) && String(key).toLowerCase().includes("port")) return "<port>";
  if (HOST_RE.test(text) && /(host|url|endpoint|repo|domain)/i.test(key)) return "<host>";
  if (text.length > 80) return "<long_string>";
  return text;
}

function normalizeArgs(value, key = "") {
  if (Array.isArray(value)) return value.map(v => normalizeArgs(v, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = normalizeArgs(childValue, childKey);
    }
    return out;
  }
  return normalizeScalar(value, key);
}

function summarizeResult(text) {
  return redactSensitive(String(text || "").replace(/\s+/g, " ").trim()).slice(0, 240);
}

function errorCategory(summary) {
  const text = String(summary || "").toLowerCase();
  if (!text) return null;
  if (text.includes("approval required")) return "approval_required";
  if (text.includes("blocked by policy")) return "policy_blocked";
  if (text.includes("unknown tool")) return "missing_tool";
  if (text.includes("timeout")) return "timeout";
  if (text.includes("permission") || text.includes("unauthorized") || text.includes("forbidden")) return "permission";
  if (text.includes("validation")) return "validation";
  return "error";
}

function slugify(value, fallback = "workflow") {
  const slug = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return slug || fallback;
}

module.exports = {
  SECRET_KEY_RE,
  stableStringify,
  fingerprint,
  normalizeArgs,
  summarizeResult,
  errorCategory,
  slugify,
};
