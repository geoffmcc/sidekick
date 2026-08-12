"use strict";

// Shared short-id generator, moved verbatim from src/tools-legacy.js (B-6)
// so descriptor families (resume, scheduling) can use it without a legacy
// import. Dependency-free.

function generateId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

module.exports = { generateId };
