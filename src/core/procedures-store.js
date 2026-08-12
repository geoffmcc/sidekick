"use strict";

// Taught-procedure JSON store, moved verbatim from src/tools-legacy.js (B-6)
// so the teach/project/evolve families and src/index.js can share it without
// a legacy import (the secret-cipher extraction precedent). DATA_DIR is
// re-based for src/core/ (__dirname moved one level deeper than src/).

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.SIDEKICK_DATA_DIR || path.join(__dirname, "..", "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const PROCEDURES_FILE = path.join(DATA_DIR, "procedures.json");

function loadProcedures() {
  if (!fs.existsSync(PROCEDURES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PROCEDURES_FILE, "utf-8"));
  } catch (e) {
    return {};
  }
}

function saveProcedures(procedures) {
  fs.writeFileSync(PROCEDURES_FILE, JSON.stringify(procedures, null, 2));
}

module.exports = { PROCEDURES_FILE, loadProcedures, saveProcedures };
