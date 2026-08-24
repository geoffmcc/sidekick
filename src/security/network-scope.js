"use strict";

// Canonical, installation-independent outbound network scope policy.
// This module deliberately contains no persistence or pack-specific behavior.

const crypto = require("crypto");
const net = require("net");
const dns = require("dns").promises;
const { domainToASCII } = require("url");
const { METADATA_HOSTS } = require("../compute/endpoint-guard");

const MAX_LIST = 256;
const MAX_HOST = 253;
const PROTOCOLS = new Set(["http", "https", "ws", "wss"]);
const PERMANENT_REASON = "permanent_denial";

function fail(message) { throw new Error(message); }
function boundedString(value, name, max) {
  const text = String(value == null ? "" : value).trim();
  if (!text || text.length > max) fail(`${name} must be 1-${max} characters`);
  return text;
}
function list(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST) fail(`${name} must contain at most ${MAX_LIST} items`);
  return value;
}
function rejectSecretFields(value, path = "metadata", depth = 0) {
  if (depth > 4) fail("metadata is too deeply nested");
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    if (/(pass(word)?|secret|token|credential|api[_-]?key|authorization|cookie)/i.test(key)) fail(`${path}.${key} is not permitted in a network scope`);
    rejectSecretFields(child, `${path}.${key}`, depth + 1);
  }
}
function ipv4(value) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every(n => n >= 0 && n <= 255) ? parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n) : null;
}
function mappedIpv4(value) {
  const h = String(value).toLowerCase();
  const match = h.match(/^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d{1,3}(?:\.\d{1,3}){3}))$/);
  if (!match) return null;
  if (match[3]) return ipv4(match[3]);
  return (BigInt(parseInt(match[1], 16)) << 16n) | BigInt(parseInt(match[2], 16));
}
function ipv6(value) {
  let h = String(value).toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = mappedIpv4(h);
  if (mapped !== null) return { value: mapped, bits: 32, mapped: true };
  if (!h.includes(":")) return null;
  const pieces = h.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  const all = [...left, ...right];
  if (all.some(p => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  const missing = 8 - all.length;
  if ((pieces.length === 1 && missing !== 0) || missing < 1) return null;
  const expanded = pieces.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : all;
  if (expanded.length !== 8) return null;
  return { value: expanded.reduce((n, p) => (n << 16n) | BigInt(parseInt(p, 16)), 0n), bits: 128, mapped: false };
}
function parseAddress(value, name = "address") {
  const text = String(value || "").trim().toLowerCase();
  const v4 = ipv4(text);
  if (v4 !== null) return { value: v4, bits: 32, text: text };
  const v6 = ipv6(text);
  if (v6) return { ...v6, text: v6.mapped ? v4Text(v6.value) : text };
  fail(`${name} must be a canonical IPv4 or IPv6 address`);
}
function v4Text(value) { return [24n, 16n, 8n, 0n].map(s => Number((value >> s) & 255n)).join("."); }
function normalizeCidr(value, name) {
  const text = boundedString(value, name, 64).toLowerCase();
  const parts = text.split("/");
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) fail(`${name} must be an IP CIDR`);
  const address = parseAddress(parts[0], name);
  const prefix = Number(parts[1]);
  if (prefix < 0 || prefix > address.bits) fail(`${name} has an invalid prefix length`);
  const mask = prefix === 0 ? 0n : ((1n << BigInt(address.bits)) - 1n) ^ ((1n << BigInt(address.bits - prefix)) - 1n);
  const network = address.value & mask;
  return `${address.bits === 32 ? v4Text(network) : ipv6Text(network)}/${prefix}`;
}
function ipv6Text(value) {
  const parts = [];
  for (let i = 7; i >= 0; i--) parts.unshift(((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  let bestStart = -1, bestLength = 0;
  for (let i = 0; i < 8;) { if (parts[i] !== "0") { i++; continue; } const start = i; while (i < 8 && parts[i] === "0") i++; if (i - start > bestLength) { bestStart = start; bestLength = i - start; } }
  if (bestLength > 1) parts.splice(bestStart, bestLength, "");
  const text = parts.join(":");
  return text === "" ? "::" : text.replace(/^:/, "::").replace(/:$/, "::");
}
function host(value, name = "hostname") {
  let text = boundedString(value, name, MAX_HOST).toLowerCase().replace(/\.$/, "");
  if (!text || text.includes("/") || text.includes("@") || text.includes(" ") || text.includes("\\")) fail(`${name} is not a valid hostname`);
  const ascii = domainToASCII(text);
  if (!ascii || ascii.length > MAX_HOST || ascii.split(".").some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) fail(`${name} is not a valid hostname`);
  return ascii;
}
function normalizePattern(value) {
  const text = boundedString(value, "allowed_hosts", MAX_HOST + 2).toLowerCase();
  if (!text.startsWith("*.")) return host(text, "allowed_hosts");
  const suffix = host(text.slice(2), "allowed_hosts wildcard");
  if (suffix.split(".").length < 2 || suffix === "localhost") fail("wildcard must cover a bounded multi-label suffix");
  return `*.${suffix}`;
}
function normalizePorts(values, name = "allowed_ports") {
  const output = [];
  for (const item of list(values, name)) {
    if (Number.isInteger(item)) { if (item < 1 || item > 65535) fail(`${name} contains an invalid port`); output.push([item, item]); continue; }
    if (typeof item !== "string" || !/^\d+-\d+$/.test(item)) fail(`${name} contains an invalid port range`);
    const [start, end] = item.split("-").map(Number);
    if (start < 1 || end > 65535 || start > end) fail(`${name} contains an invalid port range`);
    output.push([start, end]);
  }
  output.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of output) { const last = merged[merged.length - 1]; if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]); else merged.push(range); }
  return merged.map(([start, end]) => start === end ? start : `${start}-${end}`);
}
function normalizeScope(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("network scope must be an object");
  const fields = new Set(["name", "description", "enabled", "schema_version", "allow_private_addresses", "allowed_cidrs", "allowed_ips", "allowed_hosts", "allowed_protocols", "allowed_ports", "denied_cidrs", "denied_ips", "denied_hosts", "expires_at", "metadata"]);
  for (const key of Object.keys(input)) if (!fields.has(key)) fail(`unknown network scope field: ${key}`);
  if (input.schema_version != null && Number(input.schema_version) !== 1) fail("unsupported network scope schema_version");
  if (input.metadata != null) { rejectSecretFields(input.metadata); if (JSON.stringify(input.metadata).length > 10000) fail("metadata exceeds 10000 bytes"); }
  const name = boundedString(input.name, "name", 80).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,79}$/.test(name)) fail("name must use lowercase letters, numbers, _ or -");
  const description = input.description == null ? null : boundedString(input.description, "description", 500);
  const protocols = [...new Set(list(input.allowed_protocols, "allowed_protocols").map(v => boundedString(v, "protocol", 8).toLowerCase()))].sort();
  if (!protocols.length || protocols.some(p => !PROTOCOLS.has(p))) fail("allowed_protocols must contain http, https, ws or wss");
  const allowedCidrs = [...new Set(list(input.allowed_cidrs, "allowed_cidrs").map((v, i) => normalizeCidr(v, `allowed_cidrs[${i}]`)))].sort();
  const deniedCidrs = [...new Set(list(input.denied_cidrs, "denied_cidrs").map((v, i) => normalizeCidr(v, `denied_cidrs[${i}]`)))].sort();
  const exactIps = [...new Set(list(input.allowed_ips, "allowed_ips").map((v, i) => parseAddress(v, `allowed_ips[${i}]`).text))].sort();
  const deniedIps = [...new Set(list(input.denied_ips, "denied_ips").map((v, i) => parseAddress(v, `denied_ips[${i}]`).text))].sort();
  const allowedHosts = [...new Set(list(input.allowed_hosts, "allowed_hosts").map(normalizePattern))].sort();
  const deniedHosts = [...new Set(list(input.denied_hosts, "denied_hosts").map(v => host(v, "denied_hosts")))].sort();
  if (!allowedCidrs.length && !exactIps.length && !allowedHosts.length) fail("scope requires an explicit address or hostname allowlist");
  const normalized = { schema_version: 1, name, description, enabled: input.enabled !== false, allow_private_addresses: input.allow_private_addresses === true, allowed_cidrs: allowedCidrs, allowed_ips: exactIps, allowed_hosts: allowedHosts, allowed_protocols: protocols, allowed_ports: normalizePorts(input.allowed_ports), denied_cidrs: deniedCidrs, denied_ips: deniedIps, denied_hosts: deniedHosts, expires_at: input.expires_at || null };
  if (normalized.expires_at && (!Number.isFinite(Date.parse(normalized.expires_at)) || Date.parse(normalized.expires_at) <= Date.now())) fail("expires_at must be a future ISO timestamp");
  normalized.digest = crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return Object.freeze(normalized);
}
function cidrContains(cidr, address) {
  const [base, prefixText] = cidr.split("/"); const parsed = parseAddress(base); if (parsed.bits !== address.bits) return false;
  const prefix = Number(prefixText); const mask = prefix === 0 ? 0n : ((1n << BigInt(parsed.bits)) - 1n) ^ ((1n << BigInt(parsed.bits - prefix)) - 1n);
  return (parsed.value & mask) === (address.value & mask);
}
function patternMatches(value, pattern) { return pattern.startsWith("*.") ? value.endsWith(pattern.slice(1)) && value.length > pattern.length - 1 : value === pattern; }
function permanentDenial(value) {
  const text = String(value || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (METADATA_HOSTS.has(text) || text === "localhost" || text.endsWith(".localhost")) return PERMANENT_REASON;
  let address; try { address = parseAddress(text); } catch { return null; }
  if (address.value === 0n || (address.bits === 32 && ((address.value >> 24n) & 255n) === 255n)) return PERMANENT_REASON;
  if (address.bits === 32 && ((address.value >> 24n) & 255n) === 169n && ((address.value >> 16n) & 255n) === 254n) return PERMANENT_REASON;
   if (address.bits === 128 && (((address.value >> 120n) & 0xffn) === 0xffn || (address.value >> 118n) === 0x3fan)) return PERMANENT_REASON;
  return null;
}
function isPrivate(value) { let a; try { a = parseAddress(value); } catch { return false; } if (a.bits === 32) { const n = a.value; const first = Number(n >> 24n), second = Number((n >> 16n) & 255n); return first === 10 || first === 127 || first === 0 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127); } return ((a.value >> 121n) & 0x7fn) === 0x7e || a.value === 1n; }
function portAllowed(port, ranges) { return !ranges.length || ranges.some(range => { const [a, b] = String(range).split("-").map(Number); return port >= a && port <= (b || a); }); }
function decision(scope, { host: rawHost, address: rawAddress, protocol, port, allowedHosts = null } = {}) {
   if (!scope || !scope.enabled) return { ok: false, reason: "scope_disabled" };
   if (scope.is_current === false) return { ok: false, reason: "scope_superseded" };
  if (scope.expires_at && Date.parse(scope.expires_at) <= Date.now()) return { ok: false, reason: "scope_expired" };
  const h = rawHost ? (rawHost.includes(":") || net.isIP(rawHost) ? String(rawHost).toLowerCase().replace(/^\[|\]$/g, "") : host(rawHost)) : null;
  const address = rawAddress || (h && (net.isIP(h) ? h : null));
  const protectedReason = permanentDenial(address || h); if (protectedReason) return { ok: false, reason: protectedReason };
  if (protocol && !scope.allowed_protocols.includes(String(protocol).toLowerCase().replace(":", ""))) return { ok: false, reason: "protocol_not_allowed" };
  if (port && !portAllowed(Number(port), scope.allowed_ports)) return { ok: false, reason: "port_not_allowed" };
  if (allowedHosts && (!h || !allowedHosts.some(p => patternMatches(h, normalizePattern(p))))) return { ok: false, reason: "session_host_not_allowed" };
  if (scope.denied_hosts.some(p => h && patternMatches(h, p))) return { ok: false, reason: "explicit_host_denial" };
  let parsed = null; try { if (address) parsed = parseAddress(address); } catch { return { ok: false, reason: "invalid_destination" }; }
  if (parsed && (scope.denied_ips.includes(parsed.text) || scope.denied_cidrs.some(c => cidrContains(c, parsed)))) return { ok: false, reason: "explicit_address_denial" };
  if (parsed && scope.allow_private_addresses !== true && isPrivate(parsed.text)) return { ok: false, reason: "private_address_not_enabled" };
  const addressAllowed = parsed && (scope.allowed_ips.includes(parsed.text) || scope.allowed_cidrs.some(c => cidrContains(c, parsed)));
  const hostAllowed = h && scope.allowed_hosts.some(p => patternMatches(h, p));
  if (!addressAllowed && !hostAllowed) return { ok: false, reason: "destination_not_in_scope" };
  return { ok: true, reason: "allowed", scope_id: scope.scope_id || null, revision: scope.revision || null, digest: scope.digest };
}
async function resolveDestination(scope, value, options = {}) {
  let url; try { url = new URL(String(value)); } catch { return { ok: false, reason: "invalid_url" }; }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password) return { ok: false, reason: "invalid_url" };
  const protocol = url.protocol.slice(0, -1); const port = Number(url.port || (["https", "wss"].includes(protocol) ? 443 : 80));
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(hostname)) { const d = decision(scope, { host: hostname, address: hostname, protocol, port, allowedHosts: options.allowedHosts }); return { ...d, url, address: hostname, port, protocol }; }
  let records; try { records = await dns.lookup(hostname, { all: true, verbatim: true }); } catch (error) { return { ok: false, reason: "dns_resolution_failed", error_code: error.code || "dns_error" }; }
  if (!records.length) return { ok: false, reason: "dns_no_results" };
  const decisions = records.map(record => ({ record, decision: decision(scope, { host: hostname, address: record.address, protocol, port, allowedHosts: options.allowedHosts }) }));
  const refused = decisions.find(item => !item.decision.ok); if (refused) return { ...refused.decision, url, hostname, port, protocol, dns: "refused" };
  const first = decisions[0]; return { ...first.decision, url, hostname, address: first.record.address, family: first.record.family, port, protocol, dns: "validated_all" };
}

module.exports = { normalizeScope, decision, resolveDestination, parseAddress, cidrContains, permanentDenial, isPrivate, patternMatches, normalizePattern, normalizePorts, PROTOCOLS };
