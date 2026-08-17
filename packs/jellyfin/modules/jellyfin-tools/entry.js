"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");
const profiles = require("./lib/profiles"),
  { createClient } = require("./lib/client"),
  n = require("./lib/normalize"),
  storage = require("./lib/storage"),
  logs = require("./lib/logs"),
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
  // Thread the RESOLVED CA (ca_secret_ref included) into the client so a
  // pinned-CA profile actually pins; profile.ca_pem alone misses secret refs.
  return { p, c: createClient(p, c.key, runtime?.signal, c.ca) };
}
async function optional(fn) {
  try {
    return await fn();
  } catch (e) {
    // Only ABSENCE degrades to null. An authentication failure is a real
    // fault and must surface as authentication_failed, never as "unavailable".
    if (["not_found", "unsupported_capability"].includes(e.code)) return null;
    throw e;
  }
}
function bounded(x, fallback, max = 100) {
  return Math.min(max, Math.max(1, Number.isFinite(Number(x)) ? Math.trunc(Number(x)) : fallback));
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
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal)
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
  });
}
// TaskInfo.State is only Idle/Running/Cancelling; success or failure lives in
// LastExecutionResult.Status (Completed/Failed/Cancelled/Aborted).
function lastExec(task) {
  const lr = task?.LastExecutionResult;
  return lr
    ? {
        status: lr.Status || null,
        start: lr.StartTimeUtc || null,
        end: lr.EndTimeUtc || null,
        error: lr.ErrorMessage ? String(lr.ErrorMessage).slice(0, 300) : null,
      }
    : null;
}
function libView(x) {
  return {
    id: x.ItemId || null,
    name: x.Name || null,
    collection_type: x.CollectionType || null,
    locations: Array.isArray(x.Locations) ? x.Locations.slice(0, 20) : [],
    refresh_status: x.RefreshStatus ?? null,
    refresh_progress: x.RefreshProgress ?? null,
  };
}
// protected_resources: pack-level config entries {kind,id,name}. Entries
// without a kind, or kind "library", protect Jellyfin libraries here.
function protectedLibraryMatch(services, lib) {
  const entries = Array.isArray(services?.config?.protected_resources)
    ? services.config.protected_resources
    : [];
  return entries.find(
    (e) =>
      e &&
      (!e.kind || e.kind === "library") &&
      ((e.id && e.id === lib.id) ||
        (e.name && String(e.name).toLowerCase() === String(lib.name || "").toLowerCase())),
  ) || null;
}

// ---- composed readiness helpers (storage / backup / upgrade) --------------

async function computeBackupReadiness(services, c, p, { system, tasks, preflightResult }) {
  const running = (tasks || []).filter((t) => t.State === "Running" || t.State === "Cancelling");
  const evidence = {
    server_paths: system
      ? {
          program_data: system.ProgramDataPath || null,
          log: system.LogPath || null,
          cache: system.CachePath || null,
          internal_metadata: system.InternalMetadataPath || null,
          transcoding_temp: system.TranscodingTempPath || null,
        }
      : null,
    running_tasks: running.map((t) => t.Name).slice(0, 20),
    storage_preflight_state: preflightResult?.state || null,
  };
  const reasons = [];
  const provider = p.storage_provider;
  let providerBackup = null;
  if (provider?.type === "proxmox" && provider.vmid && typeof services?.dispatch === "function") {
    const dispatched = await services.dispatch("proxmox", {
      action: "backup_status",
      profile: provider.profile,
    });
    const parsed = storage.parseDispatch(dispatched);
    if (parsed.ok && parsed.data?.ok !== false) {
      const jobs = Array.isArray(parsed.data?.jobs?.list) ? parsed.data.jobs.list : [];
      const vmid = String(provider.vmid);
      const jobsCovering = jobs.filter(
        (j) => j.selection === "all" || String(j.selection || "").split(",").map((s) => s.trim()).includes(vmid),
      );
      const recent = Array.isArray(parsed.data?.recent_backups?.most_recent)
        ? parsed.data.recent_backups.most_recent
        : [];
      // vzdump task rows carry the vmid in `id` and inside the UPID.
      const guestBackups = recent.filter(
        (t) => String(t.id || "") === vmid || String(t.upid || "").includes(`:${vmid}:`),
      );
      const lastSuccess = guestBackups.find((t) => t.ok === true) || null;
      const lastFailure = guestBackups.find((t) => t.ok === false) || null;
      providerBackup = {
        source: "proxmox backup_status (vzdump jobs and task history)",
        jobs_covering_guest: jobsCovering.length,
        recent_guest_backups: guestBackups.slice(0, 5),
        last_success: lastSuccess
          ? { upid: lastSuccess.upid, end_time: lastSuccess.end_time }
          : null,
        last_failure: lastFailure
          ? { upid: lastFailure.upid, end_time: lastFailure.end_time }
          : null,
      };
      if (!lastSuccess) reasons.push("no_successful_backup_evidence_for_guest");
      if (lastFailure && (!lastSuccess || (lastFailure.end_time || 0) > (lastSuccess.end_time || 0)))
        reasons.push("most_recent_guest_backup_failed");
    } else {
      providerBackup = { source: "proxmox backup_status", error: parsed.code || parsed.data?.code || "provider_reported_failure" };
      reasons.push("backup_provider_unreachable");
    }
  }
  evidence.provider_backup = providerBackup;
  if (running.length) reasons.push("maintenance_tasks_running");
  if (preflightResult?.state === "unsafe") reasons.push("storage_unsafe");

  let status;
  if (!providerBackup || providerBackup.error) {
    // Without provider backup evidence we can never claim a backup exists.
    status = "not_verifiable";
    if (!provider?.vmid && provider?.type === "proxmox")
      reasons.push("storage_provider_has_no_vmid_for_backup_lookup");
    else if (!providerBackup) reasons.push("no_backup_evidence_source_configured");
  } else if (reasons.length) {
    status = "not_ready";
  } else {
    status = "ready";
  }
  return { status, reasons, evidence };
}

