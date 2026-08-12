"use strict";

// Operations tool family: ops.
//
// Extracted from src/tools-legacy.js. Packaged deploy/verify/restart/incident
// workflows for the Sidekick services. Depends only on Node builtins, zod,
// the shared path policy, and the observability family's sidekick_status
// (incident snapshots) — never on tools-legacy.js. All helpers move verbatim,
// including scheduleMcpRestart (spawns a detached delayed
// "sudo systemctl restart sidekick-mcp" at call time — behavior-critical for
// deploys; no timers run at module load). `ops` is `critical` risk,
// preserved from src/tools/metadata.js and gated by the dispatcher.

const fs = require("fs");
const path = require("path");
const { execFile, execFileSync, spawn } = require("child_process");
const { z } = require("zod");
const { enforcePathPolicy } = require("../path-policy");
const { sidekick_status } = require("./observability");

const SIDEKICK_SERVICES = ["sidekick-mcp", "sidekick-dashboard", "sidekick-agent"];
const SIDEKICK_DEPLOY_REPO_PATH = "/home/sidekick/sidekick";

function deployScriptPath(repoPath) {
  return path.join(repoPath, "scripts", "git-deploy.js");
}

function parseOpsJson(result) {
  if (!result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return null;
  }
}

function runOpsCommand(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      timeout: options.timeout || 30000,
      encoding: "utf-8",
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
      cwd: options.cwd
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || "").trim(),
      stderr: String(e.stderr || e.message || "").trim(),
      status: e.status
    };
  }
}

function runOpsCommandAsync(command, args, options = {}) {
  return new Promise(resolve => {
    execFile(command, args, {
      timeout: options.timeout || 30000,
      encoding: "utf-8",
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
      cwd: options.cwd
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || error?.message || "").trim(),
        status: error?.code
      });
    });
  });
}

function getGitValue(repoPath, args) {
  const result = runOpsCommand("git", ["-C", repoPath, ...args], { timeout: 60000 });
  return result.ok ? result.stdout : null;
}

function getServiceStates(services = SIDEKICK_SERVICES) {
  const states = {};
  for (const service of services) {
    const result = runOpsCommand("systemctl", ["is-active", service], { timeout: 5000 });
    states[service] = result.ok ? result.stdout : (result.stdout || "unknown");
  }
  return states;
}

function allServicesActive(states) {
  return Object.values(states).every(state => state === "active");
}

function filterGitStatus(statusText) {
  return (statusText || "")
    .split("\n")
    .map(line => line.trimEnd())
    .filter(Boolean)
    .filter(line => !line.endsWith(" package-lock.json") && line !== "?? package-lock.json")
    .join("\n");
}

function formatOpsReport(title, rows, details = []) {
  const body = rows.map(([key, value]) => `${key}: ${value}`).join("\n");
  const detailText = details.filter(Boolean).join("\n\n");
  return `${title}\n${body}${detailText ? "\n\n" + detailText : ""}`;
}

