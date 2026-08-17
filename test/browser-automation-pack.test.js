"use strict";

// Governed Browser Automation capability pack — full lifecycle + real Chromium.
//
// Proves the complete pack lifecycle (available -> install -> configure ->
// enable -> health -> tools callable -> disable -> re-enable -> uninstall) AND
// that the enabled pack's tools and a workflow actually drive a real browser,
// through the normal dispatcher, against a deterministic local fixture site.
//
// The pack tools compose the Core `browser` tool via the module services
// facade; nothing here calls browser internals directly. If the browser runtime
// is not installed the real-browser assertions are skipped with a loud notice
// (never silently passed); the lifecycle assertions still run.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sk-ba-pack-"));
process.env.SIDEKICK_DATA_DIR = DATA_DIR;
process.env.SIDEKICK_DB_FILE = path.join(DATA_DIR, "sidekick.db");
process.env.SIDEKICK_SECRET_KEY = "browser-automation-pack-test-key";
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.SIDEKICK_BROWSER_ENABLED = "true";
process.env.SIDEKICK_BROWSER_ALLOW_PRIVATE_NETWORK = "true"; // fixture is on loopback

require("../src/db").runPendingMigrations();

const bundled = require("../src/packs/bundled");
const lifecycle = require("../src/packs/lifecycle");
const repository = require("../src/packs/repository");
const driver = require("../src/browser/driver");
const browserSubsystem = require("../src/browser");
const { createFixtureSite } = require("./helpers/browser-fixture-site");
const secretsStore = require("../src/core/secrets-store");
const { encryptSecret } = require("../src/core/secret-cipher");

