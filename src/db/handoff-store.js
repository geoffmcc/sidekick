const fs = require("fs");
const { redactSensitive } = require("../redact");

function createHandoffStore({ db, execFileSync, childProcessEnv, hasTable, nowIso, parseJson, stableHash, stableId, auditMemoryEvent }) {
  const HANDOFF_PACKET_STATUSES = new Set(["active", "blocked", "ready", "completed", "abandoned"]);

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
        owner_principal_id, created_by_principal_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      created_by_principal_id || null
    );
    auditMemoryEvent("handoff_created", "handoff", handoffId, { project, version: 1, content_hash: hash }, source || "system");
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


  return { normalizeHandoffPacket, validateHandoffPacket, verifyHandoffProvenance, getHandoffLinks, saveHandoff, getHandoff, listHandoffs, listHandoffVersions, getHandoffVersion, restoreHandoffVersion, updateHandoffExtraction, archiveHandoff, unarchiveHandoff, purgeHandoffVersion, saveTaskSession, getTaskSession, listTaskSessions };
}

module.exports = { createHandoffStore };
