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
const { callTool } = require("../dispatch-seam");
const { childProcessEnv } = require("../../security/child-process");

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
      cwd: options.cwd,
      env: childProcessEnv(options.env)
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
      cwd: options.cwd,
      env: childProcessEnv(options.env)
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
      stdio: "ignore",
      env: childProcessEnv()
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
    const deployResult = runOpsCommand("node", [script, "deploy"], {
      timeout: 300000,
      maxBuffer: 20 * 1024 * 1024,
      // The helper runs inside sidekick-mcp. Keep MCP alive until the helper
      // releases its deployment lock; the restart is scheduled only after the
      // response has been returned to the caller.
      env: { SIDEKICK_DEPLOY_SKIP_MCP_LIFECYCLE: "1" },
    });
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

// sidekick_mission (Mission Control) moved here in B-6. It routes an intent
// to a profile and dispatches the resulting workflow through the nested
// dispatch seam. missionRoute stays on the src/tools facade as a
// compatibility export.
const MISSION_PROFILES = {
  read_only_audit: {
    risk: "low",
    description: "Read-only inspection. Routes status, logs, tool discovery, project context, and deploy verification.",
    execute: ["status", "logs", "tools", "policy", "project", "verify_deploy"]
  },
  trusted_vps: {
    risk: "high",
    description: "Trusted single-operator VPS. Allows normal inspection plus deploy_current_main with confirmation.",
    execute: ["status", "logs", "tools", "policy", "project", "verify_deploy", "deploy", "delete_key"]
  },
  production: {
    risk: "critical",
    description: "Production-like host. Requires confirmation for mutation and defaults deploy requests to verification.",
    execute: ["status", "logs", "tools", "policy", "project", "verify_deploy", "delete_key"]
  },
  danger_zone: {
    risk: "critical",
    description: "Explicit high-power mode. Allows deploy_current_main and key deletion with confirmation.",
    execute: ["status", "logs", "tools", "policy", "project", "verify_deploy", "deploy", "delete_key"]
  }
};

function normalizeMissionIntent(intent) {
  const text = String(intent || "").toLowerCase();
  if (!text.trim()) return "unknown";
  if (/\bdeploy\b|release|rollout|ship/.test(text)) return "deploy";
  if (/verify.*deploy|deployed.*commit|current.*main|matches.*origin/.test(text)) return "verify_deploy";
  if (/status|health|uptime|services|disk|memory|load/.test(text)) return "status";
  if (/log|logs|history|recent activity|tool calls/.test(text)) return "logs";
  if (/policy|permission|permissions|allowed|blocked|lockdown|approval|approvals|why.*tool|tool.*why|who can call|can call|call what|risk/.test(text)) return "policy";
  if (/tool|tools|catalog|manifest|available capabilities|what can sidekick do/.test(text)) return "tools";
  if (/project|memory|context|remember|stored facts/.test(text)) return "project";
  if (/delete.*key|remove.*key|delete.*kv|remove.*kv/.test(text)) return "delete_key";
  return "unknown";
}

function missionRoute(intent, profileName = "trusted_vps", options = {}) {
  const route = normalizeMissionIntent(intent);
  const profile = MISSION_PROFILES[profileName] ? profileName : "trusted_vps";
  const allowed = MISSION_PROFILES[profile].execute.includes(route);
  const toolMap = {
    deploy: { tool: "ops", args: { action: "deploy_current_main", repo_path: options.repo_path } },
    verify_deploy: { tool: "ops", args: { action: "verify_deployed_commit", repo_path: options.repo_path } },
    status: { tool: "status", args: { include: options.include || "services,disk,memory,load,uptime", services: options.services } },
    logs: { tool: "log_query", args: { limit: options.limit || 20, tool: options.tool, source: options.source } },
    tools: { tool: "tools", args: { action: options.query ? "search" : "overview", query: options.query, format: options.format || "text" } },
    policy: { tool: "tools", args: { action: "policy", name: options.tool, source: options.source, format: options.format || "text", limit: options.limit } },
    project: { tool: "project", args: { name: options.project || "sidekick", include: options.include || "kv,context" } },
    delete_key: { tool: "delete", args: { key: options.key } }
  };
  const recommendation = toolMap[route] || null;
  const requiresConfirmation = ["deploy", "delete_key"].includes(route);
  return {
    intent: intent || "",
    profile,
    route,
    allowed,
    requires_confirmation: requiresConfirmation,
    risk: route === "deploy" ? "critical" : (route === "delete_key" ? "medium" : "low"),
    recommended_tool: recommendation?.tool || null,
    recommended_args: recommendation?.args || null,
    reason: route === "unknown"
      ? "No deterministic route matched. Use tools action=search or a narrower tool."
      : (allowed ? "Route is allowed by profile." : "Route is not allowed by profile.")
  };
}

