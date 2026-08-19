"use strict";
const { NetworkFirewallError } = require("./errors");
const PROFILE = /^[a-z][a-z0-9_-]{0,63}$/;
const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
function name(value, field = "name") { if (typeof value !== "string" || !PROFILE.test(value)) throw new NetworkFirewallError("invalid_input", `${field} must match ${PROFILE}`); return value; }
function text(value, field, max = 200) { if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n]/.test(value)) throw new NetworkFirewallError("invalid_input", `${field} is invalid`); return value; }
function endpoint(value) {
  let u; try { u = new URL(value); } catch { throw new NetworkFirewallError("invalid_input", "endpoint is invalid"); }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new NetworkFirewallError("invalid_input", "endpoint must be an HTTPS origin without credentials, path, query, or fragment");
  return u;
}
function ip(value) { if (typeof value !== "string" || !require("net").isIP(value)) throw new NetworkFirewallError("invalid_input", "IP address is invalid"); return value; }
function cidr(value) { if (typeof value !== "string" || !/^\S+\/\d{1,3}$/.test(value)) throw new NetworkFirewallError("invalid_input", "CIDR is invalid"); const [host,bits] = value.split("/"); ip(host); const max = require("net").isIP(host) === 6 ? 128 : 32; if (Number(bits) > max) throw new NetworkFirewallError("invalid_input", "CIDR prefix is invalid"); return value; }
function port(value, field = "port") { if (!Number.isInteger(value) || value < 1 || value > 65535) throw new NetworkFirewallError("invalid_input", `${field} is invalid`); return value; }
function mac(value) { if (typeof value !== "string" || !MAC.test(value)) throw new NetworkFirewallError("invalid_input", "MAC address is invalid"); return value.toLowerCase(); }
function bounded(value, fallback, min = 1, max = 1000) { const n = Number(value); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback; }
module.exports = { name, text, endpoint, ip, cidr, port, mac, bounded };
