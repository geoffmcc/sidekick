"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright-core");

const root = path.join(__dirname, "..");
const executable = chromium.executablePath();
if (!executable || !fs.existsSync(executable)) {
  console.log("Dashboard browser tests skipped: Chromium executable is unavailable");
  process.exit(0);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  if (pathname.startsWith("/api/")) {
    const payload = pathname === "/api/projects"
      ? { ok: true, projects: [{ project: { project_id: "alpha", display_name: "Alpha Project", state: "active" }, workspace: { state: "active" }, sources: [] }] }
      : pathname === "/api/services"
        ? { services: { "sidekick-mcp": "active", "sidekick-dashboard": "active", "sidekick-agent": "active", ollama: "unavailable" } }
        : {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }
  const file = pathname === "/" ? path.join(root, "src", "dashboard.html") : path.join(root, pathname.replace(/^\//, ""));
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: executable });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/#mission`, { waitUntil: "networkidle" });
    for (const viewport of [
      [320, 568], [375, 667], [390, 844], [768, 1024], [900, 900],
      [1024, 768], [1180, 800], [1280, 720], [1366, 768], [1440, 900], [1920, 1080]
    ]) {
      await page.setViewportSize({ width: viewport[0], height: viewport[1] });
      const overflow = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map(el => ({ tag: el.tagName, id: el.id, className: el.className, right: Math.round(el.getBoundingClientRect().right) })));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no document overflow at ${viewport[0]}x${viewport[1]}: ${JSON.stringify(overflow)}`);
    }
    await page.setViewportSize({ width: 1366, height: 768 });
    assert.strictEqual(await page.locator("#nav-brain").isVisible(), true, "Intelligence navigation is visible");
    assert.strictEqual(await page.locator("#nav-config").isVisible(), true, "System navigation reaches the final option");

    await page.locator("#workspaceButton").click();
    await page.locator("#workspace-option-alpha").click();
    assert.strictEqual(await page.locator("#workspaceLabel").textContent(), "Alpha Project");
    assert.strictEqual(await page.locator("#page-projects").isVisible(), true, "workspace selection routes to Projects");

    await page.locator("#commandTrigger").click();
    await page.locator("#commandInput").fill("Health");
    await page.locator("#commandInput").press("Enter");
    assert.strictEqual(await page.locator("#page-system").isVisible(), true, "command palette navigates by keyboard");
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), "commandTrigger", "command palette returns focus after selection");

    assert.match(await page.locator("#serviceStatusList").textContent(), /MCP: active/);
    assert.match(await page.locator("#serviceStatusList").textContent(), /Ollama: unavailable/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "desktop has no document overflow");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#mobileMenu").click();
    assert.strictEqual(await page.locator("#appSidebar").evaluate(el => el.classList.contains("mobile-open")), true);
    assert.strictEqual(await page.locator("#mobileNavBackdrop").isVisible(), true);
    assert.strictEqual(await page.evaluate(() => document.body.classList.contains("mobile-nav-open")), true);
    await page.keyboard.press("Escape");
    assert.strictEqual(await page.locator("#appSidebar").evaluate(el => el.classList.contains("mobile-open")), false);
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), "mobileMenu", "mobile navigation returns focus");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile has no document overflow");
    await page.evaluate(() => { document.body.style.zoom = "2"; });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "200% zoom has no document overflow");
    console.log("Dashboard browser tests: passed");
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { server.close(); console.error(error); process.exitCode = 1; });
