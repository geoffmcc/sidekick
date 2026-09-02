"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "dashboard.html"), "utf8");
const css = fs.readFileSync(path.join(root, "static", "dashboard.css"), "utf8");
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
ok("unknown health is represented distinctly", html.includes('class="status-dot unknown"') && css.includes(".status-dot.unknown"));
ok("command palette is keyboard discoverable", html.includes('id="commandDialog"') && js.includes("event.key.toLowerCase() === 'k'"));
ok("project records use escaped rendering", js.includes("esc(project)") && js.includes("attr(project)"));
console.log("Dashboard shell tests: passed");
