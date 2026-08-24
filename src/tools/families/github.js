"use strict";

// GitHub tool family: github, ci_status.
//
// Extracted from src/tools-legacy.js. Depends only on Node builtins, zod,
// the shared redaction utility, the encrypted-secrets store, the shared secret
// cipher, and (optionally) the connector authority — never on tools-legacy.js.
// The GitHub integration is governed by the registered GitHub connector when
// present: endpoint and credential come from the connector (its secret_ref
// resolved at call time via connectors/resolve.js) — the connector is the
// credential authority and resolves first. File-backed credentials and the
// legacy secret-store key remain supported for migration. Each API response feeds bounded connector
// health observability (githubHealthDecision/noteGithubResponse). The token is
// redacted from error text by redactGithubError before any output. The
// helper quartet parseGithubArgs/getGithubArg/getCiRevisionSelector/
// buildCiStatusResult (+formatCiStatusText) stays on the src/tools facade as
// compatibility exports. Risk (github high, ci_status low) preserved from
// src/tools/metadata.js.

const https = require("https");
const { z } = require("zod");
const { redactSensitive } = require("../../redact");
const { resolveOutboundUrl } = require("../../security/outbound-url");
const { loadSecrets } = require("../../core/secrets-store");
const { decryptSecret } = require("../../core/secret-cipher");
const { readSecret } = require("../../core/runtime-secrets");

// Reuse TLS connections for the GitHub API. Most calls are short read
// sequences, so avoiding a new handshake per request materially reduces
// handler time without changing request semantics.
const githubHttpAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

function parseGithubArgs(extraArgs) {
  if (extraArgs === undefined || extraArgs === null || extraArgs === "") return {};
  if (typeof extraArgs === "object") return extraArgs;
  if (typeof extraArgs !== "string") return { value: extraArgs };
  const trimmed = extraArgs.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return { value: parsed };
  } catch (e) {
    return { value: extraArgs };
  }
}

function getGithubArg(args, names) {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null && args[name] !== "") return args[name];
  }
  return args.value;
}

// The GitHub connector is the governing authority for this integration when one
// is registered (endpoint + credential reference). It is optional so the tool
// still works before the connector authority is present; env stays the highest-
// precedence override for backwards compatibility.
let connectorResolve = null;
try { connectorResolve = require("../../connectors/resolve"); } catch { connectorResolve = null; }

function githubConnector() {
  return connectorResolve ? connectorResolve.getActiveConnector("github") : null;
}

function resolveGithubToken() {
  // Authority order: the ACTIVE registered GitHub connector is the governing
  // authority for this integration, so its secret_ref resolves FIRST. The
  // GITHUB_TOKEN env var is a fallback for pre-connector deployments (and the
  // escape hatch when no connector is live — including after the connector
  // degrades to `error`, since only enabled/healthy connectors are "active"),
  // not an override that silently bypasses the governed credential. The legacy
  // encrypted secret-store key remains the final fallback.
  const connector = githubConnector();
  if (connector && connectorResolve) {
    const viaConnector = connectorResolve.resolveConnectorCredential(connector);
    if (viaConnector) return viaConnector;
  }

  try {
    const fileToken = readSecret("GITHUB_TOKEN");
    if (fileToken) return fileToken;
    const sidekickToken = readSecret("SIDEKICK_GITHUB_TOKEN");
    if (sidekickToken) return sidekickToken;
  } catch (error) {
    // A configured file failure is fail-closed; do not fall back to an env value.
    return undefined;
  }

  try {
    const secrets = loadSecrets();
    const secret = secrets["github_token"];
    if (secret) return decryptSecret(secret);
  } catch (e) {
    // Secret store not available
  }
  return undefined;
}

// Governed API base: the connector's endpoint when registered, else the public
// GitHub API. Callers append the API path to this.
function resolveGithubApiBase() {
  const connector = githubConnector();
  if (connector && connector.endpoint) return String(connector.endpoint).replace(/\/$/, "");
  return "https://api.github.com";
}

