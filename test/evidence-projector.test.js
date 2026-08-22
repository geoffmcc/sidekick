"use strict";

const assert = require("assert");
const { runToolLoop } = require("../src/agent-loop");
const {
  EVIDENCE_BUDGETS,
  projectValue,
  projectEvidenceItems,
  projectContextEntries,
} = require("../src/evidence/projector");

console.log("Running bounded evidence projector tests...\n");

function assertProjected(value, expected, message) {
  const result = projectEvidenceItems([{ tool: "fixture", text: JSON.stringify(value) }]);
  assert.ok(result.text.includes(expected), message || `missing ${expected}`);
  assert.ok(result.text.length <= EVIDENCE_BUDGETS.MAX_TOTAL_CHARS, "projection exceeded total budget");
}

(() => {
  const important = { marker: "EVIDENCE_MUST_SURVIVE", nested: { symbol: "authenticateUser" } };
  const large = { metadata: "m".repeat(6000), array: Array.from({ length: 40 }, (_, i) => ({ i, value: "x".repeat(100) })) };
  assertProjected({ important, large_metadata: large }, "EVIDENCE_MUST_SURVIVE", "important first evidence was lost");
  assertProjected({ large_metadata: large, important }, "EVIDENCE_MUST_SURVIVE", "important late evidence was lost");

  const arrayResult = projectEvidenceItems([{ tool: "array_tool", text: JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => `item-${i}`), later: "LATE_SIBLING" }) }], { totalChars: 1200, perToolChars: 1200 });
  assert.ok(arrayResult.text.length <= 1200);
  assert.ok(arrayResult.text.includes("LATE_SIBLING"), "later sibling was starved by an array");
  assert.ok(arrayResult.text.includes("additional array items omitted"), "array omission was not explicit");

  const circular = { name: "root" }; circular.self = circular;
  const circularResult = projectValue(circular, { budget: 800, maxDepth: 4, maxObjectKeys: 8, maxArrayItems: 8, maxValueChars: 100 }, { seen: new WeakSet() });
  assert.ok(JSON.stringify(circularResult).includes("circular") && JSON.stringify(circularResult).includes("root"));

  const largeText = projectEvidenceItems([{ tool: "text", text: "BEGIN_USEFUL\n" + "x".repeat(6000) + "\nEND_USEFUL" }], { totalChars: 800, perToolChars: 800 });
  assert.ok(largeText.text.includes("BEGIN_USEFUL") && largeText.text.includes("END_USEFUL"), "large text lost one of its useful ends");

  const error = projectEvidenceItems([{ tool: "broken", isError: true, text: JSON.stringify({ details: "d".repeat(8000), code: "E_SYNTHETIC", message: "actual failure message", reason: "synthetic reason" }) }]);
  assert.ok(error.text.includes("E_SYNTHETIC") && error.text.includes("actual failure message") && error.text.includes("synthetic reason"), "error identity was hidden by debug detail");

  const many = projectEvidenceItems(Array.from({ length: 3 }, (_, i) => ({ tool: `tool-${i}`, text: JSON.stringify({ section: `tool-${i}-evidence`, data: "z".repeat(5000) }) })), { totalChars: 1800, perToolChars: 1200 });
  for (let i = 0; i < 3; i++) assert.ok(many.text.includes(`tool-${i}`), `tool ${i} was starved`);
  assert.ok(many.text.length <= 1800);

  const context = projectContextEntries([
    { source: "memory", type: "memory", sourceId: "1", summary: "generic summary", content: "IMPORTANT_CONTEXT_CONTENT", provenance: { trust: "untrusted" } },
    { source: "memory", type: "memory", sourceId: "2", summary: "summary only", content: "" },
    { source: "memory", type: "memory", sourceId: "3", summary: "", content: "content only" },
  ], { totalChars: 1200, perEntryChars: 400 });
  assert.ok(context.text.includes("IMPORTANT_CONTEXT_CONTENT"));
  assert.ok(context.text.includes("Trust: untrusted"));
  assert.ok(context.text.includes("summary only") && context.text.includes("content only"));

  let synthesisMessages = null;
  let call = 0;
  return runToolLoop({
    history: [],
    callLLM: async messages => {
      call++;
      if (call === 1) return { response: JSON.stringify({ tool: "inspect", arguments: {} }) };
      synthesisMessages = messages;
      return { response: JSON.stringify({ done: true, result: "completed" }) };
    },
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ metadata: "a".repeat(3000), secret: "synthetic-secret", semantic: { symbol: "authenticateUser", marker: "SRI_ONLY_EVIDENCE" } }) }] }),
    getToolDefs: () => [{ name: "inspect", enabled: true }],
    requireEvidence: true,
    redact: text => String(text).replace(/synthetic-secret/g, "[REDACTED]"),
  }).then(() => {
    const joined = (synthesisMessages || []).map(m => m.content || "").join("\n");
    assert.ok(joined.includes("SRI_ONLY_EVIDENCE"), "model-facing Agent evidence omitted late semantic content");
    assert.ok(!joined.includes("synthetic-secret"), "redaction was bypassed by evidence projection");
    console.log("Bounded evidence projector tests passed");
  });
})();
