"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { captureDownload } = require("../src/browser/sessions");

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
