"use strict";

// Inference-caller convergence guard (Model & Provider Convergence, fast-follow).
//
// Production inference callers must route through Compute
// (src/compute/inference-service) — the single inference authority that owns
// provider/model selection, credentials, trust/data-classification gating,
// health, and fallback. They must not reach a provider inference endpoint
// directly. The provider adapters (src/providers/*), the Compute internals
// (src/compute/*), and the `ollama` model-management admin surface
// (list/ps/pull/show) are the ONLY sanctioned direct-Ollama touchpoints; this
// guard covers the callers, so a regression that reintroduces a direct
// Ollama/Groq inference path fails here.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

console.log("Running inference-caller convergence guard...\n");

// Inference egress endpoints that must never appear in a converged caller.
const INFERENCE_ENDPOINTS = [/api\.groq\.com/, /\/api\/chat/, /\/api\/generate/, /\/api\/embeddings/, /:11434/];

function assertNoDirect(rel, patterns = INFERENCE_ENDPOINTS) {
  const src = read(rel);
  for (const p of patterns) {
    assert.ok(!p.test(src), `${rel} must not contain a direct inference endpoint (${p})`);
  }
}

test("agent.js (Agent Bridge / Brain / tool loop) routes inference only through Compute", () => assertNoDirect("src/agent.js"));
test("agent-loop.js has no direct provider endpoint", () => assertNoDirect("src/agent-loop.js"));
test("memory.js embeddings route through Compute", () => assertNoDirect("src/memory.js"));
test("context.js embeddings route through Compute", () => assertNoDirect("src/tools/families/context.js"));

test("inference tool family has no direct chat/generate/embeddings egress (ollama admin allowed)", () => {
  // The `ollama` handler legitimately manages models (list/ps/pull/show); only
  // inference egress is forbidden here, not model administration.
  assertNoDirect("src/tools/families/inference.js", [/api\.groq\.com/, /\/api\/chat/, /\/api\/generate/, /\/api\/embeddings/]);
});

test("dashboard /api/llm no longer probes a hardcoded Ollama endpoint", () => assertNoDirect("src/dashboard.js", [/:11434/, /\/api\/tags/]));

test("agent.js no longer imports GROQ_* provider env", () => {
  const src = read("src/agent.js");
  assert.ok(!/GROQ_API_KEY/.test(src) && !/GROQ_MODEL/.test(src), "agent.js should not reference GROQ_* env");
});

test("agent.js requires the Compute inference-service", () => {
  assert.ok(/require\("\.\/compute\/inference-service"\)/.test(read("src/agent.js")), "agent.js requires compute inference-service");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
