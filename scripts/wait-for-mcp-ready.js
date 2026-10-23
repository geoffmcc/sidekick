"use strict";

const STARTUP_TIMEOUT_MS = 180_000;
const RETRY_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 1_000;

function readinessAddress(host) {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host || "127.0.0.1";
}

function readinessUrl(host = process.env.SIDEKICK_BIND_HOST, port = process.env.SIDEKICK_PORT) {
  const address = readinessAddress(host);
  const authority = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  const parsedPort = Number.parseInt(port || "4097", 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) throw new Error("SIDEKICK_PORT must be a valid TCP port");
  return `http://${authority}:${parsedPort}/health`;
}

async function waitForHttpReady({
  url = readinessUrl(),
  timeoutMs = STARTUP_TIMEOUT_MS,
  retryIntervalMs = RETRY_INTERVAL_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable for the MCP startup health check");
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(probeTimeoutMs) });
      if (response?.ok) return { ready: true, url };
    } catch {}
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(retryIntervalMs, remaining));
  }
  return { ready: false, url, timeoutMs };
}

if (require.main === module) {
  waitForHttpReady().then(result => {
    if (result.ready) {
      console.log("MCP health endpoint is accepting local requests");
      return;
    }
    console.error(`MCP health endpoint did not respond within ${result.timeoutMs}ms`);
    process.exitCode = 1;
  }).catch(error => {
    console.error(`MCP startup health check failed: ${String(error?.message || error).slice(0, 300)}`);
    process.exitCode = 1;
  });
}

module.exports = { readinessAddress, readinessUrl, waitForHttpReady };
