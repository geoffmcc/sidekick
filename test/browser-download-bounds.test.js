"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { captureDownload } = require("../src/browser/sessions");
const { sha256File, copyArtifactFile } = require("../src/browser/artifacts");

test("browser artifact hashing and copying use bounded streaming IO", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-browser-artifact-bounds-"));
  const source = path.join(dir, "source.bin");
  const destination = path.join(dir, "destination.bin");
  const oversizedDestination = path.join(dir, "oversized-destination.bin");
  try {
    fs.writeFileSync(source, "bounded browser artifact");
    const digest = sha256File(source, 1024);
    assert.equal(digest.sha256, crypto.createHash("sha256").update("bounded browser artifact").digest("hex"));
    assert.equal(digest.byteSize, Buffer.byteLength("bounded browser artifact"));
    copyArtifactFile(source, destination, 1024);
    assert.equal(fs.readFileSync(destination, "utf8"), "bounded browser artifact");
    assert.throws(() => sha256File(source, 3), /byte limit/);
    assert.throws(() => copyArtifactFile(source, oversizedDestination, 3), /byte limit/);
    assert.equal(fs.existsSync(oversizedDestination), false, "rejected copies must leave no partial artifact");
    assert.throws(() => copyArtifactFile(source, destination, 1024), /exist|file already/i);
    assert.equal(fs.readFileSync(destination, "utf8"), "bounded browser artifact", "exclusive create must preserve an existing artifact");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("browser cancels a download whose file path does not settle", async () => {
  let cancelled = false;
  const session = { id: "test-session", downloads: [], warnings: [], executionContext: null };
  const download = {
    url: () => "https://downloads.example/large.bin",
    suggestedFilename: () => "large.bin",
    path: () => new Promise(() => {}),
    cancel: async () => { cancelled = true; },
    failure: async () => "cancelled",
  };
  await captureDownload(session, download, { downloadPathTimeoutMs: 5 });
  assert.equal(cancelled, true);
  assert.equal(session.downloads[0].status, "failed");
  assert.match(session.downloads[0].error, /cancellation=completed/);
});

test("browser reports a failed download cancellation", async () => {
  const session = { id: "test-session", downloads: [], warnings: [], executionContext: null };
  const download = {
    url: () => "https://downloads.example/stalled.bin",
    suggestedFilename: () => "stalled.bin",
    path: () => new Promise(() => {}),
    cancel: async () => { throw new Error("synthetic cancel failure"); },
    failure: async () => "still active",
  };
  await captureDownload(session, download, { downloadPathTimeoutMs: 5 });
  assert.equal(session.downloads[0].status, "failed");
  assert.match(session.downloads[0].error, /cancellation=failed: synthetic cancel failure/);
});
