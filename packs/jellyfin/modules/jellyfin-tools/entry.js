"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");
const profiles = require("./lib/profiles"),
  { createClient } = require("./lib/client"),
  n = require("./lib/normalize"),
  { JellyfinError } = require("./lib/errors");
function result(x) {
  return { content: [{ type: "text", text: JSON.stringify(x, null, 2) }] };
}
function err(e) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: false,
            code: e.code || "internal_error",
            error: String(e.message || e)
              .replace(/\s+/g, " ")
              .slice(0, 500),
            details: e.details || {},
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
    code: e.code || "internal_error",
  };
}
function guard(fn) {
  return (services) => async (a, r) => {
    try {
      return result(await fn(services, a, r));
    } catch (e) {
      return err(e);
    }
  };
}
async function open(services, args, runtime) {
  const p = profiles.resolve(services.config || {}, args.profile);
  const c = profiles.credential(p);
  return { p, c: createClient(p, c.key, runtime?.signal) };
}
async function optional(fn) {
  try {
    return await fn();
  } catch (e) {
    if (
      ["not_found", "unsupported_capability", "authentication_failed"].includes(
        e.code,
      )
    )
      return null;
    throw e;
  }
}
async function getAll(client, path, query, limit = 100) {
  const data = await client.get(path, {
    ...query,
    Limit: Math.min(100, Math.max(1, limit)),
  });
  return Array.isArray(data)
    ? data
    : Array.isArray(data?.Items)
      ? data.Items
      : Array.isArray(data?.items)
        ? data.items
        : [];
}
async function read(services, args, runtime) {
  if (args.action === "list_profiles")
    return { profiles: profiles.list(services.config || {}) };
  const { p, c } = await open(services, args, runtime);
  let system, sessions, libraries, tasks, plugins;
  if (
    args.action === "version" ||
    args.action === "system_info" ||
    args.action === "capabilities" ||
    args.action === "server_profile" ||
    args.action === "status" ||
    args.action === "health"
  ) {
    system = await c.get("/System/Info");
  }
  if (args.action === "system_info")
    return { profile: p.name, server: n.systemInfo(system) };
  if (args.action === "version")
    return {
      profile: p.name,
      version: n.version(system),
      server_id: system?.Id || null,
    };
  if (args.action === "status" || args.action === "health")
    return {
      profile: p.name,
      server: n.systemInfo(system),
      reachable: true,
      authenticated: true,
    };
  if (
    args.action === "list_libraries" ||
    args.action === "library_status" ||
    args.action === "library_health" ||
    args.action === "recent_media" ||
    args.action === "metadata_issues" ||
    args.action === "duplicate_candidates"
  ) {
    libraries = await getAll(c, "/Library/VirtualFolders", null, 100);
    if (args.action === "list_libraries")
      return {
        profile: p.name,
        libraries: libraries.map((x) => ({
          id: x.ItemId || x.Id || null,
          name: x.Name || null,
          collection_type: x.CollectionType || null,
          paths: Array.isArray(x.Locations) ? x.Locations.slice(0, 20) : [],
        })),
      };
  }
  if (args.action === "search_media") {
    const items = await getAll(
      c,
      "/Items",
      {
        SearchTerm: args.query || "",
        Recursive: true,
        IncludeItemTypes: args.include_item_types || undefined,
        StartIndex: Math.max(0, args.start || 0),
      },
      Math.min(args.limit || 25, 100),
    );
    return {
      profile: p.name,
      items: items.map((x) => ({
        id: x.Id,
        name: x.Name,
        type: x.Type,
        path: x.Path || null,
        production_year: x.ProductionYear || null,
        media_sources: x.MediaSources?.length || 0,
      })),
      bounded: true,
    };
  }
  if (args.action === "item_details") {
    if (!args.item_id)
      throw new JellyfinError("invalid_input", "item_id is required");
    const x = await c.get(`/Items/${encodeURIComponent(args.item_id)}`, {
      Fields: "MediaSources,MediaStreams,Path,ProviderIds",
    });
    return {
      profile: p.name,
      item: {
        id: x.Id,
        name: x.Name,
        type: x.Type,
        path: x.Path || null,
        media_sources: x.MediaSources || [],
        media_streams: x.MediaStreams || [],
        provider_ids: x.ProviderIds || {},
      },
    };
  }
  if (
    args.action === "list_sessions" ||
    args.action === "playback_diagnose" ||
    args.action === "directplay_analysis" ||
    args.action === "transcoding_summary"
  ) {
    sessions = await c.get("/Sessions");
    const normalized = sessions.map(n.session);
    if (args.action === "list_sessions")
      return { profile: p.name, sessions: normalized.slice(0, 100) };
    if (args.action === "playback_diagnose") {
      const s = args.session_id
        ? sessions.find((x) => x.Id === args.session_id)
        : sessions[0];
      return s
        ? n.diagnose(s)
        : {
            classification: "insufficient_evidence",
            observed: [],
            unknowns: ["No matching active session"],
            recommended_next_check: "Capture an active playback session",
          };
    }
    if (args.action === "directplay_analysis")
      return {
        profile: p.name,
        scope: "current_sessions_only",
        historical_data: false,
        sessions: normalized.map((x) => ({
          id: x.id,
          method: x.playback_method,
          transcoding: Boolean(x.transcoding),
        })),
      };
    return {
      profile: p.name,
      active_transcodes: normalized.filter((x) => x.transcoding),
    };
  }
  if (
    args.action === "list_tasks" ||
    args.action === "task_status" ||
    args.action === "maintenance_plan"
  ) {
    tasks = await c.get("/ScheduledTasks");
    if (args.action === "list_tasks")
      return {
        profile: p.name,
        tasks: tasks
          .slice(0, 100)
          .map((x) => ({
            id: x.Id,
            name: x.Name,
            state: x.State,
            last_execution_result: x.LastExecutionResult || null,
            current_execution_time: x.CurrentExecutionTime || null,
          })),
      };
    if (args.action === "task_status") {
      const x = tasks.find((t) => t.Id === args.task_id);
      if (!x)
        throw new JellyfinError("not_found", "scheduled task was not found");
      return {
        profile: p.name,
        task: {
          id: x.Id,
          name: x.Name,
          state: x.State,
          last_execution_result: x.LastExecutionResult || null,
        },
      };
    }
    return {
      profile: p.name,
      recommendations: tasks
        .filter((x) => x.State === "Failed")
        .map((x) => ({
          kind: "failed_task",
          task_id: x.Id,
          name: x.Name,
          classification: "inspect_before_rerun",
        })),
      tasks_seen: tasks.length,
    };
  }
  if (
    args.action === "list_users" ||
    args.action === "user_status" ||
    args.action === "user_access_audit"
  ) {
    const users = await getAll(c, "/Users", null, 100);
    return {
      profile: p.name,
      users: users.map((x) => ({
        id: x.Id,
        name: x.Name,
        enabled: x.Policy?.IsDisabled !== true,
        is_admin: x.Policy?.IsAdministrator === true,
        has_password: x.HasPassword === true,
      })),
    };
  }
  if (args.action === "list_devices") {
    const devices = await getAll(c, "/Devices", null, 100);
    return {
      profile: p.name,
      devices: devices.map((x) => ({
        id: x.Id,
        name: x.Name,
        app_name: x.AppName,
        last_user: x.LastUserName || null,
        last_used: x.DateLastActivity || null,
      })),
    };
  }
  if (args.action === "list_plugins" || args.action === "plugin_status") {
    const ps = await c.get("/Plugins");
    return {
      profile: p.name,
      plugins: (ps || [])
        .slice(0, 100)
        .map((x) => ({
          id: x.Id,
          name: x.Name,
          version: x.Version,
          status: x.Status || "unknown",
        })),
    };
  }
  if (args.action === "metrics_summary") {
    const m = await optional(() => c.get("/System/Metric"));
    return m
      ? {
          profile: p.name,
          available: true,
          metrics: Array.isArray(m) ? m.slice(0, 100) : m,
          bounded: true,
        }
      : {
          profile: p.name,
          available: false,
          unsupported: "unsupported_capability",
        };
  }
  if (
    args.action === "activity" ||
    args.action === "logs_summary" ||
    args.action === "incident_diagnose"
  ) {
    const a = await optional(() =>
      c.get("/System/ActivityLog/Entries", {
        Limit: Math.min(args.limit || 50, 100),
        StartIndex: 0,
      }),
    );
    return {
      profile: p.name,
      evidence_sources: ["activity_log"],
      activity: Array.isArray(a) ? a.slice(0, 100) : a,
      logs_available: false,
      logs_note:
        "Raw log retrieval is intentionally not exposed by this read surface; use Jellyfin artifact/log support when available.",
    };
  }
  if (args.action === "storage_preflight")
    return {
      profile: p.name,
      state: "unknown",
      safe_for_library_state_mutation: false,
      reason:
        "Jellyfin configured paths do not establish current storage availability",
      external_dependency:
        "Use a governed host/storage capability or Proxmox guest/storage inspection when configured",
    };
  if (args.action === "backup_readiness")
    return {
      profile: p.name,
      status: "unknown",
      capability: false,
      warnings: [
        "Jellyfin does not expose a universally available built-in backup readiness API",
      ],
    };
  if (args.action === "upgrade_readiness")
    return {
      profile: p.name,
      status: "ready_with_warnings",
      current_version: n.version(system || (await c.get("/System/Info"))),
      warnings: [
        "Release discovery and plugin compatibility require official-source policy integration; no automatic upgrade is performed",
      ],
    };
  if (
    args.action === "live_tv_status" ||
    args.action === "tuner_status" ||
    args.action === "recording_status"
  ) {
    const x = await optional(() => c.get("/LiveTv/Info"));
    return x
      ? { profile: p.name, available: true, info: x }
      : {
          profile: p.name,
          available: false,
          unsupported: "unsupported_capability",
        };
  }
  if (args.action === "server_profile" || args.action === "capabilities") {
    system = system || (await c.get("/System/Info"));
    sessions = (await optional(() => c.get("/Sessions"))) || [];
    libraries = (await optional(() => c.get("/Library/VirtualFolders"))) || [];
    tasks = (await optional(() => c.get("/ScheduledTasks"))) || [];
    plugins = (await optional(() => c.get("/Plugins"))) || [];
    const live = await optional(() => c.get("/LiveTv/Info"));
    const metrics = await optional(() => c.get("/System/Metric"));
    const capabilities = n.capabilities({
      system,
      sessions,
      libraries,
      tasks,
      plugins,
      liveTv: live,
      metrics,
    });
    if (args.action === "capabilities")
      return { profile: p.name, server: n.systemInfo(system), capabilities };
    return {
      profile: p.name,
      server: n.systemInfo(system),
      reachable: true,
      authenticated: true,
      libraries: libraries.length,
      active_sessions: sessions.length,
      scheduled_tasks: tasks.length,
      plugins: plugins.length,
      capabilities,
      warnings: [],
    };
  }
  throw new JellyfinError("invalid_input", `unknown action "${args.action}"`);
}
async function maintenance(services, args, runtime) {
  const { p, c } = await open(services, args, runtime);
  if (!p.allow_writes)
    throw new JellyfinError(
      "policy_denied",
      `writes are disabled for Jellyfin profile "${p.name}"`,
    );
  if (args.dry_run === true)
    return {
      dry_run: true,
      profile: p.name,
      operation: args.action,
      target: args.task_id || args.library_id || null,
      expected_effect:
        args.action === "run_task"
          ? "run a resolved scheduled task"
          : "request a library refresh",
      storage_preflight: {
        state: "unknown",
        required_for_state_affecting_operation: true,
      },
      changes_made: false,
    };
  if (args.action === "run_task" || args.action === "cancel_task") {
    if (!args.task_id)
      throw new JellyfinError("invalid_input", "task_id is required");
    const tasks = await c.get("/ScheduledTasks");
    const t = tasks.find((x) => x.Id === args.task_id);
    if (!t)
      throw new JellyfinError("not_found", "scheduled task was not found");
    if (args.action === "run_task" && t.State === "Running")
      return {
        profile: p.name,
        task_id: t.Id,
        outcome: "already_running",
        verified: true,
      };
    if (args.action === "run_task")
      await c.post(`/ScheduledTasks/Running/${encodeURIComponent(t.Id)}`);
    else await c.del(`/ScheduledTasks/Running/${encodeURIComponent(t.Id)}`);
    const after = await c.get("/ScheduledTasks");
    const now = after.find((x) => x.Id === t.Id);
    return {
      profile: p.name,
      task_id: t.Id,
      outcome: "request_accepted",
      postcondition: { state: now?.State || "unknown" },
      verified: Boolean(now),
    };
  }
  if (args.action === "scan_library") {
    const preflight = { state: "unknown" };
    throw new JellyfinError(
      "unsafe_storage_state",
      "maintenance denied: library storage availability could not be established safely",
      { preflight },
    );
  }
  throw new JellyfinError(
    "invalid_input",
    `unknown maintenance action "${args.action}"`,
  );
}
const readActions = [
  "list_profiles",
  "status",
  "health",
  "server_profile",
  "version",
  "capabilities",
  "system_info",
  "list_libraries",
  "library_status",
  "library_health",
  "search_media",
  "item_details",
  "recent_media",
  "metadata_issues",
  "duplicate_candidates",
  "list_sessions",
  "playback_diagnose",
  "directplay_analysis",
  "transcoding_summary",
  "list_tasks",
  "task_status",
  "maintenance_plan",
  "storage_preflight",
  "list_users",
  "user_status",
  "user_access_audit",
  "list_devices",
  "list_plugins",
  "plugin_status",
  "metrics_summary",
  "activity",
  "logs_summary",
  "incident_diagnose",
  "backup_readiness",
  "upgrade_readiness",
  "live_tv_status",
  "tuner_status",
  "recording_status",
];
const common = z.object({
  action: z.enum(readActions),
  profile: z.string().optional(),
  query: z.string().max(200).optional(),
  session_id: z.string().optional(),
  item_id: z.string().optional(),
  task_id: z.string().optional(),
  library_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  start: z.number().int().min(0).max(100000).optional(),
  include_item_types: z.string().max(200).optional(),
});
const entry = {
  buildDescriptors(services) {
    return [
      {
        name: "jellyfin",
        aliases: ["jf"],
        description:
          "Bounded read-only Jellyfin operations and deterministic operational diagnosis. Selects an administrator-configured named profile; never accepts a server endpoint.",
        schema: common,
        args: {
          action: "string",
          profile: "string",
          query: "string",
          session_id: "string",
          item_id: "string",
          task_id: "string",
          limit: "number",
          start: "number",
        },
        risk: "low",
        category: "Media",
        handler: guard(read)(services),
      },
      {
        name: "jellyfin_maintenance",
        aliases: ["jf_maintenance"],
        description:
          "Governed Jellyfin maintenance with profile write opt-in, dry-run, bounded targets and postcondition verification. Storage-unsafe library mutation fails closed.",
        schema: z.object({
          action: z.enum(["run_task", "cancel_task", "scan_library"]),
          profile: z.string().optional(),
          task_id: z.string().optional(),
          library_id: z.string().optional(),
          dry_run: z.boolean().optional(),
        }),
        args: {
          action: "string (run_task|cancel_task|scan_library)",
          profile: "string",
          task_id: "string",
          library_id: "string",
          dry_run: "boolean",
        },
        risk: "high",
        category: "Media",
        handler: guard(maintenance)(services),
      },
    ];
  },
  healthCheck({ config }) {
    const count = Object.keys(config?.profiles || {}).length;
    return {
      ok: true,
      details: {
        state: count ? "configured" : "healthy-but-unconfigured",
        profiles: count,
      },
    };
  },
};
module.exports = {
  entry,
  buildDescriptors: entry.buildDescriptors,
  healthCheck: entry.healthCheck,
};
