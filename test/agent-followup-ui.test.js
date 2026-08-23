"use strict";

// UI tests for the Agent tab follow-up controls. The dashboard frontend is a
// plain browser script loaded via <script src>, and the repo has no DOM test
// harness (jsdom); per the repo convention (see static-code-quality.test.js)
// frontend behavior is asserted against the served source. Each assertion maps
// to a required UI behavior. This intentionally avoids adding a UI framework.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const clientJs = fs.readFileSync(path.join(__dirname, "..", "static", "dashboard.js"), "utf-8");
const dashHtml = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf-8");
const dashServer = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.js"), "utf-8");

console.log("Running Agent tab follow-up UI tests...\n");

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

ok("submitFollowup + streamAgentTask + openFollowup functions exist", () => {
  assert.match(clientJs, /function submitFollowup\(/);
  assert.match(clientJs, /function streamAgentTask\(/);
  assert.match(clientJs, /function openFollowup\(/);
});

ok("submission calls the canonical follow-up endpoint", () => {
  const body = fnBody(clientJs, "submitFollowup");
  assert.match(body, /'\/api\/agent\/run\/'\s*\+\s*id\s*\+\s*'\/follow-up'/, "posts to /api/agent/run/:id/follow-up");
  assert.match(body, /method:\s*'POST'/);
  assert.match(body, /JSON\.stringify\(\{\s*goal\s*\}\)/, "sends the goal");
});

ok("duplicate submission is prevented (guard + disable while pending)", () => {
  const body = fnBody(clientJs, "submitFollowup");
  assert.match(body, /if\s*\(agentRunning\)\s*return/, "guards against a concurrent run");
  assert.match(body, /btn\.disabled\s*=\s*true/, "disables the submit button while pending");
  assert.match(body, /input\.disabled\s*=\s*true/, "disables the input while pending");
});

ok("the child task becomes selected and is streamed", () => {
  const submit = fnBody(clientJs, "submitFollowup");
  assert.match(submit, /streamAgentTask\(data\.taskId/, "streams the returned child task");
  const stream = fnBody(clientJs, "streamAgentTask");
  assert.match(stream, /currentAgentTaskId\s*=\s*taskId/, "selects the child task");
  assert.match(stream, /new EventSource\('\/api\/agent\/stream\/'\s*\+\s*taskId\)/, "uses the existing SSE endpoint");
  assert.match(stream, /msg\.type === 'lineage'/, "renders the follow-up lineage event");
});

ok("Agent task selection survives tab changes and page reloads", () => {
  assert.ok(clientJs.includes("const AGENT_LAST_TASK_KEY = 'sidekick_agent_last_task_id'"), "uses a dedicated persisted task pointer");
  assert.match(clientJs, /function rememberAgentTask\(/, "persists the selected task");
  assert.ok(clientJs.includes("localStorage.setItem(AGENT_LAST_TASK_KEY, taskId)"), "stores the task id locally");
  const showPage = fnBody(clientJs, "showPage");
  assert.match(showPage, /name === 'agent'\)\s*restoreAgentState\(\)/, "restores when the Agent page is selected");
  const restore = fnBody(clientJs, "restoreAgentState");
  assert.match(restore, /\/api\/agent\/run\/' \+ encodeURIComponent\(taskId\)/, "loads the durable transcript");
  assert.match(restore, /streamAgentTask\(taskId, \{ reset: false, reconnect: true \}\)/, "reconnects active tasks");
  assert.match(clientJs, /function renderAgentTranscript\(/, "renders completed transcript steps in the Agent log");
});

ok("parent/root metadata renders in detail and history", () => {
  const detail = fnBody(clientJs, "toggleRunDetail");
  assert.match(detail, /run\.parent_task_id/, "detail reads parent lineage");
  assert.match(detail, /Thread root/, "detail shows the thread root");
  assert.match(detail, /Follow-up to/, "detail labels a follow-up");
  const hist = fnBody(clientJs, "toggleHistory");
  assert.match(hist, /r\.parentTaskId/, "history row reads parent lineage");
  assert.match(hist, /follow-up of/, "history row labels follow-ups");
});

ok("follow-up controls are rendered for terminal history tasks (the only ones listed)", () => {
  const hist = fnBody(clientJs, "toggleHistory");
  assert.match(hist, /data-action="followup"/, "history rows expose a Follow up action");
  const detail = fnBody(clientJs, "toggleRunDetail");
  assert.match(detail, /followup-input-/, "detail renders a follow-up input");
  assert.match(detail, /data-action="followup-submit"/, "detail renders a follow-up submit");
});

ok("follow-up controls are accessible (labels / aria)", () => {
  const hist = fnBody(clientJs, "toggleHistory");
  assert.match(hist, /aria-label="Follow up on task/, "follow-up button has an accessible label");
  const detail = fnBody(clientJs, "toggleRunDetail");
  assert.match(detail, /<label for="followup-input-/, "follow-up input has a label");
  assert.match(detail, /aria-label="Follow-up goal for task/, "follow-up input has an accessible label");
});

ok("API errors render safely (escaped, not injected)", () => {
  const body = fnBody(clientJs, "submitFollowup");
  assert.match(body, /agent-err/, "errors render in the error style");
  assert.match(body, /esc\(\s*\(data && data\.error\)/, "error text is HTML-escaped");
  assert.match(body, /apiError\(/, "errors are reported to the error handler");
});

ok("old tasks without lineage still render (parent lineage is optional)", () => {
  const hist = fnBody(clientJs, "toggleHistory");
  // The follow-up-of label is conditional on parentTaskId, so a root/old task
  // (parentTaskId null) renders without it.
  assert.match(hist, /r\.parentTaskId\s*\?/, "history conditionally renders parent label");
  const detail = fnBody(clientJs, "toggleRunDetail");
  assert.match(detail, /if\s*\(run\.parent_task_id\)/, "detail conditionally renders lineage");
});

ok("wiring: followup actions are dispatched from the delegated handlers", () => {
  assert.match(clientJs, /action === 'followup'\)\s*openFollowup\(id\)/, "history handler wires followup");
  assert.match(clientJs, /action === 'followup-submit'\)\s*submitFollowup\(did\)/, "detail handler wires submit");
});

ok("dashboard server proxies the follow-up endpoint to the agent bridge", () => {
  assert.match(dashServer, /app\.post\("\/api\/agent\/run\/:taskId\/follow-up"/, "proxy route exists");
});

ok("control room exposes typed governed continuation actions", () => {
  assert.match(dashHtml, /id="agentDurableContinuationActions"/, "control-room action region exists");
  const detail = fnBody(clientJs, "loadDurableAgentTask");
  assert.match(detail, /agentDurableContinuationActions/, "durable projection renders the action region");
  assert.match(detail, /investigate.*Investigate finding/, "investigation action is rendered");
  assert.match(detail, /verify.*Verify claim/, "verification action is rendered");
  assert.match(detail, /repair.*Repair failure/, "repair action is rendered");
  assert.match(detail, /implement.*Implement recommendation/, "implementation action is rendered");
  assert.match(detail, /apply.*Apply approved proposal/, "approved-proposal action is rendered");
  assert.match(detail, /monitor.*Monitor condition/, "monitor action is rendered");
  assert.match(detail, /recheck.*Recheck condition/, "recheck action is rendered");
  const action = fnBody(clientJs, "startAgentContinuation");
  assert.match(action, /\/api\/agent\/tasks\/.*\/act-on/, "typed continuation uses the governed act-on endpoint");
  assert.match(action, /JSON\.stringify\(\{ kind \}\)/, "only the structured continuation kind is submitted");
  assert.match(action, /streamAgentTask\(data\.taskId/, "returned child task is selected and streamed");
  assert.match(dashServer, /app\.post\("\/api\/agent\/tasks\/:taskId\/act-on"/, "Dashboard proxies act-on");
});

ok("durable control room renders bounded resources, work, evidence, and plan gates", () => {
  const detail = fnBody(clientJs, "loadDurableAgentTask");
  assert.match(detail, /Resources used\/remaining/, "resource usage includes remaining allowance");
  assert.match(detail, /verification_calls/, "resource usage includes verification calls");
  assert.match(detail, /fresh independent/, "verification distinguishes fresh independent evidence");
  assert.match(detail, /freshness_ms/, "Dashboard applies the durable recipe freshness window");
  assert.match(detail, /failed=/, "evidence reports failed outcomes");
  assert.match(detail, /milestones:/, "plan projection renders milestone state");
  assert.match(detail, /verification gates:/, "plan projection renders verification gates");
  assert.match(detail, /packages=.*active/, "work-package projection renders active work");
});

ok("existing Agent tab anchors are preserved (no dashboard redesign)", () => {
  assert.match(dashHtml, /id="agentGoal"/);
  assert.match(dashHtml, /id="agentLog"/);
  assert.match(dashHtml, /id="agentHistory"/);
  assert.match(dashHtml, /id="agentHistoryToggle"[^>]*type="button"/);
  assert.match(dashHtml, /aria-expanded="false"/);
  assert.match(dashHtml, /aria-controls="agentHistory"/);
  assert.match(clientJs, /function runAgent\(/, "the normal new-task flow is preserved");
});

ok("history control exposes and updates real expanded state", () => {
  const body = fnBody(clientJs, "toggleHistory");
  assert.match(body, /agentHistoryToggle/, "uses the semantic history button");
  assert.match(body, /setAttribute\('aria-expanded', String\(expanded\)\)/, "updates expanded state");
  assert.match(body, /agentHistoryChevron/, "updates the visible chevron");
});

ok("history control is wired to its real toggle handler", () => {
  assert.match(dashHtml, /id="agentHistoryToggle"[^>]*onclick="toggleHistory\(\)"/, "button invokes toggleHistory");
});

console.log("\nAll " + passed + " follow-up UI tests passed.\n");
