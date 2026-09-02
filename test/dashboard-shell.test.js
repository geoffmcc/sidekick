"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "dashboard.html"), "utf8");
const css = fs.readFileSync(path.join(root, "static", "dashboard.css"), "utf8");
const theme = fs.readFileSync(path.join(root, "static", "dashboard-theme.css"), "utf8");
const systemJs = fs.readFileSync(path.join(root, "static", "dashboard-system.js"), "utf8");
const activityJs = fs.readFileSync(path.join(root, "static", "dashboard-activity.js"), "utf8");
const js = fs.readFileSync(path.join(root, "static", "dashboard.js"), "utf8");

function ok(name, condition) {
  assert.ok(condition, name);
  console.log("  ok - " + name);
}

console.log("Running dashboard shell tests...");
const shell = html.slice(0, html.indexOf("<!-- Projects Page -->"));
ok("legacy horizontal navigation is replaced by grouped sidebar navigation", shell.includes('class="sidebar"') && shell.includes('class="side-nav"') && !shell.includes("onclick=\"showPage"));
ok("all destinations are deep-linkable", (html.match(/data-page="[^"]+"/g) || []).length >= 22 && js.includes("location.hash"));
ok("projects are an explicit destination", html.includes('id="page-projects"') && js.includes("loadProjects") && js.includes("/api/kv"));
ok("shell state is remembered without storing credentials", js.includes("sidekick_sidebar_collapsed") && !js.includes("localStorage.setItem('sidekick_auth'"));
ok("responsive and reduced-motion contracts exist", css.includes("@media(max-width:900px)") && css.includes("prefers-reduced-motion"));
ok("shared page theme is loaded after legacy styles", html.includes("dashboard-theme.css") && theme.includes(".data-browser") && theme.includes(".status-badge.unknown"));
ok("unknown health is represented distinctly", html.includes('class="status-dot unknown"') && css.includes(".status-dot.unknown"));
ok("command palette is keyboard discoverable", html.includes('id="commandDialog"') && js.includes("event.key.toLowerCase() === 'k'"));
ok("project records use escaped rendering", js.includes("esc(project.display_name || project.project_id)") && js.includes("attr(project.project_id)"));
const systemStart = html.indexOf('id="page-system"');
const systemEnd = html.indexOf('id="page-activity"');
const systemMarkup = html.slice(systemStart, systemEnd);
ok("system page has no inline handlers or styles", !systemMarkup.includes("onclick=") && !systemMarkup.includes("onchange=") && !systemMarkup.includes("style="));
ok("system controls are wired from a separate controller", html.includes("dashboard-system.js") && systemJs.includes("addEventListener(\"change\""));
const activityStart = html.indexOf('id="page-activity"');
const activityEnd = html.indexOf('id="page-blackbox"');
const activityMarkup = html.slice(activityStart, activityEnd);
ok("activity controls have no inline handlers or styles", !activityMarkup.includes("onclick=") && !activityMarkup.includes("oninput=") && !activityMarkup.includes("onchange=") && !activityMarkup.includes("style="));
ok("activity controls are wired from a focused controller", html.includes("dashboard-activity.js") && activityJs.includes("data-activity-filter") && activityJs.includes("addEventListener"));
console.log("Dashboard shell tests: passed");
