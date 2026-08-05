"use strict";

const YAML = require("yaml");
const { XMLParser } = require("fast-xml-parser");
const INI = require("ini");
const Ajv = require("ajv");
const Handlebars = require("handlebars");
const fs = require("fs");
const path = require("path");
const { z } = require("zod");
const { detectFormat, parseCSV } = require("../../core/format");
const { redactSensitive } = require("../../redact");
const { enforcePathPolicy } = require("../path-policy");

const ajv = new Ajv({ allErrors: true, verbose: true });

// --- Parse Tool ---

async function sidekick_parse({ input, format }) {
  if (!input) {
    return { content: [{ type: "text", text: "input required" }], isError: true };
  }

  const detectedFormat = format || detectFormat(input);

  if (!detectedFormat) {
    return { content: [{ type: "text", text: "Could not detect format. Specify format: json, yaml, xml, ini, csv" }], isError: true };
  }

  try {
    let parsed;

    if (detectedFormat === "json") {
      parsed = JSON.parse(input);
    } else if (detectedFormat === "yaml") {
      parsed = YAML.parse(input);
    } else if (detectedFormat === "xml") {
      const parser = new XMLParser({ ignoreAttributes: false });
      parsed = parser.parse(input);
    } else if (detectedFormat === "ini") {
      parsed = INI.parse(input);
    } else if (detectedFormat === "csv") {
      parsed = parseCSV(input);
    } else {
      return { content: [{ type: "text", text: `Unsupported format: ${detectedFormat}` }], isError: true };
    }

    return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Parse error (${detectedFormat}): ${e.message}` }], isError: true };
  }
}

const SENSITIVE_FIELD_RE = /password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|encryption[_-]?key|credential|authorization/i;

function redactExtractedValue(value, key = "") {
  if (SENSITIVE_FIELD_RE.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redactExtractedValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactExtractedValue(childValue, childKey)]));
  }
  return value;
}

async function sidekick_extract({ path: filePath, fields }) {
  if (!filePath) return { content: [{ type: "text", text: "path required" }], isError: true };
  const policyError = enforcePathPolicy(filePath, "read");
  if (policyError) return policyError;
  if (!fs.existsSync(filePath)) {
    return { content: [{ type: "text", text: redactSensitive("File not found: " + filePath) }], isError: true };
  }
  const content = fs.readFileSync(filePath, "utf-8");
  let data;
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".json") data = JSON.parse(content);
    else if (ext === ".yaml" || ext === ".yml") data = YAML.parse(content);
    else if (ext === ".ini" || ext === ".cfg") data = INI.parse(content);
    else if (ext === ".xml") data = new XMLParser().parse(content);
    else data = JSON.parse(content);
  } catch (e) {
    return { content: [{ type: "text", text: redactSensitive("Parse error: " + e.message) }], isError: true };
  }
  if (!fields) return { content: [{ type: "text", text: redactSensitive(JSON.stringify(redactExtractedValue(data), null, 2)) }] };
  const fieldList = Array.isArray(fields) ? fields : fields.split(",").map(f => f.trim());
  const result = {};
  for (const fieldPath of fieldList) {
    const parts = fieldPath.replace(/\[(\d+)\]/g, ".$1").split(".");
    let val = data;
    for (const part of parts) {
      if (part === "__proto__" || part === "prototype" || part === "constructor" || val === null || val === undefined || !Object.prototype.hasOwnProperty.call(Object(val), part)) {
        val = undefined;
        break;
      }
      val = val[part];
    }
    Object.defineProperty(result, fieldPath, {
      value: val !== undefined ? (typeof val === "object" ? JSON.stringify(redactExtractedValue(val, fieldPath)) : (SENSITIVE_FIELD_RE.test(fieldPath) ? "[REDACTED]" : String(val))) : null,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { content: [{ type: "text", text: redactSensitive(JSON.stringify(result, null, 2)) }] };
}

async function sidekick_transform({ action, input, pattern, format, field, key, value }) {
  if (!input && input !== "") return { content: [{ type: "text", text: "input required" }], isError: true };
  let data;
  try { data = JSON.parse(input); } catch { data = input; }

  if (action === "filter") {
    if (!pattern) return { content: [{ type: "text", text: "pattern required for filter" }], isError: true };
    const regex = new RegExp(pattern);
    if (typeof data === "string") return { content: [{ type: "text", text: data.split("\n").filter(line => regex.test(line)).join("\n") }] };
    if (Array.isArray(data)) {
      const filtered = data.filter(item => typeof item === "string" ? regex.test(item) : regex.test(typeof item === "object" ? JSON.stringify(item) : String(item)));
      return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
    }
    return { content: [{ type: "text", text: "filter works on strings or arrays" }], isError: true };
  }

  if (action === "extract") {
    if (!field) return { content: [{ type: "text", text: "field required for extract" }], isError: true };
    if (typeof data !== "object" || data === null) return { content: [{ type: "text", text: "extract requires JSON input" }], isError: true };
    let result = data;
    for (const f of field.split(".")) {
      if (result === undefined || result === null) break;
      if (Array.isArray(result) && f === "[]") continue;
      if (f === "__proto__" || f === "prototype" || f === "constructor" || !Object.prototype.hasOwnProperty.call(Object(result), f)) {
        result = undefined;
        break;
      }
      result = result[f];
    }
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
  }

  if (action === "sort") {
    if (!Array.isArray(data)) return { content: [{ type: "text", text: "sort requires array input" }], isError: true };
    const sorted = [...data].sort((a, b) => {
      if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
      if (typeof a === "number" && typeof b === "number") return a - b;
      if (typeof a === "object" && typeof b === "object" && key) {
        const aVal = a[key];
        const bVal = b[key];
        if (typeof aVal === "number" && typeof bVal === "number") return aVal - bVal;
        return String(aVal).localeCompare(String(bVal));
      }
      return String(a).localeCompare(String(b));
    });
    return { content: [{ type: "text", text: JSON.stringify(sorted, null, 2) }] };
  }

  if (action === "format") {
    if (!format) return { content: [{ type: "text", text: "format required" }], isError: true };
    if (format === "json") {
      if (typeof data === "string") {
        try { return { content: [{ type: "text", text: JSON.stringify(JSON.parse(data), null, 2) }] }; }
        catch { return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }; }
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    if (format === "csv") {
      if (!Array.isArray(data)) return { content: [{ type: "text", text: "csv format requires array input" }], isError: true };
      if (data.length === 0) return { content: [{ type: "text", text: "" }] };
      const first = data[0];
      if (typeof first !== "object" || first === null) return { content: [{ type: "text", text: data.join("\n") }] };
      const headers = Object.keys(first);
      const rows = data.map(item => headers.map(h => {
        const val = item[h];
        const str = val === null || val === undefined ? "" : String(val);
        return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
      }).join(","));
      return { content: [{ type: "text", text: [headers.join(","), ...rows].join("\n") }] };
    }
    if (format === "table") {
      if (!Array.isArray(data)) return { content: [{ type: "text", text: "table format requires array input" }], isError: true };
      if (data.length === 0) return { content: [{ type: "text", text: "" }] };
      const first = data[0];
      if (typeof first !== "object" || first === null) return { content: [{ type: "text", text: data.join("\n") }] };
      const headers = Object.keys(first);
      const widths = headers.map(h => Math.max(h.length, ...data.map(row => String(row[h] || "").length)));
      const headerRow = headers.map((h, i) => h.padEnd(widths[i])).join(" | ");
      const separator = widths.map(w => "-".repeat(w)).join("-+-");
      const dataRows = data.map(row => headers.map((h, i) => String(row[h] || "").padEnd(widths[i])).join(" | "));
      return { content: [{ type: "text", text: [headerRow, separator, ...dataRows].join("\n") }] };
    }
    if (format === "text") return { content: [{ type: "text", text: typeof data === "string" ? data : Array.isArray(data) ? data.join("\n") : JSON.stringify(data) }] };
    return { content: [{ type: "text", text: "Unknown format. Use: json, csv, table, text" }], isError: true };
  }

  if (action === "map") {
    if (!key || !value) return { content: [{ type: "text", text: "key and value required for map" }], isError: true };
    if (!Array.isArray(data)) return { content: [{ type: "text", text: "map requires array input" }], isError: true };
    const mapped = data.map(item => typeof item === "object" && item !== null ? { ...item, [key]: value } : { [key]: value, original: item });
    return { content: [{ type: "text", text: JSON.stringify(mapped, null, 2) }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: filter, extract, sort, format, map" }], isError: true };
}

// --- Diff Tool ---

function diffText(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const changes = [];

  // Simple line-by-line diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine === undefined) {
      changes.push({ type: "added", line: i + 1, content: newLine });
    } else if (newLine === undefined) {
      changes.push({ type: "removed", line: i + 1, content: oldLine });
    } else if (oldLine !== newLine) {
      changes.push({ type: "modified", line: i + 1, oldContent: oldLine, newContent: newLine });
    }
  }

  return changes;
}

function diffJSON(oldObj, newObj, path = "") {
  const changes = [];

  const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);

  for (const key of allKeys) {
    const currentPath = path ? `${path}.${key}` : key;
    const oldVal = oldObj?.[key];
    const newVal = newObj?.[key];

    if (oldVal === undefined) {
      changes.push({ type: "added", path: currentPath, value: newVal });
    } else if (newVal === undefined) {
      changes.push({ type: "removed", path: currentPath, value: oldVal });
    } else if (typeof oldVal === "object" && typeof newVal === "object" && oldVal !== null && newVal !== null) {
      // Recursively diff nested objects
      if (Array.isArray(oldVal) && Array.isArray(newVal)) {
        // Array comparison
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          changes.push({ type: "modified", path: currentPath, oldValue: oldVal, newValue: newVal });
        }
      } else {
        // Object comparison
        changes.push(...diffJSON(oldVal, newVal, currentPath));
      }
    } else if (oldVal !== newVal) {
      changes.push({ type: "modified", path: currentPath, oldValue: oldVal, newValue: newVal });
    }
  }

  return changes;
}

function formatChanges(changes, format) {
  if (format === "summary") {
    const added = changes.filter(c => c.type === "added").length;
    const removed = changes.filter(c => c.type === "removed").length;
    const modified = changes.filter(c => c.type === "modified").length;
    return `Summary: ${added} added, ${removed} removed, ${modified} modified`;
  }

  if (format === "unified") {
    return changes.map(c => {
      if (c.type === "added") {
        return `+ ${c.path || `line ${c.line}`}: ${JSON.stringify(c.value || c.content)}`;
      } else if (c.type === "removed") {
        return `- ${c.path || `line ${c.line}`}: ${JSON.stringify(c.value || c.content)}`;
      } else if (c.type === "modified") {
        return `~ ${c.path || `line ${c.line}`}:\n- ${JSON.stringify(c.oldValue || c.oldContent)}\n+ ${JSON.stringify(c.newValue || c.newContent)}`;
      }
    }).join("\n");
  }

  // Default: structured JSON
  return JSON.stringify(changes, null, 2);
}

async function sidekick_diff({ old_text, new_text, format, type }) {
  if (!old_text || !new_text) {
    return { content: [{ type: "text", text: "old_text and new_text required" }], isError: true };
  }

  const diffType = type || "auto";
  const outputFormat = format || "unified";

  let changes;

  if (diffType === "text") {
    changes = diffText(old_text, new_text);
  } else if (diffType === "json") {
    try {
      const oldObj = JSON.parse(old_text);
      const newObj = JSON.parse(new_text);
      changes = diffJSON(oldObj, newObj);
    } catch (e) {
      return { content: [{ type: "text", text: `JSON parse error: ${e.message}` }], isError: true };
    }
  } else if (diffType === "yaml") {
    try {
      const oldObj = YAML.parse(old_text);
      const newObj = YAML.parse(new_text);
      changes = diffJSON(oldObj, newObj);
    } catch (e) {
      return { content: [{ type: "text", text: `YAML parse error: ${e.message}` }], isError: true };
    }
  } else {
    // Auto-detect
    const oldFormat = detectFormat(old_text);
    const newFormat = detectFormat(new_text);

    if (oldFormat === "json" && newFormat === "json") {
      try {
        const oldObj = JSON.parse(old_text);
        const newObj = JSON.parse(new_text);
        changes = diffJSON(oldObj, newObj);
      } catch (e) {
        return { content: [{ type: "text", text: `Auto-detect JSON parse error: ${e.message}` }], isError: true };
      }
    } else if ((oldFormat === "yaml" && newFormat === "yaml") || (oldFormat === "json" && newFormat === "yaml") || (oldFormat === "yaml" && newFormat === "json")) {
      try {
        const oldObj = oldFormat === "json" ? JSON.parse(old_text) : YAML.parse(old_text);
        const newObj = newFormat === "json" ? JSON.parse(new_text) : YAML.parse(new_text);
        changes = diffJSON(oldObj, newObj);
      } catch (e) {
        return { content: [{ type: "text", text: `Auto-detect YAML/JSON parse error: ${e.message}` }], isError: true };
      }
    } else {
      // Fall back to text diff
      changes = diffText(old_text, new_text);
    }
  }

  const output = formatChanges(changes, outputFormat);
  return { content: [{ type: "text", text: output }] };
}

// --- Validate Tool ---

async function sidekick_validate({ data, schema }) {
  if (!data || !schema) {
    return { content: [{ type: "text", text: "data and schema required" }], isError: true };
  }

  let parsedData, parsedSchema;

  try {
    // Try to parse data as JSON, otherwise use as-is
    parsedData = typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    parsedData = data;
  }

  try {
    parsedSchema = typeof schema === "string" ? JSON.parse(schema) : schema;
  } catch (e) {
    return { content: [{ type: "text", text: `Schema parse error: ${e.message}` }], isError: true };
  }

  try {
    const validate = ajv.compile(parsedSchema);
    const valid = validate(parsedData);

    if (valid) {
      return { content: [{ type: "text", text: "✓ Validation passed" }] };
    } else {
      const errors = validate.errors.map(e => ({
        path: e.instancePath || "/",
        message: e.message,
        params: e.params
      }));
      return { content: [{ type: "text", text: `✗ Validation failed:\n${JSON.stringify(errors, null, 2)}` }] };
    }
  } catch (e) {
    return { content: [{ type: "text", text: `Validation error: ${e.message}` }], isError: true };
  }
}

// --- Template Tool ---

async function sidekick_template({ template, data }) {
  if (!template) {
    return { content: [{ type: "text", text: "template required" }], isError: true };
  }

  let parsedData = {};

  if (data) {
    try {
      parsedData = typeof data === "string" ? JSON.parse(data) : data;
    } catch (e) {
      return { content: [{ type: "text", text: `Data parse error: ${e.message}` }], isError: true };
    }
  }

  try {
    const compiled = Handlebars.compile(template);
    const result = compiled(parsedData);
    return { content: [{ type: "text", text: result }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Template error: ${e.message}` }], isError: true };
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "parse",
    description: "Parse structured data formats (JSON, YAML, XML, INI, CSV) with auto-detection",
    schema: z.object({
      input: z.string().describe("Data to parse (string content)"),
      format: z.string().optional().describe("Format: json, yaml, xml, ini, csv (auto-detected if not specified)")
    }),
    args: { input: "string (data to parse)", format: "string (optional, json|yaml|xml|ini|csv - auto-detected if not specified)" },
    risk: "low",
    category: "Data Pipeline",
    source: "builtin",
    family: "data-utilities",
    handler: sidekick_parse,
  }),
  Object.freeze({
    name: "extract",
    description: "Parse JSON/YAML/INI/XML and extract specific fields by path. Returns only what you need.",
    schema: z.object({
      path: z.string().describe("File path (JSON, YAML, INI, or XML)"),
      fields: z.union([z.string(), z.array(z.string())]).optional().describe("Field paths to extract (e.g. 'database.host,database.port')"),
    }),
    args: { path: "string (file path)", fields: "string|array (optional, field paths to extract e.g. 'database.host,database.port')" },
    risk: "medium",
    category: "Data Pipeline",
    source: "builtin",
    family: "data-utilities",
    handler: sidekick_extract,
  }),
  Object.freeze({
    name: "transform",
    description: "Data manipulation pipeline: filter, extract, sort, format, and map data",
    schema: z.object({
      action: z.enum(["filter", "extract", "sort", "format", "map"]),
      input: z.string().describe("Input data (text or JSON string)"),
      pattern: z.string().optional().describe("Regex pattern for filter action"),
      field: z.string().optional().describe("Field path for extract action"),
      key: z.string().optional().describe("Key for sort or map action"),
      value: z.string().optional().describe("Value for map action"),
      format: z.string().optional().describe("Output format for format action: json, csv, table, text"),
    }),
    args: { action: "string (filter|extract|sort|format|map)", input: "string", pattern: "string (optional, for filter)", field: "string (optional, for extract)", key: "string (optional, for sort/map)", value: "string (optional, for map)", format: "string (optional, for format: json|csv|table|text)" },
    risk: "low",
    category: "Data Pipeline",
    source: "builtin",
    family: "data-utilities",
    handler: sidekick_transform,
  }),
  Object.freeze({
    name: "diff",
    description: "Semantic comparison of text, JSON, or YAML with structure-aware diffing",
    schema: z.object({
      old_text: z.string().describe("Original content to compare"),
      new_text: z.string().describe("Modified content to compare"),
      type: z.string().optional().describe("Diff type: text, json, yaml, or auto (default: auto)"),
      format: z.string().optional().describe("Output format: unified, summary, or json (default: unified)")
    }),
    args: { old_text: "string (original content)", new_text: "string (modified content)", type: "string (optional, text|json|yaml|auto - default auto)", format: "string (optional, unified|summary|json - default unified)" },
    risk: "low",
    category: "Data Pipeline",
    source: "builtin",
    family: "data-utilities",
    handler: sidekick_diff,
  }),
  Object.freeze({
    name: "validate",
    description: "Validate data against JSON Schema",
    schema: z.object({
      data: z.union([z.string(), z.record(z.any())]).describe("Data to validate (JSON string or object)"),
      schema: z.union([z.string(), z.record(z.any())]).describe("JSON Schema (JSON string or object)")
    }),
    args: { data: "string|object (data to validate)", schema: "string|object (JSON Schema)" },
    risk: "low",
    category: "Data Pipeline",
    source: "builtin",
    family: "data-utilities",
    handler: sidekick_validate,
  }),
  Object.freeze({
    name: "template",
    description: "Render Handlebars templates with data",
    schema: z.object({
      template: z.string().describe("Handlebars template string"),
      data: z.union([z.string(), z.record(z.any())]).optional().describe("Template data (JSON string or object)")
    }),
    args: { template: "string (Handlebars template)", data: "string|object (template data)" },
    risk: "low",
    category: "Data Pipeline",
    source: "builtin",
    family: "data-utilities",
    handler: sidekick_template,
  }),
]);

module.exports = {
  descriptors,
  sidekick_parse,
  sidekick_extract,
  sidekick_transform,
  sidekick_diff,
  sidekick_validate,
  sidekick_template,
};
