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
const provision = require("./lib/provision");
const policy = require("./lib/policy");
const provenance = require("./lib/provenance");
const ansible = require("./lib/ansible");
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
      case "list_snapshots": data = await provision.snapshotList(client, { node: requireNode(args), vmid: requireVmid(args) }); break;
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
  "list_snapshots", "backup_status", "version", "list_profiles", "detect_providers",
];

const PROVISION_ACTIONS = ["create_vm", "create_lxc", "clone", "configure", "snapshot_create", "convert_template"];

// Actions that act on an EXISTING guest, so protection/provenance facts are
// resolved before the operation and gated deterministically.
const PROVISION_ON_EXISTING = new Set(["configure", "convert_template", "snapshot_create"]);

function protectedMatchers(services) {
  const cfg = services.config || {};
  return Array.isArray(cfg.protected_resources) ? cfg.protected_resources : [];
}

// Resolve the facts (provenance + protection) for an existing target guest.
async function resolveTargetFacts(client, vmid) {
  const located = await provision.findGuestKind(client, vmid);
  const config = await client.get(["nodes", located.node, located.kind, vmid, "config"]).catch(() => ({}));
  const ev = provenance.readProvenance(config);
  return {
    node: located.node,
    kind: located.kind,
    vmid,
    name: config && config.name ? String(config.name) : (config && config.hostname ? String(config.hostname) : null),
    tags: ev.tags,
    proxmox_protection: ev.protection,
    provenanceEvidence: ev,
  };
}

async function handleProvision(services, args, runtime) {
  const config = services.config || {};
  const action = args.action;
  const context = runtime && runtime.context;
  const session = service.openSession(config, args.profile, runtime && runtime.signal);
  if (!session.ok) return errorResult(new ProxmoxError(session.code, session.message));
  const { client, profile } = session;
  const dryRun = args.dry_run === true;

  try {
    // For operations on an existing guest, resolve facts and run policy first.
    let facts = null;
    let decision = { result: "allowed", reasons: [] };
    if (PROVISION_ON_EXISTING.has(action)) {
      const vmid = requireVmid(args);
      facts = await resolveTargetFacts(client, vmid);
      // protected_resources is documented as a hard deny for ALL mutating
      // operations, so every operation on an existing guest — snapshot
      // included — is refused when the target is protected.
      decision = policy.decide({ matchers: protectedMatchers(services), target: facts, provenance: facts.provenanceEvidence, requireOwnership: false, blockIfProtected: true });
    }

    const expected = expectedEffect(action, args, facts);
    const plan = policy.explain({
      operation: action,
      profile: profile.name,
      target: facts || { node: args.node, vmid: args.vmid, name: args.name || null },
      decision,
      expected_effect: expected,
      provenance: facts ? facts.provenanceEvidence : null,
    });

    if (decision.result === "denied") {
      return jsonResult({ ok: false, action, profile: profile.name, code: "protected_resource", explain: plan, error: `Operation denied by policy: ${decision.reasons.join("; ")}` });
    }
    if (dryRun) {
      return jsonResult({ ok: true, action, profile: profile.name, dry_run: true, explain: plan, note: "Dry run: no changes were made. Re-invoke without dry_run to apply." });
    }

    let result;
    switch (action) {
      case "create_vm": result = await provision.createVm(client, profile, args.vm || {}, context); break;
      case "create_lxc": result = await provision.createLxc(client, profile, args.lxc || {}, context); break;
      case "clone": result = await provision.cloneGuest(client, profile, args.clone || {}, context); break;
      case "configure": result = await provision.configureGuest(client, profile, { node: facts.node, vmid: facts.vmid, ...(args.configure || {}) }, context); break;
      case "snapshot_create": result = await provision.snapshotCreate(client, profile, { node: facts.node, vmid: facts.vmid, ...(args.snapshot || {}) }, context); break;
      case "convert_template": result = await provision.convertTemplate(client, profile, { node: facts.node, vmid: facts.vmid }, context); break;
      default: return errorResult(new ProxmoxError("invalid_input", `Unknown provision action "${action}"`));
    }
    return jsonResult({ ok: result.outcome !== "task_failed", action, profile: profile.name, explain: plan, ...result });
  } catch (error) {
    return errorResult(error);
  }
}