async function fetchLatestStable(services) {
  if (typeof services?.dispatch !== "function")
    return { latest_stable: "unknown", reason: "dispatch_unavailable" };
  const dispatched = await services.dispatch("web_fetch", {
    url: "https://api.github.com/repos/jellyfin/jellyfin/releases/latest",
  });
  if (!dispatched || dispatched.isError)
    return { latest_stable: "unknown", reason: dispatched?.code || "release_lookup_failed" };
  const text =
    Array.isArray(dispatched.content) && dispatched.content[0]
      ? String(dispatched.content[0].text || "")
      : "";
  const match = /^Status:\s*(\d+)\s*\n\n([\s\S]*)$/.exec(text);
  if (!match || match[1] !== "200")
    return { latest_stable: "unknown", reason: `release_endpoint_http_${match ? match[1] : "unparseable"}` };
  try {
    const release = JSON.parse(match[2]);
    const tag = String(release.tag_name || "").replace(/^v/, "");
    return tag
      ? { latest_stable: tag, source: "github releases/latest" }
      : { latest_stable: "unknown", reason: "release_tag_missing" };
  } catch {
    return { latest_stable: "unknown", reason: "release_body_unparseable" };
  }
}

// ---- read tool -------------------------------------------------------------

async function read(services, args, runtime) {
  const userFilterActions = new Set(["activity", "user_status", "user_access_audit"]);
  if ((args.user_id || args.username) && !userFilterActions.has(args.action)) {
    throw new JellyfinError(
      "invalid_input",
      `user_id/username filtering is not supported for action "${args.action}"`,
    );
  }
  const noArgumentActions = new Set([
    "list_profiles",
    "status",
    "health",
    "server_profile",
    "version",
    "capabilities",
    "system_info",
    "metrics_summary",
    "upgrade_readiness",
    "live_tv_status",
    "tuner_status",
    "recording_status",
    "list_devices",
  ]);
  if (noArgumentActions.has(args.action)) {
    const ignored = Object.entries(args)
      .filter(([key, value]) => key !== "action" && key !== "profile" && value !== undefined)
      .map(([key]) => key);
    if (ignored.length) {
      throw new JellyfinError(
        "invalid_input",
        `action "${args.action}" does not support argument(s): ${ignored.join(", ")}`,
      );
    }
  }
  if (args.action === "list_profiles")
    return { profiles: profiles.list(services.config || {}) };
  const { p, c } = await open(services, args, runtime);
  let system, sessions, libraries, tasks, plugins;
  if (
    ["version", "system_info", "capabilities", "server_profile", "status", "health"].includes(
      args.action,
    )
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
    [
      "list_libraries",
      "library_status",
      "library_health",
    ].includes(args.action)
  ) {
    libraries = await getAll(c, "/Library/VirtualFolders", null, 100);
    const views = libraries.map(libView);
    if (args.action === "list_libraries")
      return {
        profile: p.name,
        libraries: views.map((x) => ({
          id: x.id,
          name: x.name,
          collection_type: x.collection_type,
          paths: x.locations,
        })),
      };
    const counts = await optional(() => c.get("/Items/Counts"));
    const allTasks = (await optional(() => c.get("/ScheduledTasks"))) || [];
    const refreshTask = allTasks.find((t) => t.Key === "RefreshLibrary") || null;
    const refreshView = refreshTask
      ? {
          id: refreshTask.Id,
          name: refreshTask.Name,
          state: refreshTask.State,
          last_execution_result: lastExec(refreshTask),
        }
      : null;
    if (args.action === "library_status")
      return {
        profile: p.name,
        libraries: views,
        item_counts: counts || null,
        library_scan_task: refreshView,
        evidence_sources: ["/Library/VirtualFolders", "/Items/Counts", "/ScheduledTasks"],
      };
    // library_health: evidence-based findings only. The Jellyfin API does not
    // expose per-path mount or IO health, so filesystem accessibility is
    // explicitly reported as not verified here, not guessed.
    const findings = [];
    for (const lib of views) {
      if (!lib.locations.length)
        findings.push({ library: lib.name, id: lib.id, finding: "no_locations", detail: "library has no configured locations" });
      if (lib.refresh_status && /fail|error/i.test(String(lib.refresh_status)))
        findings.push({ library: lib.name, id: lib.id, finding: "refresh_status_reports_failure", detail: String(lib.refresh_status) });
    }
    const scanExec = refreshView?.last_execution_result;
    if (scanExec && ["Failed", "Aborted"].includes(scanExec.status))
      findings.push({ finding: "library_scan_last_failed", detail: scanExec });
    if (scanExec?.end) {
      const ageDays = (Date.now() - Date.parse(scanExec.end)) / 86400000;
      if (Number.isFinite(ageDays) && ageDays > 30)
        findings.push({ finding: "stale_library_scan", detail: `last completed scan ended ${Math.round(ageDays)} days ago` });
    }
    return {
      profile: p.name,
      state: findings.length ? "attention" : "no_issues_observed",
      findings,
      libraries: views,
      library_scan_task: refreshView,
      not_verified: [
        "filesystem_accessibility: the Jellyfin API does not expose per-path mount/IO health; use storage_preflight with a configured storage_provider",
      ],
      evidence_sources: ["/Library/VirtualFolders", "/Items/Counts", "/ScheduledTasks"],
    };
  }
  if (args.action === "recent_media") {
    // Verified against the 10.9/10.10 OpenAPI: GET /Items accepts
    // SortBy/SortOrder/Recursive server-wide with an admin API key — no user
    // context is required (unlike the legacy /Users/{id}/Items/Latest route).
    const data = await c.get("/Items", {
      SortBy: "DateCreated",
      SortOrder: "Descending",
      Recursive: true,
      IncludeItemTypes: args.include_item_types || undefined,
      Fields: "DateCreated,Path",
      Limit: bounded(args.limit, 25),
      StartIndex: Math.max(0, args.start || 0),
    });
    const items = Array.isArray(data?.Items) ? data.Items : [];
    return {
      profile: p.name,
      items: items.slice(0, 100).map((x) => ({
        id: x.Id,
        name: x.Name,
        type: x.Type,
        date_created: x.DateCreated || null,
        production_year: x.ProductionYear || null,
        path: x.Path || null,
      })),
      total_record_count: data?.TotalRecordCount ?? null,
      source: "/Items?SortBy=DateCreated&SortOrder=Descending&Recursive=true",
      bounded: true,
    };
  }
  if (args.action === "metadata_issues") {
    const filters = {
      Recursive: true,
      IncludeItemTypes: args.include_item_types || "Movie,Series",
      Fields: "Overview",
      SortBy: "SortName",
      Limit: bounded(args.limit, 100),
      StartIndex: Math.max(0, args.start || 0),
    };
    const data = await c.get("/Items", filters);
    const items = Array.isArray(data?.Items) ? data.Items : [];
    const issues = [];
    for (const x of items) {
      const missing = [];
      if (!x.ProductionYear) missing.push("production_year");
      if (!x.Overview || !String(x.Overview).trim()) missing.push("overview");
      if (!x.ImageTags || !x.ImageTags.Primary) missing.push("primary_image");
      if (missing.length) issues.push({ id: x.Id, name: x.Name, type: x.Type, missing });
    }
    return {
      profile: p.name,
      bounded_sample: true,
      filters_used: filters,
      sample_size: items.length,
      total_record_count: data?.TotalRecordCount ?? null,
      issues_in_sample: issues.length,
      issues: issues.slice(0, 100),
      note: "Findings cover only the bounded sample described by filters_used; use start to page.",
    };
  }
  if (args.action === "duplicate_candidates") {
    const filters = {
      Recursive: true,
      IncludeItemTypes: args.include_item_types || "Movie",
      Fields: "Path",
      SortBy: "SortName",
      Limit: bounded(args.limit, 100),
      StartIndex: Math.max(0, args.start || 0),
    };
    const data = await c.get("/Items", filters);
    const items = Array.isArray(data?.Items) ? data.Items : [];
    const groups = new Map();
    for (const x of items) {
      const key = `${String(x.Name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${x.ProductionYear || ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ id: x.Id, name: x.Name, production_year: x.ProductionYear || null, path: x.Path || null });
    }
    const candidates = [...groups.entries()]
      .filter(([, members]) => members.length > 1)
      .map(([key, members]) => ({ normalized_key: key, items: members }))
      .slice(0, 50);
    return {
      profile: p.name,
      bounded_sample: true,
      filters_used: filters,
      sample_size: items.length,
      total_record_count: data?.TotalRecordCount ?? null,
      candidates,
      note: "Name+year grouping from a bounded sample — CANDIDATES only, not confirmed duplicates; editions/qualities legitimately share name and year.",
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
    [
      "list_sessions",
      "playback_diagnose",
      "directplay_analysis",
      "transcoding_summary",
    ].includes(args.action)
  ) {
    sessions = await c.get("/Sessions");
    const normalized = sessions.map(n.session);
    if (args.action === "list_sessions")
      return { profile: p.name, sessions: normalized.slice(0, 100) };
    if (args.action === "playback_diagnose") {
      if (args.session_id) {
        const s = sessions.find((x) => x.Id === args.session_id);
        return s
          ? { profile: p.name, ...n.diagnose(s) }
          : {
              profile: p.name,
              classification: "insufficient_evidence",
              observed: [],
              unknowns: ["No active session matches the requested session_id"],
              recommended_next_check: "list_sessions to enumerate current sessions",
            };
      }
      // No session_id: never silently pick sessions[0]. Diagnose only when
      // the choice is unambiguous, and say which session was chosen and why.
      const playing = sessions.filter((x) => x.NowPlayingItem);
      if (playing.length === 1)
        return {
          profile: p.name,
          session_chosen: { id: playing[0].Id, reason: "only_session_with_active_playback" },
          ...n.diagnose(playing[0]),
        };
      if (playing.length === 0 && sessions.length === 1)
        return {
          profile: p.name,
          session_chosen: { id: sessions[0].Id, reason: "only_connected_session" },
          ...n.diagnose(sessions[0]),
        };
      if (playing.length > 1)
        return {
          profile: p.name,
          classification: "ambiguous_sessions",
          candidates: playing.slice(0, 20).map((x) => ({
            session_id: x.Id,
            user: x.UserName || null,
            device: x.DeviceName || null,
            now_playing: x.NowPlayingItem?.Name || null,
          })),
          conclusion: "Multiple sessions are actively playing; a diagnosis target must be named.",
          unknowns: [],
          recommended_next_check: "Re-invoke playback_diagnose with session_id",
        };
      return {
        profile: p.name,
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
    ["list_tasks", "task_status", "maintenance_plan"].includes(args.action)
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
    // maintenance_plan: recommendations from LastExecutionResult, never from
    // State — State is only Idle/Running/Cancelling and never says "Failed".
    const recommendations = [];
    const running = [];
    for (const t of tasks) {
      const exec = lastExec(t);
      if (t.State === "Running" || t.State === "Cancelling")
        running.push({ task_id: t.Id, name: t.Name, state: t.State, progress: t.CurrentProgressPercentage ?? null });
      if (exec && ["Failed", "Aborted"].includes(exec.status))
        recommendations.push({
          kind: "failed_task",
          task_id: t.Id,
          name: t.Name,
          last_status: exec.status,
          last_end: exec.end,
          error: exec.error,
          classification: "inspect_before_rerun",
        });
      else if (exec && exec.status === "Cancelled")
        recommendations.push({
          kind: "cancelled_task",
          task_id: t.Id,
          name: t.Name,
          last_end: exec.end,
          classification: "informational",
        });
      else if (!exec && t.IsHidden !== true)
        recommendations.push({
          kind: "never_ran",
          task_id: t.Id,
          name: t.Name,
          classification: "informational",
        });
      else if (exec?.end && t.Key === "RefreshLibrary") {
        const ageDays = (Date.now() - Date.parse(exec.end)) / 86400000;
        if (Number.isFinite(ageDays) && ageDays > 30)
          recommendations.push({
            kind: "stale_library_scan",
            task_id: t.Id,
            name: t.Name,
            last_end: exec.end,
            age_days: Math.round(ageDays),
            classification: "consider_scan",
          });
      }
    }
    return {
      profile: p.name,
      recommendations,
      currently_running: running,
      tasks_seen: tasks.length,
      basis:
        "TaskInfo.State only reports Idle/Running/Cancelling; outcomes come from LastExecutionResult.Status (Completed/Failed/Cancelled/Aborted)",
    };
  }
  if (
    ["list_users", "user_status", "user_access_audit"].includes(args.action)
  ) {
    const users = await getAll(c, "/Users", null, 100);
    if (args.action === "list_users")
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
    if (args.action === "user_status") {
      if (!args.user_id && !args.username)
        throw new JellyfinError(
          "invalid_input",
          "user_id or username is required (use list_users to enumerate)",
        );
      const u =
        users.find((x) => args.user_id && x.Id === args.user_id) ||
        users.find(
          (x) =>
            args.username &&
            String(x.Name || "").toLowerCase() === String(args.username).toLowerCase(),
        );
      if (!u) throw new JellyfinError("not_found", "no matching Jellyfin user");
      const pol = u.Policy || {};
      return {
        profile: p.name,
        user: {
          id: u.Id,
          name: u.Name,
          has_password: u.HasPassword === true,
          last_login: u.LastLoginDate || null,
          last_activity: u.LastActivityDate || null,
          policy: {
            is_administrator: pol.IsAdministrator === true,
            is_disabled: pol.IsDisabled === true,
            is_hidden: pol.IsHidden === true,
            enable_remote_access: pol.EnableRemoteAccess !== false,
            enable_all_folders: pol.EnableAllFolders === true,
            enabled_folders_count: Array.isArray(pol.EnabledFolders)
              ? pol.EnabledFolders.length
              : null,
          },
        },
      };
    }
    // user_access_audit: findings derived from /Users Policy + activity dates.
    const findings = [];
    let admins = 0, disabled = 0, remote = 0, allFolders = 0;
    for (const u of users) {
      const pol = u.Policy || {};
      const who = { user_id: u.Id, name: u.Name };
      if (pol.IsAdministrator === true) {
        admins += 1;
        findings.push({ ...who, finding: "administrator" });
      }
      if (pol.IsDisabled === true) {
        disabled += 1;
        findings.push({ ...who, finding: "disabled_account" });
      }
      if (pol.EnableRemoteAccess !== false) {
        remote += 1;
        findings.push({ ...who, finding: "remote_access_enabled" });
      }
      if (pol.EnableAllFolders === true) {
        allFolders += 1;
        findings.push({ ...who, finding: "access_to_all_folders" });
      } else {
        findings.push({
          ...who,
          finding: "restricted_folder_access",
          evidence: { enabled_folders_count: Array.isArray(pol.EnabledFolders) ? pol.EnabledFolders.length : 0 },
        });
      }
      if (!u.LastActivityDate) findings.push({ ...who, finding: "no_recorded_activity" });
      else {
        const ageDays = (Date.now() - Date.parse(u.LastActivityDate)) / 86400000;
        if (Number.isFinite(ageDays) && ageDays > 90)
          findings.push({ ...who, finding: "inactive_over_90_days", evidence: { last_activity: u.LastActivityDate } });
      }
    }
    return {
      profile: p.name,
      summary: {
        users: users.length,
        administrators: admins,
        disabled_accounts: disabled,
        remote_access_enabled: remote,
        all_folder_access: allFolders,
      },
      findings: findings.slice(0, 200),
      basis: "/Users Policy flags and LastActivityDate",
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
    if (args.action === "list_plugins")
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
    if (!args.plugin_id && !args.query)
      throw new JellyfinError(
        "invalid_input",
        "plugin_id (or query for a name match) is required; use list_plugins to enumerate",
      );
    const plugin =
      (ps || []).find((x) => args.plugin_id && x.Id === args.plugin_id) ||
      (ps || []).find(
        (x) =>
          args.query &&
          String(x.Name || "").toLowerCase() === String(args.query).toLowerCase(),
      );
    if (!plugin) throw new JellyfinError("not_found", "no matching Jellyfin plugin");
    return {
      profile: p.name,
      plugin: {
        id: plugin.Id,
        name: plugin.Name,
        version: plugin.Version,
        status: plugin.Status || "unknown",
        description: plugin.Description ? String(plugin.Description).slice(0, 300) : null,
        can_uninstall: plugin.CanUninstall === true,
        configuration_file: plugin.ConfigurationFileName || null,
      },
    };
  }
  if (args.action === "metrics_summary") {
    // /System/Metric is NOT a Jellyfin route (verified against the official
    // 10.9/10.10 OpenAPI). The summary is derived only from real sources and
    // says exactly which ones were used.
    const s = (await optional(() => c.get("/Sessions"))) || null;
    const counts = await optional(() => c.get("/Items/Counts"));
    const t = await optional(() => c.get("/ScheduledTasks"));
    const normalized = Array.isArray(s) ? s.map(n.session) : null;
    return {
      profile: p.name,
      sources_used: ["/Sessions", "/Items/Counts", "/ScheduledTasks"],
      sessions: normalized
        ? {
            connected: normalized.length,
            playing: normalized.filter((x) => x.media.id).length,
            transcoding: normalized.filter((x) => x.transcoding).length,
          }
        : null,
      item_counts: counts || null,
      tasks: Array.isArray(t)
        ? {
            total: t.length,
            running: t.filter((x) => x.State === "Running").length,
            recent_failures: t
              .map((x) => ({ id: x.Id, name: x.Name, exec: lastExec(x) }))
              .filter((x) => x.exec && ["Failed", "Aborted"].includes(x.exec.status))
              .map((x) => ({ task_id: x.id, name: x.name, last_status: x.exec.status, last_end: x.exec.end }))
              .slice(0, 10),
          }
        : null,
      note: "Jellyfin exposes no metrics endpoint; this summary is derived only from the listed sources.",
    };
  }
  if (args.action === "activity") {
    // Real response shape is { Items, TotalRecordCount } (ActivityLogEntryQueryResult).
    let userId = args.user_id || null;
    if (!userId && args.username) {
      const users = await getAll(c, "/Users", null, 100);
      const user = users.find(
        (x) => String(x.Name || "").toLowerCase() === String(args.username).toLowerCase(),
      );
      if (!user) throw new JellyfinError("not_found", "no matching Jellyfin user");
      userId = user.Id;
    }
    const a = await c.get("/System/ActivityLog/Entries", {
      Limit: bounded(args.limit, 50),
      StartIndex: Math.max(0, args.start_index ?? args.start ?? 0),
      ...(userId ? { UserId: userId } : {}),
    });
    const items = Array.isArray(a?.Items) ? a.Items : [];
    return {
      profile: p.name,
      items: items.slice(0, 100).map((x) => ({
        id: x.Id,
        name: x.Name,
        type: x.Type || null,
        severity: x.Severity || null,
        date: x.Date || null,
        user_id: x.UserId || null,
        short_overview: x.ShortOverview || x.Overview || null,
      })),
      total_record_count: a?.TotalRecordCount ?? null,
      start_index: Math.max(0, args.start_index ?? args.start ?? 0),
      bounded: true,
    };
  }
  if (args.action === "logs_summary" || args.action === "incident_diagnose") {
    // Bounded log intelligence: GET /System/Logs lists files; the tail of one
    // file is retrieved through client.getTail (Range first) and summarized —
    // raw log content never leaves the module.
    let logResult = null;
    const unknowns = [];
    try {
      const files = await c.get("/System/Logs");
      const file = logs.pickLogFile(files, args.log_file);
      const tail = await c.getTail("/System/Logs/Log", { name: file.Name }, 65536);
      if (tail.ok) {
        logResult = {
          file: { name: file.Name, size: file.Size ?? null, modified: file.DateModified || null },
          retrieval: {
            method: tail.method,
            bytes_scanned: Buffer.byteLength(tail.text || ""),
            total_size: tail.total_size,
            bounded: true,
            tail_only: true,
          },
          summary: logs.summarizeTail(tail.text),
          files_available: (Array.isArray(files) ? files : []).slice(0, 20).map((f) => f.Name),
        };
      } else {
        unknowns.push(`log tail unavailable: ${tail.reason}`);
      }
    } catch (e) {
      if (["not_found", "unsupported_capability"].includes(e.code))
        unknowns.push("Jellyfin did not expose retrievable log files");
      else throw e;
    }
    if (args.action === "logs_summary") {
      if (!logResult)
        return { profile: p.name, available: false, unknowns, raw_output_withheld: true };
      return {
        profile: p.name,
        available: true,
        log_file: logResult.file,
        retrieval: logResult.retrieval,
        time_range: logResult.summary.time_range,
        level_counts: logResult.summary.level_counts,
        top_errors: logResult.summary.top_errors,
        lines_parsed: logResult.summary.lines_parsed,
        continuation_or_unparsed_lines: logResult.summary.continuation_or_unparsed_lines,
        files_available: logResult.files_available,
        raw_output_withheld: true,
      };
    }
    const t = (await optional(() => c.get("/ScheduledTasks"))) || [];
    const activityData = await optional(() =>
      c.get("/System/ActivityLog/Entries", { Limit: bounded(args.limit, 50), StartIndex: 0 }),
    );
    const activityItems = Array.isArray(activityData?.Items) ? activityData.Items : [];
    const failedTasks = t
      .map((x) => ({ id: x.Id, name: x.Name, exec: lastExec(x) }))
      .filter((x) => x.exec && ["Failed", "Aborted"].includes(x.exec.status))
      .map((x) => ({ id: x.id, name: x.name, last_status: x.exec.status }));
    const errorActivity = activityItems
      .filter((x) => /error|critical/i.test(String(x.Severity || "")))
      .map((x) => ({ id: x.Id, name: x.Name, severity: x.Severity, date: x.Date || null }));
    const evidenceSources = [];
    if (logResult) evidenceSources.push("/System/Logs/Log (bounded tail)");
    if (t.length) evidenceSources.push("/ScheduledTasks");
    if (activityData) evidenceSources.push("/System/ActivityLog/Entries");
    return {
      profile: p.name,
      ...logs.classifyIncident({
        logSummary: logResult ? logResult.summary : null,
        failedTasks,
        errorActivity,
        unknowns,
      }),
      log_file: logResult ? logResult.file : null,
      evidence_sources: evidenceSources,
      raw_output_withheld: true,
    };
  }
  if (args.action === "storage_preflight") {
    const pf = await storage.preflight({ services, client: c, profile: p });
    // require_safe lets governed callers (the maintenance-preflight workflow)
    // FAIL on anything but verified-ok storage instead of merely reporting it.
    if (args.require_safe === true && pf.state !== "ok")
      throw new JellyfinError(
        "unsafe_storage_state",
        `storage preflight state is "${pf.state}"`,
        { preflight: pf },
      );
    return pf;
  }
  if (args.action === "backup_readiness") {
    system = await c.get("/System/Info");
    const t = (await optional(() => c.get("/ScheduledTasks"))) || [];
    const pf = await storage.preflight({ services, client: c, profile: p });
    const readiness = await computeBackupReadiness(services, c, p, {
      system,
      tasks: t,
      preflightResult: pf,
    });
    return { profile: p.name, ...readiness, storage_preflight: { state: pf.state, reasons: pf.reasons || [] } };
  }
  if (args.action === "upgrade_readiness") {
    system = await c.get("/System/Info");
    sessions = (await optional(() => c.get("/Sessions"))) || [];
    tasks = (await optional(() => c.get("/ScheduledTasks"))) || [];
    plugins = (await optional(() => c.get("/Plugins"))) || [];
    const pf = await storage.preflight({ services, client: c, profile: p });
    const backup = await computeBackupReadiness(services, c, p, {
      system,
      tasks,
      preflightResult: pf,
    });
    const latest = await fetchLatestStable(services);
    const runningTasks = tasks
      .filter((t) => t.State === "Running" || t.State === "Cancelling")
      .map((t) => t.Name);
    const malfunctioning = plugins
      .filter((x) => x.Status === "Malfunctioned")
      .map((x) => ({ id: x.Id, name: x.Name, version: x.Version }));
    const currentVersion = n.version(system);
    const blockedBy = [];
    const warnings = [];
    if (sessions.length) blockedBy.push({ reason: "active_sessions", count: sessions.length });
    if (runningTasks.length) blockedBy.push({ reason: "running_tasks", tasks: runningTasks.slice(0, 10) });
    if (pf.state === "unsafe") blockedBy.push({ reason: "storage_unsafe", detail: pf.reasons });
    if (pf.state === "not_verifiable") warnings.push({ reason: "storage_not_verifiable", detail: pf.reason || pf.reasons });
    if (backup.status === "not_ready") blockedBy.push({ reason: "backup_not_ready", detail: backup.reasons });
    if (backup.status === "not_verifiable") warnings.push({ reason: "no_backup", detail: backup.reasons });
    if (malfunctioning.length) warnings.push({ reason: "malfunctioning_plugins", plugins: malfunctioning });
    if (system?.HasPendingRestart === true) warnings.push({ reason: "pending_restart" });
    if (latest.latest_stable === "unknown") warnings.push({ reason: "latest_stable_unknown", detail: latest.reason });
    else if (currentVersion && latest.latest_stable !== currentVersion)
      warnings.push({ reason: "update_available", current: currentVersion, latest: latest.latest_stable });
    const status = blockedBy.length ? "blocked" : warnings.length ? "ready_with_warnings" : "ready";
    return {
      profile: p.name,
      status,
      current_version: currentVersion,
      latest_stable: latest.latest_stable,
      latest_stable_source: latest.source || null,
      blocked_by: blockedBy,
      warnings,
      evidence: {
        active_sessions: sessions.length,
        running_tasks: runningTasks.slice(0, 10),
        plugins_total: plugins.length,
        storage_preflight_state: pf.state,
        backup_status: backup.status,
      },
      note: "No upgrade is performed; this is evidence for an operator decision.",
    };
  }
  if (
    ["live_tv_status", "tuner_status", "recording_status"].includes(args.action)
  ) {
    const info = await optional(() => c.get("/LiveTv/Info"));
    if (!info)
      return { profile: p.name, available: false, unsupported: "unsupported_capability" };
    const enabled = info.IsEnabled === true;
    const services_ = Array.isArray(info.Services) ? info.Services.slice(0, 10) : [];
    if (args.action === "live_tv_status")
      return {
        profile: p.name,
        available: true,
        enabled,
        services: services_.map((s) => ({
          name: s.Name || null,
          status: s.Status || null,
          status_message: s.StatusMessage || null,
          tuner_count: Array.isArray(s.Tuners) ? s.Tuners.length : 0,
        })),
      };
    if (!enabled)
      return { profile: p.name, available: false, reason: "live_tv_disabled" };
    if (args.action === "tuner_status")
      // Verified: Jellyfin exposes no GET tuner-listing route (/LiveTv/Tuners
      // does not exist; /LiveTv/TunerHosts is POST/DELETE only). Tuner
      // identities come from LiveTvInfo.Services[].Tuners — reported as such.
      return {
        profile: p.name,
        available: true,
        services: services_.map((s) => ({
          name: s.Name || null,
          status: s.Status || null,
          tuners: Array.isArray(s.Tuners) ? s.Tuners.slice(0, 20) : [],
        })),
        note: "Jellyfin has no dedicated tuner-listing endpoint; tuner identities come from LiveTvInfo.Services[].Tuners.",
      };
    const rec = await c.get("/LiveTv/Recordings", {
      Limit: bounded(args.limit, 25),
      StartIndex: Math.max(0, args.start_index ?? args.start ?? 0),
      EnableTotalRecordCount: true,
    });
    const items = Array.isArray(rec?.Items) ? rec.Items : [];
    return {
      profile: p.name,
      available: true,
      recordings: items.slice(0, 100).map((x) => ({
        id: x.Id,
        name: x.Name,
        series_name: x.SeriesName || null,
        channel: x.ChannelName || null,
        date_created: x.DateCreated || null,
        status: x.Status || null,
      })),
      total_record_count: rec?.TotalRecordCount ?? null,
      bounded: true,
    };
  }
  if (args.action === "server_profile" || args.action === "capabilities") {
    system = system || (await c.get("/System/Info"));
    sessions = (await optional(() => c.get("/Sessions"))) || [];
    libraries = (await optional(() => c.get("/Library/VirtualFolders"))) || [];
    tasks = (await optional(() => c.get("/ScheduledTasks"))) || [];
    plugins = (await optional(() => c.get("/Plugins"))) || [];
    const live = await optional(() => c.get("/LiveTv/Info"));
    // No /System/Metric probe: the route does not exist in Jellyfin, so the
    // capability is reported false without issuing a known-404 request.
    const capabilities = n.capabilities({
      system,
      sessions,
      libraries,
      tasks,
      plugins,
      liveTv: live,
      metrics: null,
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

// ---- maintenance tool ------------------------------------------------------

async function pollForTransition(c, taskId, predicate, { interval, signal, polls = 3 }) {
  let lastSeen = null;
  for (let i = 0; i < polls; i += 1) {
    await sleep(interval, signal);
    if (signal?.aborted) break;
    const tasks = await c.get("/ScheduledTasks");
    lastSeen = tasks.find((x) => x.Id === taskId) || null;
    if (lastSeen && predicate(lastSeen)) return { observed: true, task: lastSeen, polls: i + 1 };
  }
  return { observed: false, task: lastSeen, polls };
}

async function maintenance(services, args, runtime) {
  const { p, c } = await open(services, args, runtime);
  if (!p.allow_writes)
    throw new JellyfinError(
      "policy_denied",
      `writes are disabled for Jellyfin profile "${p.name}"`,
    );
  const interval = p.verify_poll_interval_ms;
  const signal = runtime?.signal;

  if (args.action === "run_task" || args.action === "cancel_task") {
    // Required args are validated BEFORE any dry-run plan: a dry run of an
    // unexecutable request is a lie, not a preview.
    if (!args.task_id)
      throw new JellyfinError("invalid_input", "task_id is required");
    const tasks = await c.get("/ScheduledTasks");
    const t = tasks.find((x) => x.Id === args.task_id);
    if (!t)
      throw new JellyfinError("not_found", "scheduled task was not found");
    const before = { state: t.State, last_execution: lastExec(t) };
    if (args.dry_run === true)
      return {
        dry_run: true,
        profile: p.name,
        operation: args.action,
        target: { task_id: t.Id, name: t.Name, current_state: t.State },
        expected_effect:
          args.action === "run_task"
            ? `start scheduled task "${t.Name}"`
            : `request cancellation of scheduled task "${t.Name}"`,
        would_execute:
          args.action === "run_task" ? t.State !== "Running" : t.State === "Running",
        changes_made: false,
      };
    if (args.action === "run_task" && t.State === "Running")
      return {
        profile: p.name,
        task_id: t.Id,
        outcome: "already_running",
        postcondition: { state_before: t.State, state_after: t.State, transition_observed: false },
      };
    if (args.action === "cancel_task" && t.State === "Idle")
      return {
        profile: p.name,
        task_id: t.Id,
        outcome: "nothing_to_cancel",
        postcondition: { state_before: t.State, state_after: t.State, transition_observed: false },
      };
    if (args.action === "run_task")
      await c.post(`/ScheduledTasks/Running/${encodeURIComponent(t.Id)}`);
    else await c.del(`/ScheduledTasks/Running/${encodeURIComponent(t.Id)}`);
    // Bounded transition poll: "verified" means the state transition (or a
    // newer LastExecutionResult, for tasks that finish within the window) was
    // OBSERVED — a surviving task row alone is only "request_accepted".
    const predicate =
      args.action === "run_task"
        ? (now) =>
            now.State === "Running" ||
            (lastExec(now)?.start && lastExec(now).start !== before.last_execution?.start)
        : (now) => now.State === "Cancelling" || now.State === "Idle";
    const polled = await pollForTransition(c, t.Id, predicate, { interval, signal });
    return {
      profile: p.name,
      task_id: t.Id,
      outcome: polled.observed ? "verified" : "request_accepted",
      postcondition: {
        state_before: before.state,
        state_after: polled.task?.State || "unknown",
        transition_observed: polled.observed,
        polls: polled.polls,
      },
    };
  }

  if (args.action === "scan_library") {
    const wantsAll = args.all_libraries === true;
    if (!args.library_id && !wantsAll)
      throw new JellyfinError(
        "invalid_input",
        "library_id is required (or pass all_libraries=true explicitly for a full scan)",
      );
    if (args.library_id && wantsAll)
      throw new JellyfinError(
        "invalid_input",
        "library_id and all_libraries are mutually exclusive",
      );
    const rawLibraries = await c.get("/Library/VirtualFolders");
    const views = (Array.isArray(rawLibraries) ? rawLibraries : []).map(libView);
    let target = null;
    if (args.library_id) {
      target = views.find((x) => x.id === args.library_id) || null;
      if (!target)
        throw new JellyfinError(
          "not_found",
          "library_id does not match any /Library/VirtualFolders ItemId",
        );
      const shielded = protectedLibraryMatch(services, target);
      if (shielded)
        throw new JellyfinError(
          "policy_denied",
          `library "${target.name}" is a protected resource and must not be mutated`,
          { protected_by: shielded },
        );
    } else {
      // A full /Library/Refresh touches EVERY library, so any protected
      // library is a hard deny for the all-libraries form — fail closed.
      const shielded = views.map((x) => ({ lib: x, entry: protectedLibraryMatch(services, x) })).filter((x) => x.entry);
      if (shielded.length)
        throw new JellyfinError(
          "policy_denied",
          "a full library scan would touch protected libraries",
          { protected: shielded.map((x) => ({ id: x.lib.id, name: x.lib.name })) },
        );
    }
    const pf = await storage.preflight({ services, client: c, profile: p });
    const plan = {
      operation: "scan_library",
      profile: p.name,
      target: target
        ? { library_id: target.id, name: target.name, locations: target.locations }
        : { all_libraries: true, libraries: views.map((x) => ({ id: x.id, name: x.name })) },
      endpoint: target
        ? `POST /Items/${target.id}/Refresh`
        : "POST /Library/Refresh",
      expected_effect: target
        ? `request a metadata refresh of library "${target.name}"`
        : "request a scan of all media libraries",
      storage_preflight: pf,
    };
    if (args.dry_run === true)
      return {
        dry_run: true,
        ...plan,
        would_execute: pf.state === "ok",
        blocked_reason: pf.state === "ok" ? null : `storage preflight state is "${pf.state}"`,
        changes_made: false,
      };
    if (pf.state !== "ok")
      throw new JellyfinError(
        "unsafe_storage_state",
        "maintenance denied: library storage availability could not be established safely",
        { preflight: pf },
      );
    const beforeTasks = await c.get("/ScheduledTasks");
    const refreshBefore = beforeTasks.find((x) => x.Key === "RefreshLibrary") || null;
    const beforeExec = lastExec(refreshBefore);
    if (target) await c.post(`/Items/${encodeURIComponent(target.id)}/Refresh`);
    else await c.post("/Library/Refresh");
    // Postcondition: watch for the RefreshLibrary task running, per-library
    // refresh progress, or a completed newer execution. Absence of an observed
    // transition downgrades the claim, never upgrades it.
    let outcome = "accepted";
    let evidence = null;
    for (let i = 0; i < 3 && outcome === "accepted"; i += 1) {
      await sleep(interval, signal);
      if (signal?.aborted) break;
      const nowTasks = await optional(() => c.get("/ScheduledTasks"));
      const refreshNow = (nowTasks || []).find((x) => x.Key === "RefreshLibrary") || null;
      if (refreshNow && (refreshNow.State === "Running" || refreshNow.State === "Cancelling")) {
        outcome = "running";
        evidence = { task_state: refreshNow.State, progress: refreshNow.CurrentProgressPercentage ?? null };
        break;
      }
      const nowExec = lastExec(refreshNow);
      if (nowExec?.start && nowExec.start !== beforeExec?.start) {
        outcome = "verified";
        evidence = { last_execution_result: nowExec };
        break;
      }
      if (target) {
        const folders = await optional(() => c.get("/Library/VirtualFolders"));
        const lib = (Array.isArray(folders) ? folders : []).map(libView).find((x) => x.id === target.id);
        if (lib && ((lib.refresh_progress ?? 0) > 0 || (lib.refresh_status && lib.refresh_status !== "Idle"))) {
          outcome = "running";
          evidence = { refresh_status: lib.refresh_status, refresh_progress: lib.refresh_progress };
          break;
        }
      }
    }
    return {
      profile: p.name,
      operation: "scan_library",
      target: plan.target,
      outcome,
      outcome_semantics:
        "accepted = Jellyfin accepted the request but no refresh activity was observed within the bounded poll; running = refresh activity observed; verified = a newer completed execution observed",
      postcondition_evidence: evidence,
      storage_preflight: { state: pf.state },
      changes_made: outcome !== "accepted",
    };
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
  user_id: z.string().max(100).optional(),
  username: z.string().max(100).optional(),
  plugin_id: z.string().max(100).optional(),
  log_file: z.string().max(200).optional(),
  require_safe: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  start: z.number().int().min(0).max(100000).optional(),
  start_index: z.number().int().min(0).max(100000).optional(),
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
          user_id: "string",
          username: "string",
          plugin_id: "string",
          log_file: "string",
          require_safe: "boolean",
          limit: "number",
          start: "number",
          start_index: "number",
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
          all_libraries: z.boolean().optional(),
          dry_run: z.boolean().optional(),
        }),
        args: {
          action: "string (run_task|cancel_task|scan_library)",
          profile: "string",
          task_id: "string",
          library_id: "string",
          all_libraries: "boolean (explicit opt-in for a full scan when library_id is omitted)",
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
