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

function isIPv4MappedAddress(host) {
  const bytes = ipv6Bytes(host);
  return Boolean(bytes && bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff);
}

function ipv6PrefixMatches(bytes, prefix, prefixLength) {
  const prefixBytes = ipv6Bytes(prefix);
  if (!bytes || !prefixBytes) return false;
  let value = 0n;
  let prefixValue = 0n;
  for (let index = 0; index < 16; index++) {
    value = (value << 8n) | BigInt(bytes[index]);
    prefixValue = (prefixValue << 8n) | BigInt(prefixBytes[index]);
  }
  const shift = BigInt(128 - prefixLength);
  return (value >> shift) === (prefixValue >> shift);
}

/**
 * Returns true for addresses that should only be contacted with an explicit
 * operator network scope. Besides private and link-local ranges, this covers
 * the IANA special-purpose ranges that are not globally reachable. Globally
 * reachable exceptions within the 192.0.0.0/24 and 2001::/23 registries are
 * kept explicit so a broad special-purpose prefix does not block them.
 */
function isNonGloballyReachableAddress(host) {
  const normalized = stripBrackets(String(host || "")).toLowerCase();
  if (isPrivateAddress(normalized) || isLinkLocal(normalized) || isIPv4MappedAddress(normalized)) return true;
  const version = net.isIP(normalized);
  if (version === 4) {
    const octets = normalized.split(".").map(Number);
    if (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) {
      return octets[3] !== 9 && octets[3] !== 10;
    }
    return (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) ||
      (octets[0] === 192 && octets[1] === 88 && octets[2] === 99) ||
      (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) ||
      (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) ||
      (octets[0] === 203 && octets[1] === 0 && octets[2] === 113);
  }
  if (version === 6) {
    const bytes = ipv6Bytes(normalized);
    const embedded = embeddedIPv4Address(normalized);
    const wellKnownNat64 = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];
    if (embedded && wellKnownNat64.every((byte, index) => bytes[index] === byte)) {
      return isNonGloballyReachableAddress(embedded);
    }
    if (!ipv6PrefixMatches(bytes, "2000::", 3)) return true;
    if (ipv6PrefixMatches(bytes, "2001::", 23)) {
      const globallyReachableExceptions = [
        ["2001:1::1", 128], ["2001:1::2", 128], ["2001:1::3", 128],
        ["2001:3::", 32], ["2001:4:112::", 48], ["2001:20::", 28], ["2001:30::", 28],
      ];
      if (!globallyReachableExceptions.some(([prefix, length]) => ipv6PrefixMatches(bytes, prefix, length))) return true;
    }
    return ipv6PrefixMatches(bytes, "2001:db8::", 32) || ipv6PrefixMatches(bytes, "3fff::", 20);
  }
  return false;
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

  // RFC 8215 reserves 64:ff9b:1::/48 for local-use translation. RFC 6052's
  // /48 layout places the first two IPv4 octets after the prefix, then the
  // reserved u octet, followed by the remaining two octets.
  const localUseNat64 = [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01];
  if (localUseNat64.every((byte, index) => bytes[index] === byte) && bytes[8] === 0 && bytes.slice(11).every(byte => byte === 0)) {
    return `${bytes[6]}.${bytes[7]}.${bytes[9]}.${bytes[10]}`;
  }

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
    const bytes = ipv6Bytes(normalized);
    if (bytes && [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01].every((byte, index) => bytes[index] === byte)) return true;
    if (/^f[cd]/.test(normalized)) return true;
    const embedded = embeddedIPv4Address(normalized);
    return embedded ? isPrivateAddress(embedded) : false;
  }
  return normalized === "localhost" || normalized === "localhost.localdomain" || normalized.endsWith(".localhost");
}

module.exports = { METADATA_HOSTS, stripBrackets, ipv6Bytes, isIPv4MappedAddress, embeddedIPv4Address, isLinkLocal, isMetadataAddress, isNonUnicastAddress, isPrivateAddress, isNonGloballyReachableAddress };
