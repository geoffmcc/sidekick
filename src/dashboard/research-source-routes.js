"use strict";

const ACTIONS = new Set(["verify", "select", "index", "compare", "archive", "remove", "recover", "import"]);
const DESTRUCTIVE = new Set(["archive", "remove", "recover"]);
const MAX_LIMIT = 100;

function boundedLimit(value, fallback = 25) {
  const number = Number(value || fallback);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, MAX_LIMIT) : fallback;
}

function parseResult(result) {
  const text = result && Array.isArray(result.content) ? result.content.map(item => item && item.text || "").join("") : "";
  try { return JSON.parse(text); } catch { return { ok: !result?.isError, message: text }; }
}

function cleanRef(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) return null;
  return value;
}

function shortCommit(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^[0-9a-f]{7,64}$/i);
  return match ? match[0].slice(0, 12) : null;
}

function safeMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const output = {};
  for (const key of ["import_kind", "index_state", "index_status", "stale", "recovery_state", "branch"]) {
    const value = metadata[key];
    if (typeof value === "string" || typeof value === "boolean") output[key] = String(value).slice(0, 120);
  }
  for (const key of ["commit", "git_commit", "commit_sha"]) {
    const commit = shortCommit(metadata[key]);
    if (commit) output.commit = commit;
  }
  return output;
}

function verificationView(verification = {}, snapshot = {}) {
  const verified = verification.verified === true;
  const stale = verification.verified === false || snapshot.state === "stale";
  return {
    state: verified ? "verified" : stale ? "stale" : "unknown",
    verified,
    stale,
    expected_hash: typeof verification.expected_hash === "string" ? verification.expected_hash : null,
    actual_hash: typeof verification.actual_hash === "string" ? verification.actual_hash : null,
    expected_file_count: Number.isSafeInteger(verification.expected_file_count) ? verification.expected_file_count : null,
    actual_file_count: Number.isSafeInteger(verification.actual_file_count) ? verification.actual_file_count : null,
    expected_byte_count: Number.isSafeInteger(verification.expected_byte_count) ? verification.expected_byte_count : null,
    actual_byte_count: Number.isSafeInteger(verification.actual_byte_count) ? verification.actual_byte_count : null,
  };
}

function snapshotView(snapshot = {}) {
  const verification = verificationView(snapshot.verification, snapshot);
  return {
    snapshot_id: snapshot.snapshot_id || null,
    repository_id: snapshot.repository_id || null,
    campaign_id: snapshot.campaign_id || null,
    project_id: snapshot.project_id || null,
    state: snapshot.state || "unknown",
    workspace_ref: cleanRef(snapshot.storage_ref),
    content_hash: typeof snapshot.content_hash === "string" ? snapshot.content_hash : null,
    file_count: Number.isSafeInteger(snapshot.file_count) ? snapshot.file_count : null,
    byte_count: Number.isSafeInteger(snapshot.byte_count) ? snapshot.byte_count : null,
    max_depth: Number.isSafeInteger(snapshot.max_depth) ? snapshot.max_depth : null,
    authority: snapshot.authority === "derived_analysis_input" ? snapshot.authority : "unknown",
    created_at: snapshot.created_at || null,
    finalized_at: snapshot.finalized_at || null,
    archived_at: snapshot.archived_at || null,
    removed_at: snapshot.removed_at || null,
    verification,
    integrity_status: verification.state,
    index_status: safeMetadata(snapshot.metadata).index_status || safeMetadata(snapshot.metadata).index_state || "unknown",
    recovery_status: safeMetadata(snapshot.metadata).recovery_state || "available",
    metadata: safeMetadata(snapshot.metadata),
  };
}

function repositoryView(repository = {}) {
  return {
    repository_id: repository.repository_id || null,
    campaign_id: repository.campaign_id || null,
    project_id: repository.project_id || null,
    name: typeof repository.name === "string" ? repository.name.slice(0, 200) : null,
    state: repository.state || "unknown",
    selected_snapshot_id: repository.selected_snapshot_id || null,
    created_at: repository.created_at || null,
    updated_at: repository.updated_at || null,
    archived_at: repository.archived_at || null,
    metadata: safeMetadata(repository.metadata),
  };
}

function resultErrorResponse(req, res, result, fallback = "research source operation failed", errorResponse) {
  const payload = parseResult(result);
  const code = payload.code === "policy_denied" ? "policy_denied" : "invalid_request";
  return errorResponse(req, res, null, { status: code === "policy_denied" ? 403 : 400, code, component: "research_source" });
}

