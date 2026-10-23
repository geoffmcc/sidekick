"use strict";

/**
 * Optional Ansible integration — a bounded, provider-agnostic playbook planner.
 *
 * This module knows nothing about Proxmox; it configures reachable hosts with
 * Ansible. It is contributed by the Proxmox pack for the provision→configure
 * composition, but is written to be extracted into a standalone Ansible pack
 * later without change. The Proxmox pack does not need to know why a host is
 * being configured, and Ansible does not need to know it was provisioned by
 * Proxmox.
 *
 * Security posture:
 *
 *   - Ansible is OPTIONAL. Absence is detected and reported, never assumed, and
 *     never auto-installed.
 *   - Only ALLOWLISTED playbooks from an administrator-configured directory run.
 *     A model can never supply a playbook path, a role, an ad-hoc module, an
 *     inventory script, a callback plugin, or extra command-line arguments.
 *   - The inventory is GENERATED from structured, validated host records. Every
 *     value is allowlist-validated before it can reach the INI file, so nothing
 *     can break out of an inventory line.
 *   - Extra variables are structured scalars, written to a JSON file and passed
 *     as `--extra-vars @file` — never interpolated into the command line.
 *   - Host key checking stays ON (no StrictHostKeyChecking=no).
 *   - Run requests fail closed until a scoped network broker and isolated
 *     workspace can safely carry its network and filesystem requirements.
 *     Dry-run planning remains available.
 */

const fs = require("fs");
const path = require("path");
const providers = require("./providers");

const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const HOST_RE = /^[a-zA-Z0-9._-]{1,253}$/; // hostname or IPv4/IPv6-literal-free address
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const VAR_KEY_RE = /^[a-z_][a-z0-9_]{0,63}$/i;
const INI_VALUE_RE = /^[A-Za-z0-9._~/:@=+-]+$/; // safe inventory value charset
const PLAYBOOK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ya?ml$/;
function isAvailable() {
  return providers.whichSync("ansible-playbook");
}

function detect(config) {
  const available = isAvailable();
  const ans = (config && config.ansible) || {};
  const configured = Boolean(ans.playbook_dir);
  let dirExists = false;
  if (configured) { try { dirExists = fs.statSync(path.resolve(ans.playbook_dir)).isDirectory(); } catch { dirExists = false; } }
  const providerState = !available ? "not_installed" : !configured ? "installed_unconfigured" : !dirExists ? "misconfigured" : "ready";
  const executionBlocker = "No scoped network broker is configured for Ansible; unrestricted host networking is not granted to shell commands.";
  return {
    available,
    configured,
    playbook_dir_exists: dirExists,
    allowed_playbooks: Array.isArray(ans.allowed_playbooks) ? ans.allowed_playbooks : null,
    execution_available: false,
    execution_blocker: executionBlocker,
    state: providerState === "ready" ? "execution_unavailable" : providerState,
    detail: !available
      ? "ansible-playbook is not on the Sidekick host PATH."
      : !configured
        ? "Ansible is installed but no playbook_dir is configured for the pack."
        : !dirExists
          ? `Configured ansible.playbook_dir does not exist: ${ans.playbook_dir}`
          : executionBlocker,
  };
}

/** Resolve an allowlisted playbook to an absolute path confined to playbook_dir. */
function resolvePlaybook(config, name) {
  const ans = (config && config.ansible) || {};
  if (!ans.playbook_dir) return { ok: false, code: "not_configured", message: "No ansible.playbook_dir is configured." };
  if (typeof name !== "string" || !PLAYBOOK_NAME_RE.test(name)) {
    return { ok: false, code: "invalid_input", message: "playbook must be a .yml/.yaml file name (no path components)." };
  }
  if (Array.isArray(ans.allowed_playbooks) && ans.allowed_playbooks.length && !ans.allowed_playbooks.includes(name)) {
    return { ok: false, code: "not_allowed", message: `playbook "${name}" is not in ansible.allowed_playbooks.` };
  }
  const dir = path.resolve(ans.playbook_dir);
  const resolved = path.resolve(dir, name);
  // Confinement: the resolved path must sit directly inside the playbook dir.
  const rel = path.relative(dir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
    return { ok: false, code: "invalid_input", message: "playbook path escapes the configured playbook_dir." };
  }
  try { if (!fs.statSync(resolved).isFile()) throw new Error("not a file"); }
  catch { return { ok: false, code: "resource_missing", message: `playbook not found: ${name}` }; }
  return { ok: true, path: resolved, dir };
}

