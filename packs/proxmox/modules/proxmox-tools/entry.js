"use strict";

/**
 * proxmox-tools module — the runtime of the Proxmox VE capability pack.
 *
 * Contributes two tools, split by risk because a module tool's risk is
 * per-tool and cannot be lowered per action:
 *
 *   proxmox        (low)   read-only discovery, status and capability detection
 *   proxmox_guest  (high)  the controlled guest lifecycle actions
 *
 * The endpoint is never model-supplied: a tool selects an administrator
 * configured profile by NAME, and the client, credentials and TLS trust are
 * resolved server-side. Credentials never appear in any result, log or error.
 * See lib/client.js and lib/profiles.js for the security invariants.
 */

const { requireFromSidekick } = require("./lib/deps");
const service = require("./lib/service");
const operations = require("./lib/operations");
const lifecycle = require("./lib/lifecycle");
const capabilities = require("./lib/capabilities");
const providers = require("./lib/providers");
const profilesLib = require("./lib/profiles");
const validate = require("./lib/validate");
const { ProxmoxError } = require("./lib/errors");
const { scrubSecrets } = require("./lib/client");

const { z } = requireFromSidekick("zod");

function jsonResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(error) {
  const isProxmox = error instanceof ProxmoxError;
  const code = isProxmox ? error.code : "internal_error";
  const details = isProxmox ? error.details || {} : {};
  // Defense in depth: ProxmoxError messages are already scrubbed at their
  // source, but an unforeseen generic exception could stringify something
  // sensitive. Run every outgoing message through the pattern scrubber (no
  // token value needed — the patterns catch PVEAPIToken/Authorization forms).
  const message = scrubSecrets(String((error && error.message) || error || "Unknown error"), null);
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, code, details }, null, 2) }],
    isError: true,
    code,
  };
}

// Validate a model-supplied vmid/node/storage before it can reach a request.
function requireVmid(args) {
  const v = validate.validateVmid(args.vmid);
  if (!v.ok) throw new ProxmoxError("invalid_input", v.message, { field: "vmid" });
  return v.value;
}
function optionalNode(args) {
  if (args.node === undefined || args.node === null || args.node === "") return undefined;
  const n = validate.validateNodeName(args.node);
  if (!n.ok) throw new ProxmoxError("invalid_input", n.message, { field: "node" });
  return n.value;
}
function requireStorage(args) {
  const s = validate.validateStorageId(args.storage);
  if (!s.ok) throw new ProxmoxError("invalid_input", s.message, { field: "storage" });
  return s.value;
}

// --- read tool -------------------------------------------------------------

async function handleRead(services, args, runtime) {
  const config = services.config || {};
  const action = args.action;

  // Actions that do not open an API session.
  if (action === "list_profiles") {
    return jsonResult({ ok: true, action, profiles: profilesLib.listProfiles(config) });
  }
  if (action === "detect_providers") {
    return jsonResult({ ok: true, action, providers: providers.detectAll(["ansible", "nodex", "ssh", "opentofu", "terraform"]) });
  }

  const session = service.openSession(config, args.profile, runtime && runtime.signal);
  if (!session.ok) return errorResult(new ProxmoxError(session.code, session.message));
  const { client, profile } = session;

  try {
    let data;
    switch (action) {
      case "cluster_summary": data = await operations.clusterSummary(client); break;
      case "capabilities": data = await capabilities.detectCapabilities(client, profile); break;
      case "list_nodes": data = await operations.listNodes(client); break;
      case "node_status": data = await operations.nodeStatus(client, requireNode(args)); break;
      case "list_guests": data = await operations.listGuests(client, { node: optionalNode(args), type: args.type }); break;
      case "guest_status": data = await operations.guestStatus(client, { vmid: requireVmid(args), node: optionalNode(args) }); break;
      case "list_storage": data = await operations.listStorage(client, { node: optionalNode(args) }); break;
      case "storage_status": data = await operations.storageStatus(client, { node: requireNode(args), storage: requireStorage(args) }); break;
      case "list_tasks": data = await operations.listTasks(client, { node: optionalNode(args), limit: args.limit, errors: args.errors }); break;
      case "task_status": data = await operations.taskStatus(client, { upid: requireUpid(args), node: optionalNode(args) }); break;
      case "backup_status": data = await operations.backupStatus(client); break;
      case "version": data = await operations.versionStatus(client); break;
      default:
        return errorResult(new ProxmoxError("invalid_input", `Unknown action "${action}"`));
    }
    return jsonResult({ ok: true, action, profile: profile.name, ...wrap(data) });
  } catch (error) {
    return errorResult(error);
  }
}

function requireNode(args) {
  const n = validate.validateNodeName(args.node);
  if (!n.ok) throw new ProxmoxError("invalid_input", n.message, { field: "node" });
  return n.value;
}
function requireUpid(args) {
  const u = validate.parseUpid(args.upid);
  if (!u.ok) throw new ProxmoxError("invalid_input", u.message, { field: "upid" });
  return u.value;
}
// Keep the structured payload under a stable key when it is not already an object with named fields.
function wrap(data) {
  return data && typeof data === "object" && !Array.isArray(data) ? data : { data };
}

