"use strict";

const assert = require("assert");
const { buildCuratorPrompt, proposeMemoryCuration, curateLearningCandidates, scopeCandidates } = require("../src/brain/memory-curator");

const candidates = [
  {
    candidate_id: "alc_one",
    candidate_version: 2,
    project_ref: "project:brain",
    kind: "planning_pattern",
    source_task_id: "task_one",
    provenance: { source_task_id: "task_one", token: "sk-secret-value" },
    proposal: { pattern: "Use a bounded verification step", password: "dont-store-this" },
  },
  { candidate_id: "foreign", candidate_version: 1, project_ref: "project:other", source_task_id: "task_other", kind: "budget_estimate" },
];

assert.strictEqual(scopeCandidates(candidates, { project: "project:brain", taskId: "task_one" }).length, 1);
const prompt = buildCuratorPrompt(candidates, { project: "project:brain", taskId: "task_one" });
assert.ok(prompt.includes("UNTRUSTED CANDIDATE DATA"));
assert.ok(!prompt.includes("sk-secret-value"));
assert.ok(!prompt.includes("dont-store-this"));

(async () => {
  const result = await proposeMemoryCuration({
    candidates,
    project: "project:brain",
    taskId: "task_one",
    generate: async value => {
      assert.ok(value.includes("project:brain"));
      return { response: JSON.stringify({ proposals: [
        { candidate_id: "alc_one", candidate_version: 2, type: "decision", summary: "Keep verification bounded", content: "password=super-secret", tags: ["brain"] },
        { candidate_id: "foreign", candidate_version: 1, type: "fact", summary: "wrong scope", content: "discard" },
        { candidate_id: "alc_one", candidate_version: 1, type: "fact", summary: "stale", content: "discard" },
      ] }) };
    },
  });
  assert.strictEqual(result.proposals.length, 1);
  assert.strictEqual(result.proposals[0].project_ref, "project:brain");
  assert.strictEqual(result.proposals[0].source_task_id, "task_one");
  assert.ok(result.proposals[0].content.includes("[REDACTED]"));
  assert.deepStrictEqual(result.proposals[0].review, { state: "proposal", requires_human_review: true, auto_promote: false, approved_by: null });
  assert.strictEqual(result.bounded, true);
  assert.ok(!JSON.stringify(result).includes("foreign"));
  const readCalls = [];
  const readOnlyFlow = await curateLearningCandidates({
    project: "project:brain",
    taskId: "task_one",
    listCandidates: async project => { readCalls.push(project); return candidates; },
    generate: async () => ({ response: JSON.stringify({ proposals: [{ candidate_id: "alc_one", candidate_version: 2, type: "fact", summary: "review me", content: "bounded" }] }) }),
  });
  assert.deepStrictEqual(readCalls, ["project:brain"]);
  assert.strictEqual(readOnlyFlow.proposals[0].review.auto_promote, false);
  await assert.rejects(() => proposeMemoryCuration({ candidates, project: "project:brain", generate: async () => ({ response: JSON.stringify({ proposals: [{ approved: true }] }) }) }), /authority_key_not_permitted/);
  console.log("Brain memory curator: passed");
})().catch(error => { console.error(error); process.exit(1); });
