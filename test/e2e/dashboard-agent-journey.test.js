"use strict";

const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { startFixture, launchBrowser, waitFor, withDiagnostics } = require("./dashboard-e2e-testkit");

let fixture;
let browser;
let page;

before(async () => {
  fixture = await startFixture({ withAgent: true });
  browser = await launchBrowser();
  page = await browser.newPage({ httpCredentials: { username: "e2e-user", password: "e2e-dashboard-password" } });
});

after(async () => {
  await browser?.close();
  await fixture?.close();
});

test("Agent task submission, durable completion, history, and reload restoration work end to end", async () => {
  await withDiagnostics(page, fixture, "agent-task-session", async () => {
    await page.goto(`${fixture.baseUrl}/#agent`, { waitUntil: "networkidle" });
    await page.locator("#agentGoal").fill("Give me a short greeting");
    await page.locator("#agentProject").fill("e2e_journey");
    await page.locator("#agentGo").click();

    await waitFor("Agent task completion", async () => {
      const response = await fixture.request("GET", "/api/agent/tasks?project=e2e_journey&limit=10");
      const tasks = Array.isArray(response.body?.tasks) ? response.body.tasks : [];
      return tasks.find(task => ["completed", "partial", "failed", "cancelled", "interrupted"].includes(task.state));
    }, 60000);
    await page.locator("#agentLog").getByText("E2E direct answer").waitFor({ state: "visible", timeout: 60000 });
    await waitFor("durable Agent terminal state", async () => /State:\s*(completed|partial)/.test(await page.locator("#agentDurableState").textContent()), 30000);
    assert.match(await page.locator("#agentDurableVerification").textContent(), /Verification:\s*(verified|unable_to_verify)/);

    const historyToggle = page.locator("#agentHistoryToggle");
    await historyToggle.click();
    if (await historyToggle.getAttribute("aria-expanded") !== "true") await historyToggle.click();
    await page.locator("#agentHistory .history-item").waitFor({ state: "visible" });
    assert.match(await page.locator("#agentHistory").textContent(), /Give me a short greeting/);

    await page.locator("#nav-mission").click();
    await page.locator("#nav-agent").click();
    await waitFor("Agent session restoration", async () => /Give me a short greeting/.test(await page.locator("#agentSessionMeta").textContent()));
    assert.match(await page.locator("#agentLog").textContent(), /E2E direct answer/);
    assert.ok(fixture.ollama, "the external inference boundary fixture should be running");
  });
});
