#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { serveStdio } = require("@modelcontextprotocol/server/stdio");
const packageJson = require("../package.json");
const { prepareLocalEnvironment, acquireBootstrapLock, getLocalPaths } = require("./local/paths");

function usage() {
  console.error("Usage: sidekick [setup|doctor|certify|status|version]");
  console.error("With no command, Sidekick starts its full governed MCP stdio runtime.");
}

function status() {
  const paths = getLocalPaths();
  const exists = fs.existsSync(paths.db);
  console.log(JSON.stringify({ version: packageJson.version, home: paths.home, data: paths.data, database_initialized: exists }, null, 2));
}

async function run() {
  const command = process.argv[2];
  if (command === "version") return console.log(packageJson.version);
  if (command === "status") return status();
  if (command === "doctor" || command === "setup" || command === "certify") {
    const paths = prepareLocalEnvironment();
    const release = acquireBootstrapLock(paths.lock);
    try { console.error(`Sidekick local data: ${paths.data}`); }
    finally { release(); }
    if (command === "doctor") {
      const { runDoctor, formatDoctorText, createSupportBundle } = require("./doctor");
      const report = runDoctor();
      if (process.argv.includes("--bundle")) return console.log(JSON.stringify(createSupportBundle({ report }), null, 2));
      if (process.argv.includes("--json")) return console.log(JSON.stringify(report, null, 2));
      return console.log(formatDoctorText(report));
    }
    if (command === "certify") {
      const { runCertification, formatCertificationText } = require("./certification");
      const report = await runCertification({ mode: process.argv.includes("--live") ? "live" : "hermetic", availability: false });
      if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
      else console.log(formatCertificationText(report));
      if (report.verdict === "failed") process.exitCode = 1;
      return;
    }
    return;
  }
  if (command && command !== "start") { usage(); process.exitCode = 2; return; }

  const paths = prepareLocalEnvironment();
  const release = acquireBootstrapLock(paths.lock);
  try {
    // Every startup diagnostic from the existing runtime is redirected away
    // from stdout. The MCP SDK owns stdout for framed protocol traffic.
    console.log = (...args) => console.error(...args);
    process.env.SIDEKICK_LOCAL = "1";
    const { createMcpServer } = require("./index");
    const handle = serveStdio(() => createMcpServer(() => null), {
      onerror: error => console.error(`Sidekick MCP stdio error: ${error.message}`)
    });
    const close = async () => {
      try { await handle.close(); } catch (error) { console.error(`Sidekick shutdown failed: ${error.message}`); }
    };
    process.once("SIGINT", () => { close().finally(() => process.exit(0)); });
    process.once("SIGTERM", () => { close().finally(() => process.exit(0)); });
  } finally {
    release();
  }
}

run().catch(error => { console.error(`Sidekick startup failed: ${error.message}`); process.exitCode = 1; });
