// Execution-node protocol integration: drive the packaged node process against
// a local fixture so authentication, lifecycle outcomes, and response bounds
// are tested across the HTTP/process boundary.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const AGENT = path.join(ROOT, "src", "node", "agent.js");
const placement = require("../src/node/placement");
const { normalizeDescriptor } = require("../src/tools/descriptor");
const { getCanonicalRegistry } = require("../src/tools/canonical-registry");
const developerEntry = require("../packs/developer/modules/developer-tools/entry");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-node-protocol-"));
const workspaceRoot = path.join(fixture, "workspace");
const repositoryRoot = path.join(workspaceRoot, "repo");
const configPath = path.join(fixture, "node.json");
const credentialPath = path.join(fixture, "credential.json");
const token = "enroll_protocol_fixture_token";
const credential = "wksec_protocol_fixture_credential";
const workerId = "wk_protocol_fixture";
const nodeId = "node_protocol_fixture";
const jobs = [];
const requests = [];
let oversizeEnrollment = false;

fs.mkdirSync(repositoryRoot, { recursive: true });
fs.writeFileSync(path.join(repositoryRoot, "result.txt"), "node protocol result\n");
fs.writeFileSync(path.join(repositoryRoot, "package.json"), JSON.stringify({
  name: "node-protocol-fixture",
  scripts: { test: "node -e \"setTimeout(() => {}, 2500)\"" },
}, null, 2));
fs.writeFileSync(configPath, JSON.stringify({
  workspaceRoot,
  workspaceName: "security-research",
  packs: ["developer"],
  permissions: { read: true, write: false, execute: true },
}));
fs.writeFileSync(path.join(fixture, "enrollment-token"), token, { mode: 0o600 });

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function authenticated(req) {
  return req.headers.authorization === `Bearer ${workerId}:${credential}`;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    if (req.url === "/execution-node/enrollment/exchange") {
      if (oversizeEnrollment) return send(res, 200, { credential: "x".repeat(2 * 1024 * 1024 + 1) });
      return send(res, 200, {
        ok: true,
        credential,
        worker: { workerId, nodeId },
      });
    }
    if (!authenticated(req)) return send(res, 401, { ok: false, error: "authentication required" });
    if (req.url === "/execution-node/node/heartbeat") return send(res, 200, { ok: true });
    if (req.url === "/execution-node/node/disconnect") return send(res, 200, { ok: true });
    if (req.url === "/execution-node/node/jobs/claim") {
      const job = jobs.shift() || null;
      return send(res, 200, { ok: true, claimed: Boolean(job), job });
    }
    const match = req.url.match(/^\/execution-node\/node\/jobs\/([^/]+)\/(cancellation|complete|fail|renew)$/);
    if (!match) return send(res, 404, { ok: false, error: "not found" });
    const jobId = decodeURIComponent(match[1]);
    const operation = match[2];
    const parsed = body ? JSON.parse(body) : {};
    const job = requests.jobById?.get(jobId);
    if (operation === "cancellation") return send(res, 200, { ok: true, cancellation: job?.cancelled ? { requested: true } : { requested: false } });
    if (operation === "renew") return send(res, 200, { ok: true, job });
    if (operation === "complete") {
      job.outcome = { type: "complete", payload: parsed };
      return send(res, 200, { ok: true });
    }
    job.outcome = { type: "fail", payload: parsed };
    return send(res, 200, { ok: true });
  });
});

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitFor(predicate, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function startNode(port, command = "run") {
  const child = spawn(process.execPath, [AGENT, command], {
    cwd: ROOT,
    env: {
      ...process.env,
      SIDEKICK_URL: `http://127.0.0.1:${port}`,
      SIDEKICK_NODE_CONFIG: configPath,
      SIDEKICK_NODE_CREDENTIAL: credentialPath,
      SIDEKICK_NODE_ENROLL_TOKEN: token,
      SIDEKICK_NODE_ENROLL_TOKEN_FILE: path.join(fixture, "enrollment-token"),
      SIDEKICK_NODE_ID: nodeId,
      SIDEKICK_NODE_NAME: "protocol-fixture",
      SIDEKICK_NODE_POLL_MS: "250",
      SIDEKICK_NODE_HEARTBEAT_MS: "5000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  return { child, output: () => output };
}

function descriptor(name) {
  if (name === "read") return getCanonicalRegistry({ includeActiveModules: false }).get(name);
  const services = { config: { repository_roots: [workspaceRoot] }, paths: { enforce: () => null } };
  const found = developerEntry.buildDescriptors(services).find(item => item.name === name);
  return normalizeDescriptor({ ...found, source: "module:developer-tools", family: null });
}

function makeJob(jobId, toolName, args, context = {}, cancelled = false) {
  const tool = toolName === "missing_tool" ? { version: "1" } : descriptor(toolName);
  const job = {
    jobId,
    leaseId: `lease_${jobId}`,
    toolName,
    descriptorVersion: tool.version,
    descriptorIdentity: toolName === "missing_tool" ? "unknown" : placement.descriptorIdentity(tool),
    args,
    context,
    outcome: null,
    cancelled,
  };
  jobs.push(job);
  return job;
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("node process did not exit")), timeoutMs);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
}

(async () => {
  console.log("Running Execution Node Protocol Tests...");
  let nodeProcess;
  let oversizedProcess;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const first = makeJob("job_complete", "read", { path: path.join(repositoryRoot, "result.txt") });
    const second = makeJob("job_failure", "missing_tool", {});
    const third = makeJob("job_cancel", "dev_verify", {
      path: repositoryRoot,
      intents: ["test"],
      timeout_ms: 5000,
    }, { timeoutMs: 5000 }, true);
    requests.jobById = new Map([first, second, third].map(job => [job.jobId, job]));

    nodeProcess = startNode(port);
    await waitFor(() => first.outcome, "successful completion");
    await waitFor(() => second.outcome, "failure delivery");
    await waitFor(() => third.outcome, "cancellation delivery");

    assert.strictEqual(first.outcome.type, "complete", "valid local tool completes over HTTP");
    assert.strictEqual(first.outcome.payload.result.content[0].text, "node protocol result\n");
    assert.strictEqual(second.outcome.type, "fail", "unknown local tool is reported as failure");
    assert.strictEqual(second.outcome.payload.code, "local_execution_failed");
    assert.strictEqual(third.outcome.type, "fail", "cancelled local work reports failure delivery");
    assert.strictEqual(third.outcome.payload.code, "node_execution_cancelled");
    const protectedCalls = requests.filter(request => request.url.startsWith("/execution-node/node/"));
    assert.ok(protectedCalls.length > 0, "node protocol routes were exercised");
    assert.ok(protectedCalls.every(request => request.authorization === `Bearer ${workerId}:${credential}`), "all node routes use the enrolled bearer credential");
    assert.ok(protectedCalls.some(request => request.url.endsWith("/cancellation")), "cancellation status was polled over HTTP");

    nodeProcess.child.kill("SIGTERM");
    assert.strictEqual(await waitForExit(nodeProcess.child), 0, "node shuts down cleanly after lifecycle coverage");

    oversizeEnrollment = true;
    fs.rmSync(credentialPath, { force: true });
    oversizedProcess = startNode(port, "enroll");
    const oversizedExit = await waitForExit(oversizedProcess.child);
    assert.notStrictEqual(oversizedExit, 0, "oversized protocol response fails closed");
    assert.match(oversizedProcess.output(), /response too large/, "oversized response reports the bounded failure");
    console.log("Execution node protocol tests passed");
  } finally {
    for (const process of [nodeProcess?.child, oversizedProcess?.child]) {
      if (process && process.exitCode === null) process.kill("SIGKILL");
    }
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
