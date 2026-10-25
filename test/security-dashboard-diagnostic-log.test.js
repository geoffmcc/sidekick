"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDashboardErrorBoundary } = require("../src/dashboard/error-boundary");

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-dashboard-diagnostic-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logFile = path.join(directory, "dashboard-errors.jsonl");
  return {
    directory,
    logFile,
    append() {
      return createDashboardErrorBoundary({ fs, logFile }).logError(
        { method: "GET", headers: {}, route: { path: "/api/test" } },
        new Error("synthetic diagnostic"),
        { component: "test" },
      );
    },
  };
}

test("dashboard diagnostic append refuses a symlink target", { skip: process.platform === "win32" }, t => {
  const fixture = createFixture(t);
  const target = path.join(fixture.directory, "outside.jsonl");
  fs.writeFileSync(target, "synthetic target content\n");
  fs.symlinkSync(target, fixture.logFile);

  assert.equal(fixture.append(), null, "unsafe log path is rejected by best-effort diagnostic logging");
  assert.equal(fs.readFileSync(target, "utf8"), "synthetic target content\n");
});

test("dashboard diagnostic append refuses a hard-linked target", t => {
  const fixture = createFixture(t);
  const target = path.join(fixture.directory, "outside.jsonl");
  fs.writeFileSync(target, "synthetic target content\n");
  fs.linkSync(target, fixture.logFile);

  assert.equal(fixture.append(), null, "unsafe log path is rejected by best-effort diagnostic logging");
  assert.equal(fs.readFileSync(target, "utf8"), "synthetic target content\n");
});
