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
    await page.goto(`${fixture.baseUrl}/#agent`, { waitUntil: "domcontentloaded" });
    await page.locator("#page-agent.active").waitFor({ state: "attached" });
    await page.locator("#agentGoal").waitFor({ state: "visible" });
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

test("tool-backed Agent task shows dispatch completion and durable history after reload", async () => {
  await withDiagnostics(page, fixture, "agent-tool-backed-session", async () => {
    fixture.ollama.setChatResponses([
      { tool: "tools", arguments: { action: "overview" } },
      { done: true, result: "E2E tool-backed task completed after inspecting the Sidekick tool catalog." },
    ]);
    await page.goto(`${fixture.baseUrl}/#agent`, { waitUntil: "domcontentloaded" });
    await page.locator("#page-agent.active").waitFor({ state: "attached" });
    await page.locator("#agentGoal").fill("Inspect the Sidekick tool catalog and summarize it");
    await page.locator("#agentProject").fill("e2e_tool_journey");
    await page.locator("#agentGo").click();

    const task = await waitFor("tool-backed Agent task", async () => {
      const response = await fixture.request("GET", "/api/agent/tasks?project=e2e_tool_journey&limit=10");
      return response.body?.tasks?.find(item => ["completed", "partial", "failed", "cancelled"].includes(item.state));
    }, 60000);
    await page.locator("#agentLog").getByText("E2E tool-backed task completed").waitFor({ state: "visible", timeout: 60000 });
    await waitFor("tool-backed durable state", async () => /State:\s*(completed|partial)/.test(await page.locator("#agentDurableState").textContent()), 30000);

    const transcript = await fixture.request("GET", `/api/agent/run/${encodeURIComponent(task.task_id)}`);
    assert.equal(transcript.status, 200);
    const dispatched = transcript.body.steps?.find(step => step.type === "tool" && step.tool === "tools");
    assert.ok(dispatched, "transcript must contain the canonical tools dispatch");
    assert.equal(transcript.body.status, "completed", "the Agent loop must complete after its successful tool call");
    const toolLogs = await fixture.request("GET", `/api/logs?tool=tools&source=agent&task=${encodeURIComponent(task.task_id)}&status=success`);
    assert.equal(toolLogs.status, 200);
    assert.ok(toolLogs.body.entries.some(entry => entry.tool === "tools" && entry.task_id === task.task_id && entry.ok === true), "durable tool audit must prove successful canonical dispatch");
    const durable = await fixture.request("GET", `/api/agent/tasks/${encodeURIComponent(task.task_id)}`);
    assert.equal(durable.status, 200);
    assert.ok(["completed", "partial"].includes(durable.body.task.state));

    const historyToggle = page.locator("#agentHistoryToggle");
    await historyToggle.click();
    if (await historyToggle.getAttribute("aria-expanded") !== "true") await historyToggle.click();
    await page.locator("#agentHistory").getByText("Inspect the Sidekick tool catalog and summarize it").waitFor({ state: "visible" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#page-agent.active").waitFor({ state: "attached" });
    await waitFor("reloaded durable Agent session", async () => /Inspect the Sidekick tool catalog/.test(await page.locator("#agentSessionMeta").textContent()));
    assert.match(await page.locator("#agentLog").textContent(), /E2E tool-backed task completed/);
    assert.ok(fixture.ollama, "the external inference boundary fixture should be running");
  });
});
