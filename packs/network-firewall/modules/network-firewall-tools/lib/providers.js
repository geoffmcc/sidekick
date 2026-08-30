"use strict";
const { NetworkFirewallError } = require("./errors");
const n = require("./normalize");
const ow = require("./openwrt");
const { authHeaders } = require("./client");
const READ_CAPS = ["system_information","interfaces","networks","routes","gateways","dhcp","clients","dns","firewall","nat","vpn","health","connectivity_analysis"];
const CHANGE_CAPS = ["firewall_rule_mutation","nat_mutation","network_mutation","route_mutation","dhcp_reservation_mutation","safe_apply","rollback"];
function unsupported(provider, capability, reason = "Provider interface does not expose this capability") { return { state:"unsupported", provider, capability, reason }; }
function unwrap(data) { return data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "data") ? data.data : data; }
function collection(data, keys) { const value=unwrap(data); if (Array.isArray(value)) return value; for (const key of keys) if (Array.isArray(value?.[key])) return value[key]; return []; }
async function open(profile, client) { if (profile.provider !== "openwrt") return { session:null }; const session = await ow.login(client, profile); return { session }; }
async function openwrt(profile, client, session, action) {
  const u = (object, method, args) => ow.invoke(client, profile, session, object, method, args);
  if (action === "system") { const [board, info] = await Promise.all([u("system","board"), u("system","info")]); return n.device("openwrt", { ...board, ...info, version:board?.release, hostname:info?.hostname, uptime:info?.uptime }, {}); }
  if (action === "interfaces") { const x=await u("network.interface","dump"); return (x?.interface || []).map(i=>n.interfaceView("openwrt", {id:i.interface,name:i.interface,ifname:i.l3_device || i.device,state:i.up ? "up":"down",up:i.up,addresses:(i['ipv4-address']||[]).concat(i['ipv6-address']||[]).map(a=>({address:a.address,prefix:a.mask || a.prefix})),protocol:i.proto,provider_data:i}, "runtime")); }
  if (action === "routes") { const x=await u("network.route","dump").catch(()=>({route:[]})); return (x?.route || []).map(r=>n.routeView("openwrt", {id:r.target, destination:r.target && r.mask !== undefined ? `${r.target}/${r.mask}` : r.target, gateway:r.nexthop, interface:r.device, metric:r.metric, active:true, provider_data:r}, "runtime")); }
  if (action === "gateways") { const x=await u("network.route","dump").catch(()=>({route:[]})); return (x?.route || []).filter(r=>r.target === "0.0.0.0" || r.target === "::").map(r=>({address:r.nexthop || null,interface:r.device || null,monitoring:{state:"unknown",reason:"OpenWrt route dump does not itself prove gateway monitoring"},source:n.source("openwrt","runtime"),provider_data:r})); }
  if (action === "networks") { const x=await u("uci","get",{config:"network"}); const values=x?.values || {}; return Object.entries(values).filter(([,v])=>v?.type === "interface" || v?.type === "bridge-vlan").map(([id,v])=>n.networkView("openwrt", {id,name:id,subnet:v.ipaddr && v.netmask ? `${v.ipaddr}/${v.netmask}` : null,vlan_id:v.vid ?? null,interfaces:v.ifname || v.device || [],gateway:v.gateway,dns:v.dns,provider_data:v})); }
  if (action === "dhcp") { const [leases, configs] = await Promise.all([u("dhcp","ipv4leases").catch(()=>({leases:[]})), u("uci","get",{config:"dhcp"}).catch(()=>({values:{}}))]); return { servers:Object.entries(configs.values || {}).filter(([,v])=>v?.type === "dhcp").map(([id,v])=>({id,interface:v.interface,start:v.start,limit:v.limit,leasetime:v.leasetime,source:n.source("openwrt","configured")})), leases:(leases.leases || []).map(x=>({mac:x.mac,ip:x.ip,hostname:x.hostname,expires:x.expires,source:n.source("openwrt","runtime")})) }; }
  if (action === "firewall") { const [zones, rules] = await Promise.all([u("uci","get",{config:"firewall"}), u("uci","get",{config:"firewall"})]); const values=zones.values || {}; return { zones:Object.entries(values).filter(([,v])=>v?.type === "zone").map(([id,v])=>({id,name:id,input:v.input,output:v.output,forward:v.forward,networks:v.network,source:n.source("openwrt","configured")})), rules:Object.entries(rules.values || {}).filter(([,v])=>["rule","redirect","forwarding"].includes(v?.type)).map(([id,v])=>n.ruleView("openwrt",{id,enabled:v.enabled !== "0",action:v.target || v.type,direction:v.src || null,interface:v.src,destination:v.dest,protocol:v.proto,source:v.src_ip || "any",source_port:v.src_port,destination_port:v.dest_port,description:v.name || v.comment,order:v.position,provider_data:v},"configured")) }; }
  if (action === "vpn") { const [wg, ov] = await Promise.all([u("uci","get",{config:"wireguard"}).catch(()=>({values:{}})), u("uci","get",{config:"openvpn"}).catch(()=>({values:{}}))]); return {wireguard:Object.entries(wg.values || {}).filter(([,v])=>v?.type).map(([id,v])=>({id,name:id,state:"configured",peers:[],provider_data:v})), openvpn:Object.entries(ov.values || {}).filter(([,v])=>v?.type).map(([id,v])=>({id,name:id,state:"configured",provider_data:v}))}; }
  if (action === "capabilities") { const caps={}; for (const c of READ_CAPS) caps[c]={state:"supported",evidence:"OpenWrt ubus/rpcd/UCI"}; for (const c of CHANGE_CAPS) caps[c]={state:["safe_apply","rollback"].includes(c)?"version_dependent":"supported",evidence:"UCI/ubus permissions and target version determine availability"}; return {provider:"openwrt",capabilities:caps}; }
  if (action === "health") { const [board, interfaces] = await Promise.all([u("system","board"),u("network.interface","dump")]); const down=(interfaces?.interface || []).filter(x=>x.up===false).length; return {state:down ? "degraded":"healthy", checks:{management:{state:"healthy",evidence:"authenticated ubus session"},interfaces:{state:down?"warning":"healthy",down},system:{state:"healthy",release:board?.release}}, source:n.source("openwrt","runtime")}; }
  throw new NetworkFirewallError("invalid_input", `Unknown OpenWrt action ${action}`);
}
const REST_PATHS = { opnsense:{system:"/api/core/firmware/info",interfaces:"/api/interfaces/overview/export",routes:"/api/routes/routes/get",firewall:"/api/firewall/filter/searchRule",dhcp:"/api/dhcpv4/leases/search"}, pfsense:{system:"/api/v1/system/version",interfaces:"/api/v1/interfaces",routes:"/api/v1/routing/routes",firewall:"/api/v1/firewall/rules",dhcp:"/api/v1/services/dhcp/leases"}, unifi:{system:"/v1/info",interfaces:"/v1/devices",networks:"/v1/sites",clients:"/v1/clients"} };
async function generic(profile, client, action) {
  if (action === "capabilities") {
    const paths = REST_PATHS[profile.provider] || {};
    const capabilities = {};
    for (const c of READ_CAPS) capabilities[c] = paths[c] ? {state:"version_dependent", evidence:`Configured official ${profile.provider} API path for ${c}; permissions and provider version still apply`} : {state:"unsupported", evidence:`No official ${profile.provider} endpoint mapped for ${c}`};
    for (const c of CHANGE_CAPS) capabilities[c] = {state:"unsupported", evidence:"No provider-native transactional mutation and verified rollback implementation is enabled"};
    return {provider:profile.provider,capabilities};
  }
  const path=REST_PATHS[profile.provider]?.[action]; if (!path) return unsupported(profile.provider, action, "No supported official endpoint is configured for this provider/version");
  const raw=await client.get(path, authHeaders(profile));
  const data=unwrap(raw);
  if (action === "system") return n.device(profile.provider, {version:data?.version || data?.release,hostname:data?.hostname,provider_data:data}, {});
  if (action === "interfaces") return collection(data,["rows","items","interfaces"]).map(x=>n.interfaceView(profile.provider,{id:x.id||x.uuid||x.name,name:x.name||x.ifname,state:x.status||x.state,addresses:x.addresses||[],provider_data:x},"runtime"));
  if (action === "networks") return collection(data,["items","networks","sites"]).map(x=>n.networkView(profile.provider,{id:x.id||x.uuid||x.name,name:x.name,subnet:x.subnet||x.ip_subnet,vlan_id:x.vlan_id||x.vlan,interfaces:x.interfaces,provider_data:x}));
  if (action === "routes") return collection(data,["rows","items","routes"]).map(x=>n.routeView(profile.provider,{id:x.id,destination:x.destination||x.network,gateway:x.gateway||x.next_hop,interface:x.interface,metric:x.metric,active:x.active,provider_data:x},"runtime"));
  if (action === "firewall") return {rules:collection(data,["rows","items","rules"]).map(x=>n.ruleView(profile.provider,{id:x.id||x.uuid,name:x.name,enabled:x.enabled,action:x.action,interface:x.interface,protocol:x.protocol,source:x.source,destination:x.destination,destination_port:x.destination_port,order:x.sequence,description:x.description,provider_data:x},"configured")), limitation:profile.provider === "opnsense" ? "OPNsense automation API only reports automation-managed rules; effective rules outside that component remain unknown":"Provider API response"};
  if (action === "dhcp") return {leases:collection(data,["rows","items","leases"]).map(x=>({mac:x.mac||x.mac_address,ip:x.ip||x.address,hostname:x.hostname||x.name,expires:x.expire||x.expires,source:n.source(profile.provider,"runtime")}))};
  if (action === "clients") return {clients:collection(data,["items","clients"]).map(x=>({id:x.id||x.uuid,mac:x.mac||x.macAddress,ip:x.ip||x.ipAddress,hostname:x.name||x.hostname,network:x.network||x.site,source:n.source(profile.provider,"runtime")}))};
  return data;
}
async function read(profile, client, action) { const opened=await open(profile,client); if(profile.provider === "openwrt") return openwrt(profile,client,opened.session,action); return generic(profile,client,action); }
async function openwrtMutation(profile, client, mutation) {
  const session=await ow.login(client,profile); const u=(object,method,args)=>ow.invoke(client,profile,session,object,method,args);
  if (!["rule_create","rule_update","rule_enable","rule_disable","rule_delete"].includes(mutation.action)) return unsupported("openwrt", mutation.action, "This provider-specific mutation is not exposed by the reference implementation");
  if (!profile.allow_mutations) throw new NetworkFirewallError("mutation_disabled", "Profile mutations are disabled");
  const section=String(mutation.id || mutation.name || ""); if (!/^[A-Za-z0-9_-]{1,48}$/.test(section)) throw new NetworkFirewallError("invalid_input", "OpenWrt rule identifier must be a bounded UCI section name");
  const allowed={name:"name",src:"src",dest:"dest",src_ip:"src_ip",dest_ip:"dest_ip",src_port:"src_port",dest_port:"dest_port",proto:"proto",target:"target",family:"family",enabled:"enabled",weekdays:"weekdays",monthdays:"monthdays",start_time:"start_time",stop_time:"stop_time",extra:"extra"};
  if (mutation.action === "rule_create") await u("uci","add",{config:"firewall",type:"rule"}).then(async result=>{ const created=result?.section || result?.name; if (!created) throw new NetworkFirewallError("apply_failed","OpenWrt did not return a created firewall section"); mutation._created=created; for (const [key,opt] of Object.entries(allowed)) if (mutation[key] !== undefined) await u("uci","set",{config:"firewall",section:created,option:opt,value:String(mutation[key])}); });
  else if (mutation.action === "rule_delete") await u("uci","delete",{config:"firewall",section});
  else { const value=mutation.action === "rule_enable" ? "1" : mutation.action === "rule_disable" ? "0" : null; if (value !== null) await u("uci","set",{config:"firewall",section,option:"enabled",value}); else for (const [key,opt] of Object.entries(allowed)) if (mutation[key] !== undefined) await u("uci","set",{config:"firewall",section,option:opt,value:String(mutation[key])}); }
  const applied=await u("uci","apply",{rollback:true,timeout:10});
  if (applied === undefined) throw new NetworkFirewallError("apply_failed", "OpenWrt rejected UCI apply");
  // Verify the authenticated management path before confirming the provider's
  // rollback timer. If this read cannot complete, deliberately leave the
  // provider transaction unconfirmed so OpenWrt can roll it back.
  await u("system","board");
  const confirmed=await u("uci","confirm",{}).catch(e=>{ throw new NetworkFirewallError("verification_failed", "OpenWrt apply could not be confirmed", {cause:e.code}); });
  return {provider:"openwrt", action:mutation.action, outcome:"applied_and_confirmed", rollback_protection:true, confirmation:confirmed ?? null, section:mutation._created || section};
}
module.exports = { read, openwrtMutation, unsupported, READ_CAPS, CHANGE_CAPS };
