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

// --- provisioning field validators -----------------------------------------

// Guest name / hostname: a DNS label.
const GUEST_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
// Snapshot name (pve-common): letters/digits/_/-, starting alnum, <=40.
const SNAPNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
// cloud-init username.
const CI_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
// A storage:vztmpl/<file> OS template volume id for LXC.
const OSTEMPLATE_RE = /^[A-Za-z][A-Za-z0-9\-_.]{0,99}:vztmpl\/[A-Za-z0-9][\w.\-+]{0,127}$/;
const ISO_VOLUME_RE = /^[A-Za-z][A-Za-z0-9\-_.]{0,99}:iso\/[A-Za-z0-9][\w.\-+]{0,127}$/;
const NET_MODELS = new Set(["virtio", "e1000", "rtl8139", "vmxnet3"]);
const OS_TYPES = new Set(["l26", "l24", "other", "wxp", "w2k", "w2k3", "w2k8", "wvista", "win7", "win8", "win10", "win11", "solaris"]);
const LXC_OSTYPES = new Set(["debian", "ubuntu", "centos", "fedora", "alpine", "archlinux", "opensuse", "unmanaged"]);

function validateGuestName(value) {
  if (typeof value !== "string" || !GUEST_NAME_RE.test(value)) {
    return invalid("name", "name must be a DNS label (letters, digits, hyphens; max 63)");
  }
  return { ok: true, value };
}

function validateSnapname(value) {
  if (typeof value !== "string" || !SNAPNAME_RE.test(value)) {
    return invalid("snapname", "snapshot name must start alphanumeric and contain only letters, digits, '_', '-' (max 40)");
  }
  return { ok: true, value };
}

function validateIntRange(field, value, min, max) {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || String(n) !== String(value).trim() || n < min || n > max) {
    return invalid(field, `${field} must be an integer between ${min} and ${max}`);
  }
  return { ok: true, value: n };
}

function validateCiUser(value) {
  if (typeof value !== "string" || !CI_USER_RE.test(value)) {
    return invalid("ci_user", "ci_user must be a valid Unix username");
  }
  return { ok: true, value };
}

function validateOsTemplate(value) {
  if (typeof value !== "string" || !OSTEMPLATE_RE.test(value)) {
    return invalid("ostemplate", "ostemplate must be a <storage>:vztmpl/<file> volume id");
  }
  return { ok: true, value };
}

/**
 * An ISO volume id, validated for the same reason ostemplate is: it is
 * interpolated into a Proxmox property string (`ide2: <vol>,media=cdrom`), so
 * an unvalidated value carrying a comma can append arbitrary options to that
 * property.
 */
function validateIsoVolume(value) {
  if (typeof value !== "string" || !ISO_VOLUME_RE.test(value)) {
    return invalid("iso", "iso must be a <storage>:iso/<file> volume id");
  }
  return { ok: true, value };
}

function validateOsType(value) {
  if (typeof value !== "string" || !OS_TYPES.has(value)) {
    return invalid("ostype", `ostype must be one of: ${[...OS_TYPES].join(", ")}`);
  }
  return { ok: true, value };
}

function validateLxcOsType(value) {
  if (typeof value !== "string" || !LXC_OSTYPES.has(value)) {
    return invalid("ostype", `LXC ostype must be one of: ${[...LXC_OSTYPES].join(", ")}`);
  }
  return { ok: true, value };
}

// An SSH public key line. Conservative: known key types + base64 body + optional comment.
function validateSshKey(value) {
  if (typeof value !== "string") return invalid("ssh_keys", "ssh key must be a string");
  const trimmed = value.trim();
  if (!/^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/]{20,}={0,3}(\s+\S+)?$/.test(trimmed)) {
    return invalid("ssh_keys", "value is not a well-formed SSH public key");
  }
  if (trimmed.length > 4096) return invalid("ssh_keys", "ssh key is too long");
  return { ok: true, value: trimmed };
}

// A network spec built from structured parts, never a raw model-supplied string.
function validateNetSpec({ model, bridge, vlan } = {}) {
  const m = model || "virtio";
  if (!NET_MODELS.has(m)) return invalid("net_model", `net_model must be one of: ${[...NET_MODELS].join(", ")}`);
  if (bridge !== undefined && bridge !== null) {
    if (typeof bridge !== "string" || !/^vmbr\d{1,4}$/.test(bridge)) {
      return invalid("net_bridge", "net_bridge must be a Linux bridge name like vmbr0");
    }
  }
  if (vlan !== undefined && vlan !== null) {
    const v = validateIntRange("net_vlan", vlan, 1, 4094);
    if (!v.ok) return v;
  }
  return { ok: true, value: { model: m, bridge: bridge || null, vlan: vlan != null ? Number(vlan) : null } };
}

// An IPv4 CIDR or "dhcp" for cloud-init ipconfig.
function validateIpConfig(value) {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (value === "dhcp") return { ok: true, value: "ip=dhcp" };
  const m = String(value).match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2})(?:,gw=(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}))?$/);
  if (!m) return invalid("ip", "ip must be 'dhcp' or '<ipv4>/<prefix>[,gw=<ipv4>]'");
  const octetsOk = m[1].split("/")[0].split(".").every(o => Number(o) <= 255) && (!m[2] || m[2].split(".").every(o => Number(o) <= 255));
  const prefix = Number(m[1].split("/")[1]);
  if (!octetsOk || prefix > 32) return invalid("ip", "ip contains an out-of-range octet or prefix");
  return { ok: true, value: `ip=${m[1]}${m[2] ? `,gw=${m[2]}` : ""}` };
}

module.exports = {
  PROFILE_NAME_RE,
  NODE_NAME_RE,
  STORAGE_ID_RE,
  SECRET_REF_RE,
  GUEST_NAME_RE,
  SNAPNAME_RE,
  VMID_MIN,
  VMID_MAX,
  NET_MODELS,
  OS_TYPES,
  LXC_OSTYPES,
  validateProfileName,
  validateVmid,
  validateNodeName,
  validateStorageId,
  validateEndpoint,
  validateSecretRef,
  parseUpid,
  validateGuestName,
  validateSnapname,
  validateIntRange,
  validateCiUser,
  validateOsTemplate,
  validateIsoVolume,
  validateOsType,
  validateLxcOsType,
  validateSshKey,
  validateNetSpec,
  validateIpConfig,
};
