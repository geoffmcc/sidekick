#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-memory-intel-test-"));
process.env.SIDEKICK_DATA_DIR = tempDir;
process.env.SIDEKICK_AUTO_MEMORY = "1";
process.env.SIDEKICK_EMBEDDINGS = "1";

// Exercise vector retrieval with deterministic local doubles, never a provider.
const qdrant = require("../src/qdrant");
const inference = require("../src/compute/inference-service");
let vectorResults = [];
qdrant.isAvailable = async () => true;
qdrant.search = async () => vectorResults;
qdrant.upsert = async () => true;
inference.embed = async () => ({ embedding: [1, 0, 0] });

const dbStore = require("../src/db");
const { TOOLS } = require("../src/tools");
const executionContext = require("../src/tools/context");

dbStore.runPendingMigrations();

(async () => {
  console.log("Test memory intelligence handoff/session APIs");

  const handoffContent = [
    "Fact: host sidekick-vm runs service sidekick-mcp on port 4097.",
    "Decision: keep SQLite as the durable memory source because it works without Qdrant.",
    "Completed: added dashboard memory evidence display.",
    "Failed: using raw tool logs as durable memory created noisy recall.",
    "Open problem: SMB direct-path verification remains unresolved.",
    "Next step: run memory-intelligence validation tests.",
    "password=super-secret-value"
  ].join("\n");

  const create = await TOOLS.handoff({
    action: "create",
    project: "sidekick",
    title: "Memory Intelligence Test Handoff",
    content: handoffContent,
    source: "test"
  });
  assert.ok(!create.isError, "handoff create should succeed");
  const createData = JSON.parse(create.content[0].text);
  assert.ok(createData.handoff.id, "handoff should have an id");
  assert.ok(createData.handoff.content.includes("super-secret-value"), "full handoff artifact should be preserved");
  assert.ok(!createData.memories.some(memory => JSON.stringify(memory).includes("super-secret-value")), "secret-looking value should not be extracted into memory payload");
  assert.ok(createData.memories.some(memory => memory.type === "decision"), "decision memory should be extracted");
  assert.ok(createData.memories.some(memory => memory.type === "negative"), "negative memory should be extracted");
  assert.ok(createData.memories.some(memory => memory.type === "open_thread"), "open thread should be extracted");
  const reportedFact = createData.memories.find(memory => memory.type === "fact" && memory.content.includes("sidekick-vm"));
  assert.ok(reportedFact, "handoff fact claim should remain traceable as a memory record");
  assert.strictEqual(reportedFact.state, "pending", "a handoff claim is not server-verified merely because it is labeled Fact");
  assert.strictEqual(reportedFact.requires_confirmation, true, "agent-authored fact claims require confirmation");

  // Simulate rows extracted before confirmation requirements were introduced.
  const legacyClaims = ["handoff", "task_session"].map(source => dbStore.upsertMemory({
    type: "fact", project: "sidekick", source, source_tool: `legacy_${source}`,
    content: source === "handoff" ? "Legacy handoff provenanceclaim: amber orchard harvest storage" : "Legacy task_session provenanceclaim: cobalt satellite orbital telemetry", confidence: 0.99
  }));
  const pendingProcedure = dbStore.upsertMemory({ type: "procedure", project: "sidekick", source: "test", content: "Pending procedure provenanceclaim sentinel", requires_confirmation: true });
  const claims = [reportedFact, ...legacyClaims, pendingProcedure];
  const memoryApi = require("../src/memory");
  const contextApi = require("../src/tools/families/context");
  vectorResults = claims.map(claim => ({ payload: { memory_id: claim.id, type: claim.type, project: "sidekick", content: "stale vector claims to be confirmed" }, score: 1 }));
  assert.deepStrictEqual(await memoryApi.searchMemoriesByEmbedding("provenanceclaim", { project: "sidekick" }), [], "stale vector payloads must not bypass current confirmation state");
  assert.deepStrictEqual(memoryApi.recallMemoryForText("provenanceclaim", { project: "sidekick" }), [], "automatic lexical recall must exclude claims");
  const compatibilitySearch = await contextApi.searchContext(contextApi.loadContext(), "provenanceclaim", "memories", 50);
  assert.ok(!compatibilitySearch.some(result => claims.some(claim => claim.id === result.item.id)), "compatibility search must exclude claims");
  const parse = result => {
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const assertBriefExcludes = (brief, excludedClaims) => {
    for (const claim of excludedClaims) {
      assert.ok(!brief.selected.some(item => item.id === claim.id), `brief selection must exclude ${claim.id}`);
      assert.ok(!(brief.sections || "").includes(claim.content), `brief prose must exclude ${claim.id}`);
    }
  };
  async function assertAutomaticContextExcludes(excludedClaims) {
    const memoryResult = parse(await TOOLS.memory({ action: "query", project: "sidekick", query: "sidekick provenanceclaim", limit: 100 }));
    assertBriefExcludes(memoryResult.context_brief, excludedClaims);
    const assembled = parse(await TOOLS.context({ action: "assemble", project: "sidekick", query: "sidekick provenanceclaim", limit: 50 }));
    const projectResult = parse(await TOOLS.project({ name: "sidekick", include: "context" }));
    for (const claim of excludedClaims) {
      assert.ok(!assembled.entries.some(item => item.source === "memory" && item.sourceId === claim.id), `context assembly must exclude ${claim.id}`);
      assert.ok(!projectResult.context.some(item => item.id === claim.id || item.summary === claim.content), `project context must exclude ${claim.id}`);
    }
  }
  await assertAutomaticContextExcludes(claims);
  for (const claim of claims) {
    const direct = parse(await TOOLS.memory({ action: "get", project: "sidekick", id: claim.id }));
    assert.strictEqual(direct.memory.id, claim.id, "explicit memory review must remain available");
    const recalled = await TOOLS.context({ action: "recall", project: "sidekick", query: claim.id });
    assert.ok(recalled.content[0].text.includes(claim.id), `exact context lookup must remain available for ${claim.id}: ${recalled.content[0].text}`);
    assert.match(recalled.content[0].text, /requires_confirmation=true/, "exact lookup must identify unconfirmed provenance");
  }

  const legacyResumeKey = await TOOLS.resume({ action: "set", project: "sidekick", summary: "legacy resume key", handoff_key: "sidekick-handoff-test" });
  assert.ok(legacyResumeKey.isError, "legacy resume handoff keys must be rejected");
  const handoffEvent = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'memory.handoff_processed' AND subject_id = ?").get(createData.handoff.id);
  assert.ok(handoffEvent, "handoff processing should emit a platform memory event");

  const inspect = await TOOLS.handoff({ action: "inspect", id: createData.handoff.id });
  const inspectData = JSON.parse(inspect.content[0].text);
  assert.ok(inspectData.extracted_memories.length >= createData.memories.length, "inspect should link extracted memories");
  assert.ok(inspectData.extracted_memories.every(memory => memory.source_ref === createData.handoff.id), "extracted memories should link to handoff source");

  const beforeCount = dbStore.searchMemories({ project: "sidekick", includeDisabled: true, limit: 100 }).length;
  await TOOLS.handoff({ action: "reprocess", id: createData.handoff.id });
  const afterCount = dbStore.searchMemories({ project: "sidekick", includeDisabled: true, limit: 100 }).length;
  assert.strictEqual(afterCount, beforeCount, "reprocessing same handoff version should be idempotent");

  const begin = await TOOLS.session({
    action: "begin",
    goal: "Investigate SMB direct-path verification for project sidekick",
    project: "sidekick",
    source: "test",
    repository: "geoffmcc/sidekick",
    branch: "feat/memory-intelligence-system",
    current_plan: "1. Inspect memory state\n2. Verify continuity\n3. Finish test",
    next_step: "Inspect memory state"
  });
  const beginData = JSON.parse(begin.content[0].text);
  assert.ok(beginData.session.id, "session begin should create a session");
  assert.ok(beginData.handoff_id, "session begin should always create a durable handoff");
  assert.strictEqual(dbStore.getHandoffByTaskId(beginData.session.id).id, beginData.handoff_id, "session handoff should be bound to the session");
  assert.ok(beginData.session.current_plan, "session begin should persist the initial plan");
  assert.ok(!beginData.session.memory_brief.selected.some(memory => memory.id === reportedFact.id), "pending fact claims must not enter the default agent memory brief");
  assertBriefExcludes(beginData.session.memory_brief, claims);
  assert.ok(Array.isArray(dbStore.getHandoffByTaskId(beginData.session.id).packet.plan?.steps), "session handoff should expose a structured plan");
  assert.strictEqual(dbStore.getHandoffByTaskId(beginData.session.id).packet.remaining_steps.length, 3, "session handoff should expose all remaining plan steps");
  const duplicateGoalA = JSON.parse((await TOOLS.session({ action: "begin", goal: "Duplicate goal identity test", project: "sidekick", source: "test" })).content[0].text);
  const duplicateGoalB = JSON.parse((await TOOLS.session({ action: "begin", goal: "Duplicate goal identity test", project: "sidekick", source: "test" })).content[0].text);
  assert.notStrictEqual(duplicateGoalA.handoff_id, duplicateGoalB.handoff_id, "sessions with identical goals must receive distinct handoff identities");
  assert.ok(beginData.memory_brief.selected.some(item => /SMB|raw tool logs|SQLite|sidekick-mcp/i.test(item.summary)), "brief should recall relevant handoff-derived memory");
  const beginEvent = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'memory.session_started' AND subject_id = ?").get(beginData.session.id);
  assert.ok(beginEvent, "session begin should emit a platform memory event");
  assert.strictEqual(beginData.session.project, "sidekick", "session project must be persisted");
  assert.strictEqual(dbStore.getHandoffByTaskId(beginData.session.id).project, "sidekick", "session handoff must carry the resolved project");

  const missingProject = await TOOLS.session({ action: "begin", goal: "A session without trusted project scope" });
  assert.ok(missingProject.isError, "session begin must reject missing project scope");
  assert.match(missingProject.content[0].text, /project is required/i);
  const derivedProject = await executionContext.runWithContext(
    executionContext.createTestExecutionContext({ project: "sidekick" }),
    () => TOOLS.session({ action: "begin", goal: "Derive project from trusted execution scope", source: "test" })
  );
  assert.ok(!derivedProject.isError, "session begin should derive project from trusted execution scope");
  assert.strictEqual(JSON.parse(derivedProject.content[0].text).session.project, "sidekick");

  const otherProjectRecall = await TOOLS.memory({ action: "query", query: "sidekick-mcp port", project: "other_project" });
  const otherData = JSON.parse(otherProjectRecall.content[0].text);
  assert.ok(!otherData.memories.some(memory => memory.project === "sidekick"), "unrelated project recall should exclude sidekick-scoped memories");

  const end = await TOOLS.session({
    action: "end",
    id: beginData.session.id,
    outcome: "success",
    final_summary: "Memory intelligence session completed",
    acceptance_state: "accepted",
    handoff_id: createData.handoff.id,
    next_step: null,
    reports: [{ id: "subagent-1", source: "test-agent", title: "Verification report", content: "Focused tests passed and the handoff remains resumable.", evidence: ["test/memory-intelligence.test.js"] }],
    artifacts: [{ type: "test", path: "test/memory-intelligence.test.js" }],
    do_not_repeat: ["Do not promote raw tool-log adjacency as durable memory"],
    verified_facts: ["Project sidekick memory intelligence tests passed in temp DB"],
    decisions: ["Use explicit sidekick_handoff ingestion for mutable handoffs"],
    failed_approaches: ["Do not promote raw tool-log adjacency as durable memory"],
    follow_ups: ["Add model-assisted extraction after deterministic redaction"]
  });
  const endData = JSON.parse(end.content[0].text);
  const sessionFact = dbStore.searchMemories({ project: "sidekick", type: "fact", limit: 100 }).find(memory => memory.source_task_id === beginData.session.id);
  assert.ok(sessionFact, "session verified_facts should remain available for review");
  assert.strictEqual(sessionFact.state, "pending", "a verified_facts label is not independent verification");
  assert.strictEqual(sessionFact.requires_confirmation, true);
  await assertAutomaticContextExcludes([...claims, sessionFact]);
  const pendingSessionBrief = parse(await TOOLS.session({ action: "begin", goal: "Review provenanceclaim memory", project: "sidekick", source: "test" }));
  assertBriefExcludes(pendingSessionBrief.memory_brief, [...claims, sessionFact]);

  for (const claim of [reportedFact, ...legacyClaims, sessionFact]) {
    const confirmed = await TOOLS.memory({ action: "confirm", id: claim.id, project: "sidekick", source: "test-reviewer" });
    assert.ok(!confirmed.isError, confirmed.content[0].text);
    assert.strictEqual(dbStore.getMemoryById(claim.id).state, "confirmed");
    const memoryResult = parse(await TOOLS.memory({ action: "query", project: "sidekick", query: claim.content, limit: 100 }));
    assert.ok(memoryResult.context_brief.selected.some(item => item.id === claim.id), "confirmed claims should enter memory briefs");
    const assembled = parse(await TOOLS.context({ action: "assemble", project: "sidekick", query: claim.content, limit: 50 }));
    const entry = assembled.entries.find(item => item.source === "memory" && item.sourceId === claim.id);
    assert.ok(entry, "confirmed claims should enter automatic context");
    assert.strictEqual(entry.state, "confirmed");
    assert.strictEqual(entry.requires_confirmation, false);
    assert.strictEqual(entry.provenance.source, claim.source);
    const projectResult = parse(await TOOLS.project({ name: "sidekick", include: "context" }));
    assert.ok(projectResult.context.some(item => item.id === claim.id && item.state === "confirmed" && item.source === claim.source), "project context should retain confirmed provenance");
  }
  const confirmedSessionBrief = parse(await TOOLS.session({ action: "begin", goal: "Review confirmed provenanceclaim", project: "sidekick", source: "test" }));
  vectorResults.push({ payload: { memory_id: "mem_missing", content: "orphan vector" }, score: 1 }, { payload: {}, score: 1 });
  const confirmedVectors = await memoryApi.searchMemoriesByEmbedding("provenanceclaim", { project: "sidekick" });
  assert.deepStrictEqual(confirmedVectors.map(item => item.id).sort(), [reportedFact, ...legacyClaims].map(item => item.id).sort(), "only confirmed current rows should survive vector hydration");
  assert.ok(confirmedVectors.every(item => item.state === "confirmed" && item.content !== "stale vector claims to be confirmed"), "vectors must return current SQLite content and provenance");
  dbStore.disableMemory(legacyClaims[0].id);
  assert.ok(!(await memoryApi.searchMemoriesByEmbedding("provenanceclaim", { project: "sidekick" })).some(item => item.id === legacyClaims[0].id), "disabled confirmed rows must not return through stale vectors");
  dbStore.enableMemory(legacyClaims[0].id);
  assert.ok(confirmedSessionBrief.memory_brief.selected.some(item => item.id === reportedFact.id), "session briefs should admit confirmed claims");
  assert.ok(confirmedSessionBrief.memory_brief.sections.includes(legacyClaims[0].content), "brief prose should admit confirmed facts");
  await assertAutomaticContextExcludes([pendingProcedure]);
  assert.ok(endData.memories_created >= 4, "ending session should create supported memories");
  assert.ok(endData.continuation_packet.artifacts.length >= 2, "session finalization should retain reports, artifacts, and continuity plan");
  assert.strictEqual(endData.continuation_packet.provenance.task_id, beginData.session.id, "continuation packet should retain task provenance");
  const finalizedHandoff = JSON.parse((await TOOLS.handoff({ action: "get", id: createData.handoff.id })).content[0].text);
  assert.strictEqual(finalizedHandoff.handoff.packet.status, "completed", "linked handoff should receive the finalized continuation packet");
  assert.ok(finalizedHandoff.handoff.links.some(link => link.type === "artifact" && link.payload.type === "subagent_report"), "subagent report should be a first-class handoff artifact");
  const endEvent = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'memory.session_completed' AND subject_id = ?").get(beginData.session.id);
  assert.ok(endEvent, "session end should emit a platform memory event");

  const preservedPacket = {
    objective: "Preserve linked handoff state during session finalization",
    status: "active",
    next_step: "Review the preserved continuation",
    decisions: ["Keep the original decision"],
    blockers: [],
    acceptance_criteria: ["Original acceptance criterion remains present"],
    risks: ["Original risk remains visible"],
    evidence: [{ type: "source", label: "original evidence" }],
    artifacts: [{ type: "file", path: "original-artifact.txt" }],
    relationships: [{ type: "related", target: "original-work" }]
  };
  const preserved = JSON.parse((await TOOLS.handoff({ action: "create", project: "sidekick", content: "Original continuation state", packet: preservedPacket })).content[0].text);
  const preservedSession = JSON.parse((await TOOLS.session({ action: "begin", goal: "Finalize without losing linked packet state", project: "sidekick", source: "test" })).content[0].text);
  const preservedEnd = JSON.parse((await TOOLS.session({
    action: "end",
    id: preservedSession.session.id,
    handoff_id: preserved.handoff.id,
    final_summary: "Finalized while preserving linked state",
    acceptance_state: "accepted"
  })).content[0].text);
  assert.strictEqual(preservedEnd.handoff_version, 2, "session finalization should return the new handoff version");
  const preservedResult = JSON.parse((await TOOLS.handoff({ action: "get", id: preserved.handoff.id })).content[0].text).handoff.packet;
  assert.deepStrictEqual(preservedResult.decisions, preservedPacket.decisions, "finalization should preserve prior decisions");
  assert.deepStrictEqual(preservedResult.risks, preservedPacket.risks, "finalization should preserve prior risks");
  assert.ok(preservedResult.artifacts.some(artifact => artifact.path === "original-artifact.txt"), "finalization should preserve prior artifacts");
  assert.ok(preservedResult.evidence.some(item => item.label === "original evidence"), "finalization should preserve prior evidence");
  assert.ok(preservedResult.relationships.some(item => item.target === "original-work"), "finalization should preserve prior relationships");
  assert.ok(preservedResult.acceptance_criteria.includes("Original acceptance criterion remains present"), "finalization should preserve prior acceptance criteria");

  const atomicHandoff = JSON.parse((await TOOLS.handoff({ action: "create", project: "sidekick", content: "Atomic finalization guard", packet: { objective: "Atomic finalization guard", status: "active", next_step: "Try finalization", acceptance_criteria: ["Remain resumable"] } })).content[0].text);
  const atomicSession = JSON.parse((await TOOLS.session({ action: "begin", goal: "Verify failed handoff finalization does not end the session", project: "sidekick", source: "test" })).content[0].text);
  dbStore.getDb().prepare(`
    INSERT INTO memory_handoff_versions (handoff_id, version, content, redacted_content, content_hash, created_at, superseded_at)
    VALUES (?, ?, 'WRONG-PLANTED', 'WRONG-PLANTED', 'nothash', datetime('now'), datetime('now'))
  `).run(atomicHandoff.handoff.id, atomicHandoff.handoff.version);
  const atomicEnd = await TOOLS.session({ action: "end", id: atomicSession.session.id, handoff_id: atomicHandoff.handoff.id, final_summary: "Should not complete", acceptance_state: "accepted" });
  assert.ok(atomicEnd.isError, "failed handoff finalization should return an error");
  assert.ok(atomicEnd.content[0].text.includes("session finalization failed"), atomicEnd.content[0].text);
  assert.strictEqual(dbStore.getTaskSession(atomicSession.session.id).state, "active", "failed handoff finalization must leave the session active");

  const wrong = await TOOLS.memory({ action: "remember", project: "sidekick", type: "fact", content: "Sidekick dashboard runs on port 9999", evidence: "test wrong fact" });
  const wrongId = JSON.parse(wrong.content[0].text).memory.id;
  const correction = await TOOLS.memory({ action: "correct", id: wrongId, correct_to: "Sidekick dashboard runs on port 4098", reason: "test correction" });
  const correctionData = JSON.parse(correction.content[0].text);
  assert.ok(correctionData.replacement.id, "correction should create replacement memory");
  const rememberEvent = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'memory.remembered' AND subject_id = ?").get(wrongId);
  assert.ok(rememberEvent, "explicit remember should emit a platform memory event");
  const correctEvent = dbStore.getDb().prepare("SELECT * FROM platform_execution_events WHERE event_type = 'memory.corrected' AND subject_id = ?").get(correctionData.replacement.id);
  assert.ok(correctEvent, "memory correction should emit a platform memory event");
  const old = dbStore.getMemoryById(wrongId, { includeDisabled: true });
  assert.strictEqual(old.state, "deleted", "corrected old memory should be excluded from current recall");

  const explain = await TOOLS.memory({ action: "explain", id: correctionData.replacement.id });
  const explainData = JSON.parse(explain.content[0].text);
  assert.ok(explainData.evidence.length >= 1, "explain should return evidence rows");

  const health = await TOOLS.memory({ action: "health" });
  const healthData = JSON.parse(health.content[0].text);
  assert.ok(healthData.stats.stored_handoffs >= 1, "health should count stored handoffs");
  assert.ok(healthData.stats.durable_active >= 1, "health should count durable active memories");

  const getByNoSelector = await TOOLS.handoff({ action: "get" });
  assert.ok(getByNoSelector.isError, "handoff get with no selector should be an error");
  assert.ok(getByNoSelector.content[0].text.includes("requires id"), "error message should state id is required");

  const getByProjectOnly = await TOOLS.handoff({ action: "get", project: "sidekick" });
  assert.ok(getByProjectOnly.isError, "handoff get with only project should be an error");
  assert.ok(getByProjectOnly.content[0].text.includes("requires id"), "error message should state id is required");

  const inspectByNoSelector = await TOOLS.handoff({ action: "inspect" });
  assert.ok(inspectByNoSelector.isError, "handoff inspect with no selector should be an error");
  assert.ok(inspectByNoSelector.content[0].text.includes("requires id"), "inspect error message should state id is required");

  const inspectByProjectOnly = await TOOLS.handoff({ action: "inspect", project: "sidekick" });
  assert.ok(inspectByProjectOnly.isError, "handoff inspect with only project should be an error");
  assert.ok(inspectByProjectOnly.content[0].text.includes("requires id"), "inspect error message should state id is required");

  const getById = await TOOLS.handoff({ action: "get", id: createData.handoff.id });
  assert.ok(!getById.isError, "handoff get by id should still work");
  const getByIdData = JSON.parse(getById.content[0].text);
  assert.strictEqual(getByIdData.handoff.id, createData.handoff.id, "get by id should return the correct handoff");

  const getByWrongProject = await TOOLS.handoff({ action: "get", id: createData.handoff.id, project: "other_project" });
  assert.ok(getByWrongProject.isError, "handoff get should enforce the requested project scope");
  assert.ok(getByWrongProject.content[0].text.includes("not found"), "wrong-project handoff access should be indistinguishable from a missing handoff");

  const foreignSession = JSON.parse((await TOOLS.session({ action: "begin", goal: "Reject a cross-project handoff link", project: "other_project", source: "test" })).content[0].text);
  const foreignEnd = await TOOLS.session({ action: "end", id: foreignSession.session.id, handoff_id: createData.handoff.id, final_summary: "Should not link across projects", acceptance_state: "accepted" });
  assert.ok(foreignEnd.isError, "session finalization should reject a cross-project handoff link");
  assert.strictEqual(dbStore.getTaskSession(foreignSession.session.id).state, "active", "cross-project handoff rejection must leave the session active");

  const getByUnknownId = await TOOLS.handoff({ action: "get", id: "nonexistent_id" });
  assert.ok(getByUnknownId.isError, "handoff get by unknown id should be an error");
  assert.ok(getByUnknownId.content[0].text.includes("Handoff not found"), "unknown id should return Handoff not found");

  console.log("✅ Memory intelligence tests passed");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
