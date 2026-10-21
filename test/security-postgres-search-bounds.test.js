"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const pg = require("pg");
const OriginalPool = pg.Pool;
const state = { queries: [], searches: [] };

class MockPool {
  async end() {}

  async query(sql, values = []) {
    state.queries.push({ sql: String(sql), values });
    if (String(sql).includes("information_schema.tables")) {
      return { rows: [{ table_name: "allowed" }, { table_name: "other" }] };
    }
    if (String(sql).includes("information_schema.columns")) {
      return { rows: [{ column_name: "body", data_type: "text" }, { column_name: "title", data_type: "character varying" }] };
    }
    throw new Error("Unexpected direct PostgreSQL query");
  }

  async connect() {
    return {
      query: async request => {
        state.searches.push(request);
        return { rows: Array.from({ length: 10 }, (_, index) => ({ body: `needle ${index}` })) };
      },
      release() {},
    };
  }
}

pg.Pool = MockPool;
const postgresStore = require("../src/pg");
pg.Pool = OriginalPool;

test("PostgreSQL search bounds total results and avoids work for blank queries", async () => {
  const results = await postgresStore.searchAllTables(" needle ", { tables: ["allowed"], limit: 1 });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { table: "allowed", column: "body", snippet: "needle 0" });
  assert.equal(state.searches.length, 1, "the global result bound stops subsequent column queries");
  assert.deepEqual(state.searches[0].values, ["%needle%"]);
  assert.equal(state.queries.filter(query => query.sql.includes("information_schema.columns"))[0].values[0], "allowed");

  const queryCount = state.queries.length;
  const searchCount = state.searches.length;
  assert.deepEqual(await postgresStore.searchAllTables("   ", { limit: 500 }), []);
  assert.equal(state.queries.length, queryCount);
  assert.equal(state.searches.length, searchCount);
});

test.after(async () => {
  await postgresStore.getPool().end();
});