// --- guest lifecycle tool --------------------------------------------------

async function handleGuest(services, args, runtime) {
  const config = services.config || {};
  const action = args.action;
  const session = service.openSession(config, args.profile, runtime && runtime.signal);
  if (!session.ok) return errorResult(new ProxmoxError(session.code, session.message));
  const { client, profile } = session;
  try {
    const vmid = requireVmid(args);
    const result = await lifecycle.performAction(client, profile, { action, vmid, wait: args.wait });
    return jsonResult({ ok: result.outcome !== "task_failed", action, profile: profile.name, ...result });
  } catch (error) {
    return errorResult(error);
  }
}

// --- module contract -------------------------------------------------------

const READ_ACTIONS = [
  "cluster_summary", "capabilities", "list_nodes", "node_status", "list_guests",
  "guest_status", "list_storage", "storage_status", "list_tasks", "task_status",
  "backup_status", "version", "list_profiles", "detect_providers",
];

const entry = {
  buildDescriptors(services) {
    return [
      {
        name: "proxmox",
        aliases: ["pve"],
        description:
          "Inspect a Proxmox VE environment (read-only): cluster_summary, capabilities (detect PBS/Ceph/SDN/guest-agent/cloud-init/optional automation), list_nodes, node_status, list_guests, guest_status (with QEMU guest-agent enrichment when available), list_storage, storage_status, list_tasks, task_status, backup_status, version, list_profiles, detect_providers. Selects an administrator-configured profile by name; never accepts a raw endpoint.",
        schema: z.object({
          action: z.enum(READ_ACTIONS).describe("The read operation to perform"),
          profile: z.string().max(63).optional().describe("Configured Proxmox profile name (omit when only one profile is configured)"),
          node: z.string().max(63).optional().describe("Node name, for node_status/storage_status or to scope list_guests/list_storage/list_tasks"),
          vmid: z.union([z.number().int(), z.string()]).optional().describe("Guest VMID, for guest_status"),
          storage: z.string().max(100).optional().describe("Storage id, for storage_status"),
          upid: z.string().max(512).optional().describe("Task UPID, for task_status"),
          type: z.enum(["qemu", "lxc"]).optional().describe("Filter guests by type in list_guests"),
          limit: z.number().int().min(1).max(500).optional().describe("Max tasks to return in list_tasks (default 50)"),
          errors: z.boolean().optional().describe("Only error tasks in list_tasks"),
        }),
        args: {
          action: `string (${READ_ACTIONS.join("|")})`,
          profile: "string (configured profile name)",
          node: "string (node name)",
          vmid: "number|string (guest id)",
          storage: "string (storage id)",
          upid: "string (task UPID)",
          type: "string (qemu|lxc)",
          limit: "number",
          errors: "boolean",
        },
        risk: "low",
        category: "Infrastructure",
        handler: (args, runtime) => handleRead(services, args, runtime),
      },
      {
        name: "proxmox_guest",
        aliases: ["pve_guest"],
        description:
          "Perform a controlled Proxmox guest lifecycle action: start, graceful shutdown, or reboot a VM or container. Selects an administrator-configured profile by name and only acts when that profile permits lifecycle operations. Checks current state first (idempotent), submits the operation, and monitors the Proxmox task to a terminal state — success is derived from task completion, not from the request being accepted. Does not hard-stop, reset, delete, clone, migrate, or snapshot.",
        schema: z.object({
          action: z.enum(["start", "shutdown", "reboot"]).describe("Lifecycle action"),
          vmid: z.union([z.number().int(), z.string()]).describe("Guest VMID to act on"),
          profile: z.string().max(63).optional().describe("Configured Proxmox profile name (omit when only one profile is configured)"),
          wait: z.boolean().optional().describe("Wait for the task to reach a terminal state (default true)"),
        }),
        args: {
          action: "string (start|shutdown|reboot)",
          vmid: "number|string (guest id)",
          profile: "string (configured profile name)",
          wait: "boolean (default true)",
        },
        risk: "high",
        category: "Infrastructure",
        handler: (args, runtime) => handleGuest(services, args, runtime),
      },
    ];
  },

  healthCheck({ config }) {
    // Cheap and synchronous by contract: validate configuration shape and
    // report profile readiness WITHOUT any network call or secret value.
    const profileList = profilesLib.listProfiles(config || {});
    const invalid = profileList.filter(p => !p.valid);
    const details = {
      tools: 2,
      profiles: profileList.length,
      profile_names: profileList.map(p => p.name),
      invalid_profiles: invalid.map(p => ({ name: p.name, error: p.error })),
      lifecycle_enabled_profiles: profileList.filter(p => p.valid && p.allow_lifecycle).map(p => p.name),
    };
    if (invalid.length) {
      return { ok: false, error: `Invalid Proxmox profile configuration: ${invalid.map(p => p.name).join(", ")}`, details };
    }
    // Zero profiles is healthy-but-unconfigured: the pack is installed and inert
    // until an administrator configures a profile.
    return { ok: true, details };
  },
};

module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
