"use strict";

// Security regression suite for the Handlebars dependency advisories and the
// `sidekick_template` trust boundary. Reported by M8ven and patched in
// Handlebars 4.7.10:
//   GHSA-8r5x-fm3f-whwj (critical) - JS injection via AST type confusion in
//     compile()/precompile() when an object (pre-parsed AST) is accepted.
//   GHSA-p8wg-vrv2-v86f (critical) - Function constructor reachable through the
//     proto-access own-property check when allowProtoMethodsByDefault is true.
//   GHSA-xw65-4hp5-5hc7 (moderate) - unsafe inline embedding of precompiled
//     templates containing `</script>`.
//
// These tests assert observable behaviour (injected code does not execute,
// object templates are rejected, proto access stays off) rather than only a
// version string. Payloads are harmless: they set/observe throwaway globals
// instead of running any real command or touching secrets.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-hb-security-"));
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
// The suite runner sets NODE_ENV=test, which enables the test-only env secret
// branch documented in src/core/runtime-secrets.js.
process.env.SIDEKICK_SECRET_KEY = "handlebars-security-test-key";
delete process.env.SIDEKICK_BLOCKED_TOOLS;

delete require.cache[require.resolve("../src/tools")];
const tools = require("../src/tools");
const family = require("../src/tools/families/data-utilities");
const Handlebars = require("handlebars");
const { provisionBuiltinModules } = require("../src/modules/builtin-modules");

const provision = provisionBuiltinModules();
assert.deepEqual(provision.errors, [], "builtin module provisioning should succeed");

const text = result => result.content[0].text;
const ownerContext = require("./helpers/authorized-context").createOwnerContext({ source: "mcp" });
const context = requestId => ({ ...ownerContext, requestId });

// Malicious AST from the GHSA-8r5x-fm3f-whwj proof of concept. The injected
// expression is harmless: it only sets a throwaway global.
function maliciousAst(expression) {
  return {
    type: "Program",
    loc: { start: { line: 1, column: 0 } },
    body: [
      {
        type: "BlockStatement",
        path: {
          type: "PathExpression",
          data: false,
          depth: 0,
          parts: ["missingHelper"],
          original: "missingHelper",
          loc: { start: { line: 1, column: 0 } },
        },
        params: [],
        program: {
          type: "Program",
          blockParams: { length: expression },
          body: [],
          loc: { start: { line: 1, column: 0 } },
        },
        openStrip: { open: false, close: false },
        inverseStrip: { open: false, close: false },
        closeStrip: { open: false, close: false },
        loc: { start: { line: 1, column: 0 } },
      },
    ],
  };
}

