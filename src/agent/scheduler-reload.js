"use strict";

const httpDefault = require("http");
const { createAgentProxyHeaders } = require("../security/agent-proxy-auth");

const ROUTES = Object.freeze({
  delays: "/api/delays/reload",
  watches: "/api/watches/reload",
});

function reloadAgentScheduler(kind, options = {}) {
  const secret = options.secret;
  const port = options.port ?? Number.parseInt(process.env.SIDEKICK_AGENT_PORT || "4099", 10);
  const http = options.http || httpDefault;
  const timeoutMs = options.timeoutMs ?? 1000;
  const path = ROUTES[kind];
  if (!path) return Promise.resolve({ ok: false, code: "unsupported_reload" });
  if (typeof secret !== "string" || !secret) return Promise.resolve({ ok: false, code: "service_credential_unavailable" });
  // Test suites must supply an explicit fake transport; never send a signed
  // request to a developer's loopback Agent service by accident.
  if (process.env.NODE_ENV === "test" && !options.http) return Promise.resolve({ ok: false, code: "test_transport_required" });

  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      request = http.request({
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          ...createAgentProxyHeaders({ secret, service: "scheduler", method: "POST", path }),
          Connection: "close",
        },
        agent: false,
      }, response => {
        response.resume();
        finish(response.statusCode >= 200 && response.statusCode < 300
          ? { ok: true }
          : { ok: false, code: "agent_reload_rejected", status: response.statusCode });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error("Agent reload timed out")));
      request.on("error", () => finish({ ok: false, code: "agent_unavailable" }));
      request.end();
    } catch {
      finish({ ok: false, code: "agent_unavailable" });
    }
  });
}

module.exports = Object.freeze({ reloadAgentScheduler, ROUTES });
