"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { appendAuditLine } = require("../src/dashboard/audit-log");

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-audit-"));
  try { run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("audit append creates a private regular file and durably appends JSONL", () => {
  withTempDir(dir => {
    const file = path.join(dir, "audit.jsonl");
    appendAuditLine(file, '{"action":"first"}\n');
    appendAuditLine(file, '{"action":"second"}\n');
    assert.equal(fs.readFileSync(file, "utf8"), '{"action":"first"}\n{"action":"second"}\n');
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

test("audit append refuses symlinks and hard-linked audit files", { skip: process.platform === "win32" }, () => {
  withTempDir(dir => {
    const target = path.join(dir, "outside.jsonl");
    const linked = path.join(dir, "audit.jsonl");
    fs.writeFileSync(target, "original\n");
    fs.symlinkSync(target, linked);
    assert.throws(() => appendAuditLine(linked, "attack\n"));
    assert.equal(fs.readFileSync(target, "utf8"), "original\n");
    fs.unlinkSync(linked);
    fs.linkSync(target, linked);
    assert.throws(() => appendAuditLine(linked, "attack\n"));
    assert.equal(fs.readFileSync(target, "utf8"), "original\n");
  });
});

test("audit append tightens permissions on an existing regular file", { skip: process.platform === "win32" }, () => {
  withTempDir(dir => {
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(file, "existing\n", { mode: 0o644 });
    appendAuditLine(file, "new\n");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

test("audit append rejects an oversized event without changing history", () => {
  withTempDir(dir => {
    const file = path.join(dir, "audit.jsonl");
    appendAuditLine(file, '{"action":"retained"}\n');
    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => appendAuditLine(file, `${"x".repeat(32 * 1024)}\n`), /dashboard audit event exceeds the safe size limit/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});
