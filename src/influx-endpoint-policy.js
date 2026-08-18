"use strict";

const DEFAULT_ALLOWED_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1", "sidekick-influxdb"]);

function allowedHosts(raw = process.env.SIDEKICK_INFLUX_ALLOWED_HOSTS) {
  const values = String(raw || DEFAULT_ALLOWED_HOSTS.join(","))
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  return new Set(values.length ? values : DEFAULT_ALLOWED_HOSTS);
}

function validateInfluxUrl(value = process.env.SIDEKICK_INFLUX_URL || "http://localhost:8086", options = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SIDEKICK_INFLUX_URL must be an absolute http(s) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("SIDEKICK_INFLUX_URL must use http or https");
  }
  const hosts = allowedHosts(options.allowedHosts);
  const hostname = parsed.hostname.toLowerCase();
  if (!hosts.has(hostname)) {
    throw new Error(`SIDEKICK_INFLUX_URL host '${hostname}' is not in SIDEKICK_INFLUX_ALLOWED_HOSTS`);
  }
  return parsed;
}

module.exports = { DEFAULT_ALLOWED_HOSTS, allowedHosts, validateInfluxUrl };
