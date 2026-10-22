"use strict";

function buildGrafanaProxyHeaders(incomingHeaders, username, password) {
  if (!username || !password) throw new Error("Grafana proxy credentials are unavailable");
  const removed = new Set(["host", "cookie", "authorization", "x-webauth-user", "x-webauth-groups", "x-webauth-email", "x-webauth-name", "x-webauth-role"]);
  const headers = Object.fromEntries(Object.entries(incomingHeaders || {}).filter(([name]) => !removed.has(name.toLowerCase())));
  headers.authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  return headers;
}

module.exports = { buildGrafanaProxyHeaders };
