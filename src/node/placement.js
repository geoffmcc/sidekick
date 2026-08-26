"use strict";

const os = require("os");
const path = require("path");
const { createHash } = require("crypto");

function descriptorIdentity(descriptor) {
  const value = JSON.stringify({
    name: descriptor.name,
    version: descriptor.version || "1",
    source: descriptor.source || "builtin",
    placement: descriptor.placement || {},
  });
  return createHash("sha256").update(value).digest("hex");
}

function localOperatingSystem(platform = process.platform) {
  if (["linux", "windows", "darwin"].includes(platform)) return platform;
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "darwin";
  return "linux";
}

function normalizeNodeCapabilities(capabilities = {}) {
  const workspaceEntries = Array.isArray(capabilities.workspaces) ? capabilities.workspaces : [];
  return {
    nodeId: String(capabilities.nodeId || ""),
    platform: localOperatingSystem(capabilities.platform || process.platform),
    architecture: String(capabilities.architecture || os.arch()),
    protocolVersion: String(capabilities.protocolVersion || "1"),
    descriptorSetHash: String(capabilities.descriptorSetHash || ""),
    binaries: new Set(Array.isArray(capabilities.binaries) ? capabilities.binaries.map(String) : []),
    packs: new Set(Array.isArray(capabilities.packs) ? capabilities.packs.map(String) : []),
    workspaces: new Set(workspaceEntries.map(item => typeof item === "object" ? String(item.name || "") : String(item)).filter(Boolean)),
    workspaceRoots: workspaceEntries.filter(item => item && typeof item === "object" && item.root).map(item => ({ name: String(item.name || ""), root: String(item.root) })),
    networkScopes: new Set(Array.isArray(capabilities.networkScopes) ? capabilities.networkScopes.map(String) : []),
    browser: capabilities.browser === true,
    privilege: capabilities.privilege === true,
    healthy: capabilities.healthy !== false,
    authorized: capabilities.authorized !== false,
  };
}

function pathWithinRoot(root, target) {
  const normalize = value => String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRoot = normalize(root);
  const normalizedTarget = normalize(target);
  if (!normalizedRoot || !normalizedTarget) return false;
  const caseInsensitive = /^[A-Za-z]:\//.test(normalizedRoot) || /^[A-Za-z]:\//.test(normalizedTarget);
  const comparisonRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparisonTarget = caseInsensitive ? normalizedTarget.toLowerCase() : normalizedTarget;
  return comparisonTarget === comparisonRoot || comparisonTarget.startsWith(`${comparisonRoot}/`);
}

function checkEligibility(descriptor, capabilities, { descriptorSetHash, protocolVersion = "1", requestedPaths = [] } = {}) {
  const placement = descriptor?.placement;
  const reasons = [];
  if (!placement?.nodeSafe || !placement.locations.includes("node")) reasons.push("tool_server_bound");
  const node = normalizeNodeCapabilities(capabilities);
  if (!node.authorized) reasons.push("node_not_authorized");
  if (!node.healthy) reasons.push("node_unhealthy");
  if (node.protocolVersion !== String(protocolVersion)) reasons.push("protocol_mismatch");
  if (descriptorSetHash && node.descriptorSetHash !== descriptorSetHash) reasons.push("descriptor_set_mismatch");
  const requirements = placement?.requirements || {};
  if (requirements.os?.length && !requirements.os.includes(node.platform)) reasons.push("operating_system_unsupported");
  for (const binary of requirements.binaries || []) if (!node.binaries.has(binary)) reasons.push(`binary_missing:${binary}`);
  for (const pack of requirements.packs || []) if (!node.packs.has(pack)) reasons.push(`pack_missing:${pack}`);
  for (const workspace of requirements.workspaces || []) if (!node.workspaces.has(workspace)) reasons.push(`workspace_missing:${workspace}`);
  for (const scope of requirements.networkScopes || []) if (!node.networkScopes.has(scope)) reasons.push(`network_scope_missing:${scope}`);
  if (requestedPaths.length) {
    if (!node.workspaceRoots.length) reasons.push("path_visibility_unverifiable");
    else for (const requestedPath of requestedPaths) if (!node.workspaceRoots.some(item => pathWithinRoot(item.root, requestedPath))) reasons.push(`path_not_visible:${path.basename(String(requestedPath))}`);
  }
  if (requirements.browser && !node.browser) reasons.push("browser_unavailable");
  if (requirements.privilege && !node.privilege) reasons.push("privilege_unavailable");
  return { eligible: reasons.length === 0, reasons, nodeId: node.nodeId, descriptorIdentity: descriptorIdentity(descriptor) };
}

function selectNode(candidates, descriptor, options = {}) {
  const evaluated = candidates.map(candidate => ({ candidate, ...checkEligibility(descriptor, candidate.capabilities || candidate, options) }));
  const eligible = evaluated.filter(item => item.eligible).sort((a, b) => String(a.candidate.nodeId).localeCompare(String(b.candidate.nodeId)));
  return { selected: eligible[0] || null, candidates: evaluated };
}

module.exports = { descriptorIdentity, normalizeNodeCapabilities, checkEligibility, selectNode, pathWithinRoot };
