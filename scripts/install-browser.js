#!/usr/bin/env node
"use strict";

// Deliberate, reproducible browser runtime installation for the Sidekick
// browser subsystem.
//
// Nothing in Sidekick downloads a browser implicitly: an agent using the
// `browser` tool on a host without a runtime gets an actionable error and a
// health state, never a surprise 150MB download. An operator runs THIS script
// once per host (and after a playwright-core upgrade changes the pinned
// revision).
//
// Determinism: the Chromium build is pinned by playwright-core's own
// browsers.json, and playwright-core is pinned exactly in package.json /
// package-lock.json — so the lockfile pins the browser build the same way it
// pins every library. The installation lands under the DATA directory (not the
// app directory) so deploys, which replace the app checkout, never delete it.
//
// Usage:
//   node scripts/install-browser.js            # install pinned Chromium
//   node scripts/install-browser.js --with-deps  # also install OS packages (needs sudo)
//   node scripts/install-browser.js --check      # report status, install nothing

const path = require("path");
const { spawnSync } = require("child_process");
const { childProcessEnv } = require("../src/security/child-process");

const { browserConfig } = require("../src/browser/config");
const driver = require("../src/browser/driver");

function main() {
  const args = process.argv.slice(2);
  const withDeps = args.includes("--with-deps");
  const checkOnly = args.includes("--check");

  const config = browserConfig();
  const revision = driver.chromiumRevision();
  console.log(`Pinned Chromium: revision ${revision ? revision.revision : "unknown"} (${revision ? revision.version : "unknown"})`);
  console.log(`Managed browsers path: ${config.browsersPath}`);

  const before = driver.resolveExecutable(config);
  if (before.executable) {
    console.log(`Browser already available: ${before.executable} (source: ${before.source})`);
    if (checkOnly || before.source === "managed" || before.source === "override") {
      console.log("Nothing to do.");
      return 0;
    }
    console.log("Available only from the Playwright cache; installing into the managed path for durability.");
  } else if (checkOnly) {
    console.log(`Browser NOT installed. Checked: ${(before.checked || []).join(", ")}`);
    return 1;
  }

  const cli = path.join(path.dirname(require.resolve("playwright-core/package.json")), "cli.js");
  const installArgs = [cli, "install", "chromium"];
  if (withDeps) installArgs.push("--with-deps");
  console.log(`Running: node ${installArgs.join(" ")}`);
  const result = spawnSync(process.execPath, installArgs, {
    stdio: "inherit",
    env: childProcessEnv({ PLAYWRIGHT_BROWSERS_PATH: config.browsersPath }),
  });
  if (result.status !== 0) {
    console.error(`Browser installation failed (exit ${result.status}).`);
    return result.status || 1;
  }

  const after = driver.resolveExecutable(config);
  if (!after.executable) {
    console.error("Installation reported success but no executable was found — refusing to claim success.");
    console.error(`Checked: ${(after.checked || []).join(", ")}`);
    return 1;
  }
  console.log(`Installed: ${after.executable} (source: ${after.source})`);
  return 0;
}

process.exit(main());
