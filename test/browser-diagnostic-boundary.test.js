"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const browserActions = require("../src/browser/actions");
const browserSessions = require("../src/browser/sessions");
const browserEgress = require("../src/browser/egress");
const { classifyError } = browserActions;

test("browser diagnostics retain the failing origin without echoing URL secrets", () => {
  const secret = "synthetic-browser-url-secret-6c91";
  const error = classifyError(new Error(
    `page.goto: net::ERR_CONNECTION_REFUSED at https://user:${secret}@example.invalid/private/${secret}?token=${secret}#${secret}`
  ));

  assert.equal(error.category, "navigation_failed");
  assert.match(error.message, /https:\/\/example\.invalid/);
  assert.ok(!error.message.includes(secret));
  assert.ok(!error.message.includes("/private/"));
  assert.ok(!error.message.includes("token="));
});

test("browser timeout diagnostics redact URLs while preserving useful locator context", () => {
  const secret = "synthetic-timeout-secret-2d34";
  const error = classifyError(new Error(
    `Timeout 1000ms exceeded while waiting for https://user:${secret}@example.invalid/path?token=${secret}`
  ));

  assert.equal(error.category, "timeout");
  assert.match(error.message, /Timed out: Timeout 1000ms exceeded/);
  assert.match(error.message, /https:\/\/example\.invalid/);
  assert.ok(!error.message.includes(secret));
});

test("page state returns only the URL authority, not secret-bearing path or query data", async () => {
  const secret = "synthetic-page-url-secret-841d";
  const session = {
    secretValues: new Set(),
    pages: new Map([[
      "pg_1",
      { id: "pg_1", page: { url: () => `https://user:${secret}@example.invalid/private/${secret}?token=${secret}#${secret}`, title: async () => "fixture" } },
    ]]),
    activePageId: "pg_1",
  };

  const result = await browserActions.listPages(session);
  assert.equal(result.pages[0].url, "https://example.invalid");
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("download records and failure diagnostics do not retain raw URL secrets", async () => {
  const secret = "synthetic-download-url-secret-c760";
  const url = `https://user:${secret}@example.invalid/private/${secret}?token=${secret}`;
  const session = { id: "bsn_fixture", downloads: [], warnings: [], executionContext: null };
  await browserSessions.captureDownload(session, {
    url: () => url,
    suggestedFilename: () => "fixture.bin",
    path: async () => null,
    failure: async () => `download failed for ${url}`,
  });

  assert.equal(session.downloads[0].url, "https://example.invalid");
  assert.ok(!JSON.stringify(session.downloads[0]).includes(secret));
  assert.ok(!session.downloads[0].error.includes("/private/"));
  assert.ok(!session.downloads[0].error.includes("token="));
});

test("shared browser URL evidence sanitizer preserves authority and safe blank-page identity", () => {
  const secret = "synthetic-evidence-url-secret-fb19";
  assert.equal(
    browserEgress.safeEvidenceTarget(`wss://user:${secret}@example.invalid/private/${secret}?token=${secret}`, "http"),
    "wss://example.invalid"
  );
  assert.equal(browserEgress.safeEvidenceTarget("about:blank", "http"), "about:blank");
  assert.equal(browserEgress.safeEvidenceTarget("example.invalid:443", "connect"), "example.invalid:443");
});
