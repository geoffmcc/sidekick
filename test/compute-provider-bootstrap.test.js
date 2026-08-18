"use strict";

// Provider bootstrap + credential-resolution tests (Model & Provider
// Convergence, keystone slice). Verifies that Compute's provider/model registry
// is populated from the environment so InferenceService has providers to route
// to, that the seeding is idempotent and secure by default (cloud = public/
// internal only, private fails closed on local/trusted), and that credentials
// are stored as encrypted secret references — never plaintext in the provider
// record — and resolved through the secret authority. No network or model
// required.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const TEST_DATA_DIR = path.join(__dirname, "test-data-provider-bootstrap");
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_API_KEY = "sk-sidekick-test-key";

// Start from a clean env so host configuration cannot influence the scenarios.
for (const k of [
  "GROQ_API_KEY", "GROQ_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE",
  "OPENAI_MODEL", "OPENAI_EMBEDDING_MODEL", "OLLAMA_MODEL", "SIDEKICK_AGENT_MODEL",
  "SIDEKICK_EMBEDDING_MODEL", "SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP",
  "SIDEKICK_DISABLE_OLLAMA_BOOTSTRAP", "SIDEKICK_SECRET_KEY",
]) delete process.env[k];

delete require.cache[require.resolve("../src/db")];
const dbStore = require("../src/db");
const providerRegistry = require("../src/compute/provider-registry");
const modelRegistry = require("../src/compute/model-registry");
const placement = require("../src/compute/placement");
const { bootstrapProviders } = require("../src/compute/provider-bootstrap");
const { resolveProviderApiKey } = require("../src/compute/provider-credentials");

