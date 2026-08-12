"use strict";

// Regression net for the Track B slice B-5 extractions: every handler moved
// out of tools-legacy.js in B-5 must resolve through the registry as a
// family-owned builtin descriptor with its pre-move risk classification, and
// its legacy TOOLS entry must be gone. For handlers with a cheap
// validation-error path, invoking that path exercises the moved function body
// without touching the system (no shell, network, or file mutations).

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-b5-"));
process.env.SIDEKICK_DATA_DIR = testDataDir;

delete require.cache[require.resolve("../src/tools")];
const tools = require("../src/tools");
const legacy = require("../src/tools-legacy");
const registry = tools.getBuiltinRegistry();

// name -> [family, risk]
const EXPECTED = {
  llm: ["inference", "medium"],
  bash: ["shell", "critical"],
  write: ["filesystem", "critical"],
  git: ["development", "medium"],
  changelog: ["development", "medium"],
  depend: ["development", "medium"],
  ocr: ["media", "medium"],
  media: ["media", "medium"],
  transcribe: ["media", "medium"],
  analytics: ["media", "medium"],
  insight_report: ["media", "low"],
  download: ["media", "medium"],
  snapshot: ["monitoring", "medium"],
  timeline: ["monitoring", "medium"],
  baseline: ["monitoring", "high"],
  security_scan: ["security", "low"],
  sandbox: ["security", "critical"],
  anonymize: ["security", "low"],
  predict: ["meta", "medium"],
  debug_tool: ["meta", "low"],
  fresheyes: ["meta", "medium"],
  knowledge: ["knowledge", "low"],
  ops: ["operations", "critical"],
  black_box: ["black-box", "medium"],
};

(async () => {
  for (const [name, [family, risk]] of Object.entries(EXPECTED)) {
    const d = registry.get(name);
    assert.ok(d, `${name} should resolve from the registry`);
    assert.strictEqual(d.source, "builtin", `${name} source`);
    assert.strictEqual(d.family, family, `${name} family`);
    assert.strictEqual(d.risk, risk, `${name} risk must match its pre-move classification`);
    assert.strictEqual(typeof d.handler, "function", `${name} handler`);
    assert.ok(!Object.prototype.hasOwnProperty.call(legacy.TOOLS, name), `${name} should have no legacy TOOLS entry`);
  }

  // Cheap validation-error paths: executes each moved body with no side effects.
  const invalidAction = async name => (await registry.get(name).handler({ action: "zzz-invalid" })).content[0].text;
  assert.match(await invalidAction("git"), /Invalid action/);
  assert.match(await invalidAction("depend"), /Unknown action/);
  assert.match(await invalidAction("snapshot"), /Unknown action/);
  assert.match(await invalidAction("baseline"), /Unknown action/);
  assert.match(await invalidAction("sandbox"), /Unknown action/);
  assert.match(await invalidAction("anonymize"), /Unknown action/);
  assert.match(await invalidAction("predict"), /Invalid action/);
  assert.match(await invalidAction("debug_tool"), /Unknown action/);
  assert.match(await invalidAction("ops"), /Unknown action|Invalid action/);
  assert.match(await invalidAction("knowledge"), /Unknown action|Invalid action/);
  assert.match(await invalidAction("black_box"), /Unknown action|Invalid action|unknown/i);
  assert.match((await registry.get("media").handler({ action: "zzz-invalid" })).content[0].text, /input is required|Invalid action|Unknown action/);
  assert.match((await registry.get("download").handler({})).content[0].text, /url required|Error/i);

  // bash's dangerous-pattern pre-filter runs before any execution.
  const blocked = await registry.get("bash").handler({ command: "rm -rf /" });
  assert.match(blocked.content[0].text, /Blocked/);
  assert.strictEqual(blocked.isError, true);

  // The compatibility surface still carries the migrated helpers.
  assert.strictEqual(typeof tools.isDangerous, "function");
  assert.strictEqual(tools.isDangerous("mkfs.ext4 /dev/sda"), true);
  assert.strictEqual(typeof tools.checkNetwork, "function");

  // Moved code must not lose free-variable bindings to child_process: every
  // identifier a family calls must appear in its require destructure.
  // (Catches the class of bug where a byte-identical helper moved into a file
  // whose child_process destructure is narrower than the legacy one.)
  const familiesDir = path.join(__dirname, "..", "src", "tools", "families");
  for (const file of fs.readdirSync(familiesDir).filter(f => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(familiesDir, file), "utf8");
    const req = src.match(/const \{([^}]*)\} = require\("child_process"\)/);
    const bound = req ? req[1].split(",").map(s => s.trim()) : [];
    for (const id of ["execFile", "execFileSync", "execSync", "spawn"]) {
      const used = new RegExp(`(?<![.\\w])${id}\\(`).test(src);
      const isLocal = new RegExp(`(function ${id}\\b|const ${id}\\s*=)`).test(src);
      if (used && !isLocal) {
        assert.ok(bound.includes(id), `${file} calls ${id}() but does not destructure it from child_process`);
      }
    }
  }

  // security_scan's no-argument default must scan the repository root, not a
  // subdirectory (the __dirname re-basing regression class).
  const scanOut = await registry.get("security_scan").handler({ format: "json", max_files: 1 });
  const scanReport = JSON.parse(scanOut.content[0].text);
  const repoRoot = path.resolve(__dirname, "..");
  assert.strictEqual(path.resolve(scanReport.root), repoRoot, "security_scan default root must be the repo root");

  console.log("B-5 extraction family tests passed");
})().catch(e => { console.error(e); process.exit(1); });
