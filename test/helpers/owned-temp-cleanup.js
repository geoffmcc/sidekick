"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function removeOwnedTempTree(rootPath, requiredPrefix) {
  const root = path.resolve(String(rootPath || ""));
  const tempRoot = path.resolve(os.tmpdir());
  const parent = path.dirname(root);
  if (parent !== tempRoot || !path.basename(root).startsWith(requiredPrefix)) {
    throw new Error("refusing to clean a path outside the owned temporary fixture");
  }
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root) {
    throw new Error("refusing to clean a replaced or linked temporary fixture");
  }

  function removeDirectory(directory) {
    for (const entry of fs.readdirSync(directory)) {
      const target = path.join(directory, entry);
      const stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) removeDirectory(target);
      else fs.unlinkSync(target);
    }
    fs.rmdirSync(directory);
  }

  removeDirectory(root);
}

module.exports = Object.freeze({ removeOwnedTempTree });
