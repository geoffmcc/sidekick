"use strict";

const os = require("os");

function inspectNetworkInterfaces(enumerator = os.networkInterfaces) {
  let raw;
  try {
    raw = enumerator();
  } catch {
    return { interfaces: {}, diagnostic: { code: "network_interfaces_unavailable", detail: "interface enumeration failed" } };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { interfaces: {}, diagnostic: { code: "network_interfaces_malformed", detail: "interface enumeration returned an invalid shape" } };
  }
  const interfaces = {};
  let malformed = false;
  for (const [name, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) {
      malformed = true;
      continue;
    }
    const valid = entries.filter(entry => entry && typeof entry === "object" && typeof entry.address === "string"
      && (entry.family === "IPv4" || entry.family === "IPv6" || entry.family === 4 || entry.family === 6));
    if (valid.length) interfaces[name] = valid;
    if (valid.length !== entries.length) malformed = true;
  }
  return { interfaces, diagnostic: malformed ? { code: "network_interfaces_malformed", detail: "some interface entries were ignored" } : null };
}

function privateIPv4(networkInfo) {
  for (const entries of Object.values(networkInfo.interfaces || {})) {
    for (const iface of entries) {
      if ((iface.family === "IPv4" || iface.family === 4) && iface.internal !== true) return iface.address;
    }
  }
  return "unknown";
}

module.exports = { inspectNetworkInterfaces, privateIPv4 };
