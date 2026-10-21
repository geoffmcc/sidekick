"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerKnowledgeRoute } = require("../src/dashboard/knowledge-route");

test("knowledge catalog rejects unbounded negative limits and caps oversized requests", () => {
  const routes = new Map();
  const limits = [];
  const app = { get: (route, handler) => routes.set(route, handler) };
  const dbStore = { getDb: () => ({ prepare: () => ({ all: (...args) => { limits.push(args.at(-1)); return []; } }) }) };
  registerKnowledgeRoute({ app, dbStore, requireIdentityPermission: () => true, errorResponse: () => assert.fail("unexpected database error") });
  const handler = routes.get("/api/knowledge");
  const invoke = limit => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    handler({ query: { limit } }, res);
    return res;
  };
  invoke("-1");
  invoke("-999999");
  invoke("999999");
  assert.deepEqual(limits, [50, 50, 500]);
});
