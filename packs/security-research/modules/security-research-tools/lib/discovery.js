"use strict";

/**
 * Discovery / health for the pack. Distinguishes clearly between: pack
 * installed, workspace configured, dependency available, and policy enabled.
 * Never exposes secrets, endpoints, or workspace contents — only status.
 */

const fs = require("fs");
const path = require("path");
const { requireSidekickSrc } = require("./deps");
const workspace = require("./workspace");
const { ResearchError } = require("./errors");

// Tools the pack's runs/probes/workflows COMPOSE somewhere: directly through
// the module facade, or (git) through the workflow engine. Presence here means
// "worth reporting on", not "this module may dispatch it" — dispatchability is
// derived from the manifest permissions below, never asserted by hand, so the
// status output can no longer advertise a capability the permission gate would
// refuse at dispatch time.
const COMPOSED_TOOLS = ["bash", "web_fetch", "git", "proxmox", "proxmox_guest", "proxmox_provision", "proxmox_retire", "ansible_run"];

// The module's own manifest is the single source of truth for what the facade
// will permit. Read once (the file is integrity-hashed with the package);
// failure to read fails closed to an empty allowlist rather than a guess.
let dispatchableTools = null;
function manifestDispatchable() {
  if (dispatchableTools) return dispatchableTools;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
    dispatchableTools = (manifest.permissions || []).map((p) => p && p.tool).filter(Boolean);
  } catch {
    dispatchableTools = [];
  }
  return dispatchableTools;
}

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
  // Two distinct facts, reported separately: whether a composed tool exists on
  // this server at all, and whether THIS module's permission allowlist lets it
  // dispatch the tool. Conflating them previously advertised git/ansible_run
  // as pack capabilities the facade would deny.
  const presentOnServer = {};
  for (const tool of COMPOSED_TOOLS) presentOnServer[tool] = toolAvailable(tool);
  const dispatchableByPack = {};
  for (const tool of manifestDispatchable()) dispatchableByPack[tool] = toolAvailable(tool);
  const capabilities = {
    present_on_server: presentOnServer,
    dispatchable_by_pack: dispatchableByPack,
  };

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