/** Build an INI inventory from validated structured hosts. `opts` may carry an
 * administrator host allowlist and an SSH key directory to confine key files. */
function buildInventory(hosts, opts = {}) {
  if (!Array.isArray(hosts) || !hosts.length) return { ok: false, message: "at least one inventory host is required" };
  const allowedHosts = Array.isArray(opts.allowed_hosts) && opts.allowed_hosts.length ? new Set(opts.allowed_hosts.map(String)) : null;
  const keyDir = typeof opts.ssh_key_dir === "string" && opts.ssh_key_dir ? path.resolve(opts.ssh_key_dir) : null;
  const lines = [];
  const aliases = [];
  for (const h of hosts) {
    if (!h || typeof h !== "object") return { ok: false, message: "each host must be an object" };
    if (!ALIAS_RE.test(String(h.alias || ""))) return { ok: false, message: `invalid host alias: ${JSON.stringify(h.alias)}` };
    if (!HOST_RE.test(String(h.host || ""))) return { ok: false, message: `invalid host address: ${JSON.stringify(h.host)}` };
    if (allowedHosts && !allowedHosts.has(String(h.host))) return { ok: false, message: `host ${JSON.stringify(h.host)} is not in ansible.allowed_hosts` };
    const parts = [h.alias, `ansible_host=${h.host}`];
    if (h.user !== undefined) { if (!USER_RE.test(String(h.user))) return { ok: false, message: `invalid ssh user: ${JSON.stringify(h.user)}` }; parts.push(`ansible_user=${h.user}`); }
    if (h.port !== undefined) { const p = Number(h.port); if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, message: "invalid ssh port" }; parts.push(`ansible_port=${p}`); }
    if (h.ssh_key_file !== undefined) {
      const kf = String(h.ssh_key_file);
      // No traversal, and an absolute path only. If a key directory is
      // configured, the key must resolve inside it.
      if (!INI_VALUE_RE.test(kf) || kf.includes("..") || !path.isAbsolute(kf)) return { ok: false, message: "ssh_key_file must be an absolute path with no '..' segments" };
      if (keyDir) { const rel = path.relative(keyDir, path.resolve(kf)); if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, message: "ssh_key_file is outside the configured ansible.ssh_key_dir" }; }
      parts.push(`ansible_ssh_private_key_file=${kf}`);
    }
    // Final guard: every emitted token must be inventory-safe.
    for (const tok of parts) { const v = tok.includes("=") ? tok.split("=").slice(1).join("=") : tok; if (!INI_VALUE_RE.test(v) && !ALIAS_RE.test(v)) return { ok: false, message: `unsafe inventory token: ${tok}` }; }
    lines.push(parts.join(" "));
    aliases.push(h.alias);
  }
  return { ok: true, ini: `[targets]\n${lines.join("\n")}\n`, aliases };
}

/** Validate structured extra-vars (scalars and scalar arrays only). */
function buildExtraVars(vars) {
  if (vars === undefined || vars === null) return { ok: true, vars: {} };
  if (typeof vars !== "object" || Array.isArray(vars)) return { ok: false, message: "extra_vars must be an object" };
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    if (!VAR_KEY_RE.test(k)) return { ok: false, message: `invalid extra var name: ${k}` };
    if (["string", "number", "boolean"].includes(typeof v)) out[k] = v;
    else if (Array.isArray(v) && v.every(x => ["string", "number", "boolean"].includes(typeof x))) out[k] = v;
    else return { ok: false, message: `extra var ${k} must be a scalar or array of scalars` };
  }
  return { ok: true, vars: out };
}

/**
 * Extract the first complete top-level JSON object from mixed output. Ansible
 * may write its JSON callback to stdout and warnings/deprecations to stderr,
 * so slicing to the end of the text would include trailing non-JSON and break parsing. This walks
 * balanced braces, honouring string literals, and returns exactly the JSON
 * document.
 */