console.log("Running Compute provider bootstrap tests...\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

function resetRegistry() {
  providerRegistry.ensureSchema();
  modelRegistry.ensureSchema();
  const db = dbStore.getDb();
  db.exec("DELETE FROM compute_models; DELETE FROM compute_providers;");
  fs.rmSync(path.join(TEST_DATA_DIR, "secrets.enc"), { force: true });
}

function managed(bootstrapKey) {
  return providerRegistry.listProviders().find(
    p => p.metadata && p.metadata.bootstrapKey === bootstrapKey
  ) || null;
}

function eligibleFor(classification, capability = "chat") {
  const validated = placement.validatePlacementRequest({
    version: 1,
    capability,
    data_classification: classification,
    trust_level_required: "trusted",
    requirements: {},
    preferences: { allow_fallback: true },
  });
  return placement.rankProviderCandidates(validated).eligible;
}

// ---- Ollama (local, always seeded) -----------------------------------------

test("seeds a trusted local Ollama provider with chat+embedding models", () => {
  resetRegistry();
  bootstrapProviders();
  const ollama = managed("ollama");
  assert.ok(ollama, "ollama provider seeded");
  assert.strictEqual(ollama.providerType, "ollama");
  assert.strictEqual(ollama.trustLevel, "trusted");
  assert.deepStrictEqual(ollama.dataClassifications.sort(), ["internal", "private", "public"]);
  assert.strictEqual(ollama.hasAuth, false, "local ollama needs no credential");
  const models = modelRegistry.listModels({ providerId: ollama.providerId, enabled: true });
  assert.ok(models.some(m => m.capabilities.includes("chat")), "has a chat model");
  assert.ok(models.some(m => m.supportsEmbedding), "has an embedding model");
});

test("bootstrap is idempotent (no duplicate managed rows)", () => {
  resetRegistry();
  bootstrapProviders();
  bootstrapProviders();
  bootstrapProviders();
  const ollamas = providerRegistry.listProviders().filter(p => p.metadata && p.metadata.bootstrapKey === "ollama");
  assert.strictEqual(ollamas.length, 1, "exactly one managed ollama row");
});

test("respects operator edits to a managed row across re-bootstrap", () => {
  resetRegistry();
  bootstrapProviders();
  const ollama = managed("ollama");
  providerRegistry.updateProvider(ollama.providerId, { enabled: false, priority: 5 });
  bootstrapProviders();
  const after = providerRegistry.getProvider(ollama.providerId);
  assert.strictEqual(after.enabled, false, "operator disable preserved");
  assert.strictEqual(after.priority, 5, "operator priority preserved");
});

test("SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP=1 seeds nothing", () => {
  resetRegistry();
  process.env.SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP = "1";
  const { seeded } = bootstrapProviders();
  assert.strictEqual(seeded.length, 0);
  assert.strictEqual(providerRegistry.listProviders().length, 0);
  delete process.env.SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP;
});

// ---- Cloud (secure by default) with secret store ---------------------------

test("cloud provider is seeded public/internal only, lower priority than local", () => {
  resetRegistry();
  process.env.SIDEKICK_SECRET_KEY = "test-master-key";
  process.env.GROQ_API_KEY = "gsk_test_secret_value";
  try {
    bootstrapProviders();
    const groq = managed("groq");
    assert.ok(groq, "groq provider seeded");
    assert.strictEqual(groq.providerType, "openai-compatible");
    assert.deepStrictEqual(groq.dataClassifications.sort(), ["internal", "public"], "cloud excludes private/sensitive/restricted");
    assert.ok(groq.priority < managed("ollama").priority, "cloud ranks below local");
  } finally {
    delete process.env.GROQ_API_KEY;
    delete process.env.SIDEKICK_SECRET_KEY;
  }
});

test("cloud credential is stored as a secret reference, never plaintext in the record", () => {
  resetRegistry();
  process.env.SIDEKICK_SECRET_KEY = "test-master-key";
  process.env.GROQ_API_KEY = "gsk_test_secret_value";
  try {
    bootstrapProviders();
    const groq = managed("groq");
    assert.strictEqual(groq.hasAuth, true, "provider reports a credential is configured");
    // The provider record exposes neither the reference nor the value.
    const serialized = JSON.stringify(groq);
    assert.ok(!serialized.includes("gsk_test_secret_value"), "plaintext key absent from provider record");
    assert.ok(!serialized.includes("compute_provider_groq_api_key"), "secret reference absent from provider record");
    // The reference is retrievable only through the dedicated accessor.
    const ref = providerRegistry.getAuthSecretRef(groq.providerId);
    assert.strictEqual(ref, "compute_provider_groq_api_key");
    // And it resolves back to the original value through the secret authority.
    assert.strictEqual(resolveProviderApiKey(groq), "gsk_test_secret_value");
  } finally {
    delete process.env.GROQ_API_KEY;
    delete process.env.SIDEKICK_SECRET_KEY;
  }
});

test("private inference fails closed on cloud; local serves it", () => {
  resetRegistry();
  process.env.SIDEKICK_SECRET_KEY = "test-master-key";
  process.env.GROQ_API_KEY = "gsk_test_secret_value";
  try {
    bootstrapProviders();
    const groqId = managed("groq").providerId;
    const ollamaId = managed("ollama").providerId;

    const privateEligible = eligibleFor("private").map(c => c.provider.providerId);
    assert.ok(privateEligible.includes(ollamaId), "local eligible for private");
    assert.ok(!privateEligible.includes(groqId), "cloud NOT eligible for private (fail closed)");

    const publicEligible = eligibleFor("public").map(c => c.provider.providerId);
    assert.ok(publicEligible.includes(ollamaId) && publicEligible.includes(groqId), "both eligible for public");
    assert.strictEqual(publicEligible[0], ollamaId, "local preferred over cloud for public");
  } finally {
    delete process.env.GROQ_API_KEY;
    delete process.env.SIDEKICK_SECRET_KEY;
  }
});

// ---- Cloud without a master key (fail closed) -------------------------------

test("without a master key, cloud provider bootstrap fails closed", () => {
  resetRegistry();
  // No SIDEKICK_SECRET_KEY: the secret store cannot be used.
  process.env.OPENAI_API_KEY = "sk-openai-test-value";
  try {
    bootstrapProviders();
    const openai = managed("openai");
    assert.strictEqual(openai, null, "cloud provider is not seeded without encrypted secret authority");
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