async function handleAnsible(services, args, runtime) {
  const config = services.config || {};
  const action = args.action;
  if (action === "detect") {
    return jsonResult({ ok: true, action, ansible: ansible.detect(config) });
  }
  if (action === "run" || action === "dry_run") {
    const result = await ansible.run(
      config,
      (name, a, opts) => services.dispatch(name, a, opts),
      { playbook: args.playbook, hosts: args.hosts, extra_vars: args.extra_vars, limit: args.limit },
      { dryRun: action === "dry_run", timeoutMs: args.timeout_ms }
    );
    return jsonResult({ action, ...result });
  }
  return errorResult(new ProxmoxError("invalid_input", `Unknown ansible action "${action}"`));
}

function expectedEffect(action, args, facts) {
  switch (action) {
    case "create_vm": return `Create a new QEMU VM${args.vm && args.vm.name ? ` named "${args.vm.name}"` : ""} tagged sidekick-managed.`;
    case "create_lxc": return `Create a new LXC container${args.lxc && args.lxc.hostname ? ` "${args.lxc.hostname}"` : ""} tagged sidekick-managed.`;
    case "clone": return `Clone source VMID ${args.clone && args.clone.source_vmid} into a new guest tagged sidekick-managed.`;
    case "configure": return `Change configuration (${Object.keys(args.configure || {}).join(", ")}) on VMID ${facts && facts.vmid}.`;
    case "snapshot_create": return `Create snapshot "${args.snapshot && args.snapshot.snapname}" on VMID ${facts && facts.vmid}.`;
    case "convert_template": return `Convert VMID ${facts && facts.vmid} into a template.`;
    default: return null;
  }
}

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
      {
        name: "proxmox_provision",
        aliases: ["pve_provision"],
        description:
          "Create and shape Proxmox guests through controlled, provenance-tagged operations: create_vm, create_lxc, clone (with cloud-init), configure (cpu/memory), snapshot_create, convert_template. Selects an administrator-configured profile by name. Every created resource is tagged sidekick-managed with a provenance marker. Supports dry_run to return a resolved explain/plan (target, protection, provenance, expected effect, policy decision) without making changes. Honours administrator-configured protected_resources. Does NOT delete, destroy, migrate, or perform host/cluster administration.",
        schema: z.object({
          action: z.enum(PROVISION_ACTIONS).describe("The provisioning operation"),
          profile: z.string().max(63).optional().describe("Configured Proxmox profile name"),
          dry_run: z.boolean().optional().describe("Return a resolved plan without making changes"),
          node: z.string().max(63).optional().describe("Target node (for configure/snapshot_create/convert_template)"),
          vmid: z.union([z.number().int(), z.string()]).optional().describe("Target VMID (for configure/snapshot_create/convert_template)"),
          vm: z.object({
            node: z.string().max(63),
            vmid: z.union([z.number().int(), z.string()]).optional(),
            name: z.string().max(63).optional(),
            cores: z.number().int().min(1).max(128).optional(),
            memory: z.number().int().min(16).max(4194304).optional().describe("Memory in MB"),
            ostype: z.string().max(16).optional(),
            iso: z.string().max(200).optional().describe("ISO volume id, e.g. local:iso/x.iso"),
            disk: z.object({ storage: z.string().max(100), size_gb: z.number().int().min(1).max(8192) }).optional(),
            net: z.object({ model: z.string().max(16).optional(), bridge: z.string().max(16).optional(), vlan: z.number().int().optional() }).optional(),
            description: z.string().max(4000).optional(),
          }).optional().describe("create_vm parameters"),
          lxc: z.object({
            node: z.string().max(63),
            vmid: z.union([z.number().int(), z.string()]).optional(),
            ostemplate: z.string().max(200),
            hostname: z.string().max(63).optional(),
            cores: z.number().int().min(1).max(128).optional(),
            memory: z.number().int().min(16).max(4194304).optional(),
            ostype: z.string().max(16).optional(),
            rootfs: z.object({ storage: z.string().max(100), size_gb: z.number().int().min(1).max(8192).optional() }),
            net: z.object({ bridge: z.string().max(16).optional(), vlan: z.number().int().optional() }).optional(),
            ssh_keys: z.array(z.string().max(4096)).max(16).optional(),
            description: z.string().max(4000).optional(),
          }).optional().describe("create_lxc parameters"),
          clone: z.object({
            node: z.string().max(63),
            source_vmid: z.union([z.number().int(), z.string()]),
            newid: z.union([z.number().int(), z.string()]).optional(),
            name: z.string().max(63).optional(),
            full: z.boolean().optional(),
            storage: z.string().max(100).optional(),
            cloud_init: z.object({ user: z.string().max(32).optional(), ssh_keys: z.array(z.string().max(4096)).max(16).optional(), ip: z.string().max(64).optional() }).optional(),
            description: z.string().max(4000).optional(),
          }).optional().describe("clone parameters"),
          configure: z.object({
            cores: z.number().int().min(1).max(128).optional(),
            memory: z.number().int().min(16).max(4194304).optional(),
            description: z.string().max(8000).optional(),
          }).optional().describe("configure parameters (applied to node/vmid)"),
          snapshot: z.object({
            snapname: z.string().max(40),
            description: z.string().max(2000).optional(),
            include_ram: z.boolean().optional(),
          }).optional().describe("snapshot_create parameters (applied to node/vmid)"),
        }),
        args: {
          action: `string (${PROVISION_ACTIONS.join("|")})`,
          profile: "string (configured profile name)",
          dry_run: "boolean (return a plan without changes)",
          node: "string (node, for configure/snapshot_create/convert_template)",
          vmid: "number|string (target guest, for configure/snapshot_create/convert_template)",
          vm: "object (create_vm parameters)",
          lxc: "object (create_lxc parameters)",
          clone: "object (clone parameters)",
          configure: "object (cores/memory/description)",
          snapshot: "object (snapname/description/include_ram)",
        },
        risk: "high",
        category: "Infrastructure",
        handler: (args, runtime) => handleProvision(services, args, runtime),
      },
      {
        name: "ansible_run",
        aliases: ["ansible_playbook"],
        description:
          "Optionally configure reachable hosts by running an ALLOWLISTED Ansible playbook against a structured inventory. Provider-agnostic (composes with, but does not depend on, Proxmox provisioning). Actions: detect (report availability/configuration), dry_run (return the exact resolved command, generated inventory, and extra-var keys without executing), run (execute through Sidekick's governed shell and report per-host results parsed from Ansible's JSON output). A model cannot supply a playbook path, role, ad-hoc module, inventory script, or command arguments; only an allowlisted playbook name, validated hosts, and structured scalar extra-vars. Host key checking stays enabled. Ansible is optional; when absent this reports not_installed.",
        schema: z.object({
          action: z.enum(["detect", "dry_run", "run"]).describe("The Ansible operation"),
          playbook: z.string().max(128).optional().describe("Allowlisted playbook file name (e.g. baseline.yml), for run/dry_run"),
          hosts: z.array(z.object({
            alias: z.string().max(63),
            host: z.string().max(253),
            user: z.string().max(32).optional(),
            port: z.number().int().optional(),
            ssh_key_file: z.string().max(256).optional(),
          })).max(64).optional().describe("Structured inventory hosts, for run/dry_run"),
          extra_vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])).optional().describe("Structured scalar extra variables"),
          limit: z.string().max(63).optional().describe("Restrict the run to one host alias"),
          timeout_ms: z.number().int().min(1000).max(3600000).optional().describe("Execution timeout"),
        }),
        args: {
          action: "string (detect|dry_run|run)",
          playbook: "string (allowlisted playbook file name)",
          hosts: "array (inventory hosts: alias, host, user?, port?, ssh_key_file?)",
          extra_vars: "object (scalar variables)",
          limit: "string (host alias)",
          timeout_ms: "number",
        },
        risk: "high",
        category: "Infrastructure",
        handler: (args, runtime) => handleAnsible(services, args, runtime),
      },
    ];
  },

  healthCheck({ config }) {
    // Cheap and synchronous by contract: validate configuration shape and
    // report profile readiness WITHOUT any network call or secret value.
    const profileList = profilesLib.listProfiles(config || {});
    const invalid = profileList.filter(p => !p.valid);
    const details = {
      tools: 4,
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
