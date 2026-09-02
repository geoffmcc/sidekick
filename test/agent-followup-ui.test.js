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
const dashServer = [
  fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.js"), "utf-8"),
  fs.readFileSync(path.join(__dirname, "..", "src", "dashboard", "agent-proxy-routes.js"), "utf-8"),
].join("\n");
const agentServer = fs.readFileSync(path.join(__dirname, "..", "src", "agent.js"), "utf-8");

console.log("Running Agent tab follow-up UI tests...\n");

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log("  ok - " + name); }
  catch (e) { console.error("  FAIL - " + name); console.error("    " + (e && e.stack ? e.stack : e)); process.exit(1); }
}

// Slice out a named function body for scoped assertions.
function fnBody(src, name) {
  // Agent v2 is the authoritative implementation; select the last definition
  // so these source-level checks cannot accidentally exercise a legacy helper.
  const start = src.lastIndexOf("function " + name + "(");
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
  assert.match(body, /if\s*\(agentRunning\s*\|\|\s*agentSubmissionPending/, "guards against a concurrent run");
  assert.match(body, /agentFollowupGo.*disabled\s*=\s*true/, "disables the submit button while pending");
  assert.match(body, /input\.disabled\s*=\s*true/, "disables the input while pending");
});

ok("the child task becomes selected and is streamed", () => {
  const submit = fnBody(clientJs, "submitFollowup");
  assert.match(submit, /streamAgentTask\(data\.taskId/, "streams the returned child task");
  const stream = fnBody(clientJs, "streamAgentTask");
  assert.match(stream, /currentAgentTaskId\s*=\s*taskId/, "selects the child task");
  assert.match(stream, /new EventSource\('\/api\/agent\/stream\/'\s*\+\s*encodeURIComponent\(taskId\)\)/, "uses the existing SSE endpoint");
  assert.match(stream, /encodeURIComponent\(taskId\)/, "encodes the streamed task id");
});

ok("Agent task selection survives tab changes and page reloads", () => {
  assert.ok(clientJs.includes("const AGENT_LAST_TASK_KEY = 'sidekick_agent_last_task_id'"), "uses a dedicated persisted task pointer");
  assert.match(clientJs, /function rememberAgentTask\(/, "persists the selected task");
  assert.ok(clientJs.includes("localStorage.setItem(AGENT_LAST_TASK_KEY, taskId)"), "stores the task id locally");
  const showPage = fnBody(clientJs, "showPage");
  assert.match(showPage, /name === 'agent'\)\s*restoreAgentState\(\)/, "restores when the Agent page is selected");
  const restore = fnBody(clientJs, "restoreAgentState");
  assert.match(restore, /\/api\/agent\/run\/'\s*\+\s*encodeURIComponent\(task\)/, "loads the durable transcript");
  assert.match(restore, /streamAgentTask\(task,\s*\{\s*reset:\s*false,\s*reconnect:\s*true\s*\}\)/, "reconnects active tasks");
  assert.match(clientJs, /function renderAgentTranscript\(/, "renders completed transcript steps in the Agent log");
});

ok("parent/root metadata renders in detail and history", () => {
  const detail = fnBody(clientJs, "toggleRunDetail");
  assert.match(detail, /run\.parent_task_id/, "detail reads parent lineage");
  assert.match(detail, /Thread root/, "detail shows the thread root");
  assert.match(detail, /Follow-up to/, "detail labels a follow-up");
  const session = fnBody(clientJs, "renderAgentSession");
  assert.match(session, /session\.rootTaskId/, "session history retains the thread root");
});

ok("follow-up controls are rendered for terminal session tasks", () => {
  const session = fnBody(clientJs, "renderAgentSession");
  assert.match(session, /agentFollowupArea/, "session renders the follow-up area state");
  assert.match(session, /canFollowAgent\(leaf\.status\)/, "follow-up is limited to terminal tasks");
  const detail = fnBody(clientJs, "toggleRunDetail");
  assert.match(detail, /followup-input-/, "detail renders a follow-up input");
  assert.match(detail, /data-action="followup-submit"/, "detail renders a follow-up submit");
});

ok("follow-up controls are accessible (labels / aria)", () => {
  const session = fnBody(clientJs, "renderAgentSession");
  assert.match(dashHtml, /<label for="agentFollowupGoal">Ask a follow-up<\/label>/, "session follow-up input has an accessible label");
  assert.match(session, /agentFollowupArea/, "session renders the accessible follow-up area");
  const detail = fnBody(clientJs, "toggleRunDetail");
  assert.match(detail, /<label for="followup-input-/, "follow-up input has a label");
  assert.match(detail, /aria-label="Follow-up goal for task/, "follow-up input has an accessible label");
});

ok("API errors render safely (escaped, not injected)", () => {
  const body = fnBody(clientJs, "submitFollowup");
  assert.match(body, /agent-err/, "errors render in the error style");
  assert.match(body, /esc\(e\.message\)/, "error text is HTML-escaped");
});

ok("old tasks without lineage still render (parent lineage is optional)", () => {
  const session = fnBody(clientJs, "renderAgentSession");
  assert.match(session, /turn\.goal \|\| ''/, "session renders turns without lineage");
  const detail = fnBody(clientJs, "toggleRunDetail");
  assert.match(detail, /if\s*\(run\.parent_task_id\)/, "detail conditionally renders lineage");
});

ok("wiring: followup actions are dispatched from the delegated handlers", () => {
  const controls = fs.readFileSync(path.join(__dirname, "..", "static", "dashboard-controls.js"), "utf-8");
  assert.match(controls, /control\.dataset\.handler === "submitFollowup"\) return invoke\("submitFollowup", id \|\| undefined\)/, "delegated Agent controls wire follow-up submission");
  assert.match(clientJs, /action === 'followup-submit'\) submitFollowup\(did\)/, "dynamically rendered detail wires submit");
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

ok("new Agent tasks submit an explicit project scope", () => {
  assert.match(dashHtml, /id="agentProject"/, "project scope input exists");
  assert.ok(clientJs.includes("const project = (($('agentProject')"), "run reads project scope");
  assert.ok(clientJs.includes("project ? { project }"), "run sends project scope when provided");
  assert.match(agentServer, /"project"/, "agent server accepts project scope");
});

ok("Handoff cards distinguish lifecycle from receiver readiness", () => {
  assert.match(clientJs, /Authoritative handoff lifecycle/, "lifecycle status is explicitly identified");
  assert.match(clientJs, /Receiver resume readiness/, "readiness status is explicitly identified");
  assert.ok(clientJs.includes("Readiness: ' + esc(readinessStatus)"), "readiness is rendered separately from lifecycle");
});

ok("history control exposes and updates real expanded state", () => {
  const body = fnBody(clientJs, "toggleHistory");
  assert.match(body, /agentHistoryToggle/, "uses the semantic history button");
  assert.match(body, /setAttribute\('aria-expanded', String\(expanded\)\)/, "updates expanded state");
  assert.match(body, /agentHistoryChevron/, "updates the visible chevron");
});

ok("history control is wired to its real toggle handler", () => {
  assert.match(dashHtml, /id="agentHistoryToggle"[^>]*data-dashboard-action="agent"[^>]*data-handler="toggleHistory"/, "button delegates to toggleHistory");
});

console.log("\nAll " + passed + " follow-up UI tests passed.\n");
