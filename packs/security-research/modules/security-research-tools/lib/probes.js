"use strict";

/**
 * Bounded probe execution — the composition centrepiece.
 *
 * A probe is a small, typed, auditable research action. It never becomes a
 * universal "run any shell command anywhere" primitive:
 *
 *   - a `command` probe composes the governed `bash` tool, and on the Sidekick
 *     host it is refused unless the operator has explicitly opted into local
 *     probes (default off) — command execution is expected to target a
 *     provisioned lab, not the process running Sidekick;
 *   - an `http` probe composes the governed `web_fetch` tool, gated by the
 *     campaign scope snapshot when present, and otherwise by an explicit host
 *     allowlist plus an SSRF guard that refuses private/loopback targets by
 *     default.
 *
 * Every probe runs through Sidekick's normal policy/approval/timeout/redaction
 * /audit path via services.dispatch — this pack adds scope and lab gating on
 * top, it does not bypass anything underneath. The raw output is captured as an
 * OBSERVATION (never an interpretation) and stored as evidence.
 */

const { ResearchError, classifyDispatchFailure } = require("./errors");
const evidence = require("./evidence");
const records = require("./records");

const MAX_OUTPUT_CHARS = 200000;

function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function hostMatchesAllowlist(host, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  return allowed.some((pattern) => globToRegExp(pattern).test(host));
}

// Parse one dotted component, honoring inet_aton's hex (0x), octal (0…) and
// decimal forms. Returns NaN on anything unparseable.
function parseIpv4Part(part) {
  if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part, 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part, 8);
  if (/^\d+$/.test(part)) return parseInt(part, 10);
  return NaN;
}

// Parse an IPv4 literal in any inet_aton-accepted form (dotted 1-4 parts, each
// decimal/hex/octal; a bare decimal or hex integer) to a 32-bit value, or null
// if it is not an IPv4 literal (e.g. a DNS hostname).
function parseIpv4(host) {
  const parts = String(host).split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = parts.map(parseIpv4Part);
  if (nums.some((n) => Number.isNaN(n) || n < 0)) return null;
  const n = parts.length;
  if (n === 1) return nums[0] > 0xffffffff ? null : nums[0] >>> 0;
  for (let i = 0; i < n - 1; i += 1) if (nums[i] > 255) return null;
  const lastMax = Math.pow(256, 4 - (n - 1));
  if (nums[n - 1] >= lastMax) return null;
  let value = 0;
  for (let i = 0; i < n - 1; i += 1) value = value * 256 + nums[i];
  value = value * lastMax + nums[n - 1];
  return value >>> 0;
}

function ipv4IsPrivate(value) {
  const a = (value >>> 24) & 255;
  const b = (value >>> 16) & 255;
  if (a === 0) return true;          // 0.0.0.0/8 (includes unspecified)
  if (a === 10) return true;         // 10/8
  if (a === 127) return true;        // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  return false;
}

// A literal-address SSRF guard. Hostnames are not DNS-resolved here (web_fetch
// performs the real connection); this normalizes and refuses the private,
// loopback, link-local and unspecified literals in the encodings an attacker
// would reach for — dotted/short/decimal/hex/octal IPv4, IPv4-mapped IPv6, and
// the IPv6 loopback/unspecified/ULA/link-local forms.
function isPrivateHost(host) {
  let h = String(host || "").trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;

  // IPv4-mapped IPv6, dotted or hex-pair form.
  let m = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (m) { const v = parseIpv4(m[1]); return v === null ? true : ipv4IsPrivate(v); }
  m = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) { const v = (((parseInt(m[1], 16) << 16) >>> 0) + parseInt(m[2], 16)) >>> 0; return ipv4IsPrivate(v); }

  // Other IPv6: loopback/unspecified/ULA/link-local are private; a global
  // address is not (the allowlist/scope governs those).
  if (h.includes(":")) {
    if (h === "::" || h === "::1") return true;
    return /^fe80:/.test(h) || /^fc/.test(h) || /^fd/.test(h);
  }

  // IPv4 in any inet_aton form.
  const value = parseIpv4(h);
  if (value !== null) return ipv4IsPrivate(value);

  // A DNS hostname — not resolved here; the host allowlist and scope snapshot
  // govern it.
  return false;
}