test.after(() => {
  delete globalThis.__hbAstPwned;
  delete globalThis.__hbProtoPwned;
  require("../src/db").closeDatabase();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// --- The installed dependency itself must be patched -------------------------

test("resolved handlebars is at or above the patched 4.7.10 release", () => {
  const version = require("handlebars/package.json").version;
  const [major, minor, patch] = version.split(".").map(Number);
  const patched = major > 4 || (major === 4 && (minor > 7 || (minor === 7 && patch >= 10)));
  assert.ok(patched, `handlebars ${version} predates the advisory fix in 4.7.10`);
});

test("compile() rejects an AST carrying injected code (GHSA-8r5x-fm3f-whwj)", () => {
  delete globalThis.__hbAstPwned;
  let rejected = false;
  try {
    const render = Handlebars.compile(maliciousAst("(()=>{globalThis.__hbAstPwned = true})()"));
    render({});
  } catch {
    rejected = true;
  }
  assert.equal(globalThis.__hbAstPwned, undefined, "injected AST code must never execute");
  assert.ok(rejected, "a malformed/injected AST must be rejected, not rendered");
});

test("proto access cannot reach Function even when explicitly enabled (GHSA-p8wg-vrv2-v86f)", () => {
  delete globalThis.__hbProtoPwned;
  const template = Handlebars.compile(
    "{{#with a}}" +
      '{{lookup "" (push "globalThis.__hbProtoPwned = true")}}' +
      '{{lookup "" (pop)}}' +
      '{{lookup "" (shift)}}' +
      "{{/with}}" +
      '{{lookup "" (@root.a.push (lookup (lookup fn "__proto__") "constructor"))}}' +
      "{{#each @root}}{{#if @index}}{{else}}" +
      "{{#with (this.apply null @root.a)}}{{this}}{{/with}}" +
      "{{/if}}{{/each}}"
  );
  try {
    template({ fn() {}, a: [0] }, { allowProtoMethodsByDefault: true });
  } catch {
    // A rejection here is acceptable; the security property is the flag below.
  }
  assert.equal(globalThis.__hbProtoPwned, undefined, "proto-access bypass must not execute code");
});

test("precompile() does not emit a raw </script> sequence (GHSA-xw65-4hp5-5hc7)", () => {
  const output = String(Handlebars.precompile('safe</script><script>alert(1)</script><script>'));
  assert.ok(!output.includes("</script>"), "inline-embedded precompiled output must be HTML-safe");
});

// --- sidekick_template rejects dangerous template input types -----------------

test("sidekick_template rejects non-string template types before compile()", async () => {
  for (const bad of [
    { type: "Program", body: [] },
    [],
    5,
    true,
    new String("Hello {{name}}"),
  ]) {
    const result = await family.sidekick_template({ template: bad });
    assert.equal(result.isError, true, `template ${JSON.stringify(bad)} must be rejected`);
    assert.equal(text(result), "template must be a string");
  }
});

test("sidekick_template refuses an injected AST and never runs its code", async () => {
  delete globalThis.__hbAstPwned;
  const result = await family.sidekick_template({
    template: maliciousAst("(()=>{globalThis.__hbAstPwned = true})()"),
  });
  assert.equal(result.isError, true);
  assert.equal(text(result), "template must be a string");
  assert.equal(globalThis.__hbAstPwned, undefined);
});

test("dispatcher rejects an object template at the schema boundary", async () => {
  const result = await tools.dispatchTool({
    name: "sidekick_template",
    args: { template: maliciousAst("(()=>{globalThis.__hbAstPwned = true})()") },
    context: context("hb_sec_dispatch_object"),
  });
  assert.equal(result.isError, true);
  assert.equal(result.code, "validation_failed");
  assert.equal(globalThis.__hbAstPwned, undefined);
});

test("batch cannot smuggle an object template past validation", async () => {
  const result = await tools.dispatchTool({
    name: "batch",
    args: {
      calls: [
        { tool: "template", args: { template: { type: "Program", body: [] } } },
      ],
    },
    context: context("hb_sec_batch_object"),
  });
  const parsed = JSON.parse(text(result));
  assert.equal(parsed[0].error, true, "batch must surface the nested validation failure");
});

// --- Prototype access and data hygiene ---------------------------------------

test("template data cannot reach prototype properties or methods", async () => {
  assert.equal(text(await family.sidekick_template({ template: "{{__proto__}}", data: { a: 1 } })), "");
  assert.equal(text(await family.sidekick_template({ template: "{{constructor}}", data: { a: 1 } })), "");
  assert.equal(text(await family.sidekick_template({ template: '{{lookup this "constructor"}}', data: { a: 1 } })), "");
  assert.equal(text(await family.sidekick_template({ template: '{{lookup this "__proto__"}}', data: { a: 1 } })), "");
});

test("__proto__ in JSON data does not pollute Object.prototype", async () => {
  const result = await family.sidekick_template({
    template: "{{hbPolluted}}",
    data: '{"__proto__":{"hbPolluted":"yes"}}',
  });
  assert.equal(text(result), "");
  assert.equal({}.hbPolluted, undefined, "global prototype must not be polluted");
});

test("functions supplied as data are not invoked as Handlebars lambdas", async () => {
  let invoked = false;
  const result = await family.sidekick_template({
    template: "{{fn}}{{fn.a}}",
    data: { fn: () => { invoked = true; return "INVOKED"; } },
  });
  assert.equal(invoked, false, "a data function must not be called during rendering");
  assert.equal(result.isError, undefined);
  assert.equal(text(result), "");
});

test("class-instance prototype getters are not exposed to templates", async () => {
  class Record {
    constructor() { this.value = "ok"; }
    get secret() { return "LEAK"; }
  }
  const result = await family.sidekick_template({ template: "{{value}}|{{secret}}", data: new Record() });
  assert.equal(text(result), "ok|");
});

test("callers cannot override render options through the dispatcher", async () => {
  const escaped = await tools.dispatchTool({
    name: "sidekick_template",
    args: { template: "{{h}}", data: { h: "<b>" }, options: { noEscape: true, allowProtoMethodsByDefault: true } },
    context: context("hb_sec_options"),
  });
  assert.equal(escaped.isError, undefined);
  assert.equal(text(escaped), "&lt;b&gt;", "escaping must stay enabled regardless of caller options");
});

// --- Limits, errors, and preserved functionality -----------------------------

test("oversized template input is rejected", async () => {
  const result = await family.sidekick_template({ template: "x".repeat(100001) });
  assert.equal(result.isError, true);
  assert.equal(text(result), "template exceeds 100000 characters");
});

test("oversized template data is rejected", async () => {
  const result = await family.sidekick_template({
    template: "{{a}}",
    data: '"' + "y".repeat(1000001) + '"',
  });
  assert.equal(result.isError, true);
  assert.match(text(result), /data is too large/);
});

test("oversized rendered output is rejected", async () => {
  const result = await family.sidekick_template({
    template: "{{#each arr}}{{../s}}{{/each}}",
    data: { arr: new Array(1000).fill(0), s: "x".repeat(2000) },
  });
  assert.equal(result.isError, true);
  assert.match(text(result), /rendered output exceeds 1000000 characters/);
});

test("malformed templates and bad data fail predictably without leaking internals", async () => {
  const malformed = await family.sidekick_template({ template: "{{#if x}}no end", data: { x: true } });
  assert.equal(malformed.isError, true);
  assert.match(text(malformed), /^Template error:/);
  assert.ok(!/\n\s+at /.test(text(malformed)), "errors must not include a stack trace");

  const badData = await family.sidekick_template({ template: "x", data: "not-json" });
  assert.equal(badData.isError, true);
  assert.match(text(badData), /^Data parse error:/);
});

test("legitimate templates, helpers, nesting, and escaping keep working", async () => {
  assert.equal(text(await family.sidekick_template({ template: "Hello {{name}}", data: '{"name":"World"}' })), "Hello World");
  assert.equal(text(await family.sidekick_template({ template: "Hello {{name}}", data: { name: "Obj" } })), "Hello Obj");
  assert.equal(text(await family.sidekick_template({ template: "{{#if x}}yes{{else}}no{{/if}}", data: { x: false } })), "no");
  assert.equal(text(await family.sidekick_template({ template: "{{#each items}}[{{this}}]{{/each}}", data: { items: [1, 2, 3] } })), "[1][2][3]");
  assert.equal(text(await family.sidekick_template({ template: "{{#with user}}{{name}}{{/with}}", data: { user: { name: "Ann" } } })), "Ann");
  assert.equal(text(await family.sidekick_template({ template: "{{h}}", data: { h: "<b>&</b>" } })), "&lt;b&gt;&amp;&lt;/b&gt;");
  assert.equal(text(await family.sidekick_template({ template: "{{{h}}}", data: { h: "<b>&</b>" } })), "<b>&</b>");
  assert.equal(text(await family.sidekick_template({ template: "{{missing.deep}}", data: {} })), "");
});

test("the dispatcher still executes ordinary sidekick_template calls", async () => {
  const result = await tools.dispatchTool({
    name: "sidekick_template",
    args: { template: "hi {{n}}", data: '{"n":"x"}' },
    context: context("hb_sec_ok"),
  });
  assert.equal(result.isError, undefined);
  assert.equal(text(result), "hi x");
});