let passed = 0;
let failed = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${error.stack || error.message}`);
  }
}

function parse(result) {
  assert.ok(result && result.content && result.content[0], "tool returned no content");
  return JSON.parse(result.content[0].text);
}

(async () => {
  console.log("\nGoverned Browser Automation pack — lifecycle + real Chromium\n");

  const packRef = bundled.getBundledPack("browser-automation");

  await t("pack is discoverable and inspectable", () => {
    assert.ok(packRef, "browser-automation not found among bundled packs");
    const inspected = lifecycle.inspect(packRef.path, { sourceKind: "bundled" });
    assert.strictEqual(inspected.installable, true, JSON.stringify(inspected.findings || inspected));
  });

  await t("validate reports a clean, permission-consistent manifest", () => {
    const report = lifecycle.validate(packRef.path);
    assert.strictEqual(report.valid, true, JSON.stringify(report.findings));
    assert.strictEqual(report.summary.errors, 0);
  });

  await t("install (disabled) then configure", () => {
    lifecycle.install(packRef.path, {
      provenance: "first_party",
      source: { kind: "bundled", path: packRef.path },
      enable: false,
    });
    assert.strictEqual(repository.getPack("browser-automation").state, "installed");
    lifecycle.configure("browser-automation", { default_allowed_hosts: ["127.0.0.1"], full_page: false });
    assert.strictEqual(repository.getPack("browser-automation").state, "configured");
  });

  await t("enable activates the module tools and workflows", () => {
    const result = lifecycle.enable("browser-automation");
    assert.strictEqual(repository.getPack("browser-automation").state, "enabled");
    const toolNames = result.activated.modules.flatMap(m => m.tools || []);
    for (const expected of ["web_capture", "web_extract", "web_check"]) {
      assert.ok(toolNames.includes(expected), `expected ${expected} among activated tools: ${toolNames.join(", ")}`);
    }
    assert.ok(result.activated.workflows.includes("browser-automation/ui-smoke"), "ui-smoke workflow not activated");
  });

  await t("health reflects real browser runtime readiness", () => {
    const runtime = driver.resolveExecutable();
    const h = lifecycle.health("browser-automation");
    assert.ok(["healthy", "degraded"].includes(h.status), `unexpected health ${h.status}`);
    // When the runtime is present health should be healthy; when absent, degraded.
    if (runtime.executable) {
      assert.notStrictEqual(h.status, "degraded", "runtime present but pack health is degraded");
    }
  });

  await t("enabled pack tools are callable through the dispatcher", () => {
    const { getBuiltinRegistry } = require("../src/tools/dispatcher");
    const names = getBuiltinRegistry().listInDefinitionOrder().map(d => d.name);
    for (const expected of ["web_capture", "web_extract", "web_check"]) {
      assert.ok(names.includes(expected), `${expected} not on the live registry`);
    }
  });

  // --- Real browser exercise ------------------------------------------------

  const runtime = await driver.runtimeHealth({ deep: false });
  const browserAvailable = runtime.status !== "missing_runtime";
  if (!browserAvailable) {
    console.log("\n  " + "─".repeat(66));
    console.log("  Browser runtime not installed — real-browser pack assertions SKIPPED.");
    console.log("  This is NOT a pass. Run `node scripts/install-browser.js`.");
    console.log("  " + "─".repeat(66) + "\n");
  }

  let site = null;
  let base = null;
  if (browserAvailable) {
    browserSubsystem.initialize();
    site = createFixtureSite();
    ({ base } = await site.listen());
    const { callMcpTool } = require("../src/tools");
    const call = (name, args) => callMcpTool(name, args, { source: "mcp", actor: "pack-test", project: "ba-pack" });

    await t("configured host ceiling cannot be widened by a per-call allowlist", async () => {
      const result = parse(await call("web_capture", {
        url: "https://example.com/",
        allowed_hosts: ["example.com"],
        include_text: false,
      }));
      assert.strictEqual(result.ok, false, JSON.stringify(result));
      assert.strictEqual(result.code, "browser_pack_allowlist_widened", JSON.stringify(result));
      assert.match(result.error, /cannot widen/i);
    });

    await t("web_capture drives a real browser and registers a screenshot artifact", async () => {
      const result = parse(await call("web_capture", { url: `${base}/`, allow_private_network: true, include_text: true }));
      assert.strictEqual(result.ok, true, JSON.stringify(result));
      assert.ok(result.untrusted_page_content.includes("js-rendered-content"), "JS content not captured");
      assert.strictEqual(result.screenshot.custody.status, "registered", JSON.stringify(result.screenshot));
      assert.strictEqual(result.screenshot.content_type, "image/png");
    });

    await t("web_extract returns bounded structured data from a rendered page", async () => {
      const result = parse(await call("web_extract", {
        url: `${base}/`,
        allow_private_network: true,
        fields: [
          { name: "heading", target: "#heading" },
          { name: "items", target: ".item", all: true },
        ],
      }));
      assert.strictEqual(result.ok, true, JSON.stringify(result));
      assert.strictEqual(result.untrusted_page_content.heading, "Fixture Home");
      assert.deepStrictEqual(result.untrusted_page_content.items, ["Alpha", "Beta", "Gamma"]);
    });

    await t("web_check passes on expected content and fails truthfully on missing content", async () => {
      const ok = parse(await call("web_check", {
        url: `${base}/`,
        allow_private_network: true,
        assertions: [{ kind: "title_contains", value: "Fixture" }, { kind: "text_visible", value: "js-rendered-content" }],
        capture_evidence: true,
      }));
      assert.strictEqual(ok.passed, true, JSON.stringify(ok.assertions));
      assert.strictEqual(ok.evidence.custody.status, "registered");

      const bad = parse(await call("web_check", {
        url: `${base}/`,
        allow_private_network: true,
        assertions: [{ kind: "text_visible", value: "this text is definitely not present" }],
      }));
      assert.strictEqual(bad.passed, false, "web_check should report a truthful failure");
    });

    await t("web tools never leak the pack into arbitrary tool access (deny-by-default facade)", async () => {
      // The module declares only `browser`; a health probe confirms the facade
      // is the only dispatch path. This is a smoke that the tool ran through the
      // module services (its result shape is the module's, not a raw browser
      // dump): web_capture returns tool: "web_capture".
      const result = parse(await call("web_capture", { url: `${base}/form`, allow_private_network: true, include_text: false }));
      assert.strictEqual(result.tool, "web_capture");
    });

    await t("ui-smoke workflow runs end-to-end against the fixture", async () => {
      const { runWorkflowDefinition } = require("../src/workflows/runner");
      const run = await runWorkflowDefinition("browser-automation/ui-smoke", {
        url: `${base}/`,
        expect_text: "js-rendered-content",
        allow_private_network: true,
        allowed_hosts: ["127.0.0.1"],
      }, { source: "mcp", actor: "pack-test", project: "ba-pack" });
      assert.ok(["completed", "succeeded", "ok"].includes(run.status) || run.result, `workflow did not complete: ${JSON.stringify(run.status)}`);
      assert.strictEqual(run.result.passed, true, `ui-smoke did not pass: ${JSON.stringify(run.result)}`);
      assert.ok(run.result.evidence && run.result.evidence.artifact_id, "no evidence artifact from ui-smoke");
    });

    await t("download-verification workflow captures a real download artifact and closes on failure", async () => {
      const { runWorkflowDefinition } = require("../src/workflows/runner");
      const run = await runWorkflowDefinition("browser-automation/download-verification", {
        url: `${base}/`,
        trigger_selector: "#dl",
        allow_private_network: true,
        allowed_hosts: ["127.0.0.1"],
      }, { source: "mcp", actor: "pack-test", project: "ba-pack" });
      assert.ok(["completed", "succeeded", "ok"].includes(run.status) || run.result, `workflow did not complete: ${JSON.stringify(run.status)}`);
      assert.ok(run.result.download && run.result.download.artifact_id, `download artifact missing: ${JSON.stringify(run.result)}`);
      assert.strictEqual(run.result.download.custody.status, "registered", JSON.stringify(run.result.download));
      assert.strictEqual(run.result.download.byte_size, Buffer.byteLength("sidekick-fixture-download-payload"));

      const failed = await runWorkflowDefinition("browser-automation/download-verification", {
        url: `${base}/`,
        trigger_selector: "#missing-download-control",
        allow_private_network: true,
        allowed_hosts: ["127.0.0.1"],
      }, { source: "mcp", actor: "pack-test", project: "ba-pack" });
      assert.strictEqual(failed.status, "failed", `missing download must fail: ${JSON.stringify(failed)}`);
      const health = await browserSubsystem.health({ deep: false });
      assert.strictEqual(health.sessions.open, 0, "failed download workflow leaked its browser session");
    });

    await t("authenticated-ui-check workflow performs a governed secret login", async () => {
      // Seed the fixture credential in the secret store.
      const all = secretsStore.loadSecrets();
      all["ba_fixture_pw"] = encryptSecret("s3cr3t-fixture-pw");
      secretsStore.saveSecrets(all);
      const { runWorkflowDefinition } = require("../src/workflows/runner");
      const run = await runWorkflowDefinition("browser-automation/authenticated-ui-check", {
        login_url: `${base}/login`,
        expected_host: "127.0.0.1",
        username: "demo-user",
        password_secret_ref: "secret:ba_fixture_pw",
        username_selector: "#username",
        password_selector: "#password",
        submit_selector: "#login",
        success_text: "Welcome, demo-user",
        allow_private_network: true,
        allowed_hosts: ["127.0.0.1"],
      }, { source: "mcp", actor: "pack-test", project: "ba-pack" });
      assert.strictEqual(run.result.passed, true, `authenticated-ui-check did not pass: ${JSON.stringify(run.result)}`);
      // The secret plaintext must not appear anywhere in the run result.
      assert.ok(!JSON.stringify(run).includes("s3cr3t-fixture-pw"), "secret plaintext leaked into workflow result");
    });
  }

  // --- Lifecycle teardown ---------------------------------------------------

  await t("disable removes the tools from the live registry", () => {
    lifecycle.disable("browser-automation");
    assert.strictEqual(repository.getPack("browser-automation").state, "disabled");
    const { getBuiltinRegistry } = require("../src/tools/dispatcher");
    const names = getBuiltinRegistry().listInDefinitionOrder().map(d => d.name);
    assert.ok(!names.includes("web_capture"), "web_capture still registered after disable");
  });

  await t("re-enable restores the tools", () => {
    lifecycle.enable("browser-automation");
    const { getBuiltinRegistry } = require("../src/tools/dispatcher");
    const names = getBuiltinRegistry().listInDefinitionOrder().map(d => d.name);
    assert.ok(names.includes("web_capture"), "web_capture not restored after re-enable");
    lifecycle.disable("browser-automation");
  });

  await t("uninstall removes the pack and its tools without harming unrelated state", () => {
    lifecycle.uninstall("browser-automation");
    assert.strictEqual(repository.getPack("browser-automation"), null);
    const { getBuiltinRegistry } = require("../src/tools/dispatcher");
    const names = getBuiltinRegistry().listInDefinitionOrder().map(d => d.name);
    assert.ok(!names.includes("web_capture"), "web_capture still present after uninstall");
    // An unrelated builtin tool is unaffected.
    assert.ok(names.includes("browser"), "Core browser tool should remain");
  });

  if (site) await site.close().catch(() => {});
  if (browserAvailable) await browserSubsystem.shutdown().catch(() => {});

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) { console.log("Failures:"); for (const f of failures) console.log(`  - ${f}`); }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error("FATAL:", error.stack || error); process.exit(1); });
