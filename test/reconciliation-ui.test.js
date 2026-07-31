"use strict";

// UI tests for the reconciliation surface on the Approvals page. The dashboard
// frontend is a plain browser script loaded via <script src> and the repo has
// no DOM harness (jsdom); per the repo convention (see agent-followup-ui.test.js
// and tool-summary-cards.test.js) frontend behavior is asserted against the
// served source.
//
// What these guard, specifically:
//
//   1. The section is wired by element id across two files. An id renamed in
//      one and not the other fails SILENTLY at runtime — the section simply
//      never appears — which for this surface means an ambiguous high-risk
//      execution sits unresolved with nothing telling anyone it is there.
//   2. The four permitted decisions must match the server's closed vocabulary
//      exactly (docs/adr-approval-continuation.md §8.2). A typo here produces a
//      button that always 400s.
//   3. `confirm_not_executed` re-runs a high-risk tool. It must carry an
//      explicit confirmation, because asserting an effect did not land when it
//      did produces precisely the double-execution the risk gate exists to
//      prevent — audited, but not verifiable.
//   4. Task ids and approval ids reach attribute and JS-string contexts, where
//      esc() is the wrong escaper: it handles & < > but NOT quotes.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const clientJs = fs.readFileSync(path.join(__dirname, "..", "static", "dashboard.js"), "utf-8");
const dashHtml = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf-8");
const serverJs = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.js"), "utf-8");
const vocabulary = require("../src/approvals/vocabulary");

console.log("Running reconciliation UI tests...\n");

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log("  ok - " + name); }
  catch (e) { console.error("  FAIL - " + name); console.error("    " + (e && e.stack ? e.stack : e)); process.exit(1); }
}

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

// ---------------------------------------------------------------------------
// Wiring across files
// ---------------------------------------------------------------------------

ok("every element id the client reads exists in the markup", () => {
  for (const id of ["reconciliationSection", "reconciliationCount", "reconciliationList"]) {
    assert.ok(clientJs.includes("'" + id + "'"), "client should reference " + id);
    assert.ok(dashHtml.includes('id="' + id + '"'), "markup should define " + id);
  }
});

ok("the reconciliation section lives on the Approvals page", () => {
  const page = dashHtml.slice(dashHtml.indexOf('id="page-approvals"'), dashHtml.indexOf('id="page-database"'));
  assert.ok(page.includes('id="reconciliationSection"'), "section must be inside the approvals page");
});

ok("opening the Approvals tab loads reconciliations as well as approvals", () => {
  // A section nobody loads is a section nobody sees.
  assert.ok(
    /name === 'approvals'\)\s*\{[^}]*loadReconciliations\(\)/.test(clientJs),
    "the approvals tab handler must call loadReconciliations()"
  );
});

ok("the section is hidden when there is nothing to decide", () => {
  const body = fnBody(clientJs, "loadReconciliations");
  assert.ok(/section\.style\.display\s*=\s*items\.length\s*\?\s*'block'\s*:\s*'none'/.test(body),
    "an alarming section must not be permanent furniture");
});

// ---------------------------------------------------------------------------
// The decision vocabulary must match the server
// ---------------------------------------------------------------------------

ok("the four offered decisions match the server's closed vocabulary exactly", () => {
  const block = clientJs.slice(clientJs.indexOf("var RECONCILIATION_DECISIONS"));
  const offered = [...block.slice(0, block.indexOf("];")).matchAll(/id:\s*'([a-z_]+)'/g)].map(m => m[1]);
  assert.deepStrictEqual(
    offered.slice().sort(),
    vocabulary.RECONCILIATION_DECISIONS.slice().sort(),
    "UI decisions must equal src/approvals/vocabulary.js RECONCILIATION_DECISIONS"
  );
  assert.strictEqual(offered.length, 4, "exactly four decisions are permitted (ADR §8.2)");
});

ok("resolveReconciliation refuses an unknown decision rather than posting it", () => {
  const body = fnBody(clientJs, "resolveReconciliation");
  assert.ok(/if\s*\(!dec\)\s*return;/.test(body), "must bail on an unrecognised decision");
});

// ---------------------------------------------------------------------------
// The dangerous decision
// ---------------------------------------------------------------------------

