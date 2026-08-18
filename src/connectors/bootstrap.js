"use strict";

// Connector bootstrap — register the real integrations Sidekick already holds
// credentials for as managed connectors in the platform connector authority, so
// the registry governs a live integration instead of sitting empty scaffolding.
// GitHub first. Idempotent and best-effort; mirrors
// src/compute/provider-bootstrap.js.
//
// Design rules:
//  - Idempotent: a managed row is tagged (metadata.managed === "connector-
//    bootstrap") and matched by type, so re-running never duplicates it and
//    operator edits survive.
//  - Credentials are secret references, never values: the GitHub connector's
//    secret_ref is `secret:github_token` (the existing encrypted secret-store
//    key); the token is resolved only at call time by connectors/resolve.js.
//  - Best-effort: a failure never prevents startup, and the github tool retains
//    its env/secret fallback until it is fully routed through the connector.

let kernel = null;
try { kernel = require("../platform/kernel"); } catch { kernel = null; }
const { loadSecrets } = require("../core/secrets-store");
const { hasSecret } = require("../core/runtime-secrets");

function hasGithubCredential() {
  try {
    if (hasSecret("GITHUB_TOKEN") || hasSecret("SIDEKICK_GITHUB_TOKEN")) return true;
  } catch { return false; }
  try { return Boolean(loadSecrets()["github_token"]); } catch { return false; }
}

function findGithubConnector() {
  try {
    const list = kernel.listConnectors({ type: "github", limit: 100 }) || [];
    return list.find(c => c.metadata && c.metadata.managed === "connector-bootstrap") || list[0] || null;
  } catch {
    return null;
  }
}

function bootstrapConnectors() {
  if (process.env.SIDEKICK_DISABLE_CONNECTOR_BOOTSTRAP === "1") return { seeded: [] };
  if (!kernel || typeof kernel.registerConnector !== "function") return { seeded: [] };
  const seeded = [];
  try {
    if (hasGithubCredential() && !findGithubConnector()) {
      const connector = kernel.registerConnector({
        name: "GitHub",
        type: "github",
        endpoint: "https://api.github.com",
        secret_ref: "secret:github_token",
        capabilities: ["repo", "pull_request", "issue", "ci_status"],
        source: "bootstrap",
        metadata: { managed: "connector-bootstrap" },
      });
      // Move registered -> enabled so it is a live authority the github tool can
      // route through. Active health checks / the healthy state are a fast-follow.
      try { kernel.transitionConnector(connector.connector_id, "enabled", { source: "bootstrap" }); } catch {}
      seeded.push(connector.connector_id);
    }
  } catch {
    // Best-effort: never block startup on connector bootstrap.
  }
  return { seeded };
}

module.exports = { bootstrapConnectors };
