"use strict";

/**
 * Discovery / health for the pack. Distinguishes clearly between: pack
 * installed, workspace configured, dependency available, and policy enabled.
 * Never exposes secrets, endpoints, or workspace contents — only status.
 */

const { requireSidekickSrc } = require("./deps");
const workspace = require("./workspace");
const { ResearchError } = require("./errors");

const COMPOSED_TOOLS = ["bash", "web_fetch", "git", "hash", "proxmox", "proxmox_guest", "proxmox_provision", "ansible_run"];

function toolAvailable(name) {
  try {
    const loader = requireSidekickSrc("src/modules/loader.js");
    const active = loader.getActiveDescriptors ? loader.getActiveDescriptors() : [];
    if (active.some((d) => d.name === name || (Array.isArray(d.aliases) && d.aliases.includes(name)))) return true;
  } catch {}
  try {
    const dispatcher = requireSidekickSrc("src/tools/dispatcher.js");
    const registry = dispatcher.getBuiltinRegistry();
    if (registry && registry.has(name)) return true;
  } catch {}
  return false;
}

function workspaceStatus(config) {
  try {
    const resolved = workspace.resolveWorkspace(config, { requireExists: false });
    return { state: "configured", root: resolved.root, source: resolved.source };
  } catch (error) {
    if (error instanceof ResearchError && error.code === "workspace_missing") {
      return { state: "missing", reason: error.message };
    }
    if (error instanceof ResearchError && error.code === "workspace_unsafe") {
      return { state: "unsafe", reason: error.message };
    }
    return { state: "error", reason: error.message };
  }
}

function status(config) {
  const cfg = config || {};
  const ws = workspaceStatus(cfg);
  const capabilities = {};
  for (const tool of COMPOSED_TOOLS) capabilities[tool] = toolAvailable(tool);

  const httpCfg = cfg.http || {};
  const ready = ws.state === "configured";

  return {
    pack: "security-research",
    ready,
    workspace: ws,
    capabilities,
    policy: {
      local_probes_enabled: cfg.allow_local_probes === true,
      http_private_addresses: httpCfg.allow_private_addresses === true,
      http_allowed_hosts: Array.isArray(httpCfg.allowed_hosts) ? httpCfg.allowed_hosts.length : 0,
      probe_timeout_ms: cfg.probe_timeout_ms || 60000,
      max_evidence_bytes: cfg.max_evidence_bytes || 5242880,
    },
    environments: Object.keys(cfg.environments || {}),
    notes: ready ? [] : ["Configure a research workspace outside the Sidekick repository to enable runs and evidence capture."],
  };
}

module.exports = { status, toolAvailable, COMPOSED_TOOLS };
