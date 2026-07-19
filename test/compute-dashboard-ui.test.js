"use strict";

// UI tests for the Compute tab. The dashboard frontend is a plain browser
// script loaded via <script src>, and the repo has no DOM test harness (jsdom);
// per the repo convention (see agent-followup-ui.test.js and
// static-code-quality.test.js) frontend behavior is asserted against the served
// source. Each assertion maps to a defect that shipped to the Compute tab:
// counts with no labels, a truncation notice with nothing to expand, job fields
// read under names the API never returns, and action buttons offered for states
// the server rejects.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const clientJs = fs.readFileSync(path.join(root, "static", "dashboard.js"), "utf-8");
const clientCss = fs.readFileSync(path.join(root, "static", "dashboard.css"), "utf-8");
const dashHtml = fs.readFileSync(path.join(root, "src", "dashboard.html"), "utf-8");
const { JOB_STATES, JOB_TERMINAL_STATES } = require("../src/compute/errors");

console.log("Running Compute tab UI tests...\n");

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

// Strip `//` comments so assertions about emitted output are not satisfied — or
// broken — by prose in a comment that quotes the very string under test.
function stripComments(src) {
  return src.replace(/^\s*\/\/.*$/gm, "");
}

// Read a client-side array literal such as `const JOB_TERMINAL_STATES = [...]`.
function clientArray(name) {
  const m = clientJs.match(new RegExp("const " + name + "\\s*=\\s*\\[([^\\]]*)\\]"));
  assert.ok(m, "expected client constant " + name);
  return m[1].split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

// ── Truncation must always come with a way to expand ──

ok("renderStructuredValue delegates to the expandable renderer when truncating", () => {
  const body = fnBody(clientJs, "renderStructuredValue");
  assert.match(body, /renderExpandableValue\(value,\s*opts\)/,
    "truncated values must route through the renderer that provides a toggle");
  assert.ok(!/expand to view all/.test(stripComments(body)),
    "must not print an expand affordance that does not exist");
});

ok("no dead-end truncation notice remains anywhere in the client", () => {
  assert.ok(!/truncated, expand to view all/.test(stripComments(clientJs)),
    "the old dead-end truncation message must be gone");
});

ok("toggleExpandable sets an explicit display value", () => {
  const body = fnBody(clientJs, "toggleExpandable");
  assert.match(body, /full\.style\.display\s*=\s*'block'/,
    "clearing the inline style would lose to .expandable-full{display:none} and re-hide the block");
  assert.match(clientCss, /\.expandable-full\{display:none\}/,
    "this test is only meaningful while the stylesheet hides .expandable-full");
});

// ── Metrics must say what they are counting ──

ok("compute summary labels providers and executors by name", () => {
  const body = fnBody(clientJs, "loadComputeOverview");
  assert.match(body, /Inference providers/, "providers metric is labelled");
  assert.match(body, /Job executors/, "executors metric is labelled");
  assert.match(body, /providers\.names/, "provider names are shown, not just a count");
  assert.match(body, /o\.executorNames/, "executor names are shown, not just a count");
});

ok("metric() accepts and renders a tooltip", () => {
  const body = fnBody(clientJs, "metric");
  assert.match(body, /function metric\(label, value, detail, title\)/, "takes a title argument");
  assert.match(body, /title="/, "renders it as a title attribute");
});

// ── Job detail must read the field names the API actually returns ──

ok("job detail reads the API's own field names", () => {
  const body = stripComments(fnBody(clientJs, "showComputeJob"));
  assert.match(body, /j\.result\b/, "result is exposed as `result`, not `result_json`");
  assert.match(body, /j\.selectedWorkerId/, "worker is exposed as `selectedWorkerId`");
  assert.match(body, /j\.selectedModelId/, "model is exposed as `selectedModelId`");
  assert.ok(!/if\s*\(j\.result_json\)/.test(body), "must not gate the Result section on a field that never exists");
  assert.ok(!/j\.lastError/.test(body), "must not gate metadata on a field that never exists");
});

ok("job detail metadata is not gated behind a nonexistent error field", () => {
  const body = fnBody(clientJs, "showComputeJob");
  assert.match(body, /if\s*\(Object\.keys\(meta\)\.length\)/,
    "metadata shows whenever any field is present, so lease and timing data is not hidden on failed jobs");
  assert.match(body, /meta\.leaseExpiresAt/, "lease expiry is part of the metadata");
  assert.match(body, /meta\.errorMessage/, "the real error field is surfaced");
});

// ── Action buttons must match what the server will accept ──

ok("client terminal states mirror the server's JOB_TERMINAL_STATES", () => {
  const client = clientArray("JOB_TERMINAL_STATES").slice().sort();
  const server = Array.from(JOB_TERMINAL_STATES).slice().sort();
  assert.deepStrictEqual(client, server,
    "Cancel is offered for every non-terminal state; drift means offering a cancel that silently no-ops");
});

ok("client retryable states mirror the server's retry guard", () => {
  const jobManager = fs.readFileSync(path.join(root, "src", "compute", "job-manager.js"), "utf-8");
  const m = jobManager.match(/if\s*\(!\[([^\]]*)\]\.includes\(job\.status\)\)\s*\{\s*\n\s*throw new JobError\("Job is not retryable"/);
  assert.ok(m, "expected to locate the server-side retry guard");
  const server = m[1].split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean).sort();
  const client = clientArray("JOB_RETRYABLE_STATES").slice().sort();
  assert.deepStrictEqual(client, server,
    "drift means hiding Retry on jobs the server would happily retry");
});

ok("terminal failure states are coloured as failures", () => {
  const body = fnBody(clientJs, "computeJobStatusClass");
  for (const state of ["failed", "cancelled", "expired", "dead_letter"]) {
    assert.ok(body.includes("'" + state + "'"), state + " must be treated as a failure, not as in-progress");
  }
  assert.match(body, /return 'danger'/);
});

ok("cancel reports the resulting status instead of assuming success", () => {
  const body = fnBody(clientJs, "computeJobAction");
  assert.match(body, /d\.job && d\.job\.status/, "reads the job the endpoint returns");
  assert.match(body, /nothing to cancel/, "says so when the job was already terminal");
});

// ── Filters, counts, staleness ──

ok("the job status filter covers every server-side job state", () => {
  for (const state of JOB_STATES) {
    assert.ok(
      dashHtml.includes('<option value="' + state + '">'),
      "job status filter is missing '" + state + "' — that state would be untriageable from the dashboard"
    );
  }
});

ok("the job count reflects the total, not the page size", () => {
  const body = fnBody(clientJs, "loadComputeJobs");
  assert.match(body, /d\.stats/, "uses the total the API already returns");
  assert.ok(!/computeJobCount'\)\.textContent = jobs\.length/.test(body),
    "must not report the capped page length as the total");
});

ok("the empty state distinguishes 'no jobs' from 'filter matched nothing'", () => {
  const body = fnBody(clientJs, "loadComputeJobs");
  assert.match(body, /No compute jobs have been submitted yet/);
  assert.match(body, /No jobs match this filter/);
});

ok("the compute tab participates in the polled refresh", () => {
  const body = fnBody(clientJs, "refresh");
  assert.match(body, /currentPage !== 'compute'/, "compute is not excluded from the refresh loop");
  assert.match(body, /refreshCompute\(\)/, "compute has its own refresh path");
  const refreshCompute = fnBody(clientJs, "refreshCompute");
  assert.match(refreshCompute, /details\[open\]/,
    "worker rows must not be re-rendered while a detail panel is open, or it collapses under the reader");
  assert.match(dashHtml, /id="computeLastUpdate"/, "the tab shows when it last updated");
});

// ── Enrollment ──

ok("enrollment guards against double submission and offers a copy button", () => {
  const body = fnBody(clientJs, "createComputeEnrollment");
  assert.match(body, /if\s*\(computeEnrollmentPending\)\s*return/,
    "each click mints a distinct single-use token, so a double-click burns one");
  assert.match(body, /computeEnrollmentPending = true/);
  assert.match(body, /\.finally\(/, "the guard is released even when the request fails");
  // The handler is emitted inside a single-quoted JS string, so the quotes are escaped.
  assert.match(body, /copyElementText\(\\?'computeEnrollTokenValue/,
    "the one-time secret is too long to hand-select reliably");
  assert.match(clientJs, /function copyElementText\(/);
});

// ── Formatting ──

ok("formatBytes is defined exactly once and handles GB and above", () => {
  const defs = clientJs.match(/^function formatBytes\(/gm) || [];
  assert.strictEqual(defs.length, 1,
    "duplicate declarations hoist, so the last one silently wins for every caller");
  const body = fnBody(clientJs, "formatBytes");
  assert.match(body, /'TB'/, "artifact and model sizes exceed MB");
});

// ── Layout ──

ok("the compute layout collapses before its columns overflow", () => {
  const m = clientCss.match(/\.compute-layout\{display:grid;grid-template-columns:minmax\((\d+)px,[^)]*\) minmax\((\d+)px,[^)]*\);gap:(\d+)px/);
  assert.ok(m, "expected the .compute-layout grid definition");
  const minWidth = Number(m[1]) + Number(m[2]) + Number(m[3]);
  const breakpoint = 720;
  assert.ok(minWidth <= breakpoint,
    "columns need " + minWidth + "px but the layout only collapses at " + breakpoint +
    "px, so viewports in between scroll horizontally");
});

console.log("\nCompute tab UI: " + passed + " passed, 0 failed, " + passed + " total");
