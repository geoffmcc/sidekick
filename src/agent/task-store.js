"use strict";

const crypto = require("crypto");
const dbStore = require("../db");
const { redactSensitive, redactSensitiveKeysDeep } = require("../redact");
const model = require("./task-model");

const MAX_LIST = 100;
const json = value => JSON.stringify(redactSensitiveKeysDeep(value));
const parse = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomBytes(10).toString("hex")}`;

function rowToTask(row) {
  if (!row) return null;
  return { ...row, goal: parse(row.goal_json, {}), requirements: parse(row.requirements_json, []), budget: parse(row.budget_json, {}), usage: parse(row.usage_json, {}), authority_envelope: parse(row.authority_envelope_json, {}), principal_context: parse(row.principal_context_json, { version: 1, credential_scopes: [], delegation_id: null }), usage_ledger: parse(row.usage_ledger_json, {}), checkpoint: parse(row.checkpoint_json, {}), control: parse(row.control_json, {}), continuation: parse(row.continuation_json, { version: 1, completed_operations: [], ambiguous_operations: [] }), artifact_refs: parse(row.artifact_refs_json, []), result: parse(row.result_json, null), verification: parse(row.verification_json, null), schema_version: row.schema_version };
}
function ensureTaskSchema() {
  try { dbStore.getDb().prepare("SELECT task_id FROM agent_tasks LIMIT 1").get(); return; } catch (error) {
    if (typeof dbStore.runPendingMigrations === "function") dbStore.runPendingMigrations();
    dbStore.getDb().prepare("SELECT task_id FROM agent_tasks LIMIT 1").get();
  }
}
function insertTask(task) {
  ensureTaskSchema();
  const db = dbStore.getDb();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO agent_tasks (task_id,root_task_id,parent_task_id,session_id,execution_id,project_id,actor_id,requested_by_principal_id,actor_principal_id,acting_for_principal_id,objective,normalized_objective,goal_json,profile,state,phase,current_plan_revision,requirements_json,budget_json,usage_json,workspace_ref,authority_envelope_json,authority_envelope_version,principal_context_json,usage_ledger_json,current_milestone,active_work_package,stopping_reason,model_version,prompt_version,policy_version,capability_registry_version,schema_version,checkpoint_json,next_action,created_at,updated_at) VALUES (${Array(37).fill("?").join(",")})`).run(task.task_id, task.root_task_id, task.parent_task_id, task.session_id, task.execution_id, task.project_id, task.actor_id, task.requested_by_principal_id, task.actor_principal_id, task.acting_for_principal_id, redactSensitive(task.objective), redactSensitive(task.normalized_objective), json(task.goal), task.profile, task.state, task.phase, task.current_plan_revision, json(task.requirements), json(task.budget), json(task.usage), task.workspace_ref, json(task.authority_envelope || {}), task.authority_envelope_version || 1, json(task.principal_context || {}), json(task.usage_ledger || {}), task.current_milestone || null, task.active_work_package || null, task.stopping_reason || null, task.model_version, task.prompt_version, task.policy_version, task.capability_registry_version, task.schema_version, json(task.checkpoint), redactSensitive(task.next_action), task.created_at, task.updated_at);
    appendEventInternal(db, task.task_id, "task.created", task.actor_id, { state: task.state, profile: task.profile });
  });
  tx();
  return getTask(task.task_id);
}
function appendEventInternal(db, taskId, eventType, actorId, payload) { db.prepare("INSERT INTO agent_task_events (event_id,task_id,event_type,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,?)").run(id("ate"), taskId, eventType, actorId || null, json(payload || {}), now()); }
function getTask(taskId) { ensureTaskSchema(); const db=dbStore.getDb(); const row=db.prepare("SELECT * FROM agent_tasks WHERE task_id = ?").get(String(taskId)); if(!row)return null; const task=rowToTask(row); if(row.root_task_id && row.root_task_id!==row.task_id){const root=db.prepare("SELECT usage_ledger_json FROM agent_tasks WHERE task_id=?").get(row.root_task_id);if(root)task.usage_ledger=parse(root.usage_ledger_json,{version:1,root_task_id:row.root_task_id});} return task; }
function listDescendants(taskId) { ensureTaskSchema(); const rows=dbStore.getDb().prepare(`WITH RECURSIVE descendants(task_id) AS (SELECT task_id FROM agent_tasks WHERE task_id=? UNION ALL SELECT child.task_id FROM agent_tasks child JOIN descendants parent ON child.parent_task_id=parent.task_id) SELECT * FROM agent_tasks WHERE task_id IN (SELECT task_id FROM descendants) ORDER BY created_at ASC`).all(String(taskId)); return rows.map(rowToTask); }
function listTasks({ project_id, state, limit = 50, offset = 0 } = {}) { ensureTaskSchema(); const where = [], params = []; if (project_id) { where.push("project_id = ?"); params.push(project_id); } if (state) { where.push("state = ?"); params.push(state); } const bounded = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIST); const skip = Math.max(Number(offset) || 0, 0); const rows = dbStore.getDb().prepare(`SELECT * FROM agent_tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, bounded, skip); return rows.map(rowToTask); }
function updateTask(taskId, patch, eventType = "task.updated") {
  const current = getTask(taskId); if (!current) return null; if (model.TERMINAL.has(current.state) && patch.state && patch.state !== current.state) throw new Error("terminal task cannot be changed");
  const next = { ...current, ...patch, updated_at: now() }; if (patch.state && patch.state !== current.state) model.transition(current, patch.state, next.updated_at);
  const elapsed = Math.max(0, Math.min(24 * 60 * 60 * 1000, Date.parse(next.updated_at) - Date.parse(current.updated_at)));
  const elapsedKey = current.state === "waiting" ? "waiting_ms" : current.state === "paused" ? "idle_ms" : null;
  const db = dbStore.getDb(); const tx = db.transaction(() => {
    let rootLedger = current.usage_ledger && typeof current.usage_ledger === "object" ? { ...current.usage_ledger } : { version: 1, root_task_id: current.root_task_id || taskId };
    const rootRowForClock = current.root_task_id && current.root_task_id !== taskId
      ? db.prepare("SELECT created_at FROM agent_tasks WHERE task_id=?").get(current.root_task_id)
      : { created_at: current.created_at };
    const rootCreatedAt = rootLedger.root_created_at || rootRowForClock?.created_at || current.created_at;
    if (rootCreatedAt) rootLedger.root_created_at = rootCreatedAt;
    const rootStart = Date.parse(rootCreatedAt || "");
    const wallMs = Number.isFinite(rootStart) ? Math.max(0, Date.now() - rootStart) : 0;
    next.usage = { ...(next.usage || {}), wall_ms: Math.max(Number(next.usage?.wall_ms || 0), wallMs) };
    rootLedger.wall_ms = Math.max(Number(rootLedger.wall_ms || 0), wallMs);
    if (elapsedKey && Number.isFinite(elapsed) && elapsed > 0) {
      next.usage = { ...(next.usage || {}), [elapsedKey]: Number(next.usage?.[elapsedKey] || 0) + elapsed };
      rootLedger[elapsedKey] = Number(rootLedger[elapsedKey] || 0) + elapsed;
      next.usage_ledger = rootLedger;
      const root = current.root_task_id && current.root_task_id !== taskId
        ? db.prepare("SELECT budget_json FROM agent_tasks WHERE task_id=?").get(current.root_task_id)
        : { budget_json: JSON.stringify(current.budget || {}) };
      const budget = parse(root && root.budget_json, {});
      if (Number.isFinite(Number(budget[elapsedKey])) && rootLedger[elapsedKey] >= Number(budget[elapsedKey])) {
        next.state = "blocked";
        next.phase = "budget";
        next.stopping_reason = `${elapsedKey} budget exhausted`;
        next.next_action = "increase_profile_or_resume";
      }
    }
    db.prepare(`UPDATE agent_tasks SET execution_id=COALESCE(?,execution_id),state=?,phase=?,current_plan_revision=?,requirements_json=?,budget_json=?,usage_json=?,workspace_ref=?,authority_envelope_json=?,authority_envelope_version=?,principal_context_json=?,usage_ledger_json=?,current_milestone=?,active_work_package=?,stopping_reason=?,checkpoint_json=?,next_action=?,control_json=?,continuation_json=?,artifact_refs_json=?,result_json=?,verification_json=?,last_error_code=?,updated_at=?,completed_at=? WHERE task_id=?`).run(next.execution_id || null, next.state, next.phase, next.current_plan_revision, json(next.requirements), json(next.budget), json(next.usage), next.workspace_ref, json(next.authority_envelope || {}), next.authority_envelope_version || 1, json(next.principal_context || {}), json(next.usage_ledger || {}), next.current_milestone || null, next.active_work_package || null, next.stopping_reason || null, json(next.checkpoint), redactSensitive(next.next_action), json(next.control || {}), json(next.continuation || {}), json(next.artifact_refs || []), next.result == null ? null : json(next.result), next.verification == null ? null : json(next.verification), next.last_error_code || null, next.updated_at, next.completed_at || null, taskId);
    db.prepare("UPDATE agent_tasks SET model_version=?,prompt_version=?,policy_version=?,capability_registry_version=? WHERE task_id=?").run(next.model_version || null, next.prompt_version || null, next.policy_version || null, next.capability_registry_version || null, taskId);
    const rootId = current.root_task_id || taskId;
    if (rootId !== taskId) db.prepare("UPDATE agent_tasks SET usage_ledger_json=?,updated_at=? WHERE task_id=?").run(json(rootLedger), next.updated_at, rootId);
    appendEventInternal(db, taskId, eventType, next.actor_id, { state: next.state, phase: next.phase, next_action: next.next_action, ...(elapsedKey && elapsed > 0 ? { accounted_ms: { [elapsedKey]: elapsed } } : {}) });
  }); tx(); return getTask(taskId);
}
function checkpointTask(taskId, checkpoint) { const task = getTask(taskId); if (!task) throw new Error("task not found"); const safe = model.assertCheckpoint(task, checkpoint); return updateTask(taskId, { checkpoint: safe, next_action: safe.next_action }, "task.checkpoint"); }
function addPlanRevision(taskId, plan, source = "planner") { const task = getTask(taskId); if (!task) throw new Error("task not found"); if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("plan must be an object"); const revision = task.current_plan_revision + 1; const db = dbStore.getDb(); db.prepare("INSERT INTO agent_task_plan_revisions (task_id,revision,plan_json,source,created_at) VALUES (?,?,?,?,?)").run(taskId, revision, json(plan), String(source).slice(0, 100), now()); return updateTask(taskId, { current_plan_revision: revision }, "task.plan_revision"); }
function addFailure(taskId, failure) { const task = getTask(taskId); if (!task) throw new Error("task not found"); const record = { ...failure, failure_id: id("atf"), action_fingerprint: String(failure.action_fingerprint || "").slice(0, 128), capability: failure.capability ? String(failure.capability).slice(0, 120) : null, error_class: String(failure.error_class || "unknown").slice(0, 80), retryable: failure.retryable === true ? 1 : 0, attempt: Math.max(1, Number(failure.attempt) || 1), changed_condition: failure.changed_condition === true ? 1 : 0, detail: redactSensitive(String(failure.detail || "")).slice(0, 2000), created_at: now() }; dbStore.getDb().prepare("INSERT INTO agent_task_failures (failure_id,task_id,action_fingerprint,capability,error_class,retryable,attempt,changed_condition,detail,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(record.failure_id, taskId, record.action_fingerprint, record.capability, record.error_class, record.retryable, record.attempt, record.changed_condition, record.detail, record.created_at); return updateTask(taskId, {}, "task.failure"); }
function saveResult(taskId, result, verification) { const normalized = model.validateResult(result); return updateTask(taskId, { result: normalized, verification: verification || null, phase: "complete", next_action: null, state: normalized.status === "verified" ? "completed" : "partial" }, "task.result"); }
function listEvents(taskId, limit = 100) { ensureTaskSchema(); return dbStore.getDb().prepare("SELECT event_id,task_id,event_type,actor_id,payload_json,created_at FROM agent_task_events WHERE task_id = ? ORDER BY created_at ASC,event_id ASC LIMIT ?").all(taskId, Math.min(Math.max(Number(limit) || 100, 1), 500)).map(row => ({ ...row, payload: parse(row.payload_json, {}) })); }
function listPlans(taskId) { ensureTaskSchema(); return dbStore.getDb().prepare("SELECT task_id,revision,plan_json,source,created_at FROM agent_task_plan_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 100").all(taskId).map(row => ({ ...row, plan: parse(row.plan_json, {}) })); }
function listFailures(taskId) { ensureTaskSchema(); return dbStore.getDb().prepare("SELECT failure_id,task_id,action_fingerprint,capability,error_class,retryable,attempt,changed_condition,detail,created_at FROM agent_task_failures WHERE task_id = ? ORDER BY created_at DESC LIMIT 100").all(taskId); }
function recordGuidance(taskId, guidance, actorId = "user") { const task = getTask(taskId); if (!task) throw new Error("task not found"); const message = redactSensitive(String(guidance || "").trim()).slice(0, 2000); if (!message) throw new Error("guidance is required"); const db = dbStore.getDb(); db.transaction(() => appendEventInternal(db, taskId, "task.user_guidance", actorId, { guidance: message }))(); return getTask(taskId); }
function recordAuthorityDecision(taskId, decision) { const task = getTask(taskId); if (!task) throw new Error("task not found"); const safeDecision = { decision: String(decision?.decision || "deny").slice(0, 40), reason: redactSensitive(String(decision?.reason || "")).slice(0, 500), policy_version: String(decision?.policy_version || "unknown").slice(0, 80), descriptor_version: String(decision?.descriptor_version || "unknown").slice(0, 80), risk_class: String(decision?.risk_class || "unknown").slice(0, 40), effect_class: String(decision?.effect_class || "unknown").slice(0, 40), approval_required: decision?.approval_required === true, authority_envelope_version: task.authority_envelope_version || 1, principal_provenance: decision?.principal_provenance || task.actor_principal_id || task.requested_by_principal_id || null }; const db = dbStore.getDb(); db.transaction(() => appendEventInternal(db, taskId, "task.authority_decision", task.actor_id, safeDecision))(); return safeDecision; }
function incrementUsage(taskId, delta = {}, eventType = "task.usage") {
  const db = dbStore.getDb();
  let result;
  db.transaction(() => {
    const row = db.prepare("SELECT usage_json,usage_ledger_json,budget_json,root_task_id,actor_id,created_at FROM agent_tasks WHERE task_id=?").get(taskId);
    if (!row) throw new Error("task not found");
    const usage = parse(row.usage_json, {});
    const rootId = row.root_task_id || taskId;
    const rootRow = rootId === taskId
      ? row
      : db.prepare("SELECT usage_ledger_json,budget_json,created_at FROM agent_tasks WHERE task_id=?").get(rootId);
    if (!rootRow) throw new Error("root task not found");
    const ledger = parse(rootRow.usage_ledger_json, { version: 1, root_task_id: rootId });
    const budget = parse(rootRow.budget_json, {});
    const rootCreatedAt = ledger.root_created_at || rootRow.created_at || row.created_at;
    if (rootCreatedAt) ledger.root_created_at = rootCreatedAt;
    const rootStart = Date.parse(rootCreatedAt || "");
    if (Number.isFinite(rootStart)) {
      const wallMs = Math.max(0, Date.now() - rootStart);
      usage.wall_ms = Math.max(Number(usage.wall_ms || 0), wallMs);
      ledger.wall_ms = Math.max(Number(ledger.wall_ms || 0), wallMs);
    }
    const usageDelta = {};
    for (const [key, value] of Object.entries(delta || {})) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new Error("usage increment must be a finite non-negative bounded number");
      const nextRootValue = Number(ledger[key] || 0) + n;
      if (Number.isFinite(Number(budget[key])) && nextRootValue > Number(budget[key])) {
        throw new Error(`${key} budget exhausted`);
      }
      usage[key] = Number(usage[key] || 0) + n;
      ledger[key] = nextRootValue;
      usageDelta[key] = n;
    }
    const updated = new Date().toISOString();
    db.prepare("UPDATE agent_tasks SET usage_json=?,updated_at=? WHERE task_id=?").run(json(usage), updated, taskId);
    db.prepare("UPDATE agent_tasks SET usage_ledger_json=?,updated_at=? WHERE task_id=?").run(json(ledger), updated, rootId);
    appendEventInternal(db, taskId, eventType, row.actor_id, { usage_delta: usageDelta, root_task_id: rootId });
    result = { usage, usage_ledger: ledger, root_task_id: rootId };
  })();
  return result;
}

function adjustConcurrentOperationsInDb(db, taskId, delta) {
  const change = Number(delta);
  if (!Number.isInteger(change) || Math.abs(change) > 1) throw new Error("concurrent operation delta must be plus or minus one");
    const row = db.prepare("SELECT usage_json,usage_ledger_json,root_task_id,actor_id FROM agent_tasks WHERE task_id=?").get(taskId);
    if (!row) throw new Error("task not found");
    const rootId = row.root_task_id || taskId;
    const rootRow = rootId === taskId ? row : db.prepare("SELECT usage_ledger_json FROM agent_tasks WHERE task_id=?").get(rootId);
    if (!rootRow) throw new Error("root task not found");
    const usage = parse(row.usage_json, {});
    const ledger = parse(rootRow.usage_ledger_json, { version: 1, root_task_id: rootId });
    const current = Number(usage.concurrent_operations || 0);
    const rootCurrent = Number(ledger.concurrent_operations || 0);
    if (current + change < 0 || rootCurrent + change < 0) throw new Error("concurrent operation accounting underflow");
    usage.concurrent_operations = current + change;
    ledger.concurrent_operations = rootCurrent + change;
    const updated = now();
    db.prepare("UPDATE agent_tasks SET usage_json=?,updated_at=? WHERE task_id=?").run(json(usage), updated, taskId);
    db.prepare("UPDATE agent_tasks SET usage_ledger_json=?,updated_at=? WHERE task_id=?").run(json(ledger), updated, rootId);
    appendEventInternal(db, taskId, change > 0 ? "task.concurrent_operation_started" : "task.concurrent_operation_finished", row.actor_id, { concurrent_operations: usage.concurrent_operations, root_concurrent_operations: ledger.concurrent_operations, root_task_id: rootId });
    return { usage, usage_ledger: ledger, root_task_id: rootId };
}
function adjustConcurrentOperations(taskId, delta) {
  const db = dbStore.getDb();
  let result;
  db.transaction(() => { result = adjustConcurrentOperationsInDb(db, taskId, delta); })();
  return result;
}
// Reserve one continuation atomically against both the root profile budget and
// the parent's authority-envelope fan-out. Counting children with a prior
// SELECT is racy: two concurrent requests could both observe the same count
// and create siblings beyond the governed limit. The per-parent counter lives
// in the root usage ledger so every child/follow-up shares one durable fence.
function reserveChildTask(taskId) {
  const db = dbStore.getDb();
  let result;
  db.transaction(() => {
    const row = db.prepare("SELECT usage_json,usage_ledger_json,budget_json,authority_envelope_json,root_task_id,actor_id FROM agent_tasks WHERE task_id=?").get(taskId);
    if (!row) throw new Error("task not found");
    const rootId = row.root_task_id || taskId;
    const rootRow = rootId === taskId
      ? row
      : db.prepare("SELECT usage_ledger_json,budget_json,authority_envelope_json FROM agent_tasks WHERE task_id=?").get(rootId);
    if (!rootRow) throw new Error("root task not found");
    const usage = parse(row.usage_json, {});
    const ledger = parse(rootRow.usage_ledger_json, { version: 1, root_task_id: rootId });
    const budget = parse(rootRow.budget_json, {});
    const envelope = parse(row.authority_envelope_json, {});
    const fanoutLimit = Math.max(0, Math.min(32, Number(envelope.child_task_count) || 0));
    const fanoutKey = `authority_children:${String(taskId).slice(0, 120)}`;
    const fanoutUsed = Number(ledger[fanoutKey] || 0);
    if (Number(envelope.child_task_depth || 0) <= 0 || fanoutUsed >= fanoutLimit) throw new Error("child-task envelope limit reached");
    const nextChildUsage = Number(ledger.child_tasks || 0) + 1;
    if (Number.isFinite(Number(budget.child_tasks)) && nextChildUsage > Number(budget.child_tasks)) throw new Error("child_tasks budget exhausted");
    usage.child_tasks = Number(usage.child_tasks || 0) + 1;
    ledger.child_tasks = nextChildUsage;
    ledger[fanoutKey] = fanoutUsed + 1;
    const updated = new Date().toISOString();
    db.prepare("UPDATE agent_tasks SET usage_json=?,updated_at=? WHERE task_id=?").run(json(usage), updated, taskId);
    db.prepare("UPDATE agent_tasks SET usage_ledger_json=?,updated_at=? WHERE task_id=?").run(json(ledger), updated, rootId);
    appendEventInternal(db, taskId, "task.child_reserved", row.actor_id, { usage_delta: { child_tasks: 1 }, root_task_id: rootId, parent_fanout_used: fanoutUsed + 1, parent_fanout_limit: fanoutLimit });
    result = { usage, usage_ledger: ledger, root_task_id: rootId, parent_fanout_used: fanoutUsed + 1, parent_fanout_limit: fanoutLimit, remaining: Math.max(0, fanoutLimit - fanoutUsed - 1) };
  })();
  return result;
}
function recordChildRequest(taskId, childTaskId, kind, actorId = "user") { const task = getTask(taskId); if (!task) throw new Error("task not found"); const db = dbStore.getDb(); db.transaction(() => appendEventInternal(db, taskId, "task.child_requested", actorId, { child_task_id: String(childTaskId).slice(0, 80), kind: String(kind || "continue").slice(0, 80) }))(); return task; }
function recordCompletedOperation(taskId, operation = {}) { const task = getTask(taskId); if (!task) throw new Error("task not found"); const continuation = task.continuation || { version: 1, completed_operations: [], ambiguous_operations: [] }; const item = { fingerprint: String(operation.fingerprint || "").slice(0, 128), capability: String(operation.capability || "").slice(0, 120), read_only: operation.read_only === true, receipt_ref: operation.receipt_ref ? redactSensitive(String(operation.receipt_ref)).slice(0, 300) : null, summary: redactSensitive(String(operation.summary || "")).slice(0, 500), completed_at: now() }; if (!item.fingerprint || !item.capability) throw new Error("operation fingerprint and capability are required"); const completed = [...(continuation.completed_operations || []).filter(row => row.fingerprint !== item.fingerprint), item].slice(-100); return updateTask(taskId, { continuation: { version: 1, completed_operations: completed, ambiguous_operations: continuation.ambiguous_operations || [] } }, "task.operation_completed"); }
function recordAmbiguousOperation(taskId, operation = {}) { const task = getTask(taskId); if (!task) throw new Error("task not found"); const continuation = task.continuation || { version: 1, completed_operations: [], ambiguous_operations: [] }; const item = { fingerprint: String(operation.fingerprint || "").slice(0, 128), capability: String(operation.capability || "").slice(0, 120), reason: redactSensitive(String(operation.reason || "")).slice(0, 500), created_at: now() }; const ambiguous = [...(continuation.ambiguous_operations || []).filter(row => row.fingerprint !== item.fingerprint), item].slice(-100); return updateTask(taskId, { continuation: { version: 1, completed_operations: continuation.completed_operations || [], ambiguous_operations: ambiguous }, state: "blocked", phase: "recovery", next_action: "verify_ambiguous_operation" }, "task.operation_ambiguous"); }
module.exports = { insertTask, getTask, listTasks, listDescendants, updateTask, checkpointTask, addPlanRevision, addFailure, saveResult, listEvents, listPlans, listFailures, recordGuidance, recordAuthorityDecision, incrementUsage, adjustConcurrentOperations, adjustConcurrentOperationsInDb, reserveChildTask, recordChildRequest, recordCompletedOperation, recordAmbiguousOperation, ensureTaskSchema };
