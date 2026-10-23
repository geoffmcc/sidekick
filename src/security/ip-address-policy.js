"use strict";

const net = require("node:net");

const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "fd00:ec2::254",
  "100.100.100.200",
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "instance-data",
]);

function stripBrackets(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function ipv6Bytes(value) {
  let address = stripBrackets(String(value)).toLowerCase();
  if (address.includes("%")) return null;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const dotted = address.slice(lastColon + 1);
    if (net.isIP(dotted) !== 4) return null;
    const octets = dotted.split(".").map(Number);
    address = `${address.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const zeros = 8 - left.length - right.length;
  if (zeros < 0 || (halves.length === 2 && zeros < 1)) return null;
  const groups = [...left, ...Array(zeros).fill("0"), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const bytes = [];
  for (const group of groups) {
    const word = parseInt(group, 16);
    bytes.push(word >> 8, word & 0xff);
  }
  return bytes;
}

function embeddedIPv4Address(host) {
  const bytes = ipv6Bytes(host);
  if (!bytes) return null;
  const firstTenZero = bytes.slice(0, 10).every(byte => byte === 0);
  if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) return bytesToIPv4(bytes, 12);

  // The IPv4-mapped-compatible ::/96 and the well-known NAT64 /96 prefix.
  const firstTwelveZero = bytes.slice(0, 12).every(byte => byte === 0);
  if (firstTwelveZero) return bytesToIPv4(bytes, 12);
  const wellKnownNat64 = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];
  if (wellKnownNat64.every((byte, index) => bytes[index] === byte)) return bytesToIPv4(bytes, 12);

  // 6to4 embeds its IPv4 destination in bits 16..47.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytesToIPv4(bytes, 2);
  return null;
}

function bytesToIPv4(bytes, offset) {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

function isLinkLocal(host) {
  const normalized = stripBrackets(String(host)).toLowerCase();
  const version = net.isIP(normalized);
  if (version === 4) return /^169\.254\./.test(normalized);
  if (version === 6) {
    if (/^fe[89ab]/.test(normalized)) return true;
    const embedded = embeddedIPv4Address(normalized);
    return embedded ? isLinkLocal(embedded) : false;
  }
  return false;
}

function isMetadataAddress(host) {
  const normalized = stripBrackets(String(host)).toLowerCase();
  if (METADATA_HOSTS.has(normalized)) return true;
  const embedded = net.isIP(normalized) === 6 ? embeddedIPv4Address(normalized) : null;
  return embedded ? METADATA_HOSTS.has(embedded) : false;
}

// Destinations that are not valid unicast targets for Sidekick's outbound
// HTTP/browser clients. Keep these denied even when an operator explicitly
// permits private-network access; an opt-in to LAN access is not an opt-in to
// non-unicast traffic.
function isNonUnicastAddress(host) {
  const normalized = stripBrackets(String(host)).toLowerCase();
  const version = net.isIP(normalized);
  if (version === 4) {
    const octets = normalized.split(".").map(Number);
    return octets[0] >= 224;
  }
  if (version === 6) {
    if (/^ff/i.test(normalized)) return true;
    const embedded = embeddedIPv4Address(normalized);
    return embedded ? isNonUnicastAddress(embedded) : false;
  }
  return false;
}

function isPrivateAddress(host) {
  const normalized = stripBrackets(String(host)).toLowerCase();
  const version = net.isIP(normalized);
  if (version === 4) {
    const octets = normalized.split(".").map(Number);
    if (octets[0] === 127 || octets[0] === 0) return true;
    if (octets[0] === 10) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
    return false;
  }
  if (version === 6) {
    if (normalized === "::1" || normalized === "::") return true;
    if (/^f[cd]/.test(normalized)) return true;
    const embedded = embeddedIPv4Address(normalized);
    return embedded ? isPrivateAddress(embedded) : false;
  }
  return normalized === "localhost" || normalized === "localhost.localdomain" || normalized.endsWith(".localhost");
}

module.exports = { METADATA_HOSTS, stripBrackets, embeddedIPv4Address, isLinkLocal, isMetadataAddress, isNonUnicastAddress, isPrivateAddress };