function scheduleMcpRestart(delaySeconds = 2) {
  const delayMs = Math.max(0, (Number(delaySeconds) || 2) * 1000);
  setTimeout(() => {
    const child = spawn("sudo", ["systemctl", "restart", "sidekick-mcp"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  }, delayMs).unref();
}

async function sidekick_ops({ action, repo_path, restart_mcp }) {
  const repoPath = repo_path || SIDEKICK_DEPLOY_REPO_PATH;
  if (repoPath !== SIDEKICK_DEPLOY_REPO_PATH) {
    return { content: [{ type: "text", text: `sidekick_ops deployments are restricted to ${SIDEKICK_DEPLOY_REPO_PATH}` }], isError: true };
  }
  const pathPolicyError = enforcePathPolicy(repoPath, action === "deploy_current_main" ? "write" : "read");
  if (pathPolicyError) return pathPolicyError;

  if (action === "verify_deployed_commit") {
    const script = deployScriptPath(repoPath);
    if (!fs.existsSync(script)) return { content: [{ type: "text", text: "Deployment helper not found: " + script }], isError: true };
    const verify = runOpsCommand("node", [script, "verify"], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    const parsed = parseOpsJson(verify);
    const ok = verify.ok && parsed?.status === "ok";

    return {
      content: [{
        type: "text",
        text: JSON.stringify(parsed || { status: "failed", error: verify.stderr || verify.stdout || "verify failed" }, null, 2)
      }],
      isError: !ok
    };
  }

  if (action === "restart_and_smoke_test") {
    const restarted = [];
    for (const service of ["sidekick-dashboard", "sidekick-agent"]) {
      const result = runOpsCommand("sudo", ["systemctl", "restart", service], { timeout: 30000 });
      restarted.push([service, result.ok ? "restarted" : "failed"]);
    }

    const states = getServiceStates();
    // This tool runs inside sidekick-mcp. Use an asynchronous child process so
    // the event loop remains free to answer its own /health request.
    const health = await runOpsCommandAsync(
      "curl",
      ["--max-time", "5", "-fsS", "http://127.0.0.1:4097/health"],
      { timeout: 7000 }
    );
    let mcpNote = "not requested";
    if (restart_mcp === true) {
      scheduleMcpRestart();
      mcpNote = "scheduled after response; next MCP call may reconnect";
    }

    const serviceOk = restarted.every(([, state]) => state === "restarted") && allServicesActive(states);
    const healthOk = health.ok;
    return {
      content: [{
        type: "text",
        text: formatOpsReport("RESTART SMOKE TEST", [
          ["RESULT", serviceOk ? (healthOk ? "passed" : "passed with warnings") : "failed"],
          ["MCP restart", mcpNote],
          ["MCP health", healthOk ? "passed" : "warning"],
          ["Services", allServicesActive(states) ? "all active" : "attention needed"],
          ["Action needed", serviceOk && healthOk ? "none" : (serviceOk ? "check MCP endpoint behavior" : "review output")]
        ], [
          "Restart results:\n" + restarted.map(([svc, state]) => `${svc}: ${state}`).join("\n"),
          "Service states:\n" + Object.entries(states).map(([svc, state]) => `${svc}: ${state}`).join("\n"),
          health.ok ? null : `MCP probe warning:\n${health.stdout || health.stderr || "no response"}`
        ])
      }],
      isError: !serviceOk
    };
  }

  if (action === "deploy_current_main") {
    const script = deployScriptPath(repoPath);
    if (!fs.existsSync(script)) return { content: [{ type: "text", text: "Deployment helper not found: " + script }], isError: true };
    const deployResult = runOpsCommand("node", [script, "deploy"], { timeout: 300000, maxBuffer: 20 * 1024 * 1024 });
    const parsed = parseOpsJson(deployResult);
    const ok = deployResult.ok && parsed?.status === "ok";
    if (ok) scheduleMcpRestart();

    return {
      content: [{
        type: "text",
        text: JSON.stringify(parsed || { status: "failed", error: deployResult.stderr || deployResult.stdout || "deploy failed" }, null, 2)
      }],
      isError: !ok
    };
  }

  if (action === "incident_snapshot") {
    const states = getServiceStates();
    const status = await sidekick_status({ include: "services,disk,memory,load,uptime,processes" });
    const logs = {};
    for (const service of SIDEKICK_SERVICES) {
      const result = runOpsCommand("journalctl", ["-u", service, "-n", "25", "--no-pager"], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
      logs[service] = result.ok ? result.stdout : (result.stderr || result.stdout || "unavailable");
    }
    const git = fs.existsSync(repoPath) ? {
      head: getGitValue(repoPath, ["rev-parse", "HEAD"]),
      status: filterGitStatus(getGitValue(repoPath, ["status", "--short"]) || "")
    } : { head: "repo not found", status: "" };
    const ok = allServicesActive(states);

    return {
      content: [{
        type: "text",
        text: formatOpsReport("INCIDENT SNAPSHOT", [
          ["RESULT", ok ? "captured" : "captured with service issues"],
          ["Services", ok ? "all active" : "attention needed"],
          ["HEAD", git.head || "unknown"],
          ["Dirty files", git.status ? "yes" : "none"],
          ["Action needed", ok ? "review logs if symptoms persist" : "review service states and logs"]
        ], [
          "Status:\n" + status.content[0].text,
          git.status ? "Git status:\n" + git.status : "Git status: clean",
          "Recent logs:\n" + Object.entries(logs).map(([svc, text]) => `--- ${svc} ---\n${text}`).join("\n\n")
        ])
      }],
      isError: !ok
    };
  }

  return { content: [{ type: "text", text: "Invalid action. Use: verify_deployed_commit, restart_and_smoke_test, deploy_current_main, incident_snapshot" }], isError: true };
}

const SCHEMAS = {
  ops: z.object({
    action: z.enum(["verify_deployed_commit", "restart_and_smoke_test", "deploy_current_main", "incident_snapshot"]).describe("Packaged operations workflow to run"),
    repo_path: z.string().optional().describe("Repository path. Defaults to the current Sidekick repo."),
    restart_mcp: z.boolean().optional().default(false).describe("For restart_and_smoke_test, schedule sidekick-mcp restart after the response.")
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "ops",
    description: "Packaged Sidekick operations workflows for deploy verification, restart smoke tests, deployments, and incident snapshots.",
    schema: SCHEMAS.ops,
    args: { action: "string (verify_deployed_commit|restart_and_smoke_test|deploy_current_main|incident_snapshot)", repo_path: "string (optional, repository path - default current Sidekick repo)", restart_mcp: "boolean (optional, schedule sidekick-mcp restart for restart_and_smoke_test)" },
    risk: "critical",
    category: "Workflow",
    source: "builtin",
    family: "operations",
    handler: sidekick_ops,
  }),
]);

module.exports = { descriptors, sidekick_ops };
