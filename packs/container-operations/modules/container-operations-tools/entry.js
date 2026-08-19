"use strict";

const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");
const profiles = require("./lib/profiles");
const operations = require("./lib/operations");
const compose = require("./lib/compose");
const { createClient } = require("./lib/client");
const { ContainerError } = require("./lib/errors");

function result(payload) { return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }; }
function failure(error) { const known = error instanceof ContainerError; return { content: [{ type: "text", text: JSON.stringify({ ok: false, code: known ? error.code : "internal_error", error: String(error.message || error).replace(/(secret|token|password|authorization)[^\s]*/gi, "$1=[REDACTED]"), details: known ? error.details : {} }, null, 2) }], isError: true }; }
function session(config, profile, runtime) { const selected = profiles.resolve(config, profile); return { profile: selected, client: createClient(selected, runtime?.signal) }; }

const READ_ACTIONS = ["engines", "capabilities", "summary", "list", "inspect", "health", "stats", "logs", "images", "networks", "volumes", "ports", "updates", "orphans"];
const MUTATION_ACTIONS = ["start", "stop", "restart", "pull", "recreate"];

async function handleContainers(services, args, runtime) {
  const config = services.config || {};
  try {
    if (args.action === "engines") return result({ ok: true, action: args.action, profiles: profiles.listProfiles(config) });
    const { profile, client } = session(config, args.profile, runtime);
    let data;
    switch (args.action) {
      case "capabilities": data = await operations.capabilities(client, profile); break;
      case "summary": data = await operations.summary(client); break;
      case "list": data = { containers: await operations.list(client, args.all !== false) }; break;
      case "inspect": data = { container: await operations.inspect(client, args.target) }; break;
      case "health": { const summary = await operations.summary(client); data = { status: summary.health, evidence: summary }; break; }
      case "stats": data = { stats: await operations.stats(client, args.target) }; break;
      case "logs": data = { logs: await operations.logs(client, args.target, args) }; break;
      case "images": data = { images: await operations.images(client) }; break;
      case "networks": data = { networks: await operations.networks(client) }; break;
      case "volumes": data = { volumes: await operations.volumes(client) }; break;
      case "ports": { const containers = await operations.list(client); data = { ports: containers.flatMap(c => Object.entries(c.ports || {}).flatMap(([containerPort, bindings]) => (bindings || []).map(b => ({ container: c.name, container_port: containerPort, host_ip: b.HostIp || "0.0.0.0", host_port: b.HostPort, protocol: containerPort.split("/")[1] || "tcp" })))) }; break; }
      case "updates": data = await operations.updates(client); break;
      case "orphans": { const [containers, networks, volumes, images] = await Promise.all([operations.list(client), operations.networks(client), operations.volumes(client), operations.images(client)]); data = { containers: containers.filter(c => !c.compose.project), networks: networks.filter(n => !n.containers.length), volumes: volumes.filter(v => !v.usage || !v.usage.RefCount), images: images.filter(i => i.dangling && (!i.containers || i.containers === 0)), destructive_cleanup: "not_available" }; break; }
      default:
        if (!MUTATION_ACTIONS.includes(args.action)) throw new ContainerError("invalid_input", `Unknown containers action "${args.action}"`);
        if (!profile.allow_mutations) throw new ContainerError("policy_denied", `Mutations are disabled for engine profile "${profile.name}"`);
        if (args.action === "pull") data = await operations.pull(client, args.image);
        else if (args.action === "recreate") data = await operations.recreate(client, args.target);
        else data = await operations.action(client, args.target, args.action);
    }
    return result({ ok: true, action: args.action, profile: profile.name, provider: profile.provider, ...data });
  } catch (error) { return failure(error); }
}

