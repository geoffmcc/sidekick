"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { walk } = require("../../packs/developer/modules/developer-tools/lib/fsutil");

test("Developer repository scans exclude Sidekick runtime data without spending source budget", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-developer-data-scan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "browser", "chromium"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "entry.js"), "module.exports = true;\n");
  for (let index = 0; index < 1100; index++) {
    fs.writeFileSync(path.join(root, "data", "browser", "chromium", `runtime-${index}.js`), "binary placeholder\n");
  }

  const result = walk(root, { maxFiles: 1000, maxDepth: 6 });
  assert.deepEqual(result.files, ["src/entry.js"]);
  assert.equal(result.truncated, false, "runtime files do not consume the bounded source-file budget");
});
