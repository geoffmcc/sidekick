"use strict";
const { NetworkFirewallError } = require("./errors");
const { authHeaders } = require("./client");
async function call(client, profile, object, method, args = {}) {
  const result = await client.post("/ubus", {jsonrpc:"2.0", id:Date.now(), method:"call", params:[null, object, method, args]}, authHeaders(profile));
  const item = Array.isArray(result?.result) ? result.result : null;
  if (!item || item[0] !== 0) throw new NetworkFirewallError(item?.[0] === 6 ? "permission_denied" : "provider_rejected", `OpenWrt ubus call ${object}.${method} failed`, { ubus_status:item?.[0] ?? null });
  return item[1];
}
async function login(client, profile) {
  const [user, password] = String(profile.credential || "").split("\n", 2);
  if (!user || !password) throw new NetworkFirewallError("authentication_failed", "OpenWrt credential secret must contain username and password on separate lines");
  const result = await client.post("/ubus", {jsonrpc:"2.0", id:Date.now(), method:"call", params:[null,"session","login",{username:user,password,timeout:300}]});
  const data = result?.result?.[1]; if (result?.result?.[0] !== 0 || !data?.ubus_rpc_session) throw new NetworkFirewallError("authentication_failed", "OpenWrt rejected the configured credential");
  return data.ubus_rpc_session;
}
async function invoke(client, profile, session, object, method, args = {}) { const r = await client.post("/ubus", {jsonrpc:"2.0", id:Date.now(), method:"call", params:[session,object,method,args]}); const item=Array.isArray(r?.result)?r.result:null; if (!item || item[0] !== 0) throw new NetworkFirewallError(item?.[0] === 6 ? "permission_denied" : "provider_rejected", `OpenWrt ubus call ${object}.${method} failed`, {ubus_status:item?.[0] ?? null}); return item[1]; }
module.exports = { call, login, invoke };
