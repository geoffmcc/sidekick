"use strict";

/**
 * Provider credential resolution — the single place that turns a provider's
 * stored credential *reference* into a usable API key.
 *
 * A compute provider's `auth_secret_key` column is a reference: the NAME of a
 * secret held by Sidekick's existing secret authority (src/core/secrets-store +
 * src/core/secret-cipher — the same encrypted `secrets.enc` the `secret` tool
 * manages), never a plaintext credential. Resolution happens as late as
 * possible (at adapter dispatch) so a decrypted key spends no longer in memory
 * than necessary and never reaches a provider API response, a log line, or the
 * dashboard (the registry only ever exposes `hasAuth`, never the reference or
 * the value).
 *
 * Backwards compatibility: a provider bootstrapped before a master
 * SIDEKICK_SECRET_KEY was configured cannot use the encrypted store, so the
 * env-var name it was created from is recorded in provider metadata
 * (`envCredentialVar`) and read here as a fallback. Environment variables thus
 * remain a compatibility source, not the architectural source of truth.
 */

const providerRegistry = require("./provider-registry");

/**
 * Resolve the API key for a provider, or null when none is configured/resolvable.
 * Never throws and never logs secret material.
 */
function resolveProviderApiKey(provider) {
  if (!provider || !provider.providerId) return null;

  // 1) Preferred: a secret reference into the encrypted secret store. The raw
  // reference is read straight from the column (never surfaced on the provider
  // object) so redaction of the provider record is preserved.
  let ref = null;
  try { ref = providerRegistry.getAuthSecretRef(provider.providerId); } catch { ref = null; }
  if (ref) {
    try {
      const { loadSecrets } = require("../core/secrets-store");
      const { decryptSecret } = require("../core/secret-cipher");
      const secret = loadSecrets()[ref];
      if (secret) {
        const value = decryptSecret(secret);
        if (value) return value;
      }
    } catch {
      // Unreadable/absent secret: fall through to env compatibility rather than
      // surfacing secret-store internals or failing the inference call here.
    }
  }

  // 2) Backwards-compatible env fallback recorded at bootstrap time when no
  // master key was available to migrate the credential into the secret store.
  const envVar = provider.metadata && provider.metadata.envCredentialVar;
  if (envVar && process.env[envVar]) return process.env[envVar];

  return null;
}

module.exports = { resolveProviderApiKey };
