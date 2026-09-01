"use strict";

const crypto = require("crypto");
const dbStore = require("../db");
const { compileTaskSpec, validateTaskSpec } = require("./task-spec");
const { createBeliefState, addEvidence, assess } = require("./belief-state");
const { createTrace, addEvent, finalizeTrace } = require("./cognitive-trace");
const { createGraph, addNode, addEdge, coverage } = require("./evidence-graph");

const json = value => JSON.stringify(value == null ? {} : value);
const parse = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const id = prefix => `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
function ensure() { try { dbStore.getDb().prepare("SELECT trace_id FROM brain_cognitive_traces LIMIT 1").get(); } catch { dbStore.runPendingMigrations(); } }

function persistSpec(taskId, spec, source = "compiled") {
  ensure();
  const checked = validateTaskSpec(spec);
  if (!checked.ok) throw new Error("invalid Brain v3 TaskSpec: " + checked.errors.join(","));
  const db = dbStore.getDb();
  const revision = Number(db.prepare("SELECT COALESCE(MAX(revision),0) revision FROM brain_task_spec_revisions WHERE task_id=?").get(taskId)?.revision || 0) + 1;
  db.prepare("INSERT INTO brain_task_spec_revisions (task_id,revision,spec_id,spec_json,source,created_at) VALUES (?,?,?,?,?,?)").run(taskId, revision, checked.spec.task_id, json(checked.spec), String(source).slice(0, 64), new Date().toISOString());
  return { revision, spec: checked.spec };
}
function listSpecs(taskId) { ensure(); return dbStore.getDb().prepare("SELECT task_id,revision,spec_id,spec_json,source,created_at FROM brain_task_spec_revisions WHERE task_id=? ORDER BY revision DESC LIMIT 32").all(taskId).map(row => ({ ...row, spec: parse(row.spec_json, {}) })); }
function persistBelief(taskId, state) { ensure(); const snapshotId = id("belief"); dbStore.getDb().prepare("INSERT INTO brain_belief_snapshots (snapshot_id,task_id,revision,status,state_json,created_at) VALUES (?,?,?,?,?,?)").run(snapshotId, taskId, Number(state.step || 0), state.status, json(state), new Date().toISOString()); return snapshotId; }
function latestBelief(taskId) { ensure(); const row = dbStore.getDb().prepare("SELECT * FROM brain_belief_snapshots WHERE task_id=? ORDER BY revision DESC, created_at DESC LIMIT 1").get(taskId); return row ? { ...row, state: parse(row.state_json, {}) } : null; }
function listTraces(taskId, limit = 8) { ensure(); return dbStore.getDb().prepare("SELECT trace_id,task_id,event_count,created_at,trace_json FROM brain_cognitive_traces WHERE task_id=? ORDER BY created_at DESC LIMIT ?").all(taskId, Math.min(8, Math.max(1, Number(limit) || 8))).map(row => ({ ...row, trace: parse(row.trace_json, {}) })); }
function persistTrace(trace) { ensure(); const final = finalizeTrace(trace); const db = dbStore.getDb(); db.prepare("INSERT OR REPLACE INTO brain_cognitive_traces (trace_id,task_id,trace_json,event_count,created_at) VALUES (?,?,?,?,?)").run(final.trace_id, final.task_id, json(final), final.events.length, new Date().toISOString()); for (const [name, value] of Object.entries(final.metrics || {})) if (Number.isFinite(Number(value))) db.prepare("INSERT OR REPLACE INTO brain_cognitive_metrics (trace_id,metric_name,metric_value,created_at) VALUES (?,?,?,?)").run(final.trace_id, name, Number(value), new Date().toISOString()); return final; }
function persistGraph(taskId, graph) { ensure(); const db = dbStore.getDb(); const timestamp = new Date().toISOString(); const node = db.prepare("INSERT OR REPLACE INTO brain_evidence_graph_nodes (task_id,node_id,node_type,summary,freshness,completeness,provenance,created_at) VALUES (?,?,?,?,?,?,?,?)"); const edge = db.prepare("INSERT OR IGNORE INTO brain_evidence_graph_edges (task_id,from_id,to_id,relation,created_at) VALUES (?,?,?,?,?)"); for (const item of graph?.nodes || []) node.run(taskId, item.id, item.type, item.summary || "", item.freshness || "unknown", item.completeness || "unknown", item.provenance || "server-recorded", timestamp); for (const item of graph?.edges || []) edge.run(taskId, item.from, item.to, item.relation, timestamp); return graph; }
function listGraph(taskId) { ensure(); const db = dbStore.getDb(); const nodes = db.prepare("SELECT node_id AS id,node_type AS type,summary,freshness,completeness,provenance FROM brain_evidence_graph_nodes WHERE task_id=? ORDER BY created_at,node_id LIMIT 256").all(taskId); const edges = db.prepare("SELECT from_id AS \"from\",to_id AS \"to\",relation FROM brain_evidence_graph_edges WHERE task_id=? ORDER BY created_at,from_id,to_id LIMIT 512").all(taskId); return { version: 3, task_id: taskId, nodes, edges, coverage: coverage({ version: 3, task_id: taskId, nodes, edges }, nodes.filter(node => node.type === "requirement").map(node => ({ id: node.id }))) }; }
function createRuntime(taskId, spec) {
  const belief = createBeliefState({ task_id: taskId, required_evidence: spec.evidence_requirements });
  const graph = createGraph(taskId);
  const objectiveId = `objective:${taskId}`;
  graph.nodes.push({ id: objectiveId, type: "objective", summary: spec.normalized_objective || spec.goal, freshness: "current", completeness: "complete", provenance: "task-spec" });
  for (const requirement of spec.requirements || []) { const requirementId = `requirement:${taskId}:${requirement.id}`; graph.nodes.push({ id: requirementId, type: "requirement", summary: requirement.text, freshness: "current", completeness: "complete", provenance: "task-spec" }); graph.edges.push({ from: objectiveId, to: requirementId, relation: "references" }); }
  return { spec, belief, trace: createTrace({ task_id: taskId }), graph, record(type, data) { this.trace = addEvent(this.trace, { type, data, at: new Date().toISOString() }); }, evidence(item) { this.belief = addEvidence(this.belief, item); this.belief = assess(this.belief).state; }, checkpoint() { persistBelief(taskId, this.belief); persistTrace(this.trace); persistGraph(taskId, this.graph); } };
}
function compileRuntime(taskId, objective, goal = {}) { const result = compileTaskSpec({ ...goal, task_id: taskId, original_objective: objective, normalized_objective: goal.normalized_objective || objective, goal: goal.goal || objective }); return { ...result, runtime: createRuntime(taskId, result.spec || result.fallback) }; }

module.exports = { compileRuntime, persistSpec, listSpecs, persistBelief, latestBelief, persistTrace, listTraces, persistGraph, listGraph, createRuntime, createGraph, addNode, addEdge };
