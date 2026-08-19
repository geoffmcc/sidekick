"use strict";

const assert = require("assert");
const fs = require("fs");

const githubSource = fs.readFileSync(require.resolve("../src/tools/families/github"), "utf8");
const healthSource = fs.readFileSync(require.resolve("../src/connectors/health"), "utf8");
const endpointGuard = require("../src/compute/endpoint-guard");

assert.match(githubSource, /resolveOutboundUrl\(url\.href, "GitHub API endpoint", \{ allowPrivate: true \}\)/, "GitHub API calls must use DNS-pinned outbound resolution");
assert.match(githubSource, /servername: url\.hostname/, "GitHub HTTPS calls must retain TLS hostname verification");
assert.match(healthSource, /resolveOutboundUrl\(base\.href, "connector endpoint", \{ allowPrivate: true \}\)/, "GitHub health probes must use DNS-pinned outbound resolution");
assert.match(healthSource, /servername: base\.hostname/, "GitHub health probes must retain TLS hostname verification");
assert.match(githubSource, /url\.protocol !== "https:"/, "GitHub API calls must reject non-HTTPS connector endpoints");

assert.strictEqual(endpointGuard.validateEndpoint("http://127.0.0.1:11434"), null, "private inference providers remain supported");
assert.match(endpointGuard.validateEndpoint("http://169.254.169.254"), /link-local|valid provider endpoints/);
assert.match(endpointGuard.validateEndpoint("http://metadata.google.internal"), /metadata|valid provider endpoints/);
console.log("Phase 8 HTTP and network security tests passed");