function formatMissionRoute(route) {
  return [
    "MISSION ROUTE",
    `Intent: ${route.intent || "(empty)"}`,
    `Profile: ${route.profile}`,
    `Route: ${route.route}`,
    `Allowed: ${route.allowed ? "yes" : "no"}`,
    `Risk: ${route.risk}`,
    `Requires confirmation: ${route.requires_confirmation ? "yes" : "no"}`,
    `Recommended tool: ${route.recommended_tool || "(none)"}`,
    `Recommended args: ${route.recommended_args ? JSON.stringify(route.recommended_args) : "(none)"}`,
    `Reason: ${route.reason}`
  ].join("\n");
}

async function sidekick_mission({ action, intent, profile, confirm, key, project, query, include, services, repo_path, limit, tool, source, format }) {
  const selectedAction = action || "route";
  if (selectedAction === "profiles") {
    return { content: [{ type: "text", text: JSON.stringify(MISSION_PROFILES, null, 2) }] };
  }

  const route = missionRoute(intent, profile, { key, project, query, include, services, repo_path, limit, tool, source, format });

  if (selectedAction === "route") {
    return { content: [{ type: "text", text: formatMissionRoute(route) }] };
  }

  if (selectedAction === "preflight") {
    const checks = [
      route.route === "unknown" ? "Clarify intent or use tools search." : "Intent mapped deterministically.",
      route.allowed ? "Profile allows this route." : "Profile blocks this route.",
      route.requires_confirmation ? "Mutation requires confirm=true before execute." : "No mutation confirmation required.",
      route.recommended_tool ? `Use ${route.recommended_tool}.` : "No tool selected."
    ];
    return { content: [{ type: "text", text: JSON.stringify({ ...route, checks }, null, 2) }], isError: !route.allowed || route.route === "unknown" };
  }

  if (selectedAction === "execute") {
    if (route.route === "unknown") {
      return { content: [{ type: "text", text: "No deterministic route matched. Run action=route or action=preflight first." }], isError: true };
    }
    if (!route.allowed) {
      return { content: [{ type: "text", text: `Route ${route.route} is blocked by profile ${route.profile}` }], isError: true };
    }
    if (route.requires_confirmation && confirm !== true) {
      return { content: [{ type: "text", text: `Route ${route.route} requires confirm=true before execution.` }], isError: true };
    }
    if (route.route === "delete_key" && !key) {
      return { content: [{ type: "text", text: "key is required for delete_key missions" }], isError: true };
    }
    return callTool(route.recommended_tool, route.recommended_args || {});
  }

  return { content: [{ type: "text", text: "Invalid action. Allowed: profiles, route, preflight, execute" }], isError: true };
}

const missionSchema = z.object({
    action: z.enum(["profiles", "route", "preflight", "execute"]).optional().default("route").describe("Mission Control action"),
    intent: z.string().optional().describe("User goal or operation intent"),
    profile: z.enum(["read_only_audit", "trusted_vps", "production", "danger_zone"]).optional().default("trusted_vps").describe("Run profile"),
    confirm: z.boolean().optional().describe("Required true for mutating execute routes"),
    key: z.string().optional().describe("KV key for delete missions"),
    project: z.string().optional().describe("Project name for memory missions"),
    query: z.string().optional().describe("Search query for tool discovery"),
    include: z.string().optional().describe("Include sections for status/project"),
    services: z.string().optional().describe("Services for status missions"),
    repo_path: z.string().optional().describe("Repository path for deploy workflows"),
    limit: z.number().optional().describe("Result limit"),
    tool: z.string().optional().describe("Tool filter for logs"),
    source: z.string().optional().describe("Source filter for logs"),
    format: z.string().optional().describe("Output format for tool discovery")
  });

const descriptors = Object.freeze([
  Object.freeze({
    name: "mission",
    description: "Mission Control intent router for Sidekick operations. Profiles, routes, preflights, and executes common intents through safer existing tools before raw shell.",
    schema: missionSchema,
    args: { action: "string (profiles|route|preflight|execute - default route)", intent: "string (user goal or operation intent)", profile: "string (read_only_audit|trusted_vps|production|danger_zone - default trusted_vps)", confirm: "boolean (required true for mutating execute routes)", key: "string (optional, KV key for delete missions)", project: "string (optional, project for memory missions)", query: "string (optional, search query for tool discovery)", include: "string (optional, include sections for status/project)", services: "string (optional, services for status)", repo_path: "string (optional, repo for deploy workflows)", limit: "number (optional, result limit)", tool: "string (optional, tool filter for logs)", source: "string (optional, source filter for logs)", format: "string (optional, output format for tool discovery)" },
    risk: "critical",
    category: "Workflow",
    source: "builtin",
    family: "operations",
    handler: sidekick_mission,
  }),
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

module.exports = { descriptors, sidekick_ops, sidekick_mission, missionRoute };