function boundOutput(text) {
  const str = String(text == null ? "" : text);
  if (str.length <= MAX_OUTPUT_CHARS) return { text: str, truncated: false };
  return { text: str.slice(0, MAX_OUTPUT_CHARS), truncated: true };
}

// --- scope / policy gating --------------------------------------------------

function gate(ctx, probe) {
  const { config, run } = ctx;
  const operation = probe.operation || (probe.type === "http" ? "http.request" : "execute");
  const httpCfg = config.http || {};

  // The scope check must describe the request that will actually be made. For
  // an http probe the destination is `probe.url` and nothing else: honoring a
  // caller-supplied `probe.target` here let a caller name an in-scope host
  // while pointing `url` somewhere entirely different, and the recorded
  // observation stored the label rather than the URL, so the substitution was
  // invisible afterwards too.
  let target;
  let targetKind;
  if (probe.type === "http") {
    let parsed;
    try {
      parsed = new URL(probe.url);
    } catch {
      throw new ResearchError("invalid_input", `http probe url is invalid: ${probe.url}`);
    }
    // A snapshot registered by host must still authorize a URL probe, so the
    // caller may choose which form is checked — but both are derived from the
    // URL being requested, never from a separate argument.
    targetKind = probe.target_kind === "host" ? "host" : "url";
    target = targetKind === "host" ? parsed.hostname : probe.url;
  } else {
    target = probe.target || (ctx.environment && ctx.environment.name);
    targetKind = probe.target_kind || "host";
  }

  // Type-specific host/SSRF safety ALWAYS applies — a scope snapshot authorizes
  // a target, it does not authorize running on the Sidekick host or reaching a
  // private address. These guards are defense-in-depth beneath scope.
  if (probe.type === "command") {
    // A command probe ALWAYS executes on the Sidekick host (runCommand dispatches
    // bash locally; there is no lab routing yet). So the host-execution opt-in
    // must be enforced for EVERY environment kind, and a non-local kind must be
    // refused rather than silently running on the host under a "remote" label.
    const kind = ctx.environment ? ctx.environment.kind : "local";
    if (kind !== "local") {
      throw new ResearchError("unsupported_operation", `command probes execute on the Sidekick host and cannot be routed to a '${kind}' environment. Use an http probe, or run a workspace-confined fixture with a local environment.`);
    }
    if (config.allow_local_probes !== true) {
      throw new ResearchError("policy_denied", "command probes on the Sidekick host are disabled. Set allow_local_probes: true only for a workspace-confined synthetic fixture.");
    }
  } else if (probe.type === "http") {
    const host = new URL(probe.url).hostname;
    if (isPrivateHost(host) && !ctx.networkScope) {
      throw new ResearchError("policy_denied", "private HTTP probes require a named outbound network scope bound to the campaign or run");
    }
  }

  // A bound scope snapshot is the authoritative allowlist.
  const snapshotId = run.scope_snapshot_id || ctx.scopeSnapshotId || null;
  if (snapshotId) {
    const decision = records.evaluateScope(snapshotId, {
      project_id: run.project_id,
      target,
      target_kind: targetKind,
      operation,
    });
    if (!decision || !decision.ok) {
      throw new ResearchError("scope_denied", `probe target is out of scope: ${decision ? decision.reason : "no decision"}`, { snapshot_id: snapshotId, target, operation });
    }
    return { operation, target, scope: decision };
  }

  // No scope snapshot: an http probe still needs an explicit host allowlist.
  if (probe.type === "http") {
    const host = new URL(probe.url).hostname;
    if (!hostMatchesAllowlist(host, httpCfg.allowed_hosts)) {
      throw new ResearchError("scope_denied", `http probe host ${host} is not in http.allowed_hosts and no scope snapshot is bound.`);
    }
  }
  return { operation, target, scope: null };
}

// --- execution --------------------------------------------------------------

