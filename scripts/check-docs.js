#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const required = [
  ["docs/architecture-boundaries.md", "npm run check:architecture"],
  ["docs/metrics.md", "/api/dashboard-performance"],
  ["docs/dashboard.md", "src/dashboard/database-routes.js"],
  ["docs/tool-architecture.md", "src/tools/dispatcher.js"],
];
const missing = required.filter(([file, text]) => !fs.readFileSync(path.join(root, file), "utf8").includes(text));
if (missing.length) { console.error(JSON.stringify({ missing }, null, 2)); process.exitCode = 1; } else console.log("Documentation drift checks passed");
