"use strict";

/**
 * Input validation for everything that can reach a Proxmox API request.
 *
 * Every identifier that gets embedded in an API path is validated against a
 * strict shape BEFORE any request is built. Model-supplied strings never reach
 * the wire unvalidated, and endpoints are never model-supplied at all — tools
 * accept a profile NAME, and the endpoint comes from administrator-controlled
 * pack configuration.
 */

const { requireSidekickSrc } = require("./deps");

// Shared endpoint semantics with the compute provider guard: http(s) only, no
// embedded credentials, link-local and cloud-metadata hosts denied, private
// addressing allowed (homelab Proxmox hosts are first-class).
const endpointGuard = requireSidekickSrc("src/compute/endpoint-guard.js");

const PROFILE_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/;
// A Proxmox node name is a hostname label.
const NODE_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
// Storage identifiers per pve-storage: alphanumeric start, then [a-zA-Z0-9-_.].
const STORAGE_ID_RE = /^[A-Za-z][A-Za-z0-9\-_.]{0,99}$/;
const SECRET_REF_RE = /^secret:[A-Za-z0-9_.:/-]{1,190}$/;
// VMIDs are integers; PVE enforces 100 <= vmid < 999999999.
const VMID_MIN = 100;
const VMID_MAX = 999999999;

function invalid(field, message) {
  return { ok: false, field, message };
}

function validateProfileName(name) {
  if (typeof name !== "string" || !PROFILE_NAME_RE.test(name)) {
    return invalid("profile", "profile must match ^[a-z][a-z0-9_-]{0,62}$");
  }
  return { ok: true, value: name };
}

function validateVmid(value) {
  const vmid = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(vmid) || String(vmid) !== String(value).trim() || vmid < VMID_MIN || vmid > VMID_MAX) {
    return invalid("vmid", `vmid must be an integer between ${VMID_MIN} and ${VMID_MAX}`);
  }
  return { ok: true, value: vmid };
}

function validateNodeName(value) {
  if (typeof value !== "string" || !NODE_NAME_RE.test(value)) {
    return invalid("node", "node must be a valid hostname label (letters, digits, hyphens)");
  }
  return { ok: true, value };
}

function validateStorageId(value) {
  if (typeof value !== "string" || !STORAGE_ID_RE.test(value)) {
    return invalid("storage", "storage id must start with a letter and contain only letters, digits, '-', '_', '.'");
  }
  return { ok: true, value };
}

/**
 * Parse a Proxmox task UPID.
 *
 * Canonical shape (pve-common PVE::Tools::upid_decode):
 *   UPID:<node>:<pid hex>:<pstart hex>:<starttime hex>:<type>:<id>:<user>:
 * The trailing colon is part of the format. <id> may be empty; <user> may
 * contain '@' and '!' (API tokens). Parsed leniently on field widths but
 * strictly on structure, because the UPID is embedded in a request path.
 */
function parseUpid(value) {
  if (typeof value !== "string" || value.length > 512 || /[\s/%?#\\]/.test(value)) {
    return invalid("upid", "upid contains invalid characters");
  }
  const parts = value.split(":");
  if (parts.length < 9 || parts[0] !== "UPID" || parts[parts.length - 1] !== "") {
    return invalid("upid", "upid must have the form UPID:node:pid:pstart:starttime:type:id:user:");
  }
  const [, node, pid, pstart, starttime, type, id, user] = parts;
  if (!NODE_NAME_RE.test(node)) return invalid("upid", "upid node segment is not a valid node name");
  if (!/^[0-9A-Fa-f]{1,16}$/.test(pid) || !/^[0-9A-Fa-f]{1,16}$/.test(pstart) || !/^[0-9A-Fa-f]{1,16}$/.test(starttime)) {
    return invalid("upid", "upid pid/pstart/starttime segments must be hexadecimal");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(type)) return invalid("upid", "upid task type segment is invalid");
  return {
    ok: true,
    value,
    node,
    pid: Number.parseInt(pid, 16),
    starttime: Number.parseInt(starttime, 16),
    type,
    id: id || null,
    user: user || null,
  };
}

/**
 * Validate an administrator-configured Proxmox endpoint.
 *
 * Stricter than the shared guard on purpose: API tokens travel in a header,
 * so cleartext http is refused outright, and the endpoint must be a bare
 * origin — no path, query, fragment, or embedded credentials. This runs
 * against trusted configuration, but configuration mistakes should fail
 * loudly here rather than as confusing request errors later.
 */
function validateEndpoint(value) {
  if (typeof value !== "string" || !value.trim()) return invalid("endpoint", "endpoint is required");
  const guardError = endpointGuard.validateEndpoint(value);
  if (guardError) return invalid("endpoint", guardError.replace(/base_url/g, "endpoint"));
  let url;
  try {
    url = new URL(value);
  } catch {
    return invalid("endpoint", `not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:") {
    return invalid("endpoint", "endpoint must use https: Proxmox API tokens must never travel over cleartext http");
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return invalid("endpoint", "endpoint must be a bare origin like https://pve.example.internal:8006 (no path, query, or fragment)");
  }
  // WHATWG URL elides a scheme-default port, so `new URL("https://h:443").port`
  // is "" and `url.origin` drops the ":443". Read the explicit port from the
  // raw authority instead, so an administrator who configures :443 (a reverse
  // proxy) has requests — and the Authorization header — sent there, not to a
  // silently-substituted 8006. Default to 8006 only when no port was supplied.
  const authority = value.slice(url.protocol.length + 2).replace(/[/?#].*$/, "");
  const portMatch = authority.match(/]:(\d+)$/) || authority.match(/(?<!:):(\d+)$/);
  const port = portMatch ? Number(portMatch[1]) : 8006;
  const displayHost = url.hostname.includes(":") ? `[${url.hostname}]` : url.hostname;
  return { ok: true, value: `https://${displayHost}:${port}`, hostname: url.hostname, port };
}

function validateSecretRef(value) {
  if (typeof value !== "string" || !SECRET_REF_RE.test(value)) {
    return invalid("token_ref", "token_ref must be a secret store reference of the form secret:<name>");
  }
  return { ok: true, value };
}

module.exports = {
  PROFILE_NAME_RE,
  NODE_NAME_RE,
  STORAGE_ID_RE,
  SECRET_REF_RE,
  VMID_MIN,
  VMID_MAX,
  validateProfileName,
  validateVmid,
  validateNodeName,
  validateStorageId,
  validateEndpoint,
  validateSecretRef,
  parseUpid,
};
