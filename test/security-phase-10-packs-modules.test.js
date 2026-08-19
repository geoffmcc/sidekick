"use strict";

// Phase 10: managed pack/module paths must remain inside their canonical store,
// even when a persisted path contains a symlinked ancestor.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-phase-10-"));
process.env.SIDEKICK_DATA_DIR = dataDir;

const moduleStore = require("../src/modules/store");
const packStore = require("../src/packs/store");

function directoryLink(target, link) {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

try {
  for (const [label, store, root] of [
    ["module", moduleStore, moduleStore.moduleStoreRoot()],
    ["pack", packStore, packStore.packStoreRoot()],
  ]) {
    fs.mkdirSync(root, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `sidekick-phase-10-${label}-outside-`));
    const escaped = path.join(root, `escaped-${label}`);
    directoryLink(outside, escaped);

    assert.strictEqual(store.isManagedPath(path.join(escaped, "1.0.0")), false, `${label} symlink ancestor must not be managed`);
    assert.throws(
      () => store.removeDirectory(path.join(escaped, "1.0.0")),
      /outside the managed .* store/,
      `${label} deletion must reject a symlink escape`
    );
    assert.strictEqual(fs.existsSync(outside), true, `${label} outside target must survive rejection`);
    fs.unlinkSync(escaped);
    fs.rmSync(outside, { recursive: true, force: true });
  }
  console.log("Phase 10 managed pack/module path security tests passed.");
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
