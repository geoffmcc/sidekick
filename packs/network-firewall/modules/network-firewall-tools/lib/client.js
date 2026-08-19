"use strict";
const http = require("http"), https = require("https"), net = require("net");
const { NetworkFirewallError } = require("./errors");
const MAX = 4 * 1024 * 1024;
function scrub(s) { return String(s || "").replace(/(authorization|token|password|secret|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").slice(0, 500); }
function classify(e, provider) {
  if (e instanceof NetworkFirewallError) return e;
  if (["CERT_HAS_EXPIRED","UNABLE_TO_VERIFY_LEAF_SIGNATURE","DEPTH_ZERO_SELF_SIGNED_CERT","ERR_TLS_CERT_ALTNAME_INVALID"].includes(e?.code)) return new NetworkFirewallError("tls_failed", `${provider} TLS verification failed`);
  if (e?.code === "ETIMEDOUT" || e?.code === "ABORT_ERR") return new NetworkFirewallError("timeout", `${provider} request timed out`);
  return new NetworkFirewallError("provider_unreachable", `${provider} connection failed: ${scrub(e?.message)}`);
}
function createClient(profile, signal) {
  const base = profile.endpoint;
  function request(method, path, body, headers = {}) {
    const url = new URL(path, base);
    const transport = url.protocol === "https:" ? https : http;
    const options = { protocol:url.protocol, hostname:url.hostname, port:url.port || undefined, path:url.pathname + url.search, method, timeout:profile.timeout, headers:{Accept:"application/json", ...headers} };
    if (url.protocol === "https:") { options.rejectUnauthorized = true; if (profile.ca) options.ca = profile.ca; if (profile.tls_servername) options.servername = profile.tls_servername; else if (!net.isIP(url.hostname)) options.servername = url.hostname; }
    return new Promise((resolve, reject) => {
      let req; const fail = e => reject(classify(e, profile.provider));
      req = transport.request(options, res => {
        if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); reject(new NetworkFirewallError("redirect_refused", "Provider redirect refused")); return; }
        let size=0; const chunks=[]; res.on("data", c => { size += c.length; if (size <= MAX) chunks.push(c); else { req.destroy(); reject(new NetworkFirewallError("response_too_large", "Provider response exceeded the bounded response size")); } });
        res.on("end", () => { let data=null; const raw=Buffer.concat(chunks).toString("utf8"); try { data=raw ? JSON.parse(raw) : null; } catch { if (res.statusCode >= 200 && res.statusCode < 300) return reject(new NetworkFirewallError("provider_invalid_response", "Provider returned invalid JSON")); }
          if (res.statusCode === 401 || res.statusCode === 403) return reject(new NetworkFirewallError("permission_denied", "Provider rejected the configured credential or permission"));
          if (res.statusCode === 404) return reject(new NetworkFirewallError("not_found", "Provider endpoint or resource was not found"));
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new NetworkFirewallError("provider_rejected", scrub(data?.message || data?.error || `Provider returned HTTP ${res.statusCode}`), { status:res.statusCode }));
          resolve(data);
        });
      });
      req.on("error", fail); req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), {code:"ETIMEDOUT"})));
      if (signal) { if (signal.aborted) req.destroy(Object.assign(new Error("cancelled"), {code:"ABORT_ERR"})); else signal.addEventListener("abort", () => req.destroy(Object.assign(new Error("cancelled"), {code:"ABORT_ERR"})), {once:true}); }
      if (body !== undefined) { const raw=JSON.stringify(body); req.setHeader("Content-Type", "application/json"); req.setHeader("Content-Length", Buffer.byteLength(raw)); req.write(raw); }
      req.end();
    });
  }
  return { get:(path, headers) => request("GET", path, undefined, headers), post:(path, body, headers) => request("POST", path, body, headers), put:(path, body, headers) => request("PUT", path, body, headers), delete:(path, headers) => request("DELETE", path, undefined, headers) };
}
function authHeaders(profile) {
  if (!profile.credential) throw new NetworkFirewallError("authentication_failed", `Credential for profile ${profile.name} could not be resolved`);
  if (profile.provider === "openwrt") return {};
  if (profile.provider === "opnsense") { const [key, secret] = String(profile.credential).split("\n", 2); if (!key || !secret) throw new NetworkFirewallError("authentication_failed", "OPNsense credential secret must contain key and secret on separate lines"); return {Authorization:`Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`}; }
  if (profile.provider === "unifi") return {"X-API-KEY":String(profile.credential)};
  if (profile.provider === "pfsense") return {Authorization:`Bearer ${String(profile.credential)}`};
  return {};
}
module.exports = { createClient, authHeaders };
