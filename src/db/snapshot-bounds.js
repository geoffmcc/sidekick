"use strict";

function collectSnapshotRows(rows, budget, limits) {
  const collected = [];
  for (const row of rows) {
    budget.rows += 1;
    if (budget.rows > limits.maxRows) {
      throw new Error(`Database snapshot exceeds the ${limits.maxRows} row limit; select a specific table or narrow the data`);
    }
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    budget.bytes += rowBytes;
    if (budget.bytes > limits.maxBytes) {
      throw new Error(`Database snapshot exceeds the ${limits.maxBytes} byte limit; select a specific table or narrow the data`);
    }
    collected.push(row);
  }
  return collected;
}

module.exports = { collectSnapshotRows };
