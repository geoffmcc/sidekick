"use strict";

const YAML = require("yaml");
const { XMLParser } = require("fast-xml-parser");
const INI = require("ini");

function detectFormat(input) {
  const trimmed = input.trim();

  // Try JSON first
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {}
  }

  // Check for YAML indicators
  if (trimmed.includes(":") && (trimmed.includes("\n") || trimmed.startsWith("---"))) {
    try {
      YAML.parse(trimmed);
      return "yaml";
    } catch {}
  }

  // Check for XML
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<")) {
    try {
      const parser = new XMLParser();
      parser.parse(trimmed);
      return "xml";
    } catch {}
  }

  // Check for INI
  if (trimmed.includes("[") && trimmed.includes("=")) {
    try {
      INI.parse(trimmed);
      return "ini";
    } catch {}
  }

  // Check for CSV (has commas and newlines)
  if (trimmed.includes(",") && trimmed.includes("\n")) {
    return "csv";
  }

  return null;
}

function parseCSV(input) {
  const lines = input.trim().split("\n");
  if (lines.length === 0) return [];

  const headers = lines[0].split(",").map(h => h.trim().replace(/^"(.*)"$/, "$1"));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map(v => v.trim().replace(/^"(.*)"$/, "$1"));
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || "";
    }
    rows.push(row);
  }

  return rows;
}

module.exports = { detectFormat, parseCSV };
