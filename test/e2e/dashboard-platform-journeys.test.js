"use strict";

const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const {
  startFixture,
  launchBrowser,
  waitFor,
  withDiagnostics,
} = require("./dashboard-e2e-testkit");

let fixture;
let browser;
let page;

before(async () => {
  fixture = await startFixture();
  browser = await launchBrowser();
  page = await browser.newPage({ httpCredentials: { username: "e2e-user", password: "e2e-dashboard-password" } });
  await page.goto(`${fixture.baseUrl}/#mission`, { waitUntil: "networkidle" });
  await page.locator("#nav-mission").waitFor({ state: "visible" });
});

after(async () => {
  await browser?.close();
  await fixture?.close();
});

test("authenticated startup navigates every Dashboard workspace", async () => {
  await withDiagnostics(page, fixture, "authenticated-navigation", async () => {
    const pages = [
      "mission", "projects", "system", "activity", "blackbox", "data", "memory", "database", "config",
      "research", "agent", "handoffs", "approvals", "tools", "capabilities", "network-scopes",
      "identity", "evolve", "compute", "predict", "brain", "metrics",
    ];
    for (const name of pages) {
      await page.locator(`#nav-${name}`).click();
      await page.locator(`#page-${name}.active`).waitFor({ state: "attached" });
      assert.equal(await page.locator("#pageTitle").textContent(), {
        mission: "Mission Control", projects: "Projects", system: "Health & System", activity: "activity",
        blackbox: "Black Box", data: "Data", memory: "Memory", config: "Configuration", research: "Research",
        agent: "Agent", handoffs: "Handoffs", approvals: "Approvals", tools: "Tools", capabilities: "Capabilities",
        "network-scopes": "Network Scopes", identity: "Identity", evolve: "Evolve", compute: "Compute",
        predict: "Predict", brain: "Brain", metrics: "Metrics", database: "Database",
      }[name]);
    }
  });
});

test("capability catalog, lifecycle, health, maturity, and workflow projections are real", async () => {
  await withDiagnostics(page, fixture, "capability-lifecycle", async () => {
    const catalog = await fixture.request("GET", "/api/capabilities/catalog?limit=20");
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
    assert.equal(catalog.body.ok, true);
    assert.ok(Array.isArray(catalog.body.entries));
    assert.ok(catalog.body.entries.every(entry => entry.name && entry.kind));

    const installed = await fixture.request("POST", "/api/capabilities/install", { name: "api-engineering", enable: true });
    assert.equal(installed.status, 200, JSON.stringify(installed.body));
    const enabled = await fixture.request("GET", "/api/capabilities/api-engineering");
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    assert.equal(enabled.body.pack.state, "enabled");

    const health = await fixture.request("GET", "/api/capabilities/api-engineering/health");
    const maturity = await fixture.request("GET", "/api/capabilities/api-engineering/maturity");
    const workflows = await fixture.request("GET", "/api/capabilities/api-engineering/workflows");
    assert.equal(health.status, 200, JSON.stringify(health.body));
    assert.equal(maturity.status, 200, JSON.stringify(maturity.body));
    assert.equal(maturity.body.ok, true);
    assert.ok(["foundation", "operational", "integrated", "certified"].includes(maturity.body.maturity.level));
    assert.equal(workflows.status, 200, JSON.stringify(workflows.body));
    assert.equal(workflows.body.ok, true);

    await page.goto(`${fixture.baseUrl}/#capabilities`, { waitUntil: "networkidle" });
    const installedCard = page.locator("#capInstalled .capability-card").filter({ hasText: "api-engineering · Sidekick" });
    await installedCard.waitFor({ state: "visible" });
    const maturityButton = installedCard.getByRole("button", { name: /maturity/i });
    await maturityButton.click();
    await page.locator("#capDetail-api-engineering").waitFor({ state: "visible" });
    await waitFor("maturity detail", async () => /"level"/.test(await page.locator("#capDetail-api-engineering").textContent()));

    const disabled = await fixture.request("POST", "/api/capabilities/api-engineering/disable", {});
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    const disabledPack = await fixture.request("GET", "/api/capabilities/api-engineering");
    assert.equal(disabledPack.body.pack.state, "disabled");
    const reenabled = await fixture.request("POST", "/api/capabilities/api-engineering/enable", {});
    assert.equal(reenabled.status, 200, JSON.stringify(reenabled.body));
    const reenabledPack = await fixture.request("GET", "/api/capabilities/api-engineering");
    assert.equal(reenabledPack.body.pack.state, "enabled");
  });
});

test("authentication, CSRF, error, and configuration boundaries fail closed", async () => {
  await withDiagnostics(page, fixture, "dashboard-boundaries", async () => {
    const hostileOrigin = ["http", "evil.example"].join("://");
    assert.equal((await fixture.request("GET", "/", null, { auth: false })).status, 401);
    assert.equal((await fixture.request("GET", "/api/config", null, { auth: false })).status, 401);
    assert.equal((await fixture.request("GET", "/api/config", null, { headers: { Origin: hostileOrigin } })).status, 200);

    const csrf = await fixture.request("PUT", "/api/kv/cross-site", { value: "blocked" }, { headers: { Origin: hostileOrigin } });
    assert.equal(csrf.status, 403, JSON.stringify(csrf.body));
    assert.match(String(csrf.body.error), /origin|cross-site/i);

    const badDoctor = await fixture.request("GET", "/api/doctor?format=xml");
    assert.equal(badDoctor.status, 400, JSON.stringify(badDoctor.body));
    assert.equal(badDoctor.body.code, "invalid_format");
    const missing = await fixture.request("GET", "/api/not-a-real-route");
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.doesNotMatch(JSON.stringify(missing.body), /stack|secret|token|password/i);

    const config = await fixture.request("GET", "/api/config");
    const serialized = JSON.stringify(config.body);
    assert.doesNotMatch(serialized, /e2e-dashboard-password|e2e-dashboard-secret-key/);
  });
});

test("KV state survives a Dashboard process restart", async () => {
  await withDiagnostics(page, fixture, "dashboard-persistence-restart", async () => {
    const key = "e2e-persistence";
    const saved = await fixture.request("PUT", `/api/kv/${key}`, { value: "survives-restart", project: "sidekick" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    await page.goto(`${fixture.baseUrl}/#data`, { waitUntil: "networkidle" });
    await page.locator(`[data-key="${key}"]`).waitFor({ state: "visible" });
    await page.locator(`[data-key="${key}"]`).click();
    await page.locator("#kvInspector").getByText("survives-restart").waitFor({ state: "visible" });

    await fixture.restartDashboard();
    const restored = await fixture.request("GET", "/api/kv");
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.entries.find(entry => entry.key === key).value, "survives-restart");
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(`[data-key="${key}"]`).waitFor({ state: "visible" });
    await page.locator(`[data-key="${key}"]`).click();
    await page.locator("#kvInspector").getByText("survives-restart").waitFor({ state: "visible" });
  });
});