function registerResearchSourceRoutes({ app, callDashboardTool, dashboardExecutionMetadata, authenticatedUser, auditLog, logError, errorResponse }) {
  async function dispatch(req, tool, args) {
    return callDashboardTool(tool, args, dashboardExecutionMetadata(req, authenticatedUser(req) || "dashboard"));
  }

  async function readiness(req, res) {
    if (!authenticatedUser(req)) return res.status(403).json({ ok: false, error: "authentication required" });
    try {
      const result = await dispatch(req, "research_status", {});
      const payload = parseResult(result);
       if (result?.isError || payload.ok === false) return resultErrorResponse(req, res, result, "research workspace readiness unavailable", errorResponse);
      const workspace = payload.workspace || {};
      const policy = payload.policy || {};
      return res.json({ ok: true, readiness: {
        pack: payload.pack || "security-research",
        ready: payload.ready === true,
        workspace: { state: workspace.state || "unknown", source: typeof workspace.source === "string" && !/[\\/]/.test(workspace.source) ? workspace.source : null },
        capabilities: {
          present_on_server: Object.fromEntries(Object.entries(payload.capabilities?.present_on_server || {}).map(([key, value]) => [key, value === true])),
          dispatchable_by_pack: Object.fromEntries(Object.entries(payload.capabilities?.dispatchable_by_pack || {}).map(([key, value]) => [key, value === true])),
        },
        policy: {
          local_probes_enabled: policy.local_probes_enabled === true,
          http_private_addresses: policy.http_private_addresses === true,
          http_allowed_hosts: Number.isSafeInteger(policy.http_allowed_hosts) ? policy.http_allowed_hosts : 0,
          probe_timeout_ms: Number.isSafeInteger(policy.probe_timeout_ms) ? policy.probe_timeout_ms : null,
          max_evidence_bytes: Number.isSafeInteger(policy.max_evidence_bytes) ? policy.max_evidence_bytes : null,
        },
        environment_count: Array.isArray(payload.environments) ? payload.environments.length : 0,
      } });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "research_status" });
    }
  }

  async function list(req, res, mode) {
    if (!authenticatedUser(req)) return res.status(403).json({ ok: false, error: "authentication required" });
    try {
      const args = { action: "list", project_id: req.query.project_id, campaign_id: req.query.campaign_id, state: req.query.state, limit: boundedLimit(req.query.limit) };
      if (mode === "snapshots") args.repository_id = req.query.repository_id;
      const result = await dispatch(req, "research_source", args);
      const payload = parseResult(result);
       if (result?.isError || payload.ok === false) return resultErrorResponse(req, res, result, undefined, errorResponse);
      return res.json({ ok: true, repositories: (payload.repositories || []).map(repositoryView), snapshots: (payload.snapshots || []).map(snapshotView) });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "research_source" });
    }
  }

  async function detail(req, res, verificationOnly = false) {
    if (!authenticatedUser(req)) return res.status(403).json({ ok: false, error: "authentication required" });
    try {
      const result = await dispatch(req, "research_source", { action: "get", repository_id: req.query.repository_id, snapshot_id: req.params.snapshotId, campaign_id: req.query.campaign_id, project_id: req.query.project_id, limit: boundedLimit(req.query.limit) });
      const payload = parseResult(result);
       if (result?.isError || payload.ok === false) return resultErrorResponse(req, res, result, "source snapshot unavailable", errorResponse);
      const snapshot = snapshotView(payload.snapshot || {});
      return res.json(verificationOnly ? { ok: true, snapshot_id: snapshot.snapshot_id, verification: snapshot.verification, integrity_status: snapshot.integrity_status, stale: snapshot.verification.stale } : { ok: true, repository: repositoryView(payload.repository), snapshot });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "research_source" });
    }
  }

  async function action(req, res) {
    const name = req.params.action;
    if (!ACTIONS.has(name)) return res.status(404).json({ ok: false, error: "unknown research source action" });
    const actor = authenticatedUser(req);
    if (!actor) return res.status(403).json({ ok: false, error: "Research source actions require an authenticated dashboard user" });
    if (DESTRUCTIVE.has(name) && req.body?.confirm !== true) return res.status(400).json({ ok: false, error: "explicit confirmation is required", code: "confirmation_required" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const args = { ...body, action: name, repository_id: body.repository_id, snapshot_id: body.snapshot_id, campaign_id: body.campaign_id, project_id: body.project_id, limit: boundedLimit(body.limit) };
    try {
      auditLog(req, `research_source.${name}`, { repository_id: args.repository_id || null, snapshot_id: args.snapshot_id || null });
      const result = await dispatch(req, "research_source", args);
      const payload = parseResult(result);
       if (result?.isError || payload.ok === false) return resultErrorResponse(req, res, result, undefined, errorResponse);
      if (name === "verify") return res.json({ ok: true, verification: verificationView(payload.verification) });
      if (name === "select") return res.json({ ok: true, repository: repositoryView(payload.repository) });
      if (name === "compare") return res.json({ ok: true, comparison: { baseline: payload.baseline || null, candidate: payload.candidate || null, changed: payload.changed === true, changed_count: Array.isArray(payload.changes) ? payload.changes.length : null } });
      if (name === "index") { const partial = payload.index?.degradation?.truncated === true || payload.index?.page?.has_more === true || payload.provenance?.completeness === "partial"; return res.json({ ok: true, indexed: !partial, verification: verificationView(payload.verification), index_status: partial ? "partial" : "completed", stale: false, provenance: { snapshot_id: payload.provenance?.snapshot_id || null, authority: "derived_analysis_input" } }); }
      if (name === "recover") return res.json({ ok: true, recovery: { status: "completed", count: Number(payload.count) || 0 } });
      if (name === "import") return res.json({ ok: true, repository: repositoryView(payload.repository), snapshot: snapshotView(payload.snapshot), verification: verificationView(payload.verification) });
      const item = payload.item || payload.snapshot || payload.repository || null;
      return res.json({ ok: true, item: item ? (item.snapshot_id ? snapshotView(item) : repositoryView(item)) : null, storage_removed: name === "remove" ? payload.storage_removed === true : undefined });
    } catch (error) {
      return errorResponse(req, res, error, { status: 500, code: "service_unavailable", component: "research_source" });
    }
  }

  app.get("/api/research/source/readiness", readiness);
  app.get("/api/research/source/repositories", (req, res) => list(req, res, "repositories"));
  app.get("/api/research/source/snapshots", (req, res) => list(req, res, "snapshots"));
  app.get("/api/research/source/snapshots/:snapshotId/verification", (req, res) => detail(req, res, true));
  app.get("/api/research/source/snapshots/:snapshotId", (req, res) => detail(req, res));
  app.post("/api/research/source/:action", action);
  app.post("/api/research/source/actions/:action", action);
}

module.exports = { registerResearchSourceRoutes };
