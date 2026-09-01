"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const identifier = value => typeof value === "string" && IDENTIFIER.test(value);
const host = value => typeof value === "string" && value.length <= 253 && /^[A-Za-z0-9][A-Za-z0-9.:-]*[A-Za-z0-9]$/.test(value);
const protocol = value => ["tcp", "udp", "icmp", "icmpv6", "sctp"].includes(String(value || "").toLowerCase());
function failure(code, error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, code, error }) }], isError: true, code }; }
async function read(services, tool, args) { try { return await services.dispatch(tool, args); } catch (error) { return { state: "unavailable", code: error.code || "provider_unavailable", error: String(error.message || error).slice(0, 300) }; } }

function buildDescriptors(services) {
  const nginxActions = ["status", "list_sites", "test_config", "reload", "add_site", "remove_site"];
  return [
    {
      name: "network_service_audit", description: "Collect bounded network, DHCP, VPN, and Nginx service evidence through configured providers.",
      schema: z.object({ profile: z.string().regex(IDENTIFIER).or(z.literal("")).optional() }).strict(), args: { profile: "string" }, risk: "low", category: "Network Services",
      handler: async args => { const profile = args.profile || services.config?.default_profile; return { content: [{ type: "text", text: JSON.stringify({ network: await read(services, "network", { action: "summary", profile }), dhcp: await read(services, "dhcp", { action: "status", profile }), vpn: await read(services, "vpn", { action: "status", profile }), nginx: await read(services, "nginx", { action: "status" }) }, null, 2) }] }; },
    },
    {
      name: "network_connectivity_review", description: "Run deterministic provider connectivity analysis; unknown effective policy remains unknown.",
      schema: z.object({ profile: z.string().regex(IDENTIFIER).or(z.literal("")).optional(), source: z.string().min(1).max(255).regex(/^[^\u0000\r\n\s]+$/), destination: z.string().min(1).max(255).regex(/^[^\u0000\r\n\s]+$/), protocol: z.enum(["tcp", "udp", "icmp", "icmpv6", "sctp"]), port: z.number().int().min(1).max(65535).optional() }).strict(), args: { profile: "string", source: "string", destination: "string", protocol: "string", port: "number" }, risk: "low", category: "Network Services",
      handler: args => !protocol(args.protocol) || !host(args.source) || !host(args.destination) || ((["tcp", "udp", "sctp"].includes(args.protocol)) && args.port === undefined) ? failure("invalid_input", "source, destination, protocol, and transport port must be valid") : services.dispatch("network", { action: "path", ...args }),
    },
    {
      name: "network_nginx_operation", description: "Inspect or change Nginx through its governed manager; configuration changes retain high risk and provider policy.",
      schema: z.object({ action: z.enum(nginxActions), site_name: z.string().regex(IDENTIFIER).optional(), domain: z.string().regex(/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/).optional(), upstream_port: z.number().int().min(1).max(65535).optional(), ssl_email: z.string().email().max(255).optional() }).strict().superRefine((value, ctx) => { if (value.action === "add_site" && (!value.domain || value.upstream_port === undefined)) ctx.addIssue({ code: "custom", message: "add_site requires domain and upstream_port" }); if (value.action === "remove_site" && !value.site_name) ctx.addIssue({ code: "custom", message: "remove_site requires site_name" }); }), args: { action: "string (status|list_sites|test_config|reload|add_site|remove_site)", site_name: "string", domain: "string", upstream_port: "number", ssl_email: "string" }, risk: "high", category: "Network Services",
      handler: args => (args.action === "add_site" && (!args.domain || !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(args.domain) || args.upstream_port === undefined || args.upstream_port < 1 || args.upstream_port > 65535)) || (args.action === "remove_site" && !identifier(args.site_name)) ? failure("invalid_input", "add_site requires a valid domain and port; remove_site requires site_name") : services.dispatch("nginx", args),
    },
  ];
}
function healthCheck({ config }) { const profile = config && config.default_profile; const valid = profile === undefined || profile === "" || identifier(profile); return { ok: valid, details: { default_profile: profile || null, invalid_configuration: valid ? null : "default_profile must be an identifier", detection: "delegated to configured network, DHCP, VPN and Nginx providers", mutations: "provider-governed" } }; }
module.exports = { buildDescriptors, healthCheck };
