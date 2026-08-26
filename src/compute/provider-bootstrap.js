"use strict";

/**
 * Provider bootstrap — populate the Compute provider/model registry from the
 * environment configuration Sidekick already supports, so the existing
 * InferenceService authority actually has providers to route to.
 *
 * Before this, the only createProvider caller was the `compute` operator tool,
 * so in a normal deployment the registry was empty: every InferenceService call
 * raised RoutingError and every caller silently fell back to a direct env-based
 * Ollama/Groq HTTP call. Registering that same env config as managed provider
 * rows is what actually moves production inference traffic onto Compute
 * placement (trust, data classification, health, fallback, observability).
 *
 * Design rules:
 *  - Idempotent: managed rows are tagged (metadata.managed === "env-bootstrap")
 *    and matched by a stable bootstrapKey. An existing managed row is left
 *    untouched, so operator edits (trust promotion, disable, priority, endpoint)
 *    survive restarts. Deleting a managed row is respected until the next
 *    process start.
 *  - Secure by default: local Ollama (loopback) is trusted for
 *    public/internal/private; cloud providers (Groq, OpenAI) are seeded for
 *    public/internal ONLY and at lower priority, so private inference stays on
 *    local/trusted providers and fails closed rather than silently egressing to
 *    a cloud API. Promoting a cloud provider to private is an explicit operator
 *    step (`compute` action=update), exactly as for a manually-created provider.
 *  - Credentials are stored as secret references, never plaintext: a cloud
 *    provider's API key is migrated into the encrypted secret store and the
 *    provider row keeps only the reference. With no master SIDEKICK_SECRET_KEY
 *    configured, the env-var name is recorded in metadata as a compatibility
 *    fallback instead (resolved by provider-credentials.js).
 */

const providerRegistry = require("./provider-registry");
const modelRegistry = require("./model-registry");
const { readSecret } = require("../core/runtime-secrets");
const { hasSecretKey, encryptSecret } = require("../core/secret-cipher");
const { loadSecrets, saveSecrets } = require("../core/secrets-store");

const LOCAL_CLASSIFICATIONS = Object.freeze(["public", "internal", "private"]);
const CLOUD_CLASSIFICATIONS = Object.freeze(["public", "internal"]);

function configuredModel(value) {
  const model = String(value || "").trim();
  return model && model !== "." && model.toLowerCase() !== "inherit" ? model : null;
}

function findManaged(bootstrapKey) {
  return providerRegistry.listProviders().find(
    p => p.metadata && p.metadata.managed === "env-bootstrap" && p.metadata.bootstrapKey === bootstrapKey
  ) || null;
}

/**
 * Store an API key in the encrypted secret store under a stable name and return
 * that name as the reference. Returns null when no master key is configured (so
 * the caller records an env-var fallback instead) or on any store failure. An
 * existing secret of the same name is never overwritten — an operator may have
 * rotated it independently.
 */
function ensureSecretRef(secretName, value) {
  if (!hasSecretKey() || !value) return null;
  try {
    const secrets = loadSecrets();
    if (!secrets[secretName]) {
      const now = new Date().toISOString();
      secrets[secretName] = { ...encryptSecret(value), created: now, updated: now };
      saveSecrets(secrets);
    }
    return secretName;
  } catch {
    return null;
  }
}

function seedOllama() {
  if (findManaged("ollama")) return null;
  const endpoint = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const provider = providerRegistry.createProvider({
    providerType: "ollama",
    displayName: "Ollama (local)",
    endpoint,
    enabled: true,
    trustLevel: "trusted",
    tlsPolicy: "prefer",
    capabilities: ["chat", "generate", "embeddings", "model_listing"],
    priority: 80,
    costPolicy: "free",
    dataClassifications: [...LOCAL_CLASSIFICATIONS],
    mode: "direct",
    metadata: { managed: "env-bootstrap", bootstrapKey: "ollama", source: "OLLAMA_URL" },
  });
  const chatModel = configuredModel(process.env.OLLAMA_MODEL) || configuredModel(process.env.SIDEKICK_AGENT_MODEL) || "qwen3.5:latest";
  modelRegistry.createModel({
    providerId: provider.providerId,
    providerModelName: chatModel,
    displayName: chatModel,
    capabilities: ["chat", "generate"],
    supportsTools: true,
    metadata: { managed: "env-bootstrap" },
  });
  const embedModel = configuredModel(process.env.SIDEKICK_EMBEDDING_MODEL) || "nomic-embed-text";
  if (embedModel !== chatModel) {
    modelRegistry.createModel({
      providerId: provider.providerId,
      providerModelName: embedModel,
      displayName: embedModel,
      capabilities: ["embeddings"],
      supportsEmbedding: true,
      metadata: { managed: "env-bootstrap" },
    });
  }
  return provider;
}

