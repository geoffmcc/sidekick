"use strict";

const YAML = require("yaml");
const { XMLParser } = require("fast-xml-parser");
const INI = require("ini");
const Ajv = require("ajv");
const Handlebars = require("handlebars");
const { z } = require("zod");
const { detectFormat, parseCSV } = require("../../core/format");

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
  sidekick_diff,
  sidekick_validate,
  sidekick_template,
};
