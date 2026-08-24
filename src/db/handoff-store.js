const fs = require("fs");
const crypto = require("crypto");
const { redactSensitive } = require("../redact");

function createHandoffStore({ db, execFileSync, childProcessEnv, hasTable, nowIso, parseJson, stableHash, stableId, auditMemoryEvent }) {
  const HANDOFF_PACKET_STATUSES = new Set(["active", "blocked", "ready", "completed", "abandoned"]);
  const HANDOFF_LIFECYCLE = new Set(["draft", "ready", "claimed", "verifying", "reconciliation_required", "active", "released", "superseded", "revoked", "completed", "expired", "invalid"]);
  const TRANSITIONS = {
    draft: new Set(["ready", "invalid", "revoked"]),
    ready: new Set(["claimed", "active", "revoked", "superseded"]),
    claimed: new Set(["verifying", "active", "released", "expired", "reconciliation_required", "revoked"]),
    verifying: new Set(["active", "reconciliation_required", "released", "revoked"]),
    reconciliation_required: new Set(["verifying", "released", "revoked", "superseded"]),
    active: new Set(["ready", "claimed", "released", "completed", "reconciliation_required", "revoked", "superseded"]),
    released: new Set(["claimed", "ready", "revoked", "superseded"]),
    superseded: new Set([]), revoked: new Set([]), completed: new Set([]), expired: new Set([]), invalid: new Set([]),
  };

  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") return Object.keys(value).sort().reduce((out, key) => { out[key] = canonicalize(value[key]); return out; }, {});
    return value;
  }

  function continuityHash(value) {
    return stableHash(`sidekick:handoff:v3:${JSON.stringify(canonicalize(value))}`);
  }

  function appendHandoffEvent(handoffId, version, eventType, payload = {}, { actor = "system", source = "handoff" } = {}) {
    if (!hasTable("memory_handoff_events")) return null;
    const inTransaction = db.inTransaction;
    if (!inTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db.prepare("SELECT event_seq, event_hash FROM memory_handoff_events WHERE handoff_id = ? ORDER BY event_seq DESC LIMIT 1").get(handoffId);
      const event = { handoff_id: handoffId, event_seq: Number(previous?.event_seq || 0) + 1, version: Number(version), event_type: eventType, actor: String(actor || "system"), source: String(source || "handoff"), payload: canonicalize(payload), previous_hash: previous?.event_hash || null };
      const eventHash = continuityHash(event);
      const id = stableId("he", `${handoffId}|${eventHash}`);
      db.prepare("INSERT OR IGNORE INTO memory_handoff_events (id, handoff_id, event_seq, version, event_type, actor, source, payload_json, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, handoffId, event.event_seq, Number(version), eventType, event.actor, event.source, JSON.stringify(event.payload), event.previous_hash, eventHash, nowIso());
      if (!inTransaction) db.exec("COMMIT");
      return { id, ...event, event_hash: eventHash };
    } catch (error) {
      if (!inTransaction) { try { db.exec("ROLLBACK"); } catch {} }
      throw error;
    }
  }

  function gitCheckpoint(workingDirectory) {
    const root = String(workingDirectory || "");
    if (!root || !fs.existsSync(root)) return { workspace: { root: root || null, visible: false }, repository: null };
    const git = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: childProcessEnv(), maxBuffer: 1024 * 1024 }).trim();
    try {
      const repositoryRoot = git(["rev-parse", "--show-toplevel"]);
      const status = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z"], { encoding: "utf8", env: childProcessEnv(), maxBuffer: 1024 * 1024 }).split("\0").filter(Boolean).slice(0, 2000);
      return { workspace: { root: repositoryRoot, visible: true }, repository: { root: repositoryRoot, branch: git(["branch", "--show-current"]) || null, head: git(["rev-parse", "HEAD"]), upstream: (() => { try { return git(["rev-parse", "--abbrev-ref", "@{upstream}"]); } catch { return null; } })(), status } };
    } catch { return { workspace: { root, visible: true }, repository: { root, state: "unavailable" } }; }
  }

  function checkpointDrift(checkpoint, workingDirectory) {
    if (!checkpoint || !checkpoint.repository) return { status: "unknown", severity: "blocking", reasons: ["checkpoint has no repository state"] };
    const observed = gitCheckpoint(workingDirectory || checkpoint.workspace?.root);
    if (!observed.repository || observed.repository.state === "unavailable") return { status: "unknown", severity: "blocking", expected: checkpoint.repository, observed, reasons: ["repository state is unavailable"] };
    const differences = [];
    for (const key of ["root", "branch", "head", "upstream"]) if ((checkpoint.repository[key] || null) !== (observed.repository[key] || null)) differences.push({ field: `repository.${key}`, expected: checkpoint.repository[key] || null, observed: observed.repository[key] || null });
    if (JSON.stringify(checkpoint.repository.status || []) !== JSON.stringify(observed.repository.status || [])) differences.push({ field: "repository.status", expected: checkpoint.repository.status || [], observed: observed.repository.status || [] });
    return { status: differences.length ? "drift" : "clean", severity: differences.length ? "material" : "none", differences, expected: checkpoint.repository, observed: observed.repository };
  }

  function normalizeHandoffPacket(packet) {
    if (packet === undefined || packet === null) return null;
    if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
      throw new Error("Handoff packet must be an object");
    }
    const normalized = { ...packet };
    if (normalized.status !== undefined && !HANDOFF_PACKET_STATUSES.has(String(normalized.status))) {
      throw new Error(`Handoff packet status must be one of: ${Array.from(HANDOFF_PACKET_STATUSES).join(", ")}`);
    }
    for (const field of ["completed_steps", "decisions", "blockers", "acceptance_criteria", "risks"]) {
      if (normalized[field] !== undefined && !Array.isArray(normalized[field])) {
        throw new Error(`Handoff packet ${field} must be an array`);
      }
    }
    for (const field of ["artifacts", "evidence", "relationships"]) {
      if (normalized[field] !== undefined && !Array.isArray(normalized[field])) {
        throw new Error(`Handoff packet ${field} must be an array`);
      }
      if (Array.isArray(normalized[field]) && normalized[field].some(item => !item || typeof item !== "object" || Array.isArray(item))) {
        throw new Error(`Handoff packet ${field} entries must be objects`);
      }
    }
    if (normalized.provenance !== undefined && (!normalized.provenance || typeof normalized.provenance !== "object" || Array.isArray(normalized.provenance))) {
      throw new Error("Handoff packet provenance must be an object");
    }
    return normalized;
  }

  function parseHandoffPacket(value) {
    if (!value) return {};
    try { return JSON.parse(value); } catch { return {}; }
  }

  function getHandoffLinks(handoffId, version = null) {
    if (!hasTable("memory_handoff_links")) return [];
    const rows = version === null
      ? db.prepare("SELECT * FROM memory_handoff_links WHERE handoff_id = ? ORDER BY version DESC, link_type, created_at").all(handoffId)
      : db.prepare("SELECT * FROM memory_handoff_links WHERE handoff_id = ? AND version = ? ORDER BY link_type, created_at").all(handoffId, Number(version));
    return rows.map(row => ({ id: row.id, handoff_id: row.handoff_id, version: row.version, type: row.link_type, payload: parseJson(row.payload_json, {}), created_at: row.created_at }));
  }

  function persistHandoffLinks(handoff) {
    if (!handoff || !hasTable("memory_handoff_links")) return;
    const packet = handoff.packet || {};
    for (const type of ["evidence", "artifacts", "relationships"]) {
      const linkType = type === "artifacts" ? "artifact" : type === "relationships" ? "relationship" : "evidence";
      for (const [index, payload] of (Array.isArray(packet[type]) ? packet[type] : []).entries()) {
        const id = stableId("hl", `${handoff.id}|${handoff.version}|${linkType}|${JSON.stringify(payload)}|${index}`);
        db.prepare("INSERT OR IGNORE INTO memory_handoff_links (id, handoff_id, version, link_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, handoff.id, handoff.version, linkType, JSON.stringify(payload), handoff.updated_at || nowIso());
      }
    }
  }

  function validateHandoffPacket(packet, { requireResume = false } = {}) {
    const value = normalizeHandoffPacket(packet || {});
    const issues = [];
    if (!value.objective && !value.summary) issues.push("packet requires objective or summary");
    if (requireResume && !value.next_step && value.status !== "completed" && value.status !== "abandoned") issues.push("packet requires next_step before resume");
    if (value.status === "blocked" && (!Array.isArray(value.blockers) || value.blockers.length === 0)) issues.push("blocked packet requires at least one blocker");
    if (value.status === "completed" && (!Array.isArray(value.acceptance_criteria) || value.acceptance_criteria.length === 0)) issues.push("completed packet requires acceptance_criteria");
    return { valid: issues.length === 0, issues, packet: value };
  }

  function evaluateHandoffQuality(packet, { requireResume = true } = {}) {
    const validation = validateHandoffPacket(packet, { requireResume });
    const value = validation.packet;
    const checks = [
      ["objective", Boolean(value.objective || value.summary)],
      ["status", Boolean(value.status)],
      ["next_step", !requireResume || value.status === "completed" || value.status === "abandoned" || Boolean(value.next_step)],
      ["completed_steps", Array.isArray(value.completed_steps)],
      ["acceptance_criteria", Array.isArray(value.acceptance_criteria) && value.acceptance_criteria.length > 0],
      ["provenance", Boolean(value.provenance && typeof value.provenance === "object")],
      ["verification", Array.isArray(value.evidence) && value.evidence.length > 0],
    ];
    const issues = [...validation.issues, ...checks.filter(([, ok]) => !ok).map(([name]) => `quality requires ${name}`)];
    return { valid: issues.length === 0, issues: [...new Set(issues)], checks: checks.map(([name, ok]) => ({ name, valid: ok })), packet: value };
  }

  function evidenceFreshness(packet, { now = Date.now(), maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    const evidence = Array.isArray(packet?.evidence) ? packet.evidence : [];
    return evidence.map((item, index) => {
      const stamp = item.observed_at || item.verified_at || item.created_at || null;
      const ageMs = stamp ? Math.max(0, now - Date.parse(stamp)) : null;
      const valid = item.status === "failed" || item.status === "invalid" ? false : ageMs !== null && Number.isFinite(ageMs) && ageMs <= maxAgeMs;
      return { index, type: item.type || null, label: item.label || null, status: item.status || "unknown", observed_at: stamp, age_ms: ageMs, freshness: valid ? "fresh" : stamp ? "stale" : "unknown", valid };
    });
  }

  function evidenceKey(item, index) {
    return stableHash(`sidekick:handoff:evidence:${index}:${JSON.stringify(canonicalize(item || {}))}`).slice(0, 64);
  }

  function getHandoffEvidenceState(id, version = null) {
    if (!hasTable("memory_handoff_evidence_state")) return [];
    const handoff = getHandoff(id);
    const selectedVersion = version === null ? handoff?.version : Number(version);
    if (!selectedVersion) return [];
    return db.prepare("SELECT * FROM memory_handoff_evidence_state WHERE handoff_id = ? AND version = ? ORDER BY evidence_index ASC").all(id, selectedVersion).map(row => ({ evidence_key: row.evidence_key, evidence_index: row.evidence_index, state: row.state, reason: row.reason, source_hash: row.source_hash, observed_at: row.observed_at, checked_at: row.checked_at }));
  }

  function refreshHandoffEvidence(id, { working_directory, maxAgeMs = 7 * 24 * 60 * 60 * 1000, actor = "system" } = {}) {
    const handoff = getHandoff(id);
    if (!handoff) return { status: "invalid", reasons: ["handoff not found"] };
    if (!hasTable("memory_handoff_evidence_state")) return { status: "unavailable", reasons: ["evidence state table is not available; run migrations"] };
    const now = Date.now();
    const items = Array.isArray(handoff.packet?.evidence) ? handoff.packet.evidence : [];
    const states = items.map((item, index) => {
      const stamp = item.observed_at || item.verified_at || item.created_at || null;
      const ageMs = stamp ? Math.max(0, now - Date.parse(stamp)) : null;
      let state = item.status === "failed" || item.status === "invalid" ? "invalid" : stamp && Number.isFinite(ageMs) && ageMs <= maxAgeMs ? "fresh" : stamp ? "stale" : "unknown";
      let reason = state === "fresh" ? "within freshness window" : state === "stale" ? "outside freshness window" : state === "unknown" ? "no evidence timestamp" : "evidence reports failure or invalidity";
      let sourceHash = item.content_hash || item.sha256 || null;
      if (item.artifact_id && hasTable("platform_artifacts")) {
        const artifact = db.prepare("SELECT artifact_id, content_hash, deleted_at FROM platform_artifacts WHERE artifact_id = ?").get(String(item.artifact_id));
        if (!artifact) { state = "invalid"; reason = "referenced artifact does not exist"; }
        else if (artifact.deleted_at) { state = "invalid"; reason = "referenced artifact is deleted"; }
        else if (sourceHash && artifact.content_hash && sourceHash !== artifact.content_hash) { state = "invalid"; reason = "referenced artifact hash changed"; }
        else { sourceHash = artifact.content_hash || sourceHash; }
      }
      if (item.commit_sha && working_directory) {
        try { execFileSync("git", ["-C", working_directory, "cat-file", "-e", `${String(item.commit_sha)}^{commit}`], { stdio: "ignore", env: childProcessEnv() }); }
        catch { state = "invalid"; reason = "referenced commit is unavailable"; }
      }
      return { evidence_key: evidenceKey(item, index), evidence_index: index, state, reason, source_hash: sourceHash, observed_at: stamp, checked_at: new Date(now).toISOString() };
    });
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM memory_handoff_evidence_state WHERE handoff_id = ? AND version = ?").run(id, handoff.version);
      for (const state of states) db.prepare("INSERT INTO memory_handoff_evidence_state (handoff_id, version, evidence_key, evidence_index, state, reason, source_hash, observed_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, handoff.version, state.evidence_key, state.evidence_index, state.state, state.reason, state.source_hash, state.observed_at, state.checked_at);
    });
    tx();
    appendHandoffEvent(id, handoff.version, "evidence_refreshed", { actor, counts: states.reduce((out, item) => { out[item.state] = (out[item.state] || 0) + 1; return out; }, {}) }, { actor, source: "handoff" });
    return { status: "refreshed", handoff_id: id, version: handoff.version, states };
  }

  function getHandoffReceiverProjection(id, { working_directory, recipient = null } = {}) {
    const handoff = getHandoff(id);
    if (!handoff) return null;
    const packet = handoff.packet || {};
    const quality = evaluateHandoffQuality(packet);
    const readiness = getHandoffReadiness(id, { working_directory, recipient });
    const persistedFreshness = getHandoffEvidenceState(id);
    const freshness = persistedFreshness.length ? persistedFreshness.map(item => ({ ...item, type: packet.evidence?.[item.evidence_index]?.type || null, label: packet.evidence?.[item.evidence_index]?.label || null, freshness: item.state, valid: item.state === "fresh" })) : evidenceFreshness(packet);
    return {
      handoff_id: handoff.id,
      version: handoff.version,
      title: handoff.title,
      project: handoff.project,
      lifecycle_state: handoff.lifecycle_state,
      start_here: {
        objective: packet.objective || packet.summary || handoff.title,
        current_state: packet.current_state || packet.state || packet.summary || null,
        next_step: packet.next_step || null,
        blockers: packet.blockers || [],
        open_questions: packet.open_questions || packet.questions || [],
        decisions: packet.decisions || [],
        risks: packet.risks || [],
      },
      completed_steps: packet.completed_steps || [],
      acceptance_criteria: packet.acceptance_criteria || [],
      provenance: packet.provenance || null,
      artifacts: packet.artifacts || [],
      relationships: packet.relationships || [],
      evidence: { items: freshness, fresh: freshness.filter(item => item.freshness === "fresh").length, stale: freshness.filter(item => item.freshness === "stale").length, unknown: freshness.filter(item => item.freshness === "unknown").length, invalid: freshness.filter(item => item.freshness === "invalid").length },
      quality,
      readiness,
      claim: handoff.claim,
    };
  }

  function compareHandoffVersions(id, fromVersion, toVersion) {
    const current = getHandoff(id);
    if (!current) return null;
    const versions = listHandoffVersions(id);
    const from = versions.find(item => Number(item.version) === Number(fromVersion));
    const to = versions.find(item => Number(item.version) === Number(toVersion)) || versions.find(item => item.current);
    if (!from || !to) return { handoff_id: id, from: fromVersion, to: toVersion, issues: ["requested version not found"] };
    const keys = new Set([...Object.keys(from.packet || {}), ...Object.keys(to.packet || {})]);
    const packetChanges = [...keys].sort().filter(key => JSON.stringify(from.packet?.[key]) !== JSON.stringify(to.packet?.[key])).map(key => ({ field: key, from: from.packet?.[key] === undefined ? null : from.packet[key], to: to.packet?.[key] === undefined ? null : to.packet[key] }));
    return { handoff_id: id, from: { version: from.version, hash: from.content_hash }, to: { version: to.version, hash: to.content_hash }, content_changed: from.content_hash !== to.content_hash, packet_changes: packetChanges };
  }

  function getHandoffResumePreflight(id, { working_directory, recipient = null, simulate = false } = {}) {
    const projection = getHandoffReceiverProjection(id, { working_directory, recipient });
    if (!projection) return { status: "invalid", reasons: ["handoff not found"] };
    const handoff = getHandoff(id);
    const persistedEvidence = getHandoffEvidenceState(id);
    const provenance = verifyHandoffProvenance(handoff.packet, { requireResume: true });
    const reasons = [];
    if (projection.readiness.status !== "ready") reasons.push(...projection.readiness.reasons);
    if (!projection.quality.valid) reasons.push(...projection.quality.issues);
    if (projection.evidence.stale > 0) reasons.push("one or more evidence items are stale");
    if (projection.evidence.unknown > 0) reasons.push("one or more evidence items have unknown freshness");
    if (projection.evidence.invalid > 0) reasons.push("one or more evidence items are invalid");
    if (Array.isArray(handoff.packet?.evidence) && handoff.packet.evidence.length > 0 && persistedEvidence.length === 0) reasons.push("evidence freshness has not been explicitly refreshed");
    if (provenance.status === "invalid") reasons.push(...provenance.issues);
    const authority = ["current_principal", "current_policy", "current_capability_catalog", "current_workspace_scope", "current_approval_state"];
    return { status: reasons.length ? "blocked" : "ready", safe_to_resume: reasons.length === 0, simulated: simulate, reasons: [...new Set(reasons)], authority_recheck_required: authority, projection, provenance };
  }

  function renewHandoffClaim(id, { claim_token, leaseSeconds = 900, actor = "system", source = "handoff" } = {}) {
    if (!claim_token) throw new Error("handoff claim renewal requires claim_token");
    const current = getHandoff(id);
    if (!current || !current.claim) throw new Error("handoff has no active claim");
    const tokenHash = continuityHash({ domain: "claim", token: claim_token });
    const expires = new Date(Date.now() + Math.max(30, Math.min(Number(leaseSeconds) || 900, 86400)) * 1000).toISOString();
    const result = db.prepare("UPDATE memory_handoffs SET claim_expires_at = ?, updated_at = ? WHERE id = ? AND claim_token = ? AND lifecycle_state = 'claimed' AND claim_expires_at > ?").run(expires, nowIso(), id, tokenHash, nowIso());
    if (!result.changes) throw new Error("handoff claim is invalid or expired");
    appendHandoffEvent(id, current.version, "claim_renewed", { expires_at: expires }, { actor, source });
    return { handoff: getHandoff(id), expires_at: expires };
  }

  function beginHandoffResume(id, { claim_token, working_directory, recipient = null, actor = "system", source = "handoff" } = {}) {
    if (!claim_token) throw new Error("handoff resume requires claim_token");
    const current = getHandoff(id);
    const tokenHash = continuityHash({ domain: "claim", token: claim_token });
    if (!current || !current.claim || current.lifecycle_state !== "claimed") throw new Error("handoff is not actively claimed");
    const claimRow = db.prepare("SELECT claim_token, claim_expires_at FROM memory_handoffs WHERE id = ?").get(id);
    if (!claimRow || claimRow.claim_token !== tokenHash || new Date(claimRow.claim_expires_at).getTime() <= Date.now()) throw new Error("handoff claim is invalid or expired");
    const preflight = getHandoffResumePreflight(id, { working_directory, recipient, simulate: true });
    if (!preflight.safe_to_resume) throw new Error(`handoff resume preflight blocked: ${preflight.reasons.join("; ")}`);
    const result = db.prepare("UPDATE memory_handoffs SET lifecycle_state = 'verifying', updated_at = ? WHERE id = ? AND claim_token = ? AND lifecycle_state = 'claimed'").run(nowIso(), id, tokenHash);
    if (!result.changes) throw new Error("handoff changed before resume began");
    appendHandoffEvent(id, current.version, "resume_started", { recipient }, { actor, source });
    return { handoff: getHandoff(id), preflight };
  }

  function verifyHandoffProvenance(packet, { requireResume = true } = {}) {
    const validation = validateHandoffPacket(packet, { requireResume });
    const provenance = validation.packet.provenance;
    const checks = [];
    const issues = [...validation.issues];
    if (!provenance || typeof provenance !== "object") {
      return { status: validation.valid ? "unverifiable" : "invalid", valid: validation.valid, issues: [...issues, "packet has no provenance to verify"], checks, packet: validation.packet };
    }

    const commit = provenance.commit_sha ? String(provenance.commit_sha) : "";
    if (commit && !/^[0-9a-f]{7,64}$/i.test(commit)) issues.push("provenance.commit_sha must be a Git commit SHA");
    const repo = provenance.working_directory && fs.existsSync(String(provenance.working_directory))
      ? String(provenance.working_directory)
      : null;
    if (!repo) {
      checks.push({ name: "repository", status: "unverifiable", detail: "working_directory is not visible to the Sidekick server" });
    } else if (!commit) {
      checks.push({ name: "commit", status: "unverifiable", detail: "provenance.commit_sha is missing" });
    } else {
      try {
        execFileSync("git", ["-C", repo, "cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore", env: childProcessEnv() });
        checks.push({ name: "commit", status: "verified", commit_sha: commit });
        if (provenance.branch) {
          try {
            execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", commit, String(provenance.branch)], { stdio: "ignore", env: childProcessEnv() });
            checks.push({ name: "branch", status: "verified", branch: String(provenance.branch) });
          } catch {
            checks.push({ name: "branch", status: "stale", branch: String(provenance.branch), detail: "branch is missing or does not contain the recorded commit" });
            issues.push("provenance.branch does not contain the recorded commit");
          }
        }
      } catch {
        checks.push({ name: "commit", status: "stale", commit_sha: commit, detail: "recorded commit is not present in the visible repository" });
        issues.push("provenance.commit_sha is not present in the visible repository");
      }
    }
    const status = issues.length ? "invalid" : checks.some(check => check.status === "stale") ? "stale" : checks.some(check => check.status === "unverifiable") ? "unverifiable" : "verified";
    return { status, valid: status === "verified", issues, checks, packet: validation.packet };
  }

  /**
   * Save a handoff.
   *
   * A handoff is a durable, versioned artifact: the memory_handoffs row is
   * always the LATEST version, and every superseded version is preserved
   * verbatim in memory_handoff_versions before the row changes. Nothing about a
   * save can destroy prior content.
   *
   * Rules:
   *  - `existing` is resolved by structured id only. There is no alternate
   *    handoff identity or lookup path.
   *  - Omitted metadata (project/title/source/task_id) NEVER nulls existing
   *    values; supplied metadata replaces.
   *  - `expectedVersion`, when supplied, must equal the current version or the
   *    save throws — the caller was editing a version that is no longer latest.
   *  - Unchanged content is a metadata-only touch: no version bump, no snapshot,
   *    so extraction idempotency keyed on (id, content_hash) is preserved.
   *  - content_hash remains the hash of the REDACTED content (memory extraction
   *    fingerprints embed it; changing its meaning would duplicate memories).
   */
  function saveHandoff({ id, project, title, source, task_id, content, previous_id, extraction_state, extraction_version, expectedVersion, packet, owner_principal_id, created_by_principal_id }) {
    if (!hasTable("memory_handoffs")) throw new Error("memory_handoffs table is not available; run migrations");
    const ts = nowIso();
  const redacted = redactSensitive(String(content || ""));
    const hash = stableHash(redacted);
    const packetValue = normalizeHandoffPacket(packet);
    const packetJson = packetValue === null ? null : JSON.stringify(packetValue);

    const existing = id ? db.prepare("SELECT * FROM memory_handoffs WHERE id = ?").get(id) : null;

    if (existing && expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== Number(existing.version)) {
      throw new Error(`Handoff "${existing.id}" changed concurrently: expected version ${expectedVersion}, found ${existing.version}`);
    }

    const packetChanged = existing && packetValue !== null && packetJson !== (existing.packet_json || "{}");
    if (existing && existing.content_hash === hash && !packetChanged) {
      db.prepare(`
        UPDATE memory_handoffs SET
          updated_at = ?,
          project = COALESCE(?, project),
          title = COALESCE(?, title),
          source = COALESCE(?, source),
          task_id = COALESCE(?, task_id),
          schema_version = MAX(schema_version, 3),
          extraction_state = COALESCE(?, extraction_state),
          extraction_version = COALESCE(?, extraction_version),
          owner_principal_id = COALESCE(?, owner_principal_id),
          created_by_principal_id = COALESCE(?, created_by_principal_id)
        WHERE id = ?
      `).run(ts, project || null, title || null, source || null, task_id || null, extraction_state || null, extraction_version || null, owner_principal_id || null, created_by_principal_id || null, existing.id);
      const touched = getHandoff(existing.id);
      persistHandoffLinks(touched);
      return touched;
    }

    if (existing) {
      // Content changed: preserve the current version verbatim, then advance the
      // main row. Both happen in one transaction — a new latest version cannot
      // exist without its predecessor being in history.
      if (!hasTable("memory_handoff_versions")) {
        throw new Error("memory_handoff_versions table is not available; run migrations before updating handoff content");
      }
      const nextVersion = Number(existing.version || 1) + 1;
      const inTransaction = db.inTransaction;
      if (!inTransaction) db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          INSERT OR IGNORE INTO memory_handoff_versions (
            handoff_id, version, title, project, source, task_id, content, redacted_content, content_hash, created_at, superseded_at, packet_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(existing.id, existing.version, existing.title, existing.project, existing.source, existing.task_id, existing.content, existing.redacted_content, existing.content_hash, existing.updated_at || existing.created_at, ts, existing.packet_json || "{}");
        // The history row at (id, version) must hold THIS content — whether we
        // just wrote it or an identical concurrent snapshot beat us to it. A
        // mismatched pre-existing row (out-of-band write, restored backup) would
        // otherwise let the update proceed while history preserves the wrong
        // bytes; fail loudly inside the transaction instead.
        const snapshot = db.prepare("SELECT content_hash FROM memory_handoff_versions WHERE handoff_id = ? AND version = ?").get(existing.id, existing.version);
        if (!snapshot || snapshot.content_hash !== existing.content_hash) {
          throw new Error(`Handoff "${existing.id}" history at version ${existing.version} does not match the current content; refusing to overwrite the latest version (inspect memory_handoff_versions)`);
        }
        const outcome = db.prepare(`
          UPDATE memory_handoffs SET
            version = ?,
            content = ?,
            redacted_content = ?,
            content_hash = ?,
            packet_json = ?,
            schema_version = MAX(schema_version, 3),
            updated_at = ?,
            project = COALESCE(?, project),
            title = COALESCE(?, title),
            source = COALESCE(?, source),
            task_id = COALESCE(?, task_id),
            extraction_state = ?,
            extraction_version = COALESCE(?, extraction_version),
            owner_principal_id = COALESCE(?, owner_principal_id),
            created_by_principal_id = COALESCE(?, created_by_principal_id)
          WHERE id = ? AND version = ?
        `).run(
          nextVersion,
          String(content || ""),
          redacted,
          hash,
          packetJson === null ? (existing.packet_json || "{}") : packetJson,
          ts,
          project || null,
          title || null,
          source || null,
          task_id || null,
          extraction_state || "pending",
          extraction_version || null,
          owner_principal_id || null,
          created_by_principal_id || null,
          existing.id,
          existing.version
        );
        if (outcome.changes === 0) {
          throw new Error(`Handoff "${existing.id}" changed concurrently during save (version ${existing.version} is no longer current)`);
        }
        if (!inTransaction) db.exec("COMMIT");
      } catch (error) {
        if (!inTransaction) { try { db.exec("ROLLBACK"); } catch {} }
        throw error;
      }
      auditMemoryEvent("handoff_updated", "handoff", existing.id, { project: project || existing.project, version: nextVersion, content_hash: hash }, source || "system");
      const updated = getHandoff(existing.id);
      appendHandoffEvent(existing.id, nextVersion, "updated", { content_hash: hash }, { actor: source || "system", source: source || "handoff" });
      persistHandoffLinks(updated);
      return updated;
    }

    // New handoff. Creation-time dedupe applies only when the caller supplied no
    // identity at all — re-ingesting identical content must not mint duplicates.
    if (!id) {
      const existingByHash = db.prepare("SELECT * FROM memory_handoffs WHERE content_hash = ? AND COALESCE(project, '') = COALESCE(?, '') ORDER BY version DESC LIMIT 1").get(hash, project || null);
      if (existingByHash) return normalizeHandoffRow(existingByHash);
    }

    const handoffId = id || stableId("handoff", `${project || "global"}|${hash}`);
    db.prepare(`
      INSERT INTO memory_handoffs (
        id, project, title, source, task_id, version, previous_id, content_hash,
        content, redacted_content, extraction_state, extraction_version, created_at, updated_at, packet_json,
        owner_principal_id, created_by_principal_id, schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      handoffId,
      project || null,
      title || "handoff",
      source || "handoff",
      task_id || null,
      1,
      previous_id || null,
      hash,
      String(content || ""),
      redacted,
      extraction_state || "pending",
      extraction_version || null,
      ts,
      ts,
      packetJson || "{}",
      owner_principal_id || null,
      created_by_principal_id || null,
      3
    );
    auditMemoryEvent("handoff_created", "handoff", handoffId, { project, version: 1, content_hash: hash }, source || "system");
    appendHandoffEvent(handoffId, 1, "created", { content_hash: hash }, { actor: source || "system", source: source || "handoff" });
    return getHandoff(handoffId);
  }

  /** Version history for a handoff: prior versions plus the current row, newest first. */
  function listHandoffVersions(handoffId) {
    const current = getHandoff(handoffId);
    if (!current) return [];
    const history = hasTable("memory_handoff_versions")
      ? db.prepare("SELECT * FROM memory_handoff_versions WHERE handoff_id = ? ORDER BY version DESC").all(current.id)
      : [];
    return [
      { handoff_id: current.id, version: current.version, title: current.title, project: current.project, source: current.source, task_id: current.task_id, content_hash: current.content_hash, packet: current.packet, content_bytes: Buffer.byteLength(current.content || ""), created_at: current.updated_at, superseded_at: null, current: true },
      ...history.map(row => ({ handoff_id: row.handoff_id, version: row.version, title: row.title, project: row.project, source: row.source, task_id: row.task_id, content_hash: row.content_hash, packet: parseHandoffPacket(row.packet_json), content_bytes: Buffer.byteLength(row.content || ""), created_at: row.created_at, superseded_at: row.superseded_at, current: false })),
    ];
  }

  /** Fetch one specific version of a handoff (the current one or a historical one). */
  function getHandoffVersion(handoffId, version) {
    const current = getHandoff(handoffId);
    if (!current) return null;
    if (Number(version) === Number(current.version)) return { ...current, current: true };
    if (!hasTable("memory_handoff_versions")) return null;
    const row = db.prepare("SELECT * FROM memory_handoff_versions WHERE handoff_id = ? AND version = ?").get(current.id, Number(version));
    if (!row) return null;
    return {
      id: row.handoff_id,
      project: row.project,
      title: row.title,
      source: row.source,
      task_id: row.task_id,
      version: row.version,
      content_hash: row.content_hash,
      content: row.content,
      redacted_content: row.redacted_content,
      packet: parseHandoffPacket(row.packet_json),
      created_at: row.created_at,
      superseded_at: row.superseded_at,
      current: false,
    };
  }

  /**
   * Restore a historical version by appending its content as a NEW latest
   * version. History is never deleted or rewritten — a restore is itself a
   * recorded version, so even a mistaken restore is recoverable.
   */
  function restoreHandoffVersion(handoffId, version, { source } = {}) {
    const current = getHandoff(handoffId);
    if (!current) throw new Error(`Handoff not found: ${handoffId}`);
    const target = getHandoffVersion(current.id, version);
    if (!target) throw new Error(`Handoff "${current.id}" has no version ${version}`);
    // Restoring the current version — or any version whose content already
    // equals the current content — changes nothing; report that honestly
    // instead of minting a phantom version transition in the audit trail.
    if (Number(version) === Number(current.version) || (target.content_hash === current.content_hash && JSON.stringify(target.packet || {}) === JSON.stringify(current.packet || {}))) {
      return { handoff: current, restored_from: Number(version), no_op: true };
    }
    const saved = saveHandoff({
      id: current.id,
      content: target.content,
      packet: target.packet,
      source: source || "restore",
      extraction_state: "pending",
    });
    auditMemoryEvent("handoff_restored", "handoff", current.id, { restored_from: Number(version), new_version: saved.version }, source || "restore");
    return { handoff: saved, restored_from: Number(version), no_op: false };
  }

  function unarchiveHandoff(id) {
    const handoff = getHandoff(id);
    if (!handoff) return false;
    db.prepare("UPDATE memory_handoffs SET archived_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), handoff.id);
    auditMemoryEvent("handoff_unarchived", "handoff", handoff.id, {}, "system");
    return true;
  }

  /**
   * Deliberately and audibly remove ONE historical version's content — the
   * remediation path for a credential accidentally pasted into an old version.
   * The current version can never be purged (update past it first), and the
   * audit event records what was removed so the deletion itself is history.
   */
  function purgeHandoffVersion(handoffId, version, { reason, source } = {}) {
    const current = getHandoff(handoffId);
    if (!current) throw new Error(`Handoff not found: ${handoffId}`);
    if (Number(version) === Number(current.version)) {
      throw new Error(`Handoff "${current.id}" version ${version} is the CURRENT version; update the handoff first, then purge the historical version`);
    }
    if (!hasTable("memory_handoff_versions")) throw new Error("memory_handoff_versions table is not available; run migrations");
    const row = db.prepare("SELECT content_hash FROM memory_handoff_versions WHERE handoff_id = ? AND version = ?").get(current.id, Number(version));
    if (!row) throw new Error(`Handoff "${current.id}" has no historical version ${version}`);
    db.prepare("DELETE FROM memory_handoff_versions WHERE handoff_id = ? AND version = ?").run(current.id, Number(version));
    auditMemoryEvent("handoff_version_purged", "handoff", current.id, { version: Number(version), content_hash: row.content_hash, reason: String(reason || "unspecified").slice(0, 300) }, source || "system");
    return { purged: true, handoff_id: current.id, version: Number(version), content_hash: row.content_hash };
  }

  function normalizeHandoffRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      project: row.project,
      title: row.title,
      source: row.source,
      task_id: row.task_id,
      version: row.version,
      previous_id: row.previous_id,
      content_hash: row.content_hash,
      content: row.content,
      redacted_content: row.redacted_content,
      packet: parseHandoffPacket(row.packet_json),
      extraction_state: row.extraction_state,
      extraction_version: row.extraction_version,
      schema_version: row.schema_version || 2,
      lifecycle_state: row.lifecycle_state || "draft",
      checkpoint: parseJson(row.checkpoint_json, null),
      checkpoint_hash: row.checkpoint_hash || null,
      claim: row.claim_owner ? { owner: row.claim_owner, expires_at: row.claim_expires_at, active: !!row.claim_expires_at && new Date(row.claim_expires_at).getTime() > Date.now() } : null,
      sealed_at: row.sealed_at || null,
      revoked_at: row.revoked_at || null,
      superseded_by: row.superseded_by || null,
      completed_at: row.completed_at || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      archived_at: row.archived_at,
      owner_principal_id: row.owner_principal_id || null,
      created_by_principal_id: row.created_by_principal_id || null,
      links: getHandoffLinks(row.id, row.version)
    };
  }

  function getHandoff(id) {
    if (!hasTable("memory_handoffs")) return null;
    const row = db.prepare("SELECT * FROM memory_handoffs WHERE id = ?").get(id);
    const created = normalizeHandoffRow(row);
    persistHandoffLinks(created);
    return created;
  }

  function listHandoffEvents(handoffId, limit = 100) {
    if (!hasTable("memory_handoff_events")) return [];
    return db.prepare("SELECT * FROM memory_handoff_events WHERE handoff_id = ? ORDER BY event_seq DESC LIMIT ?").all(handoffId, Math.max(1, Math.min(Number(limit) || 100, 500))).map(row => ({ id: row.id, handoff_id: row.handoff_id, event_seq: row.event_seq, version: row.version, event_type: row.event_type, actor: row.actor, source: row.source, payload: parseJson(row.payload_json, {}), previous_hash: row.previous_hash, event_hash: row.event_hash, created_at: row.created_at }));
  }

  function captureHandoffCheckpoint(id, { working_directory, expectedVersion, actor = "system", source = "handoff", metadata = null } = {}) {
    const handoff = getHandoff(id);
    if (!handoff) throw new Error(`Handoff not found: ${id}`);
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(handoff.version)) throw new Error(`Handoff "${id}" changed concurrently: expected version ${expectedVersion}, found ${handoff.version}`);
    const checkpoint = { schema_version: 1, captured_at: nowIso(), freshness_seconds: 900, ...gitCheckpoint(working_directory || handoff.packet?.provenance?.working_directory), source_state: handoff.packet?.provenance?.commit_sha || handoff.packet?.provenance?.source_commit || null };
    const hash = continuityHash(checkpoint);
    const result = db.prepare("UPDATE memory_handoffs SET checkpoint_json = ?, checkpoint_hash = ?, updated_at = ? WHERE id = ? AND version = ?").run(JSON.stringify(checkpoint), hash, nowIso(), id, handoff.version);
    if (!result.changes) throw new Error(`Handoff "${id}" changed concurrently during checkpoint capture`);
    appendHandoffEvent(id, handoff.version, "checkpoint_captured", { checkpoint_hash: hash, repository: checkpoint.repository || null, ...(metadata && typeof metadata === "object" ? { metadata: parseJson(JSON.stringify(metadata), {}) } : {}) }, { actor, source });
    return getHandoff(id);
  }

  function getHandoffReadiness(id, { working_directory, recipient = null } = {}) {
    const handoff = getHandoff(id);
    if (!handoff) return { status: "invalid", reasons: ["handoff not found"] };
    const validation = validateHandoffPacket(handoff.packet, { requireResume: true });
    const reasons = [...validation.issues];
    if (!["ready", "claimed", "verifying", "active", "released", "completed"].includes(handoff.lifecycle_state)) reasons.push(`lifecycle state is ${handoff.lifecycle_state}`);
    const drift = handoff.checkpoint ? checkpointDrift(handoff.checkpoint, working_directory) : { status: "unknown", severity: "blocking", reasons: ["no checkpoint captured"] };
    if (drift.severity === "blocking" || drift.severity === "material") reasons.push(...(drift.reasons || ["checkpoint drift requires reconciliation"]));
    const status = reasons.length ? (drift.severity === "blocking" ? "blocked" : "reconciliation_required") : "ready";
    return { status, reasons, handoff_id: id, version: handoff.version, lifecycle_state: handoff.lifecycle_state, recipient: recipient || null, checkpoint: { hash: handoff.checkpoint_hash, drift } };
  }

  function transitionHandoff(id, target, { expectedVersion, actor = "system", source = "handoff", reason } = {}) {
    if (!HANDOFF_LIFECYCLE.has(target)) throw new Error(`Unknown handoff lifecycle state: ${target}`);
    const current = getHandoff(id);
    if (!current) throw new Error(`Handoff not found: ${id}`);
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current.version)) throw new Error(`Handoff "${id}" changed concurrently: expected version ${expectedVersion}, found ${current.version}`);
    if (current.lifecycle_state === target) return { handoff: current, no_op: true };
    if (!TRANSITIONS[current.lifecycle_state]?.has(target)) throw new Error(`Illegal handoff transition: ${current.lifecycle_state} -> ${target}`);
    if (target === "ready" || target === "completed") {
      const validation = validateHandoffPacket(current.packet, { requireResume: true });
      if (!validation.valid) throw new Error(`Handoff cannot transition to ${target}: ${validation.issues.join("; ")}`);
      if (target === "ready" && !current.checkpoint_hash) throw new Error("Handoff cannot transition to ready without a checkpoint");
    }
    const ts = nowIso();
    const fields = { lifecycle_state: target, sealed_at: target === "ready" ? ts : current.sealed_at, revoked_at: target === "revoked" ? ts : current.revoked_at, completed_at: target === "completed" ? ts : current.completed_at };
    const result = db.prepare("UPDATE memory_handoffs SET lifecycle_state = ?, sealed_at = ?, revoked_at = ?, completed_at = ?, updated_at = ? WHERE id = ? AND version = ?").run(fields.lifecycle_state, fields.sealed_at || null, fields.revoked_at || null, fields.completed_at || null, ts, id, current.version);
    if (!result.changes) throw new Error(`Handoff "${id}" changed concurrently during transition`);
    appendHandoffEvent(id, current.version, "lifecycle_changed", { from: current.lifecycle_state, to: target, reason: String(reason || "") .slice(0, 300) }, { actor, source });
    return { handoff: getHandoff(id), no_op: false };
  }

  function claimHandoff(id, { owner, leaseSeconds = 900, expectedVersion, actor = owner, source = "handoff" } = {}) {
    if (!owner) throw new Error("handoff claim requires owner");
    const current = getHandoff(id);
    if (!current) throw new Error(`Handoff not found: ${id}`);
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current.version)) throw new Error(`Handoff "${id}" changed concurrently: expected version ${expectedVersion}, found ${current.version}`);
    const now = Date.now();
    const activeClaim = current.claim?.active && new Date(current.claim.expires_at).getTime() > now && current.claim.owner !== owner;
    if (activeClaim) throw new Error(`Handoff "${id}" is claimed by another owner until ${current.claim.expires_at}`);
    if (!["ready", "released", "active", "claimed"].includes(current.lifecycle_state)) throw new Error(`Handoff "${id}" is not claimable in state ${current.lifecycle_state}`);
    const readiness = getHandoffReadiness(id);
    if (readiness.status !== "ready") throw new Error(`Handoff "${id}" is not ready to claim: ${readiness.reasons.join("; ") || readiness.status}`);
    const token = crypto.randomBytes(24).toString("hex");
    const tokenHash = continuityHash({ domain: "claim", token });
    const expires = new Date(now + Math.max(30, Math.min(Number(leaseSeconds) || 900, 86400)) * 1000).toISOString();
    const result = db.prepare("UPDATE memory_handoffs SET lifecycle_state = 'claimed', claim_owner = ?, claim_token = ?, claim_expires_at = ?, updated_at = ? WHERE id = ? AND version = ? AND (claim_expires_at IS NULL OR claim_expires_at <= ? OR claim_owner = ?)").run(owner, tokenHash, expires, nowIso(), id, current.version, new Date(now).toISOString(), owner);
    if (!result.changes) throw new Error(`Handoff "${id}" changed concurrently during claim`);
    appendHandoffEvent(id, current.version, "claimed", { owner, expires_at: expires }, { actor, source });
    return { handoff: getHandoff(id), claim_token: token, expires_at: expires };
  }

  function releaseHandoff(id, { claim_token, actor = "system", source = "handoff", reason } = {}) {
    if (!claim_token) throw new Error("handoff release requires claim_token");
    const current = getHandoff(id);
    if (!current) throw new Error(`Handoff not found: ${id}`);
    const claimRow = db.prepare("SELECT claim_token FROM memory_handoffs WHERE id = ?").get(id);
    const tokenHash = continuityHash({ domain: "claim", token: claim_token });
    if (!claimRow || claimRow.claim_token !== tokenHash) throw new Error("handoff claim token is invalid");
    const result = db.prepare("UPDATE memory_handoffs SET lifecycle_state = 'released', claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ? AND claim_token = ?").run(nowIso(), id, tokenHash);
    if (!result.changes) throw new Error(`Handoff "${id}" changed concurrently during release`);
    appendHandoffEvent(id, current.version, "released", { reason: String(reason || "").slice(0, 300) }, { actor, source });
    return getHandoff(id);
  }

  function listHandoffs({ project, includeArchived = false, limit = 50 } = {}) {
    if (!hasTable("memory_handoffs")) return [];
    const clauses = [];
    const params = [];
    if (project) { clauses.push("project = ?"); params.push(project); }
    if (!includeArchived) clauses.push("archived_at IS NULL");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`SELECT * FROM memory_handoffs ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, Math.max(1, Math.min(Number(limit) || 50, 500)));
    return rows.map(normalizeHandoffRow);
  }

  function updateHandoffExtraction(id, state, extractionVersion) {
    if (!hasTable("memory_handoffs")) return false;
    const result = db.prepare("UPDATE memory_handoffs SET extraction_state = ?, extraction_version = ?, updated_at = ? WHERE id = ?").run(state, extractionVersion || null, nowIso(), id);
    return result.changes > 0;
  }

  function archiveHandoff(id, reason = "archived") {
    if (!hasTable("memory_handoffs")) return false;
    const ts = nowIso();
    const result = db.prepare("UPDATE memory_handoffs SET archived_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, id);
    if (result.changes > 0) auditMemoryEvent("handoff_archived", "handoff", id, { reason }, "user");
    return result.changes > 0;
  }

  function saveTaskSession(session) {
    if (!hasTable("memory_task_sessions")) throw new Error("memory_task_sessions table is not available; run migrations");
    const ts = nowIso();
    const id = session.id || `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO memory_task_sessions (
        id, goal, project, source, client_session_id, working_directory, repository, branch,
        environment, tags_json, supplied_context, state, current_plan, current_hypothesis,
        completed_steps_json, blockers_json, next_step, artifacts_json, outcome,
        final_summary, acceptance_state, memory_brief_json, created_at, updated_at, ended_at,
        owner_principal_id, created_by_principal_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        goal = COALESCE(excluded.goal, goal), project = COALESCE(excluded.project, project),
        source = COALESCE(excluded.source, source), client_session_id = COALESCE(excluded.client_session_id, client_session_id),
        working_directory = COALESCE(excluded.working_directory, working_directory), repository = COALESCE(excluded.repository, repository),
        branch = COALESCE(excluded.branch, branch), environment = COALESCE(excluded.environment, environment),
        tags_json = excluded.tags_json, supplied_context = COALESCE(excluded.supplied_context, supplied_context),
        state = excluded.state, current_plan = COALESCE(excluded.current_plan, current_plan),
        current_hypothesis = COALESCE(excluded.current_hypothesis, current_hypothesis), completed_steps_json = excluded.completed_steps_json,
        blockers_json = excluded.blockers_json, next_step = COALESCE(excluded.next_step, next_step), artifacts_json = excluded.artifacts_json,
        outcome = COALESCE(excluded.outcome, outcome), final_summary = COALESCE(excluded.final_summary, final_summary),
        acceptance_state = COALESCE(excluded.acceptance_state, acceptance_state), memory_brief_json = COALESCE(excluded.memory_brief_json, memory_brief_json),
        updated_at = excluded.updated_at, ended_at = COALESCE(excluded.ended_at, ended_at),
        owner_principal_id = COALESCE(excluded.owner_principal_id, owner_principal_id),
        created_by_principal_id = COALESCE(excluded.created_by_principal_id, created_by_principal_id)
    `).run(
      id,
      session.goal || "task",
      session.project || null,
      session.source || null,
      session.client_session_id || null,
      session.working_directory || null,
      session.repository || null,
      session.branch || null,
      session.environment || null,
      JSON.stringify(session.tags || []),
      session.supplied_context || null,
      session.state || "active",
      session.current_plan || null,
      session.current_hypothesis || null,
      JSON.stringify(session.completed_steps || []),
      JSON.stringify(session.blockers || []),
      session.next_step || null,
      JSON.stringify(session.artifacts || []),
      session.outcome || null,
      session.final_summary || null,
      session.acceptance_state || null,
      session.memory_brief ? JSON.stringify(session.memory_brief) : null,
      session.created_at || ts,
      ts,
      session.ended_at || null,
      session.owner_principal_id || null,
      session.created_by_principal_id || null
    );
    auditMemoryEvent("task_session_saved", "task_session", id, { state: session.state || "active", project: session.project || null }, session.source || "system");
    return getTaskSession(id);
  }

  function normalizeTaskSessionRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      goal: row.goal,
      project: row.project,
      source: row.source,
      client_session_id: row.client_session_id,
      working_directory: row.working_directory,
      repository: row.repository,
      branch: row.branch,
      environment: row.environment,
      tags: parseJson(row.tags_json, []),
      supplied_context: row.supplied_context,
      state: row.state,
      current_plan: row.current_plan,
      current_hypothesis: row.current_hypothesis,
      completed_steps: parseJson(row.completed_steps_json, []),
      blockers: parseJson(row.blockers_json, []),
      next_step: row.next_step,
      artifacts: parseJson(row.artifacts_json, []),
      outcome: row.outcome,
      final_summary: row.final_summary,
      acceptance_state: row.acceptance_state,
      memory_brief: parseJson(row.memory_brief_json, null),
      created_at: row.created_at,
      updated_at: row.updated_at,
      ended_at: row.ended_at
      ,owner_principal_id: row.owner_principal_id || null,
      created_by_principal_id: row.created_by_principal_id || null
    };
  }

  function getTaskSession(id) {
    if (!hasTable("memory_task_sessions")) return null;
    return normalizeTaskSessionRow(db.prepare("SELECT * FROM memory_task_sessions WHERE id = ?").get(id));
  }

  function listTaskSessions({ project, state, limit = 50 } = {}) {
    if (!hasTable("memory_task_sessions")) return [];
    const clauses = [];
    const params = [];
    if (project) { clauses.push("project = ?"); params.push(project); }
    if (state) { clauses.push("state = ?"); params.push(state); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT * FROM memory_task_sessions ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, Math.max(1, Math.min(Number(limit) || 50, 500))).map(normalizeTaskSessionRow);
  }


  return { normalizeHandoffPacket, validateHandoffPacket, evaluateHandoffQuality, evidenceFreshness, getHandoffReceiverProjection, compareHandoffVersions, getHandoffResumePreflight, getHandoffEvidenceState, refreshHandoffEvidence, renewHandoffClaim, beginHandoffResume, verifyHandoffProvenance, getHandoffLinks, saveHandoff, getHandoff, listHandoffs, listHandoffVersions, getHandoffVersion, restoreHandoffVersion, updateHandoffExtraction, archiveHandoff, unarchiveHandoff, purgeHandoffVersion, saveTaskSession, getTaskSession, listTaskSessions, captureHandoffCheckpoint, checkpointDrift, getHandoffReadiness, listHandoffEvents, transitionHandoff, claimHandoff, releaseHandoff };
}

module.exports = { createHandoffStore };