// Pure decision helper for per-call connector health observability (unit
// tested directly). Only state CHANGES are recorded — the kernel's
// recordConnectorHealth writes a row and appends an event on every call, so
// recording each successful request would turn API traffic into ledger churn:
//   - 401/403 while the connector is enabled/healthy -> record degradation
//     (transitions the connector to `error`; it then stops being the active
//     credential source until an operator re-enables it).
//   - success while the connector is merely `enabled` -> record ok (promotes
//     enabled -> healthy, the one success-side state change that exists).
//   - everything else (steady-state healthy success, repeat failures after the
//     connector already errored, network errors/timeouts with status 0) is
//     not recorded.
function githubHealthDecision(connectorState, httpStatus) {
  const status = Number(httpStatus) || 0;
  const authFailure = status === 401 || status === 403;
  const success = status >= 200 && status < 400;
  if (authFailure && (connectorState === "enabled" || connectorState === "healthy")) {
    return { record: true, ok: false, error: `github auth failure (HTTP ${status})` };
  }
  if (success && connectorState === "enabled") {
    return { record: true, ok: true };
  }
  return { record: false };
}

// Best-effort per-call hook: observability must never break or slow the API
// call itself, so every failure here is swallowed. Cheap by construction —
// githubConnector() is a bounded kernel lookup and a write happens only on a
// state change (see githubHealthDecision). Success-side last-used metadata is
// deliberately NOT written per call for the same reason; the enabled->healthy
// promotion (with its last_health_check_at stamp) is the durable evidence the
// credential works.
function noteGithubResponse(httpStatus) {
  try {
    if (!connectorResolve) return;
    const connector = githubConnector();
    if (!connector) return;
    const decision = githubHealthDecision(connector.state, httpStatus);
    if (!decision.record) return;
    const kernel = require("../../platform/kernel");
    kernel.recordConnectorHealth(
      connector.connector_id,
      decision.ok
        ? { ok: true, status: Number(httpStatus) || 0, source: "github_tool" }
        : { ok: false, status: Number(httpStatus) || 0, error: decision.error, source: "github_tool" }
    );
  } catch {
    // Never let health recording interfere with the request path.
  }
}

function redactGithubError(value, token) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (token) text = text.split(token).join("[REDACTED]");
  return redactSensitive(text);
}

