#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
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

function provisionCertificationPacks() {
  if (process.env.SIDEKICK_CERTIFY_PROVISION_PACKS === "0") return;
  const path = require("path");
  const bundled = require("./packs/bundled");
  const repository = require("./packs/repository");
  const lifecycle = require("./packs/lifecycle");
  for (const name of ["developer", "security-research"]) {
    const installed = repository.getPack(name);
    if (!installed) {
      const config = name === "security-research"
        ? { workspace: path.join(require("os").tmpdir(), "sidekick-certification-research") }
        : undefined;
      bundled.installBundledPack(name, { config, enable: true });
      continue;
    }
    // Respect an operator-disabled pack; certification should report the
    // missing descriptor rather than silently re-enabling it.
    if (installed.state === "disabled") continue;
    if (installed.state !== "enabled" && installed.state !== "healthy") lifecycle.enable(name);
  }
}

function prepareCertificationEnvironment() {
  const configured = process.env.SIDEKICK_CERTIFICATION_DATA_DIR;
  const data = configured ? path.resolve(configured) : fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-certification-"));
  process.env.SIDEKICK_HOME = path.join(data, "home");
  process.env.SIDEKICK_DATA_DIR = data;
  process.env.SIDEKICK_BACKUP_DIR = path.join(data, "backups");
  return { data, temporary: !configured };
}

async function run() {
  const command = process.argv[2];
  if (command === "version") return console.log(packageJson.version);
  if (command === "status") return status();
  if (command === "doctor" || command === "setup" || command === "certify") {
    const certificationEnvironment = command === "certify" ? prepareCertificationEnvironment() : null;
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
        const db = require("./db");
        try {
          db.runPendingMigrations();
          provisionCertificationPacks();
          const { runCertification, formatCertificationText, createLifecycleExecutorFromEnv } = require("./certification");
          const live = process.argv.includes("--live");
          const liveExecutor = live ? createLifecycleExecutorFromEnv() : null;
          const previousTestPolicy = process.env.SIDEKICK_TEST_TOOL_POLICY;
          const previousTestApproval = process.env.SIDEKICK_TEST_APPROVAL_MODE;
          process.env.SIDEKICK_TEST_TOOL_POLICY = "open";
          process.env.SIDEKICK_TEST_APPROVAL_MODE = "off";
          let report;
          try {
          report = await runCertification({ mode: live ? "live" : "hermetic", availability: liveExecutor ? () => liveExecutor.available() : false, liveExecutor });
          } finally {
            if (previousTestPolicy === undefined) delete process.env.SIDEKICK_TEST_TOOL_POLICY;
            else process.env.SIDEKICK_TEST_TOOL_POLICY = previousTestPolicy;
            if (previousTestApproval === undefined) delete process.env.SIDEKICK_TEST_APPROVAL_MODE;
            else process.env.SIDEKICK_TEST_APPROVAL_MODE = previousTestApproval;
          }
          if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
          else console.log(formatCertificationText(report));
        // Unavailability is diagnostic information, never release evidence.
        // Keep the legacy flag accepted, but it cannot turn blocked or skipped
        // required certification into a pass.
          if (report.verdict !== "passed") process.exitCode = 1;
          return;
        } finally {
          db.closeDatabase();
          if (certificationEnvironment.temporary) {
            try { fs.rmSync(certificationEnvironment.data, { recursive: true, force: true }); } catch {}
          }
        }
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
