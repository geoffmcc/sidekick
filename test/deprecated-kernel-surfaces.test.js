"use strict";

// Guards for deprecated/experimental kernel surfaces (mirrors
// test/compute-model-dedup.test.js). Deprecating in place instead of deleting
// keeps schemas and existing tests buildable; the risk is that someone starts
// calling the surface anyway, so the absence of production callers is asserted
// rather than assumed.
//
//  - src/platform/identity-deployment.js is experimental future work, NOT a
//    supported capability: in-memory Maps, no durable tables, no auth
//    integration. No production module may import it.
//  - The kernel's platform_extensions CRUD is a second module-ish lifecycle;
//    platform_modules (src/modules/) is the module authority. No production
//    code may call the extension functions.

const assert = require("assert");
const path = require("path");
const { execSync } = require("child_process");

const SRC = path.join(__dirname, "..", "src");

console.log("Running deprecated kernel surface guards...\n");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

test("identity-deployment has no production importer", () => {
  const raw = execSync(
    `grep -rnE "require\\(.*identity-deployment" ${SRC} || true`,
    { encoding: "utf8", shell: "/bin/bash" }
  );
  const importers = raw.split("\n").filter(Boolean);
  assert.deepStrictEqual(importers, [],
    `identity-deployment is experimental future work and must stay import-free in src/. Found:\n${importers.join("\n")}`);
});

test("identity-deployment declares itself experimental, do-not-call", () => {
  const source = require("fs").readFileSync(path.join(SRC, "platform", "identity-deployment.js"), "utf8");
  assert.ok(/EXPERIMENTAL FUTURE WORK/.test(source), "header marks the module experimental");
  assert.ok(/DO NOT ADD PRODUCTION\s*\n?\/\/ CALLERS|DO NOT ADD PRODUCTION CALLERS/s.test(source.replace(/\n\/\//g, " ").replace(/\s+/g, " ")), "header forbids production callers");
});

test("the deprecated platform_extensions registry has no production callers", () => {
  const raw = execSync(
    `grep -rnE '\\b(registerExtension|getExtensionByName|activateExtension|deactivateExtension|uninstallExtension|updateExtensionConfig|recordExtensionUsage|listExtensions)\\(' ${SRC} || true`,
    { encoding: "utf8", shell: "/bin/bash" }
  );
  const callers = raw.split("\n")
    .filter(Boolean)
    // The kernel's own definitions and export list are the deprecated surface
    // itself, not callers of it.
    .filter(line => !line.includes(`src${path.sep}platform${path.sep}kernel.js`) && !line.includes("src/platform/kernel.js"));
  assert.deepStrictEqual(callers, [],
    `platform_extensions must stay caller-free; platform_modules is the module authority. Found:\n${callers.join("\n")}`);
});

test("the extension CRUD block carries the deprecation contract", () => {
  const kernelSource = require("fs").readFileSync(path.join(SRC, "platform", "kernel.js"), "utf8");
  const marker = kernelSource.indexOf("DEPRECATED — `platform_extensions` is a second module-ish lifecycle");
  assert.ok(marker !== -1, "kernel.js carries the platform_extensions deprecation comment");
  assert.ok(kernelSource.indexOf("function registerExtension") > marker, "the comment sits at the CRUD block");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