async function githubRequest(token, method, endpoint, body) {
  const apiBase = resolveGithubApiBase();
  const url = new URL(apiBase + endpoint);
  if (url.protocol !== "https:") return { status: 0, headers: {}, data: "GitHub API endpoint must use HTTPS" };
  const resolved = await resolveOutboundUrl(url.href, "GitHub API endpoint");
  if (resolved.refusal) return { status: 0, headers: {}, data: resolved.refusal };
  return new Promise((resolve) => {
    const options = {
      hostname: resolved.address,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Sidekick-MCP/1.0",
        // The socket is pinned to the resolved address; preserve the
        // original virtual-host destination for HTTP routing.
        "Host": url.host
      },
      agent: githubHttpAgent,
      servername: url.hostname.replace(/^\[|\]$/g, "")
    };
    let bodyStr = null;
    if (body) {
      bodyStr = JSON.stringify(body);
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        let parsed = data;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch (e) {
          parsed = data;
        }
        noteGithubResponse(res.statusCode);
        resolve({ status: res.statusCode, headers: res.headers || {}, data: parsed });
      });
    });
    req.on("error", (err) => resolve({ status: 0, headers: {}, data: err.message }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, headers: {}, data: "timeout" }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function parseGithubLinkHeader(linkHeader) {
  const links = {};
  if (!linkHeader) return links;
  for (const part of String(linkHeader).split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

function endpointFromGithubUrl(url) {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

async function githubPaginatedRequest(token, endpoint, dataKey) {
  let next = endpoint;
  const items = [];
  let lastResponse = null;

  while (next) {
    const res = await githubRequest(token, "GET", next);
    lastResponse = res;
    if (res.status < 200 || res.status >= 300) return { response: res, items };

    const pageItems = dataKey ? res.data?.[dataKey] : res.data;
    if (Array.isArray(pageItems)) items.push(...pageItems);

    const links = parseGithubLinkHeader(res.headers.link);
    next = links.next ? endpointFromGithubUrl(links.next) : null;
  }

  return { response: lastResponse, items };
}

function validateRepoName(repo) {
  return typeof repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

function getCiRevisionSelector(args) {
  const selectors = [
    { type: "pr", aliases: ["pr", "pull_number"] },
    { type: "sha", aliases: ["sha", "commit"] },
    { type: "ref", aliases: ["ref", "branch"] }
  ];
  const found = [];
  for (const selector of selectors) {
    for (const alias of selector.aliases) {
      if (args[alias] !== undefined && args[alias] !== null && args[alias] !== "") {
        found.push({ type: selector.type, alias, value: args[alias] });
        break;
      }
    }
  }
  if (found.length === 0) return { error: "Exactly one revision selector is required: pr/pull_number, sha/commit, or ref/branch" };
  if (found.length > 1) return { error: "Conflicting revision selectors: provide exactly one of pr/pull_number, sha/commit, or ref/branch" };
  return found[0];
}

function ciItemState(kind, item) {
  if (kind === "check") {
    if (item.status !== "completed") return "pending";
    if (["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(item.conclusion)) return "failure";
    if (["success", "neutral", "skipped"].includes(item.conclusion)) return item.conclusion === "skipped" ? "skipped" : "success";
    return "pending";
  }

  if (["failure", "error"].includes(item.state)) return "failure";
  if (item.state === "pending") return "pending";
  if (item.state === "success") return "success";
  return "pending";
}

function buildCiStatusResult(repo, requested, sha, checkRuns, statuses) {
  const summary = { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 };
  let sawSuccess = false;
  let sawPending = false;
  let sawFailure = false;

  const normalizedCheckRuns = checkRuns.map(run => {
    const state = ciItemState("check", run);
    summary.total++;
    if (state === "failure") { summary.failed++; sawFailure = true; }
    else if (state === "pending") { summary.pending++; sawPending = true; }
    else if (state === "skipped") { summary.skipped++; }
    else { summary.passed++; sawSuccess = true; }
    return {
      name: run.name || "(unnamed check)",
      head_sha: run.head_sha || null,
      status: run.status || null,
      conclusion: run.conclusion || null,
      details_url: run.details_url || run.html_url || null,
      html_url: run.html_url || null,
      state
    };
  });

  const normalizedStatuses = statuses.map(status => {
    const state = ciItemState("status", status);
    summary.total++;
    if (state === "failure") { summary.failed++; sawFailure = true; }
    else if (state === "pending") { summary.pending++; sawPending = true; }
    else { summary.passed++; sawSuccess = true; }
    return {
      context: status.context || "(no context)",
      state: status.state || null,
      description: status.description || null,
      target_url: status.target_url || null
    };
  });

  let overall = "no_checks";
  if (sawFailure) overall = "failure";
  else if (sawPending) overall = "pending";
  else if (sawSuccess || summary.skipped > 0) overall = "success";

  return {
    repo,
    requested,
    sha,
    overall,
    summary,
    check_runs: normalizedCheckRuns,
    statuses: normalizedStatuses
  };
}

function formatCiStatusText(result) {
  const lines = [
    `CI Status: ${result.overall}`,
    `Repository: ${result.repo}`,
    `${result.requested.type === "pr" ? "PR" : result.requested.type === "sha" ? "Commit" : "Ref"}: ${result.requested.value}`,
    `Resolved SHA: ${result.sha}`,
    "",
    "Check runs:"
  ];

  if (result.check_runs.length === 0) lines.push("- none");
  for (const run of result.check_runs) {
    lines.push(`- ${run.name}: ${run.status || "unknown"} / ${run.conclusion || "none"}`);
    if (run.details_url) lines.push(`  ${run.details_url}`);
  }

  lines.push("", "Legacy statuses:");
  if (result.statuses.length === 0) lines.push("- none");
  for (const status of result.statuses) {
    lines.push(`- ${status.context}: ${status.state || "unknown"}`);
    if (status.target_url) lines.push(`  ${status.target_url}`);
  }

  lines.push("", `Summary: ${result.summary.total} total, ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.pending} pending, ${result.summary.skipped} skipped`);
  return lines.join("\n");
}

async function sidekick_ci_status(args = {}) {
  const format = args.format || "text";
  if (!args.repo) return { content: [{ type: "text", text: "repo is required in owner/repository format" }], isError: true };
  if (!validateRepoName(args.repo)) return { content: [{ type: "text", text: "Invalid repository. Expected owner/repository format" }], isError: true };
  if (!["text", "json"].includes(format)) return { content: [{ type: "text", text: "format must be text or json" }], isError: true };

  const selector = getCiRevisionSelector(args);
  if (selector.error) return { content: [{ type: "text", text: selector.error }], isError: true };

  const token = resolveGithubToken();
  if (!token) return { content: [{ type: "text", text: "github_token not found in secret store" }], isError: true };

  try {
    let ref = String(selector.value);
    let requested = { type: selector.type, value: selector.type === "pr" ? Number(selector.value) : String(selector.value) };
    if (selector.type === "pr") {
      const prRes = await githubRequest(token, "GET", `/repos/${args.repo}/pulls/${encodeURIComponent(selector.value)}`);
      if (prRes.status !== 200) {
        return { content: [{ type: "text", text: redactGithubError(prRes.data, token) }], isError: true };
      }
      ref = prRes.data?.head?.sha;
      if (!ref) return { content: [{ type: "text", text: "GitHub PR response did not include head.sha" }], isError: true };
    }

    const encodedRef = encodeURIComponent(ref);
    const [checks, legacy] = await Promise.all([
      githubPaginatedRequest(token, `/repos/${args.repo}/commits/${encodedRef}/check-runs?per_page=100`, "check_runs"),
      githubPaginatedRequest(token, `/repos/${args.repo}/commits/${encodedRef}/status?per_page=100`, "statuses")
    ]);
    if (checks.response?.status < 200 || checks.response?.status >= 300) {
      return { content: [{ type: "text", text: redactGithubError(checks.response.data, token) }], isError: true };
    }
    if (legacy.response?.status < 200 || legacy.response?.status >= 300) {
      return { content: [{ type: "text", text: redactGithubError(legacy.response.data, token) }], isError: true };
    }

    const resolvedSha = checks.items.find(run => run.head_sha)?.head_sha || legacy.response?.data?.sha || ref;
    const result = buildCiStatusResult(args.repo, requested, resolvedSha, checks.items, legacy.items);
    const text = format === "json" ? JSON.stringify(result, null, 2) : formatCiStatusText(result);
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactGithubError(e.message, token) }], isError: true };
  }
}

async function sidekick_github({ action, repo, args: extraArgs }) {
  const parsedArgs = parseGithubArgs(extraArgs);
  const token = resolveGithubToken();

  if (!token) {
    return { content: [{ type: "text", text: "github_token not found in secret store" }], isError: true };
  }

  const https = require("https");
  const apiBase = resolveGithubApiBase();

  function ghRequest(method, endpoint, body) {
    return new Promise((resolve) => {
      const url = new URL(apiBase + endpoint);
      if (url.protocol !== "https:") return resolve({ status: 0, data: "GitHub API endpoint must use HTTPS" });
      resolveOutboundUrl(url.href, "GitHub API endpoint").then(resolved => {
        if (resolved.refusal) return resolve({ status: 0, data: resolved.refusal });
      const options = {
        hostname: resolved.address,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers: {
          "Authorization": "token " + token,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "Sidekick-MCP/1.0",
          "Host": url.host
        },
        agent: githubHttpAgent,
        servername: url.hostname.replace(/^\[|\]$/g, "")
      };
      if (body) {
        const bodyStr = JSON.stringify(body);
        options.headers["Content-Type"] = "application/json";
        options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          noteGithubResponse(res.statusCode);
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ status: res.statusCode, data: data });
          }
        });
      });
      req.on("error", (err) => resolve({ status: 0, data: err.message }));
      req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, data: "timeout" }); });
      if (body) req.write(JSON.stringify(body));
      req.end();
      }).catch(error => resolve({ status: 0, data: error.message }));
    });
  }

  const actions = {
    pr_list: async () => {
      const state = parsedArgs.state || "open";
      const res = await ghRequest("GET", `/repos/${repo}/pulls?state=${encodeURIComponent(state)}`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const prs = res.data.map(pr => `#${pr.number} ${pr.title} (${pr.user.login}) - ${pr.html_url}`);
      return { content: [{ type: "text", text: prs.join("\n") || "No open PRs" }] };
    },
    pr_create: async () => {
      const { title, head, base, body } = parsedArgs;
      if (!title || !head) return { content: [{ type: "text", text: "title and head required" }], isError: true };
      const res = await ghRequest("POST", `/repos/${repo}/pulls`, { title, head, base: base || "main", body: body || "" });
      if (res.status !== 201) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Created PR #${res.data.number}: ${res.data.html_url}` }] };
    },
    pr_get: async () => {
      const num = getGithubArg(parsedArgs, ["number", "pr", "pull", "pull_number"]);
      if (!num) return { content: [{ type: "text", text: "PR number required" }], isError: true };
      const res = await ghRequest("GET", `/repos/${repo}/pulls/${num}`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const pr = res.data;
      return { content: [{ type: "text", text: `#${pr.number} ${pr.title}\nState: ${pr.state}\nAuthor: ${pr.user.login}\nURL: ${pr.html_url}\n${pr.body || ""}` }] };
    },
    pr_merge: async () => {
      const num = getGithubArg(parsedArgs, ["number", "pr", "pull", "pull_number"]);
      if (!num) return { content: [{ type: "text", text: "PR number required" }], isError: true };
      const method = parsedArgs.method || parsedArgs.merge_method || "squash";
      const res = await ghRequest("PUT", `/repos/${repo}/pulls/${num}/merge`, { merge_method: method });
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Merged PR #${num}` }] };
    },
    issue_list: async () => {
      const res = await ghRequest("GET", `/repos/${repo}/issues?state=open`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const issues = res.data.filter(i => !i.pull_request).map(i => `#${i.number} ${i.title} (${i.user.login}) - ${i.html_url}`);
      return { content: [{ type: "text", text: issues.join("\n") || "No open issues" }] };
    },
    issue_create: async () => {
      const { title, body } = parsedArgs;
      if (!title) return { content: [{ type: "text", text: "title required" }], isError: true };
      const res = await ghRequest("POST", `/repos/${repo}/issues`, { title, body: body || "" });
      if (res.status !== 201) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Created issue #${res.data.number}: ${res.data.html_url}` }] };
    },
    issue_close: async () => {
      const num = getGithubArg(parsedArgs, ["number", "issue", "issue_number"]);
      if (!num) return { content: [{ type: "text", text: "issue number required" }], isError: true };
      const res = await ghRequest("PATCH", `/repos/${repo}/issues/${num}`, { state: "closed" });
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Closed issue #${num}` }] };
    },
    commit_status: async () => {
      const sha = getGithubArg(parsedArgs, ["sha", "ref", "commit", "commit_sha"]);
      if (!sha) return { content: [{ type: "text", text: "commit SHA required" }], isError: true };
      const res = await ghRequest("GET", `/repos/${repo}/commits/${sha}/status`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const statuses = res.data.statuses.map(s => `${s.context}: ${s.state} - ${s.description || ""}`);
      return { content: [{ type: "text", text: `Overall: ${res.data.state}\n${statuses.join("\n") || "No statuses"}` }] };
    },
    release_create: async () => {
      const { tag_name, name, body, draft, prerelease } = parsedArgs;
      if (!tag_name) return { content: [{ type: "text", text: "tag_name required" }], isError: true };
      const res = await ghRequest("POST", `/repos/${repo}/releases`, { tag_name, name: name || tag_name, body: body || "", draft: draft || false, prerelease: prerelease || false });
      if (res.status !== 201) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      return { content: [{ type: "text", text: `Created release ${res.data.name}: ${res.data.html_url}` }] };
    },
    repo_info: async () => {
      const res = await ghRequest("GET", `/repos/${repo}`);
      if (res.status !== 200) return { content: [{ type: "text", text: JSON.stringify(res.data) }], isError: true };
      const r = res.data;
      return { content: [{ type: "text", text: `${r.full_name}\nStars: ${r.stargazers_count} | Forks: ${r.forks_count} | Issues: ${r.open_issues_count}\nDefault branch: ${r.default_branch}\n${r.description || ""}` }] };
    }
  };

  if (!actions[action]) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + Object.keys(actions).join(", ") }], isError: true };
  }

  return actions[action]();
}