function seedOpenAiCompatible(opts) {
  const {
    bootstrapKey, displayName, endpoint, apiKey, secretName,
    chatModel, embedModel, supportsEmbedding,
  } = opts;
  if (findManaged(bootstrapKey)) return null;

  const ref = ensureSecretRef(secretName, apiKey);
  // A cloud credential must be persisted in the encrypted secret authority;
  // never create a provider that would need a plaintext fallback at dispatch.
  if (!ref) return null;
  const metadata = { managed: "file-bootstrap", bootstrapKey, source: "protected-file" };

  const provider = providerRegistry.createProvider({
    providerType: "openai-compatible",
    displayName,
    endpoint,
    enabled: true,
    trustLevel: "trusted",
    authSecretKey: ref || null,
    tlsPolicy: "prefer",
    capabilities: supportsEmbedding ? ["chat", "embeddings", "model_listing"] : ["chat", "model_listing"],
    priority: 40,
    costPolicy: "metered",
    // Secure by default: cloud never receives private/sensitive/restricted data
    // until an operator explicitly promotes it.
    dataClassifications: [...CLOUD_CLASSIFICATIONS],
    mode: "direct",
    metadata,
  });
  modelRegistry.createModel({
    providerId: provider.providerId,
    providerModelName: chatModel,
    displayName: chatModel,
    capabilities: ["chat", "generate"],
    supportsTools: true,
    metadata: { managed: "env-bootstrap" },
  });
  if (supportsEmbedding && embedModel) {
    modelRegistry.createModel({
      providerId: provider.providerId,
      providerModelName: embedModel,
      displayName: embedModel,
      capabilities: ["embeddings"],
      supportsEmbedding: true,
      metadata: { managed: "env-bootstrap" },
    });
  }
  return provider;
}

/**
 * Register managed providers from the environment. Best-effort and idempotent:
 * a failure never prevents compute.initialize from completing, and callers
 * retain their existing direct fallback paths until they are converged.
 * Returns { seeded: [providerId, ...] } for the rows created this call.
 */
function bootstrapProviders() {
  if (process.env.SIDEKICK_DISABLE_PROVIDER_BOOTSTRAP === "1") return { seeded: [] };
  const seeded = [];
  try {
    providerRegistry.ensureSchema();
    modelRegistry.ensureSchema();

    // Local Ollama is Sidekick's historical default inference endpoint; seed it
    // unless explicitly disabled.
    if (process.env.SIDEKICK_DISABLE_OLLAMA_BOOTSTRAP !== "1") {
      const p = seedOllama();
      if (p) seeded.push(p.providerId);
    }

    const groqApiKey = readSecret("GROQ_API_KEY");
    if (groqApiKey) {
      const p = seedOpenAiCompatible({
        bootstrapKey: "groq",
        displayName: "Groq (cloud)",
        endpoint: "https://api.groq.com/openai/v1",
        apiKey: groqApiKey,
        secretName: "compute_provider_groq_api_key",
        chatModel: configuredModel(process.env.GROQ_MODEL) || "llama-3.1-8b-instant",
        supportsEmbedding: false,
      });
      if (p) seeded.push(p.providerId);
    }

    const openaiApiKey = readSecret("OPENAI_API_KEY");
    if (openaiApiKey) {
      const p = seedOpenAiCompatible({
        bootstrapKey: "openai",
        displayName: "OpenAI (cloud)",
        endpoint: process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || "https://api.openai.com/v1",
        apiKey: openaiApiKey,
        secretName: "compute_provider_openai_api_key",
        chatModel: configuredModel(process.env.OPENAI_MODEL) || "gpt-4o-mini",
        embedModel: configuredModel(process.env.OPENAI_EMBEDDING_MODEL) || "text-embedding-3-small",
        supportsEmbedding: true,
      });
      if (p) seeded.push(p.providerId);
    }
  } catch {
    // Best-effort: never block initialize on bootstrap.
  }
  return { seeded };
}

module.exports = { bootstrapProviders };