async function handleCompose(services, args, runtime) {
  try { const profile = profiles.resolve(services.config || {}, args.profile); const client = createClient(profile, runtime?.signal); if (["projects", "inspect"].includes(args.action)) { const containers = await operations.list(client); const grouped = new Map(); for (const c of containers) if (c.compose.project) { const p = grouped.get(c.compose.project) || { project: c.compose.project, services: [], containers: [], networks: new Set() }; p.services.push(c.compose.service || c.name); p.containers.push({ name: c.name, health: c.health, running: c.running, image: c.image }); c.networks.forEach(n => p.networks.add(n)); grouped.set(c.compose.project, p); } return result({ ok: true, action: args.action, profile: profile.name, projects: [...grouped.values()].map(p => ({ ...p, services: [...new Set(p.services)], networks: [...p.networks] })) }); } if (["diff", "preflight"].includes(args.action)) return result({ ok: true, action: args.action, profile: profile.name, status: "unknown", reason: "repository comparison requires an explicitly selected configured Compose file; validate that file first" }); return result({ ok: true, action: args.action, ...(await compose.execute(profile, services.config || {}, "validate", args.file)) }); } catch (error) { return failure(error); }
}

const entry = {
  buildDescriptors(services) {
    return [
      { name: "containers", description: "Inspect configured Docker and Podman engines and perform bounded, normalized container operations. Read actions include engines, capabilities, summary, list, inspect, health, stats, logs, images, networks, volumes, ports, updates and orphans.", schema: z.object({ action: z.enum(READ_ACTIONS), profile: z.string().max(63).optional(), target: z.string().max(256).optional(), all: z.boolean().optional(), tail: z.number().int().min(1).max(10000).optional(), since: z.number().min(0).optional(), max_bytes: z.number().int().min(1024).max(1000000).optional(), max_lines: z.number().int().min(1).max(10000).optional() }), args: { action: `string (${READ_ACTIONS.join("|")})`, profile: "string", target: "string", all: "boolean", tail: "number", since: "number", max_bytes: "number", max_lines: "number" }, risk: "low", category: "Infrastructure & Homelab", handler: (args, runtime) => handleContainers(services, args, runtime) },
      { name: "container_lifecycle", description: "Governed start, stop, restart, or image pull for an administrator-configured Docker/Podman profile. No raw CLI arguments or arbitrary commands are accepted.", schema: z.object({ action: z.enum(MUTATION_ACTIONS), profile: z.string().max(63).optional(), target: z.string().max(256).optional(), image: z.string().max(256).optional() }), args: { action: `string (${MUTATION_ACTIONS.join("|")})`, profile: "string", target: "string", image: "string" }, risk: "high", category: "Infrastructure & Homelab", handler: (args, runtime) => handleContainers(services, args, runtime) },
      { name: "compose", description: "Inspect configured Compose projects and run provider-authoritative validation using an administrator-allowed project root. Paths and binaries are allowlisted; shell interpretation and arbitrary arguments are unavailable.", schema: z.object({ action: z.enum(["projects", "inspect", "validate", "diff", "preflight"]), profile: z.string().max(63).optional(), file: z.string().max(500).optional() }), args: { action: "string (projects|inspect|validate|diff|preflight)", profile: "string", file: "string" }, risk: "low", category: "Infrastructure & Homelab", handler: args => handleCompose(services, args) },
      { name: "compose_mutation", description: "Governed Compose mutation surface reserved for explicit provider-supported update operations; no arbitrary Compose arguments are accepted.", schema: z.object({ action: z.enum(["update"]), profile: z.string().max(63).optional(), file: z.string().max(500), service: z.string().max(128).optional() }), args: { action: "string (update)", profile: "string", file: "string", service: "string" }, risk: "high", category: "Infrastructure & Homelab", handler: () => failure(new ContainerError("unsupported", "Compose update requires a captured deployment plan and is not available through this direct action")) },
    ];
  },
  healthCheck({ config }) { const list = profiles.listProfiles(config || {}); const invalid = list.filter(p => p.valid === false); return { ok: invalid.length === 0, details: { profiles: list.length, profile_names: list.map(p => p.name), invalid_profiles: invalid, configured: list.length > 0 } }; },
};

module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
