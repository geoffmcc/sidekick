"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXCLUDED_DIRS = new Set([".git", "node_modules", "data", ".opencode", "spike-openvino-node", "spike-openvino-python"]);
const EXCLUDED_FILES = new Set(["opencode.json", "package-lock.json", "security.test.js", "github-setup.test.js", "static-code-quality.test.js"]);
const TEXT_EXTENSIONS = new Set([".js", ".json", ".md", ".yml", ".yaml", ".sh", ".ps1", ".service", ".example", ".gitignore", ".gitattributes"]);

function isGeneratedTestDataDirectory(root, directory) {
  const relative = path.relative(root, directory).split(path.sep);
  return relative[0] === "test" && relative.slice(1).some(segment => /^test-data(?:-|$)/.test(segment));
}

function collectTextFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || isGeneratedTestDataDirectory(root, full)) continue;
        walk(full);
      } else if (!EXCLUDED_FILES.has(entry.name) && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(full);
      }
    }
  }
  walk(root);
  return files;
}

function readTextFiles(files) {
  return files.map(file => ({ file, content: fs.readFileSync(file, "utf8") }));
}

module.exports = { collectTextFiles, readTextFiles, isGeneratedTestDataDirectory };