async function runCommand(services, ctx, probe, runtime) {
  let command = String(probe.command || "").trim();
  if (!command) throw new ResearchError("invalid_input", "command probe requires a 'command'");
  if (probe.workdir) {
    // Confine an explicit workdir to the workspace for local execution.
    const ws = require("./workspace");
    const abs = require("path").resolve(probe.workdir);
    ws.assertInside(ctx.root, abs);
    command = `cd ${JSON.stringify(abs)} && ${command}`;
  }
  const result = await services.dispatch("bash", { command }, { signal: runtime && runtime.signal, timeoutMs: ctx.timeoutMs });
  return mapDispatch(result, "command");
}

async function runHttp(services, ctx, probe, runtime) {
  const args = { url: probe.url, method: probe.method || "GET" };
  if (ctx.networkScope) {
    args.network_scope = ctx.networkScope.scope_id || ctx.networkScope.name;
    args.network_scope_revision = ctx.networkScope.revision;
  }
  // web_fetch takes headers as a JSON STRING. Passing the object straight
  // through failed schema validation, and pre-stringifying by the caller was
  // dropped by the old `typeof === "object"` test — so headers never actually
  // reached a request either way.
  if (probe.headers != null) {
    args.headers = typeof probe.headers === "string" ? probe.headers : JSON.stringify(probe.headers);
  }
  if (probe.body != null) args.body = typeof probe.body === "string" ? probe.body : JSON.stringify(probe.body);
  const result = await services.dispatch("web_fetch", args, { signal: runtime && runtime.signal, timeoutMs: ctx.timeoutMs });
  return mapDispatch(result, "http");
}

function mapDispatch(result, kind) {
  const text = result && result.content && result.content[0] ? result.content[0].text : "";
  if (result && result.isError) {
    const code = classifyDispatchFailure(result.code);
    // A capability that is simply absent/denied is a structured dependency/policy
    // error, not a probe outcome; surface it as such rather than as "output".
    if (code === "dependency_missing" || code === "capability_unavailable" || code === "policy_denied") {
      throw new ResearchError(code, `probe could not compose the required capability: ${text || result.code}`, { underlying_code: result.code });
    }
    return { ok: false, kind, raw: text, underlying_code: result.code || null };
  }
  return { ok: true, kind, raw: text };
}

/**
 * Execute a probe against a run, capturing an observation and evidence.
 * Returns { observation, evidence, scope }.
 */
async function execute(services, ctx, probe, runtime) {
  if (!probe || typeof probe !== "object") throw new ResearchError("invalid_input", "probe must be an object");
  if (!["command", "http"].includes(probe.type)) throw new ResearchError("invalid_input", `unsupported probe type: ${probe.type}`);

  const gated = gate(ctx, probe);

  let outcome;
  if (probe.type === "command") outcome = await runCommand(services, ctx, probe, runtime);
  else outcome = await runHttp(services, ctx, probe, runtime);

  const bounded = boundOutput(outcome.raw);
  const observation = {
    probe: probe.name || probe.type,
    type: probe.type,
    target: gated.target || null,
    operation: gated.operation,
    // Record what was actually executed, not just the label it was checked
    // under. Evidence that cannot say which command ran or which URL was
    // requested is not reproducible, which is the point of capturing it.
    ...(probe.type === "command"
      ? { command: String(probe.command || "") }
      : { request: { url: probe.url, method: probe.method || "GET" } }),
    executed_at: new Date().toISOString(),
    succeeded: outcome.ok,
    underlying_code: outcome.underlying_code || null,
    output: bounded.text,
    output_truncated: bounded.truncated,
    scope_decision_digest: gated.scope ? gated.scope.decision_digest : null,
  };

  const captured = evidence.capture(ctx, {
    type: "observation",
    name: `${observation.probe}-observation`,
    data: JSON.stringify(observation, null, 2),
    content_type: "application/json",
    sensitivity: "sensitive",
    redaction_state: "none",
    hypothesis_id: ctx.run.hypothesis_id,
    metadata: { probe_type: probe.type, operation: gated.operation },
  });

  // No mutation of the run is needed: the captured evidence is linked to the
  // run's execution in artifact custody, and runs.get derives evidence from
  // that linkage.
  return { observation, evidence: captured, scope: gated.scope };
}

module.exports = { execute, isPrivateHost, hostMatchesAllowlist, gate };
