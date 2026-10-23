"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { test, before, after } = require("node:test");
const { startFixture, launchBrowser, withDiagnostics, waitFor } = require("./dashboard-e2e-testkit");

let fixture;
let browser;
let page;
let dbStore;

before(async () => {
  fixture = await startFixture();
  browser = await launchBrowser();
  page = await browser.newPage({ httpCredentials: { username: "e2e-user", password: "e2e-dashboard-password" } });
});

after(async () => {
  await browser?.close();
  try { dbStore?.closeDatabase(); } catch {}
  await fixture?.close();
});

test("persisted tool-log text cannot create executable Dashboard markup", async () => {
  process.env.SIDEKICK_DATA_DIR = fixture.dataDir;
  process.env.SIDEKICK_DB_FILE = path.join(fixture.dataDir, "sidekick.db");
  dbStore = require("../../src/db");
  dbStore.clearToolLogs();
  const payload = '<img src=x onerror="window.__sidekickStoredLogXss=1">';
  dbStore.appendToolLog({
    n: payload,
    t: new Date().toISOString(),
    ok: false,
    s: payload,
    src: "e2e-untrusted-tool-output",
  });
  assert.equal(dbStore.readToolLogs(1)[0]?.s, payload, "the synthetic content is persisted as tool-log text");
  const summary = await fixture.request("GET", "/api/dashboard-summary");
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.recentErrors[0]?.summary, payload, "Dashboard API returns the persisted value for rendering");

  await page.addInitScript(() => { window.__sidekickStoredLogXss = 0; });
  await withDiagnostics(page, fixture, "stored-tool-log-text", async () => {
    await page.goto(`${fixture.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.locator("#missionRecentActivity .mission-activity").first().waitFor({ state: "visible" });
    assert.equal(await page.locator("#missionRecentActivity img").count(), 0, "persisted strings must not create Mission markup");
    assert.equal(await page.evaluate(() => window.__sidekickStoredLogXss), 0, "persisted strings must not run handlers");
    assert.match(await page.locator("#missionRecentActivity").textContent(), /<img src=x onerror=/, "the error remains visible as text");

    await page.goto(`${fixture.baseUrl}/#system`, { waitUntil: "domcontentloaded" });
    await page.locator("#page-system.active").waitFor({ state: "attached" });
    await page.locator("#recentErrors .summary-error").waitFor({ state: "visible" });
    assert.equal(await page.locator("#recentErrors img").count(), 0, "persisted strings must not create System markup");
    assert.equal(await page.evaluate(() => window.__sidekickStoredLogXss), 0, "System rendering must not run persisted handlers");
    assert.match(await page.locator("#recentErrors").textContent(), /<img src=x onerror=/, "System errors also retain the value as text");
  });
});

test("memory import is visible in the real Memory workspace", async () => {
  await withDiagnostics(page, fixture, "memory-workspace", async () => {
    const payload = {
      version: 2,
      machine_id: "e2e-machine",
      user_id: "e2e-user",
      memories: [{
        id: "mem_e2e_journey",
        type: "decision",
        project: "e2e_journey",
        content: "The E2E journey stores durable memory.",
        summary: "E2E durable memory",
        tags: ["e2e", "journey"],
        confidence: 0.95,
        source: "e2e",
        automatic: false,
      }],
    };
    const imported = await fixture.request("POST", "/api/memories/import", { data: payload, on_conflict: "skip" });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.ok, true);
    assert.equal(imported.body.imported, 1);

    await page.goto(`${fixture.baseUrl}/#memory`, { waitUntil: "domcontentloaded" });
    await page.locator("#page-memory.active").waitFor({ state: "attached" });
    await page.locator("#memoryList").getByText("E2E durable memory").waitFor({ state: "visible" });
    assert.match(await page.locator("#memoryList").textContent(), /e2e_journey/);
    await page.locator("#memoryCategoryAll").click();
    assert.equal(await page.locator("#memoryCategoryAll").getAttribute("aria-selected"), "true");
  });
});

test("knowledge, handoff, and workflow read journeys report bounded product state", async () => {
  await withDiagnostics(page, fixture, "knowledge-handoff-workflow", async () => {
    const knowledge = await fixture.request("GET", "/api/knowledge?limit=10");
    assert.equal(knowledge.status, 200, JSON.stringify(knowledge.body));
    assert.equal(knowledge.body.ok, true);
    assert.ok(Array.isArray(knowledge.body.knowledge));
    assert.ok(knowledge.body.knowledge.length <= 10);

    const handoffs = await fixture.request("GET", "/api/handoffs?limit=10");
    assert.equal(handoffs.status, 200, JSON.stringify(handoffs.body));
    assert.equal(handoffs.body.ok, true);
    assert.ok(Array.isArray(handoffs.body.handoffs));

    const workflowCatalog = await fixture.request("GET", "/api/capabilities/catalog?kind=workflow&limit=10");
    assert.equal(workflowCatalog.status, 200, JSON.stringify(workflowCatalog.body));
    assert.equal(workflowCatalog.body.ok, true);
    assert.ok(workflowCatalog.body.entries.every(entry => entry.kind === "workflow"));

    await page.goto(`${fixture.baseUrl}/#handoffs`, { waitUntil: "domcontentloaded" });
    await page.locator("#page-handoffs.active").waitFor({ state: "attached" });
    await waitFor("handoff workspace", async () => !/Loading handoffs\.\.\./.test(await page.locator("#handoffStatus").textContent()));
    assert.match(await page.locator("#handoffStatus").textContent(), /handoff/i);
    assert.equal(await page.locator("#page-handoffs").evaluate(element => element.classList.contains("active")), true);

    await page.goto(`${fixture.baseUrl}/#projects`, { waitUntil: "domcontentloaded" });
    await page.locator("#page-projects.active").waitFor({ state: "attached" });
    await page.locator("#projectsList").waitFor({ state: "visible" });
    assert.doesNotMatch(await page.locator("#projectsList").textContent(), /internal stack|password|secret/i);
  });
});
