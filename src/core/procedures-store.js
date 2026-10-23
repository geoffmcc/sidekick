"use strict";

// Taught-procedure JSON store, moved verbatim from src/tools-legacy.js (B-6)
// so the teach/project/evolve families and src/index.js can share it without
// a legacy import (the secret-cipher extraction precedent). DATA_DIR is
// re-based for src/core/ (__dirname moved one level deeper than src/).

const fs = require("fs");
const path = require("path");
const { readJsonFile, writeJsonFile } = require("./json-file-store");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const PROCEDURES_FILE = path.join(DATA_DIR, "procedures.json");
const MAX_PROCEDURES_BYTES = 5 * 1024 * 1024;

function loadProcedures() {
  if (!fs.existsSync(PROCEDURES_FILE)) return {};
  try {
    const procedures = readJsonFile(PROCEDURES_FILE, { maxBytes: MAX_PROCEDURES_BYTES });
    return procedures && typeof procedures === "object" && !Array.isArray(procedures) ? procedures : {};
  } catch (e) {
    return {};
  }
}

function saveProcedures(procedures) {
  if (!procedures || typeof procedures !== "object" || Array.isArray(procedures)) throw new Error("procedures store root must be an object");
  writeJsonFile(PROCEDURES_FILE, procedures, { maxBytes: MAX_PROCEDURES_BYTES });
}

module.exports = { PROCEDURES_FILE, MAX_PROCEDURES_BYTES, loadProcedures, saveProcedures };