const SCHEMAS = {
  github: z.object({
    action: z.enum(["pr_list", "pr_create", "pr_get", "pr_merge", "issue_list", "issue_create", "issue_close", "commit_status", "release_create", "repo_info"]).describe("GitHub action to perform"),
    repo: z.string().describe("Repository in format 'owner/repo'"),
    args: z.string().optional().describe("Additional arguments (JSON string or value depending on action)")
  }),
  ci_status: z.object({
    repo: z.string().describe("Repository in format 'owner/repo'"),
    pr: z.union([z.string(), z.number()]).optional().describe("Pull request number"),
    pull_number: z.union([z.string(), z.number()]).optional().describe("Pull request number"),
    sha: z.string().optional().describe("Commit SHA"),
    commit: z.string().optional().describe("Commit SHA"),
    ref: z.string().optional().describe("Git ref, branch, or SHA"),
    branch: z.string().optional().describe("Branch name"),
    format: z.enum(["text", "json"]).optional().describe("Output format (text or json, default text)")
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "github",
    description: "GitHub API integration (PRs, issues, commits, releases)",
    schema: SCHEMAS.github,
    args: { action: "string", repo: "string", args: "string (optional)" },
    risk: "high",
    category: "Git & GitHub",
    source: "builtin",
    family: "github",
    handler: sidekick_github,
  }),
  Object.freeze({
    name: "ci_status",
    description: "Read-only GitHub CI/check-run inspection for a PR head, commit SHA, ref, or branch",
    schema: SCHEMAS.ci_status,
    args: { repo: "string (owner/repository)", pr: "number|string (optional, PR number)", pull_number: "number|string (optional, PR number)", sha: "string (optional, commit SHA)", commit: "string (optional, commit SHA)", ref: "string (optional, branch/ref/SHA)", branch: "string (optional, branch name)", format: "string (optional, text|json - default text)" },
    risk: "low",
    category: "Git & GitHub",
    source: "builtin",
    family: "github",
    handler: sidekick_ci_status,
  }),
]);

module.exports = { descriptors, sidekick_github, sidekick_ci_status, parseGithubArgs, getGithubArg, getCiRevisionSelector, buildCiStatusResult, formatCiStatusText, resolveGithubToken, resolveGithubApiBase, githubHealthDecision, noteGithubResponse };
