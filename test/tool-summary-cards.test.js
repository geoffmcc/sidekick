"use strict";

// UI tests for the Tools page summary cards. The dashboard frontend is a plain
// browser script loaded via <script src>, and the repo has no DOM test harness
// (jsdom); per the repo convention (see agent-followup-ui.test.js) frontend
// behavior is asserted against the served source.
//
// The specific regression these guard: the summary cards are wired by element
// id across two files, so an id renamed in one file and not the other fails
// silently at runtime (the card renders its static "0" forever) rather than
// throwing. "Approvals Required" (pending inbox requests) and "Tools Requiring
// Approval" (policy-gated tools in the catalog) are separate counts that read
// alike, so the assertions below pin each card to its intended source.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const clientJs = fs.readFileSync(path.join(__dirname, "..", "static", "dashboard.js"), "utf-8");
const dashHtml = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf-8");

console.log("Running Tools page summary card tests...\n");

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log("  ok - " + name); }
  catch (e) { console.error("  FAIL - " + name); console.error("    " + (e && e.stack ? e.stack : e)); process.exit(1); }
}

// Slice out a named function body for scoped assertions.
function fnBody(src, name) {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, "expected function " + name + " to exist");
  let depth = 0, i = src.indexOf("{", start), started = false;
  for (; i < src.length; i++) {
    if (src[i] === "{") { depth++; started = true; }
    else if (src[i] === "}") { depth--; if (started && depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error("could not extract body of " + name);
}

function countOccurrences(src, needle) {
  return src.split(needle).length - 1;
}

const CARD_IDS = [
  "toolSummaryVisible",
  "toolSummaryBlocked",
  "toolSummaryApproval",
  "toolSummaryHighRisk",
  "toolSummaryApprovalGated",
];

ok("every summary card id is declared exactly once in the dashboard markup", () => {
  for (const id of CARD_IDS) {
    assert.strictEqual(
      countOccurrences(dashHtml, 'id="' + id + '"'), 1,
      id + " must be declared exactly once in dashboard.html"
    );
  }
});

ok("every summary card id declared in markup is populated by the client", () => {
  // This is the pairing that fails silently if either side is renamed alone.
  const body = fnBody(clientJs, "updateToolSummary");
  for (const id of CARD_IDS) {
    assert.ok(
      body.includes("$('" + id + "')"),
      id + " must be written by updateToolSummary"
    );
  }
});

ok("card labels convey the pending-vs-gated distinction", () => {
  assert.match(dashHtml, /Approvals Required/, "pending inbox card label");
  assert.match(dashHtml, /Tools Requiring Approval/, "policy-gated tools card label");
});

ok("the gated card counts tools whose policy requires approval", () => {
  const body = fnBody(clientJs, "updateToolSummary");
  assert.match(
    body,
    /\$\('toolSummaryApprovalGated'\)\.textContent\s*=\s*tools\.filter\(tool => tool\.approval_required\)\.length/,
    "Tools Requiring Approval counts approval_required tools in the catalog"
  );
});

ok("the approvals card counts pending requests, not catalog tools", () => {
  const body = fnBody(clientJs, "updateToolSummary");
  assert.match(
    body,
    /\$\('toolSummaryApproval'\)\.textContent\s*=\s*pendingApprovalCount/,
    "Approvals Required reads the pending inbox count"
  );
  // The regression being prevented: the pending card must not be re-derived
  // from the filtered catalog, which is what made the old label misleading.
  const approvalLine = body
    .split("\n")
    .find(line => line.includes("$('toolSummaryApproval')"));
  assert.ok(approvalLine, "expected an assignment line for toolSummaryApproval");
  assert.ok(
    !/tools\.filter/.test(approvalLine),
    "Approvals Required must not be derived from the tools array"
  );
});

ok("pending approvals are fetched from the pending-status approvals endpoint", () => {
  const body = fnBody(clientJs, "loadTools");
  assert.match(body, /'\/api\/approvals\?status=pending'/, "queries only pending approvals");
  assert.match(
    body,
    /pendingApprovalCount\s*=\s*\(approvalData\.approvals \|\| \[\]\)\.length/,
    "stores the pending count from the response"
  );
});

ok("a failing approvals fetch degrades one card instead of the whole catalog", () => {
  const body = fnBody(clientJs, "loadTools");
  assert.match(
    body,
    /\/api\/approvals\?status=pending'\)\.then\(r=>r\.json\(\)\)\.catch\(\(\)=>\(\{\}\)\)/,
    "the approvals fetch carries its own catch so Promise.all still resolves"
  );
  assert.match(clientJs, /let pendingApprovalCount = 0;/, "count falls back to a numeric zero");
});

ok("summary cards keep the existing markup and grid (no redesign)", () => {
  // The layout is driven entirely by the shared classes; a fifth card must flow
  // into the existing auto-fit grid rather than introduce bespoke styling.
  assert.strictEqual(
    countOccurrences(dashHtml, 'class="card tool-summary-card"'), CARD_IDS.length,
    "each summary card reuses the shared card markup"
  );
  assert.match(dashHtml, /class="grid tool-summary-grid"/, "cards live in the shared summary grid");
});

ok("the policy filter still offers the approval-gated tool view", () => {
  assert.match(dashHtml, /<option value="approval">Approval Required<\/option>/, "policy filter option preserved");
  const body = fnBody(clientJs, "renderTools");
  assert.match(body, /policyFilter === 'approval'\)\s*filtered = filtered\.filter\(t => t\.approval_required\)/);
});

console.log("\nAll " + passed + " tool summary card tests passed.\n");