ok("confirm_not_executed carries an explicit confirmation naming the risk", () => {
  const block = clientJs.slice(clientJs.indexOf("id: 'confirm_not_executed'"));
  const entry = block.slice(0, block.indexOf("},"));
  assert.ok(/confirm:\s*'/.test(entry), "confirm_not_executed must require confirmation");
  assert.ok(/twice/i.test(entry), "the confirmation must say the effect can happen twice");
});

ok("the confirmation is actually honoured before the request is sent", () => {
  const body = fnBody(clientJs, "resolveReconciliation");
  const confirmAt = body.indexOf("dec.confirm");
  const fetchAt = body.indexOf("authFetch");
  assert.ok(confirmAt >= 0 && fetchAt >= 0 && confirmAt < fetchAt,
    "the confirm gate must precede the request, not follow it");
  assert.ok(/if\s*\(dec\.confirm\s*&&\s*!confirm\(dec\.confirm\)\)\s*return;/.test(body),
    "declining the confirmation must abort");
});

ok("only confirm_not_executed re-runs the tool, and says so", () => {
  const block = clientJs.slice(clientJs.indexOf("var RECONCILIATION_DECISIONS"));
  const list = block.slice(0, block.indexOf("];"));
  const rerunMentions = (list.match(/re-runs the tool|dispatches the step ONCE more/g) || []).length;
  assert.ok(rerunMentions >= 1, "the redispatching decision must state that it redispatches");
  const executedEntry = list.slice(list.indexOf("id: 'confirm_executed'"), list.indexOf("id: 'confirm_not_executed'"));
  assert.ok(/not run again/i.test(executedEntry), "confirm_executed must state the tool is NOT re-run");
});

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

ok("ids reaching attribute and JS-string contexts use attr()/jsArg(), never esc()", () => {
  const body = fnBody(clientJs, "loadReconciliations");
  // esc() escapes & < > but not quotes, so it cannot safely close an attribute
  // or a JS string literal.
  assert.ok(!/onclick="[^"]*esc\(/.test(body), "esc() must not be used inside an onclick handler");
  assert.ok(!/id="[^"]*'\s*\+\s*esc\(/.test(body), "esc() must not be used to build an id attribute");
  assert.ok(/onclick="resolveReconciliation\(' \+ jsArg\(r\.task_id\)/.test(body),
    "task id must reach the handler through jsArg()");
  assert.ok(/id="approval-args-' \+ attr\(r\.approval_id\)/.test(body),
    "approval id must reach the id attribute through attr()");
});

ok("the decision tooltip is attribute-escaped", () => {
  const body = fnBody(clientJs, "loadReconciliations");
  assert.ok(/title="' \+ attr\(dec\.meaning\)/.test(body), "tooltip text must use attr()");
});

// ---------------------------------------------------------------------------
// Fail-closed behaviour surfaced to the operator
// ---------------------------------------------------------------------------

ok("without an authenticated principal the UI explains instead of offering buttons", () => {
  const body = fnBody(clientJs, "loadReconciliations");
  assert.ok(/d\.can_resolve/.test(body), "must branch on the server's can_resolve signal");
  assert.ok(/authenticated principal/i.test(body),
    "must explain that reconciliation requires an authenticated principal");
  // Buttons that are guaranteed to 403 are worse than no buttons.
  const buttonAssign = body.slice(body.indexOf("var buttons"), body.indexOf("return '<div class=\"approval-entry\""));
  assert.ok(buttonAssign.includes("?") && buttonAssign.includes(":"),
    "buttons must be conditional on can_resolve");
});

ok("the server supplies can_resolve and preview availability", () => {
  const route = serverJs.slice(serverJs.indexOf('app.get("/api/reconciliations"'), serverJs.indexOf('app.post("/api/reconciliations'));
  assert.ok(/can_resolve:\s*Boolean\(authenticatedUser\(req\)\)/.test(route),
    "the list route must report whether the caller may resolve");
  assert.ok(/args_preview_available:\s*Boolean\(r\.args_encrypted\)/.test(route),
    "preview availability must reflect whether the payload still exists");
});

ok("a discarded payload is explained rather than offering a control that fails", () => {
  const body = fnBody(clientJs, "loadReconciliations");
  assert.ok(/args_preview_available/.test(body), "must branch on preview availability");
  assert.ok(/no longer available/i.test(body), "must say so when arguments cannot be shown");
});

// ---------------------------------------------------------------------------
// Context the decider needs
// ---------------------------------------------------------------------------

ok("each entry shows what is needed to investigate", () => {
  const body = fnBody(clientJs, "loadReconciliations");
  for (const field of ["tool_name", "task_id", "step_id", "attempt_count", "approver_identity", "args_digest"]) {
    assert.ok(body.includes("r." + field), "entry should surface " + field);
  }
});

ok("the section explains that the outcome is genuinely unknown", () => {
  const page = dashHtml.slice(dashHtml.indexOf('id="reconciliationSection"'), dashHtml.indexOf("</div>\n</div>", dashHtml.indexOf('id="reconciliationSection"')) + 40);
  assert.ok(/unknown/i.test(page), "the operator must be told the outcome is unknown, not merely pending");
});

ok("resolving refreshes the approval inbox too", () => {
  // A resolved reconciliation changes approval status, so a stale inbox beside
  // a refreshed reconciliation list would contradict itself.
  const body = fnBody(clientJs, "resolveReconciliation");
  assert.ok(/loadReconciliations\(\)/.test(body) && /loadApprovals\(\)/.test(body),
    "both lists must refresh after a decision");
});

console.log("\n" + passed + " reconciliation UI tests passed.");
