"use strict";

const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { startFixture, launchBrowser, withDiagnostics, waitFor } = require("./dashboard-e2e-testkit");

let fixture;
let browser;
let page;

before(async () => {
  fixture = await startFixture();
  browser = await launchBrowser();
  page = await browser.newPage({ httpCredentials: { username: "e2e-user", password: "e2e-dashboard-password" } });
});

after(async () => {
  await browser?.close();
  await fixture?.close();
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

    await page.goto(`${fixture.baseUrl}/#memory`, { waitUntil: "networkidle" });
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

    await page.goto(`${fixture.baseUrl}/#handoffs`, { waitUntil: "networkidle" });
    await waitFor("handoff workspace", async () => !/Loading handoffs\.\.\./.test(await page.locator("#handoffStatus").textContent()));
    assert.match(await page.locator("#handoffStatus").textContent(), /handoff/i);
    assert.equal(await page.locator("#page-handoffs").evaluate(element => element.classList.contains("active")), true);

    await page.goto(`${fixture.baseUrl}/#projects`, { waitUntil: "networkidle" });
    await page.locator("#projectsList").waitFor({ state: "visible" });
    assert.doesNotMatch(await page.locator("#projectsList").textContent(), /internal stack|password|secret/i);
  });
});
