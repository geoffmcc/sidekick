"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { collectTextFiles, readTextFiles } = require("./helpers/static-source-scan");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-static-scan-"));
const source = path.join(root, "src", "kept.js");
const generated = path.join(root, "test", "test-data-installation-race", "modules", "sample", "entry.js");
fs.mkdirSync(path.dirname(source), { recursive: true });
fs.mkdirSync(path.dirname(generated), { recursive: true });
fs.writeFileSync(source, "module.exports = 'committed source';\n");
fs.writeFileSync(generated, "module.exports = 'temporary fixture';\n");

try {
  const files = collectTextFiles(root);
  assert.ok(files.includes(source), "legitimate repository source remains covered");
  assert.ok(!files.includes(generated), "ephemeral generated module fixtures are not repository source");

  // Deterministically reproduce cleanup between traversal and content reads.
  fs.rmSync(path.dirname(path.dirname(path.dirname(generated))), { recursive: true, force: true });
  assert.deepEqual(readTextFiles(files).map(item => item.content), ["module.exports = 'committed source';\n"]);

  const missingSource = path.join(root, "src", "missing.js");
  fs.writeFileSync(missingSource, "source\n");
  const sourceList = collectTextFiles(root);
  fs.rmSync(missingSource);
  assert.throws(() => readTextFiles(sourceList), error => error.code === "ENOENT", "a missing real source file remains a hard scan failure");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("Static source scanner fixture-isolation regression passed");