function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/** Parse ansible's JSON stdout callback. Success = every host with 0 failures and 0 unreachable, and at least one play ran. */
function parseResult(stdout, exitCode, aliases) {
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { parsed = null; }
  if (!parsed || !parsed.stats || typeof parsed.stats !== "object") {
    return { ok: false, reason: "ansible output could not be parsed as JSON stats (stdout truncated or callback not json)", per_host: {}, exit_code: exitCode };
  }
  const perHost = {};
  let anyFailure = false;
  for (const [host, s] of Object.entries(parsed.stats)) {
    const failures = Number(s.failures || 0) + Number(s.unreachable || 0);
    perHost[host] = { ok: Number(s.ok || 0), changed: Number(s.changed || 0), failures: Number(s.failures || 0), unreachable: Number(s.unreachable || 0) };
    if (failures > 0) anyFailure = true;
  }
  // Every requested host must appear in stats, else treat as unreachable.
  const missing = (aliases || []).filter(a => !(a in parsed.stats));
  for (const m of missing) { perHost[m] = { ok: 0, changed: 0, failures: 0, unreachable: 1 }; anyFailure = true; }
  const ok = !anyFailure && exitCode === 0 && Object.keys(parsed.stats).length > 0;
  return { ok, reason: ok ? null : (missing.length ? `hosts missing from results: ${missing.join(",")}` : "one or more hosts reported failures/unreachable"), per_host: perHost, exit_code: exitCode };
}

/**
 * Build the exact ansible-playbook command. Only module-created paths are
 * interpolated (single-quoted); model-supplied values live inside the files.
 */
function buildCommand({ playbookPath, invPath, varsPath, limit }) {
  const q = p => `'${p}'`; // paths are module-generated, no quotes/spaces
  const env = "ANSIBLE_HOST_KEY_CHECKING=True ANSIBLE_STDOUT_CALLBACK=json ANSIBLE_RETRY_FILES_ENABLED=False ANSIBLE_NOCOLOR=1";
  let cmd = `${env} ansible-playbook -i ${q(invPath)} ${q(playbookPath)} --extra-vars @${q(varsPath)}`;
  if (limit) cmd += ` --limit ${q(limit)}`; // limit is a validated alias
  return cmd;
}

/**
 * Validate an allowlisted playbook and provide a dry-run plan. Execution stays
 * unavailable until a scoped network broker and isolated workspace are wired.
 */
async function run(config, _dispatch, params, { dryRun = false } = {}) {
  const availability = detect(config);
  if (!availability.available) return { ok: false, code: "provider_unavailable", message: availability.detail, availability };
  if (!["ready", "execution_unavailable"].includes(availability.state)) return { ok: false, code: "not_configured", message: availability.detail, availability };

  const pb = resolvePlaybook(config, params.playbook);
  if (!pb.ok) return { ok: false, code: pb.code, message: pb.message };
  const ans = config.ansible || {};
  const inv = buildInventory(params.hosts, { allowed_hosts: ans.allowed_hosts, ssh_key_dir: ans.ssh_key_dir });
  if (!inv.ok) return { ok: false, code: "invalid_input", message: inv.message };
  const ev = buildExtraVars(params.extra_vars);
  if (!ev.ok) return { ok: false, code: "invalid_input", message: ev.message };
  let limit = null;
  if (params.limit !== undefined) { if (!ALIAS_RE.test(String(params.limit))) return { ok: false, code: "invalid_input", message: "limit must be a host alias" }; limit = params.limit; }

  if (dryRun) {
    return {
      ok: true, dry_run: true, playbook: params.playbook, hosts: inv.aliases,
      command: buildCommand({ playbookPath: pb.path, invPath: "<isolated-workspace>/inventory.ini", varsPath: "<isolated-workspace>/extra_vars.json", limit }),
      inventory: inv.ini, extra_var_keys: Object.keys(ev.vars),
      note: "Dry run: nothing was executed. Extra-var VALUES are omitted; execution remains unavailable until a scoped network broker is configured.",
    };
  }
  return {
    ok: false,
    code: "capability_unavailable",
    message: "Ansible execution requires a scoped network broker and isolated workspace, which are not configured; no command was executed.",
  };
}

module.exports = { isAvailable, detect, resolvePlaybook, buildInventory, buildExtraVars, parseResult, buildCommand, extractJsonObject, run };
