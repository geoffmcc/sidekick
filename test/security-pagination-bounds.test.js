"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("Agent history offsets cannot exceed the bounded directory scan", () => {
  const { HISTORY_LIMITS, clampHistoryOffset } = require("../src/agent-history");
  assert.equal(clampHistoryOffset(-1), 0);
  assert.equal(clampHistoryOffset(1.5), 0);
  assert.equal(clampHistoryOffset(Number.MAX_SAFE_INTEGER), HISTORY_LIMITS.MAX_SCAN_FILES);
});

test("approval list limits reject negative values before SQL binding", () => {
  const dbPath = require.resolve("../src/db");
  const storePath = require.resolve("../src/approvals/store");
  const priorDb = require.cache[dbPath];
  const priorStore = require.cache[storePath];
  const bindings = [];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    parent: module,
    children: [],
    exports: {
      getDb: () => ({ prepare: () => ({ all: (...args) => { bindings.push(args); return []; } }) }),
    },
  };
  delete require.cache[storePath];
  try {
    const approvals = require("../src/approvals/store");
    approvals.listApprovalRows({ limit: "-1" });
    approvals.listApprovalRows({ limit: "999999" });
    assert.deepEqual(bindings, [[100], [500]]);
  } finally {
    if (priorDb) require.cache[dbPath] = priorDb;
    else delete require.cache[dbPath];
    if (priorStore) require.cache[storePath] = priorStore;
    else delete require.cache[storePath];
  }
});
