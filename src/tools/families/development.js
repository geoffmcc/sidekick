"use strict";

// Development tool family: git, changelog, depend.
//
// Extracted from src/tools-legacy.js. Depends only on Node builtins, zod,
// shared non-legacy modules (redact, path-policy, core/command-validation),
// and the inference family's sidekick_llm (changelog's optional use_llm
// path) — never on tools-legacy.js. All handlers and helpers move verbatim;
// risk classifications (all medium) are preserved from src/tools/metadata.js
// and gated by the dispatcher.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { z } = require("zod");
const { redactSensitive } = require("../../redact");
const { enforcePathPolicy } = require("../path-policy");
const { resolveOutboundUrl } = require("../../security/outbound-url");
const { validIdentifier } = require("../../core/command-validation");
const { readTextBounded } = require("../../core/bounded-file-read");
const { writeTextFile } = require("../../core/json-file-store");
const { runLlm } = require("./inference");
const { childProcessEnv } = require("../../security/child-process");
const { requireToolExecution, requireCanonicalInvocation } = require("../read-authorization");

const GIT_EXTERNAL_EXECUTION_OPTIONS = /^(?:-c(?:$|=)|--config(?:=|-env(?:=|$))|--(?:exec-path|upload-pack|receive-pack|git-dir|work-tree)(?:=|$)|--(?:ext-diff|paginate)(?:=|$))/;
const GIT_OUTPUT_FILE_OPTIONS = /^(?:-o(?:.+)?|--output(?:=|$))/;
const GIT_CLONE_TIMEOUT_MS = 120000;
const GIT_CLONE_MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_CHANGELOG_BYTES = 5 * 1024 * 1024;
const MAX_CHANGELOG_REVISION_LENGTH = 256;
const GIT_FILTER_EXECUTION_ACTIONS = new Set(["add", "commit", "checkout", "pull", "stash"]);

function cloneError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function hostAllowed(host, allowedHosts) {
  if (!allowedHosts) return true;
  const normalized = String(host).toLowerCase();
  return allowedHosts.some(entry => {
    const value = String(entry).toLowerCase();
    return value === normalized || value.startsWith("*.") && normalized.endsWith(value.slice(1));
  });
}

function sanitizedRemoteIdentity(sourceUrl) {
  const parsed = new URL(sourceUrl);
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return { scheme: parsed.protocol.slice(0, -1), host: parsed.hostname.toLowerCase(), path: parsed.pathname };
}

async function cloneGit({ source_url: sourceUrl, destination, ref, allowed_hosts: allowedHosts }) {
  const value = String(sourceUrl || "");
  if (/[\x00-\x1f\x7f]/.test(value)) return cloneError("source_url contains control characters");
  const destinationText = String(destination || "");
  if (!path.isAbsolute(destinationText)) return cloneError("destination must be an absolute path");
  const pathPolicyError = enforcePathPolicy(destinationText, "write");
  if (pathPolicyError) return pathPolicyError;
  if (allowedHosts && (!Array.isArray(allowedHosts) || allowedHosts.length > 32 || allowedHosts.some(host => typeof host !== "string" || !/^[A-Za-z0-9.*:-]{1,253}$/.test(host)))) {
    return cloneError("allowed_hosts must be a bounded list of host patterns");
  }

  let destinationExists = false;
  try {
    const stat = fs.lstatSync(destinationText);
    destinationExists = true;
    if (stat.isSymbolicLink() || !stat.isDirectory()) return cloneError("destination must be a real directory");
    if (fs.readdirSync(destinationText).length) return cloneError("destination must be non-existing or empty");
  } catch (error) {
    if (error.code !== "ENOENT") return cloneError("destination could not be inspected safely");
  }
  const destinationParent = path.dirname(destinationText);
  try {
    const parentStat = fs.lstatSync(destinationParent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return cloneError("destination parent must be a real directory");
  } catch { return cloneError("destination parent does not exist"); }
  if (ref != null && (typeof ref !== "string" || !ref || ref.length > 1024 || /[\x00-\x1f\x7f]/.test(ref))) return cloneError("ref is invalid");

  let resolved;
  try { resolved = await resolveOutboundUrl(value, "source_url", { allowPrivate: false }); }
  catch { return cloneError("source_url could not be validated safely"); }
  if (resolved.refusal) return cloneError(resolved.refusal);
  if (resolved.url.protocol !== "https:") return cloneError("source_url must use https");
  if (!hostAllowed(resolved.url.hostname, allowedHosts)) return cloneError("source_url host is not in allowed_hosts");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-git-home-"));
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-git-hooks-"));
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, "empty.gitconfig"),
    GIT_LFS_SKIP_SMUDGE: "1",
  };
  let createdDestination = false;
  const gitConfig = [
    "-c", "credential.helper=",
    "-c", `core.hooksPath=${hooks}`,
    "-c", "core.fsmonitor=false",
    "-c", "diff.external=",
    "-c", "merge.external=",
    "-c", "filter.lfs.clean=",
    "-c", "filter.lfs.smudge=",
    "-c", "filter.lfs.process=",
    "-c", "filter.lfs.required=false",
    "-c", "protocol.file.allow=never",
    "-c", "protocol.ext.allow=never",
    "-c", "protocol.ssh.allow=never",
    "-c", "http.followRedirects=false",
  ];
  const resolvedPort = resolved.url.port || "443";
  const resolvedAddress = String(resolved.address || "").includes(":") ? `[${resolved.address}]` : resolved.address;
  if (!resolvedAddress) return cloneError("source_url did not resolve to a pin-able address");
  gitConfig.push("-c", `http.curloptResolve=${resolved.url.hostname}:${resolvedPort}:${resolvedAddress}`);
  const runGit = (args) => execFileSync("git", args, {
    env,
    timeout: GIT_CLONE_TIMEOUT_MS,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_CLONE_MAX_OUTPUT,
  });
  try {
    fs.writeFileSync(path.join(home, "empty.gitconfig"), "", { flag: "wx", mode: 0o600 });
    if (!destinationExists) { fs.mkdirSync(destinationText, { mode: 0o700 }); createdDestination = true; }
    const cloneArgs = [...gitConfig, "clone", "--no-recurse-submodules", "--no-checkout", value, destinationText];
    runGit(cloneArgs);
    const requestedRef = ref || "HEAD";
    const resolvedRef = runGit(["-C", destinationText, ...gitConfig, "rev-parse", "--verify", "--end-of-options", `${requestedRef}^{commit}`]).trim();
    runGit(["-C", destinationText, ...gitConfig, "checkout", "--detach", "--force", resolvedRef]);
    const origin = runGit(["-C", destinationText, ...gitConfig, "config", "--get", "remote.origin.url"]).trim();
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, action: "clone", destination: destinationText, requested_ref: ref || null, resolved_ref: resolvedRef, remote_identity: sanitizedRemoteIdentity(origin || value) }) }] };
  } catch (error) {
    const detail = String(error && (error.stderr || error.stdout || error.message) || "git clone failed").replace(/https?:\/\/[^\s]+/gi, "[redacted-url]").slice(0, 2000);
    if (createdDestination) {
      try { const stat = fs.lstatSync(destinationText); if (!stat.isSymbolicLink()) fs.rmSync(destinationText, { recursive: true, force: true }); } catch {}
    }
    return cloneError(`Git clone failed: ${redactSensitive(detail)}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(hooks, { recursive: true, force: true });
  }
}

function parseGitExtraArgs(extraArgs) {
  if (!extraArgs) return [];
  // Git pretty formats use ASCII unit separator (\x1f) as a field delimiter.
  // JavaScript classifies it as whitespace, so /\s+/ would silently split a
  // single --pretty argument and corrupt structured history parsing.
  const parsed = [];
  let current = ""; let quote = null; let escaped = false;
  for (const char of String(extraArgs)) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { parsed.push(current); current = ""; } continue; }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in Git arguments");
  if (current) parsed.push(current);
  if (parsed.some(arg => GIT_EXTERNAL_EXECUTION_OPTIONS.test(arg))) {
    throw new Error("Git arguments that alter configuration, helpers, execution paths, or pagers are not permitted");
  }
  if (parsed.some(arg => GIT_OUTPUT_FILE_OPTIONS.test(arg))) {
    throw new Error("Git output-file arguments are not permitted because they bypass path authorization");
  }
  return parsed;
}

function readGitMetadataFile(filePath, maxBytes = 4096) {
  let before;
  try { before = fs.lstatSync(filePath); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
    throw new Error("Git metadata file is not a bounded regular file");
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) {
      throw new Error("Git metadata file changed while being opened");
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function checkGitMetadataReferences(gitDir, operation) {
  let commonDir = gitDir;
  const commonDirFile = path.join(gitDir, "commondir");
  const commonDirPolicyError = enforcePathPolicy(commonDirFile, operation);
  if (commonDirPolicyError) return commonDirPolicyError;
  let commonDirText;
  try { commonDirText = readGitMetadataFile(commonDirFile); } catch {
    return { content: [{ type: "text", text: "Git common-directory metadata is invalid." }], isError: true };
  }
  if (commonDirText !== null) {
    const target = commonDirText.trim();
    if (!target || target.includes("\n") || target.includes("\r")) {
      return { content: [{ type: "text", text: "Git common-directory metadata is invalid." }], isError: true };
    }
    try {
      commonDir = fs.realpathSync(path.resolve(gitDir, target));
      if (!fs.statSync(commonDir).isDirectory()) throw new Error("not a directory");
    } catch {
      return { content: [{ type: "text", text: "Git common directory is unavailable or invalid." }], isError: true };
    }
    const policyError = enforcePathPolicy(commonDir, operation);
    if (policyError) return policyError;
  }

  const alternatesFile = path.join(commonDir, "objects", "info", "alternates");
  const alternatesPolicyError = enforcePathPolicy(alternatesFile, operation);
  if (alternatesPolicyError) return alternatesPolicyError;
  let alternates;
  try { alternates = readGitMetadataFile(alternatesFile, 64 * 1024); } catch {
    return { content: [{ type: "text", text: "Git alternate-object metadata is invalid." }], isError: true };
  }
  if (alternates === null) return null;
  for (const entry of alternates.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    let target;
    try {
      target = fs.realpathSync(path.resolve(commonDir, "objects", entry));
      if (!fs.statSync(target).isDirectory()) throw new Error("not a directory");
    } catch {
      return { content: [{ type: "text", text: "Git alternate object directory is unavailable or invalid." }], isError: true };
    }
    const policyError = enforcePathPolicy(target, operation);
    if (policyError) return policyError;
  }
  return null;
}

function getActiveGitFilterDrivers(repo, gitEnv, safeGitConfig) {
  const files = execFileSync("git", [...safeGitConfig, "-C", repo, "ls-files", "--cached", "--others", "-z"], {
    cwd: repo, env: gitEnv, timeout: 10000, encoding: "buffer", maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (files.length === 0) return [];
  const attributes = execFileSync("git", [...safeGitConfig, "-C", repo, "check-attr", "-z", "--stdin", "filter"], {
    cwd: repo, env: gitEnv, timeout: 10000, input: files, encoding: "buffer", maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  }).toString("utf8").split("\0");
  if (attributes.length % 3 !== 1) throw new Error("unexpected Git attribute response");
  const drivers = new Set();
  for (let index = 0; index + 2 < attributes.length; index += 3) {
    if (attributes[index + 1] !== "filter") continue;
    const value = attributes[index + 2];
    if (value && value !== "unspecified" && value !== "unset") drivers.add(value);
  }
  return [...drivers];
}

function getTreeGitFilterDrivers(repo, source, gitEnv, safeGitConfig) {
  const tree = execFileSync("git", [...safeGitConfig, "-C", repo, "ls-tree", "-r", "-z", source], {
    cwd: repo, env: gitEnv, timeout: 10000, encoding: "buffer", maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const files = [];
  for (const entry of tree.toString("utf8").split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("unexpected Git tree response");
    files.push(entry.slice(tab + 1));
  }
  if (!files.length) return [];
  const input = Buffer.from(files.join("\0") + "\0");
  const attributes = execFileSync("git", [...safeGitConfig, "-C", repo, "check-attr", "-z", `--source=${source}`, "--stdin", "filter"], {
    cwd: repo, env: gitEnv, timeout: 10000, input, encoding: "buffer", maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  }).toString("utf8").split("\0");
  if (attributes.length % 3 !== 1) throw new Error("unexpected Git attribute response");
  const drivers = new Set();
  for (let index = 0; index + 2 < attributes.length; index += 3) {
    if (attributes[index + 1] !== "filter") continue;
    const value = attributes[index + 2];
    if (value && value !== "unspecified" && value !== "unset") drivers.add(value);
  }
  return [...drivers];
}

function getUnsafeGitPushConfig(repo, gitEnv, safeGitConfig) {
  const config = execFileSync("git", [...safeGitConfig, "-C", repo, "config", "--local", "--null", "--list"], {
    cwd: repo, env: gitEnv, timeout: 10000, encoding: "buffer", maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).toString("utf8");
  const unsafe = new Set();
  for (const record of config.split("\0")) {
    const separator = record.indexOf("\n");
    if (separator < 0) continue;
    const key = record.slice(0, separator).toLowerCase();
    const value = record.slice(separator + 1).trim();
    if (!value) continue;
    if (key === "core.sshcommand" || key === "core.askpass" ||
      key === "credential.helper" || key.startsWith("credential.") && key.endsWith(".helper") ||
      /^remote\..+\.(?:vcs|uploadpack|receivepack)$/.test(key)) unsafe.add(key);
  }
  return [...unsafe];
}

async function sidekick_git({ action, path: repoPath, args: extraArgs, source_url: sourceUrl, destination, ref, allowed_hosts: allowedHosts }) {
  const authorizationError = requireToolExecution({ tool: "git", action: action || null, path: repoPath || null }, "tools.execute", "git");
  if (authorizationError) return authorizationError;
  if (action === "clone") return cloneGit({ source_url: sourceUrl, destination, ref, allowed_hosts: allowedHosts });
  const repo = repoPath || ".";
  const allowedActions = ["status", "diff", "log", "show", "ls-tree", "ls-files", "add", "commit", "push", "pull", "branch", "checkout", "stash"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const writeActions = new Set(["add", "commit", "pull", "branch", "checkout", "stash"]);
  const policyError = enforcePathPolicy(repo, writeActions.has(action) ? "write" : "read");
  if (policyError) return policyError;
  if (!fs.existsSync(repo)) {
    return { content: [{ type: "text", text: "Repository path not found: " + repo }], isError: true };
  }

  const gitFile = path.join(repo, ".git");
  const metadataPolicyError = enforcePathPolicy(gitFile, writeActions.has(action) ? "write" : "read");
  if (metadataPolicyError) return metadataPolicyError;
  let gitEnv = childProcessEnv();
  // Repository-local fsmonitor config executes helpers during ordinary reads.
  // External diff is disabled per subcommand below. These targeted controls do
  // not sandbox Git as a process.
  const safeGitConfig = ["-c", "core.fsmonitor=false"];
  let cmdArgs = [...safeGitConfig, "-C", repo, action];
  let gitMetadataStat;
  try { gitMetadataStat = fs.lstatSync(gitFile); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (gitMetadataStat?.isSymbolicLink()) {
    return { content: [{ type: "text", text: "Git metadata symlinks are not permitted." }], isError: true };
  }
  if (gitMetadataStat?.isFile()) {
    let content;
    try { content = readGitMetadataFile(gitFile).trim(); } catch {
      return { content: [{ type: "text", text: "Git metadata file is invalid." }], isError: true };
    }
    const match = content.match(/^gitdir:\s*(.+)$/i);
    if (match) {
      const gitDirPath = path.resolve(repo, match[1].trim());
      let canonicalGitDir;
      try {
        canonicalGitDir = fs.realpathSync(gitDirPath);
        if (!fs.statSync(canonicalGitDir).isDirectory()) throw new Error("not a directory");
      } catch {
        return { content: [{ type: "text", text: "Git metadata target is unavailable or invalid." }], isError: true };
      }
      const gitDirPolicyError = enforcePathPolicy(canonicalGitDir, writeActions.has(action) ? "write" : "read");
      if (gitDirPolicyError) return gitDirPolicyError;
      const referencesError = checkGitMetadataReferences(canonicalGitDir, writeActions.has(action) ? "write" : "read");
      if (referencesError) return referencesError;
      // Let Git discover the checked .git file from the checked worktree. Do
      // not convey repository-selection authority through GIT_DIR variables.
      cmdArgs = [...safeGitConfig, "-C", repo, action];
    }
  } else if (gitMetadataStat?.isDirectory()) {
    let canonicalGitDir;
    try { canonicalGitDir = fs.realpathSync(gitFile); } catch {
      return { content: [{ type: "text", text: "Git metadata directory is unavailable." }], isError: true };
    }
    const gitDirPolicyError = enforcePathPolicy(canonicalGitDir, writeActions.has(action) ? "write" : "read");
    if (gitDirPolicyError) return gitDirPolicyError;
    const referencesError = checkGitMetadataReferences(canonicalGitDir, writeActions.has(action) ? "write" : "read");
    if (referencesError) return referencesError;
  }
  if (["diff", "show", "log"].includes(action)) cmdArgs.push("--no-ext-diff", "--no-textconv");
  if (extraArgs) {
    try {
      cmdArgs.push(...parseGitExtraArgs(extraArgs));
    } catch (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
  }

  if (GIT_FILTER_EXECUTION_ACTIONS.has(action)) {
    // A pull can introduce attributes we cannot know until after the fetch,
    // so it must not reach Git's merge/checkout filter path. A safe fetch and
    // inspect flow needs a separate explicit tool contract.
    if (action === "pull") {
      return { content: [{ type: "text", text: "Git pull is blocked because incoming attributes may invoke executable filters before they can be inspected. Fetch and inspect changes through an isolated Git workflow." }], isError: true };
    }
    let filterDrivers;
    try { filterDrivers = getActiveGitFilterDrivers(repo, gitEnv, safeGitConfig); } catch {
      return { content: [{ type: "text", text: "Git filter attributes could not be checked; operation denied." }], isError: true };
    }
    if (action === "checkout") {
      const candidates = cmdArgs.slice(cmdArgs.indexOf("checkout") + 1).filter(arg => !arg.startsWith("-"));
      try {
        for (const candidate of candidates) {
          try {
            execFileSync("git", [...safeGitConfig, "-C", repo, "rev-parse", "--verify", `${candidate}^{tree}`], {
              cwd: repo, env: gitEnv, timeout: 10000, stdio: "ignore",
            });
          } catch { continue; } // Pathspecs and newly created branch names are not tree sources.
          filterDrivers.push(...getTreeGitFilterDrivers(repo, candidate, gitEnv, safeGitConfig));
        }
      } catch {
        return { content: [{ type: "text", text: "Git checkout target filter attributes could not be checked; operation denied." }], isError: true };
      }
    }
    if (filterDrivers.length > 0) {
      return { content: [{ type: "text", text: `Git operation blocked: active filter attributes (${filterDrivers.join(", ")}) require executable filters, which cannot run without OS-enforced isolation.` }], isError: true };
    }
  }

  if (action === "push") {
    const protocolPolicy = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always"];
    safeGitConfig.push(...protocolPolicy);
    cmdArgs.unshift(...protocolPolicy);
    let unsafeConfig;
    try { unsafeConfig = getUnsafeGitPushConfig(repo, gitEnv, safeGitConfig); } catch {
      return { content: [{ type: "text", text: "Git push configuration could not be checked; operation denied." }], isError: true };
    }
    if (unsafeConfig.length > 0) {
      return { content: [{ type: "text", text: `Git push blocked: repository-local executable transport or credential settings require isolation (${unsafeConfig.join(", ")}).` }], isError: true };
    }
  }

  let hooksPath;
  try {
    hooksPath = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-git-hooks-"));
    cmdArgs.unshift("-c", `core.hooksPath=${hooksPath}`);
    const stdout = execFileSync("git", cmdArgs, { cwd: repo, env: gitEnv, timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactSensitive("Exit code: " + e.status + "\n" + (e.stderr || e.stdout || "")) }], isError: true };
  } finally {
    if (hooksPath) {
      try { fs.rmSync(hooksPath, { recursive: true, force: true }); } catch {}
    }
  }
}

const COMMIT_TYPE_MAP = {
  feat: "Features",
  fix: "Bug Fixes",
  docs: "Documentation",
  style: "Styles",
  refactor: "Code Refactoring",
  perf: "Performance Improvements",
  test: "Tests",
  build: "Build System",
  ci: "Continuous Integration",
  chore: "Chores",
  revert: "Reverts",
  deps: "Dependencies"
};

function parseConventionalCommit(message) {
  const match = message.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (!match) {
    return { type: "other", scope: null, breaking: false, description: message };
  }
  return {
    type: match[1].toLowerCase(),
    scope: match[2] || null,
    breaking: !!match[3] || message.includes("BREAKING CHANGE:"),
    description: match[4]
  };
}

function resolveChangelogRevision(cwd, revision, execute = execFileSync) {
  if (typeof revision !== "string" || !revision || revision.length > MAX_CHANGELOG_REVISION_LENGTH) {
    throw new Error("Git revision is invalid or too long");
  }
  const resolved = execute("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", `safe.directory=${cwd}`, "-C", cwd,
    "rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], {
    cwd,
    env: childProcessEnv(),
    timeout: 10000,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(resolved)) throw new Error("Git revision did not resolve to a commit");
  return resolved;
}

function readChangelogFile(filePath) {
  if (enforcePathPolicy(filePath, "read")) throw new Error("Changelog is outside the configured read scope");
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Changelog must be a regular, non-symlink file");
    const read = readTextBounded(filePath, { maxBytes: MAX_CHANGELOG_BYTES, requireComplete: true, noFollow: true });
    return { content: read.content, mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return { content: "", mode: 0o600 };
    throw error;
  }
}

function writeChangelogFile(filePath, content, mode = 0o600) {
  if (enforcePathPolicy(filePath, "write")) throw new Error("Changelog is outside the configured write scope");
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Changelog must be a regular, non-symlink file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (enforcePathPolicy(filePath, "write")) throw new Error("Changelog is outside the configured write scope");
  writeTextFile(filePath, content, { maxBytes: MAX_CHANGELOG_BYTES, mode });
}

async function sidekick_changelog({ action, from, to, format, group_by, use_llm, include, path: repoPath }) {
  const denied = requireCanonicalInvocation("changelog");
  if (denied) return denied;
  if (!from) {
    return { content: [{ type: "text", text: "from parameter required (starting ref: tag, commit, or branch)" }], isError: true };
  }

  const toRef = to || "HEAD";
  const fmt = format || "markdown";
  const groupBy = group_by || "type";
  const includeType = include || "all";
  let cwd = repoPath || process.cwd();
  const pathPolicyError = enforcePathPolicy(cwd, action === "save" ? "write" : "read");
  if (pathPolicyError) return pathPolicyError;
  try {
    cwd = fs.realpathSync(cwd);
    if (!fs.statSync(cwd).isDirectory()) throw new Error("Repository path must be a directory");
  } catch (error) {
    return { content: [{ type: "text", text: `Repository path is unavailable: ${error.message}` }], isError: true };
  }

  let logOutput = "";
  try {
    const fromCommit = resolveChangelogRevision(cwd, from);
    const toCommit = resolveChangelogRevision(cwd, toRef);
    logOutput = execFileSync("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", `safe.directory=${cwd}`, "-C", cwd,
      "log", "--no-show-signature", `${fromCommit}..${toCommit}`, "--pretty=format:%H|%s|%an|%ad", "--date=short"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], cwd, env: childProcessEnv(), timeout: 30000, maxBuffer: MAX_CHANGELOG_BYTES,
    });
  } catch (e) {
    return { content: [{ type: "text", text: `Git log failed: ${e.message}\n\nMake sure you're in a git repository and the refs exist.` }], isError: true };
  }

  if (!logOutput.trim()) {
    return { content: [{ type: "text", text: `No commits found between ${from} and ${toRef}` }] };
  }

  const commits = logOutput.trim().split("\n").map(line => {
    const [hash, message, author, date] = line.split("|");
    const parsed = parseConventionalCommit(message);
    return { hash, message, author, date, ...parsed };
  });

  let filtered = commits;
  if (includeType !== "all") {
    const typeFilter = {
      features: ["feat"],
      fixes: ["fix"],
      breaking: commits.filter(c => c.breaking).map(c => c.type),
      refactor: ["refactor"],
      deps: ["deps", "chore"]
    };
    const allowedTypes = typeFilter[includeType] || [];
    filtered = commits.filter(c => allowedTypes.includes(c.type) || (includeType === "breaking" && c.breaking));
  }

  if (filtered.length === 0) {
    return { content: [{ type: "text", text: `No commits matching filter "${includeType}" between ${from} and ${toRef}` }] };
  }

  const grouped = {};
  for (const commit of filtered) {
    let key;
    if (groupBy === "type") {
      key = COMMIT_TYPE_MAP[commit.type] || commit.type;
    } else if (groupBy === "scope") {
      key = commit.scope || "general";
    } else if (groupBy === "author") {
      key = commit.author;
    } else {
      key = "other";
    }
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(commit);
  }

  let changelog = "";

  if (fmt === "markdown") {
    const breaking = filtered.filter(c => c.breaking);
    if (breaking.length > 0) {
      changelog += "## ⚠ BREAKING CHANGES\n\n";
      for (const c of breaking) {
        changelog += `- ${c.description} (${c.hash.substring(0, 7)})\n`;
      }
      changelog += "\n";
    }

    for (const [group, commits] of Object.entries(grouped)) {
      if (groupBy === "type" && group === "other") continue;
      changelog += `## ${group}\n\n`;
      for (const c of commits) {
        const scope = c.scope ? `**${c.scope}:** ` : "";
        changelog += `- ${scope}${c.description} (${c.hash.substring(0, 7)})\n`;
      }
      changelog += "\n";
    }

    changelog += `---\n**${filtered.length} commits** from ${from} to ${toRef}\n`;
  } else if (fmt === "plain") {
    for (const [group, commits] of Object.entries(grouped)) {
      changelog += `${group}:\n`;
      for (const c of commits) {
        changelog += `  - ${c.description}\n`;
      }
      changelog += "\n";
    }
  } else if (fmt === "conventional") {
    for (const c of filtered) {
      changelog += `${c.message}\n`;
    }
  }

  if (use_llm && fmt === "markdown") {
    try {
      const summaryPrompt = `Summarize these ${filtered.length} git commits in 2-3 sentences for release notes. Focus on what changed and why it matters:\n\n${filtered.map(c => `- ${c.message}`).join("\n")}`;
      const llmResult = await runLlm({
        prompt: summaryPrompt,
        system: "You are a technical writer creating release notes. Be concise and focus on user-facing changes.",
        temperature: 0.3
      });
      if (llmResult.content && llmResult.content[0]) {
        changelog = `## Summary\n\n${llmResult.content[0].text}\n\n${changelog}`;
      }
    } catch (e) {
      changelog += `\n*LLM summary failed: ${e.message}*\n`;
    }
  }

  if (action === "preview" || action === "generate") {
    return { content: [{ type: "text", text: changelog }] };
  }

  if (action === "save") {
    const changelogPath = path.join(cwd, "CHANGELOG.md");
    let existing;
    try { existing = readChangelogFile(changelogPath); }
    catch (error) { return { content: [{ type: "text", text: `Unable to read changelog: ${error.message}` }], isError: true }; }

    const date = new Date().toISOString().split("T")[0];
    const header = `## ${date}\n\n`;
    const newEntry = header + changelog;

    const lines = existing.content.split("\n");
    let insertIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("# ")) {
        insertIndex = i + 1;
        while (insertIndex < lines.length && lines[insertIndex].trim() === "") insertIndex++;
        break;
      }
    }

    lines.splice(insertIndex, 0, newEntry);
    try { writeChangelogFile(changelogPath, lines.join("\n"), existing.mode); }
    catch (error) { return { content: [{ type: "text", text: `Unable to save changelog: ${error.message}` }], isError: true }; }

    return { content: [{ type: "text", text: `Changelog saved to ${changelogPath}\n\n${newEntry}` }] };
  }

  return { content: [{ type: "text", text: changelog }] };
}

const MAX_DEPEND_DEPTH = 10;
const MAX_DEPEND_RESULTS = 100;

function resolveNpmProjectDirectory(requestedPath) {
  const candidate = path.resolve(requestedPath || process.cwd());
  if (enforcePathPolicy(candidate, "read")) throw new Error("npm project directory is outside the configured read scope");
  const canonical = fs.realpathSync(candidate);
  if (enforcePathPolicy(canonical, "read")) throw new Error("npm project directory is outside the configured read scope");
  if (!fs.statSync(canonical).isDirectory()) throw new Error("npm project path must be a directory");
  return canonical;
}

function runDependencyCommand(program, args, options = {}, execute = execFileSync) {
  return execute(program, args, { ...options, env: childProcessEnv() });
}

async function sidekick_depend({ action, type, target, depth, format }) {
  const denied = requireCanonicalInvocation("depend");
  if (denied) return denied;
  const maxDepth = Math.min(depth ?? 5, MAX_DEPEND_DEPTH);
  const fmt = format || "tree";

  if (action === "tree") {
    if (!type) {
      return { content: [{ type: "text", text: "type required (npm, service, process)" }], isError: true };
    }

    if (type === "npm") {
      try {
        const cwd = resolveNpmProjectDirectory(target);
        const result = runDependencyCommand("npm", ["ls", `--depth=${maxDepth}`, "--json"], {
          encoding: "utf8",
          cwd,
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const tree = JSON.parse(result);

        if (fmt === "json") {
          return { content: [{ type: "text", text: JSON.stringify(tree, null, 2) }] };
        }

        const formatNpmTree = (node, indent = 0) => {
          let output = "";
          const prefix = "  ".repeat(indent);
          if (node.name) {
            output += `${prefix}${node.name}@${node.version || "?"}\n`;
          }
          if (node.dependencies) {
            for (const [name, dep] of Object.entries(node.dependencies)) {
              output += formatNpmTree(dep, indent + 1);
            }
          }
          return output;
        };

        return { content: [{ type: "text", text: formatNpmTree(tree) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `npm ls failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "service") {
      if (!target) {
        return { content: [{ type: "text", text: "target required for service tree" }], isError: true };
      }
      try {
        const result = runDependencyCommand("systemctl", ["list-dependencies", validIdentifier(target, "service name", 128), "--no-pager"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `systemctl failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "process") {
      const pid = target || "1";
      try {
        if (!/^\d+$/.test(String(pid))) throw new Error("Invalid PID");
        const result = runDependencyCommand("pstree", ["-p", String(pid)], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `pstree failed: ${e.message}` }], isError: true };
      }
    }

    return { content: [{ type: "text", text: "Unknown type. Use: npm, service, process" }], isError: true };
  }

  if (action === "reverse") {
    if (!type || !target) {
      return { content: [{ type: "text", text: "type and target required" }], isError: true };
    }

    if (type === "npm") {
      try {
        const cwd = resolveNpmProjectDirectory();
        const result = runDependencyCommand("npm", ["ls", "--all", "--json"], {
          encoding: "utf8",
          cwd,
          timeout: 15000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const tree = JSON.parse(result);

        const findDependents = (node, targetName, path = []) => {
          const results = [];
          if (node.dependencies) {
            for (const [name, dep] of Object.entries(node.dependencies)) {
              if (name === targetName) {
                results.push([...path, node.name || "root"]);
              }
              results.push(...findDependents(dep, targetName, [...path, node.name || "root"]));
            }
          }
          return results;
        };

        const dependents = findDependents(tree, target);
        if (dependents.length === 0) {
          return { content: [{ type: "text", text: `No packages depend on ${target}` }] };
        }

        const unique = [...new Set(dependents.map(d => d.join(" → ")))];
        return { content: [{ type: "text", text: `Packages depending on ${target}:\n\n${unique.slice(0, MAX_DEPEND_RESULTS).join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `npm ls failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "service") {
      try {
        const result = runDependencyCommand("systemctl", ["list-dependencies", "--reverse", validIdentifier(target, "service name", 128), "--no-pager"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result || `No services depend on ${target}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `systemctl failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "process") {
      try {
        if (!/^\d+$/.test(String(target))) throw new Error("Invalid PID");
        const result = runDependencyCommand("ps", ["-o", "pid,ppid,comm", "--ppid", String(target)], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result || `No child processes for PID ${target}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `ps failed: ${e.message}` }], isError: true };
      }
    }

    return { content: [{ type: "text", text: "Unknown type. Use: npm, service, process" }], isError: true };
  }

  if (action === "outdated") {
    if (type !== "npm") {
      return { content: [{ type: "text", text: "outdated only supported for npm" }], isError: true };
    }
    try {
      const cwd = resolveNpmProjectDirectory(target);
      const result = runDependencyCommand("npm", ["outdated", "--json"], {
        encoding: "utf8",
        cwd,
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const outdated = JSON.parse(result);
      if (Object.keys(outdated).length === 0) {
        return { content: [{ type: "text", text: "All packages are up to date" }] };
      }
      const list = Object.entries(outdated).map(([name, info]) =>
        `${name}: ${info.current || "?"} → ${info.latest} (wanted: ${info.wanted || "?"})`
      ).join("\n");
      return { content: [{ type: "text", text: `Outdated packages:\n\n${list}` }] };
    } catch (e) {
      if (e.stdout) {
        try {
          const outdated = JSON.parse(e.stdout);
          const list = Object.entries(outdated).map(([name, info]) =>
            `${name}: ${info.current || "?"} → ${info.latest} (wanted: ${info.wanted || "?"})`
          ).join("\n");
          return { content: [{ type: "text", text: `Outdated packages:\n\n${list}` }] };
        } catch {}
      }
      return { content: [{ type: "text", text: `npm outdated failed: ${e.message}` }], isError: true };
    }
  }

  if (action === "impact") {
    if (!type || !target) {
      return { content: [{ type: "text", text: "type and target required" }], isError: true };
    }

    let impact = `Impact analysis for removing ${target}:\n\n`;

    if (type === "npm") {
      try {
        const cwd = resolveNpmProjectDirectory();
        const result = runDependencyCommand("npm", ["ls", "--all", "--json"], {
          encoding: "utf8",
          cwd,
          timeout: 15000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const tree = JSON.parse(result);

        const findDependents = (node, targetName) => {
          const results = [];
          if (node.dependencies) {
            for (const [name, dep] of Object.entries(node.dependencies)) {
              if (name === targetName) {
                results.push(node.name || "root");
              }
              results.push(...findDependents(dep, targetName));
            }
          }
          return results;
        };

        const dependents = findDependents(tree, target);
        if (dependents.length === 0) {
          impact += "No packages depend on this. Safe to remove.";
        } else {
          const unique = [...new Set(dependents)];
          impact += `WARNING: ${unique.length} package(s) depend on this:\n`;
          impact += unique.slice(0, 20).map(d => `  - ${d}`).join("\n");
          if (unique.length > 20) impact += `\n  ... and ${unique.length - 20} more`;
        }
      } catch (e) {
        impact += `Analysis failed: ${e.message}`;
      }
    } else if (type === "service") {
      try {
        const result = runDependencyCommand("systemctl", ["list-dependencies", "--reverse", validIdentifier(target, "service name", 128), "--no-pager"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        if (result.trim()) {
          impact += `WARNING: The following services depend on ${target}:\n${result}`;
        } else {
          impact += "No services depend on this. Safe to remove.";
        }
      } catch (e) {
        impact += `Analysis failed: ${e.message}`;
      }
    } else {
      impact += "Impact analysis not supported for this type";
    }

    return { content: [{ type: "text", text: impact }] };
  }

  if (action === "orphans") {
    if (type !== "npm") {
      return { content: [{ type: "text", text: "orphans only supported for npm" }], isError: true };
    }
    try {
      const cwd = resolveNpmProjectDirectory(target);
      const pkgPath = path.join(cwd, "package.json");
      if (!fs.existsSync(pkgPath)) {
        return { content: [{ type: "text", text: "No package.json found" }], isError: true };
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const declared = Object.keys(pkg.dependencies || {});

      const result = runDependencyCommand("npm", ["ls", "--depth=0", "--json"], {
        encoding: "utf8",
        cwd,
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const tree = JSON.parse(result);
      const installed = Object.keys(tree.dependencies || {});

      const orphans = installed.filter(dep => !declared.includes(dep));
      if (orphans.length === 0) {
        return { content: [{ type: "text", text: "No orphaned dependencies found" }] };
      }
      return { content: [{ type: "text", text: `Orphaned dependencies (installed but not in package.json):\n\n${orphans.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Analysis failed: ${e.message}` }], isError: true };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: tree, reverse, outdated, impact, orphans" }], isError: true };
}

const SCHEMAS = {
  git: z.object({
    action: z.enum(["status", "diff", "log", "show", "ls-tree", "ls-files", "add", "commit", "push", "pull", "branch", "checkout", "stash"]).describe("Git action to perform"),
    path: z.string().optional().describe("Repository path (defaults to current directory)"),
    args: z.string().optional().describe("Additional arguments for the git command")
  }).or(z.object({
    action: z.literal("clone").describe("Clone a remote repository safely"),
    source_url: z.string().describe("HTTPS repository URL"),
    destination: z.string().describe("Absolute empty or new destination directory"),
    ref: z.string().optional().describe("Optional branch, tag, or commit ref"),
    allowed_hosts: z.array(z.string()).max(32).optional().describe("Optional allowed source host patterns")
  }).strict()),
  changelog: z.object({
    action: z.enum(["generate", "preview", "save"]),
    from: z.string().min(1).max(MAX_CHANGELOG_REVISION_LENGTH).describe("Starting ref (tag, commit, branch)"),
    to: z.string().max(MAX_CHANGELOG_REVISION_LENGTH).optional().default("HEAD"),
    format: z.enum(["markdown", "plain", "conventional"]).optional().default("markdown"),
    group_by: z.enum(["type", "scope", "author"]).optional().default("type"),
    use_llm: z.boolean().optional().default(false),
    include: z.enum(["all", "features", "fixes", "breaking", "refactor", "deps"]).optional().default("all"),
    path: z.string().optional().describe("Git repository path (default: current directory)")
  }),
  depend: z.object({
    action: z.enum(["tree", "reverse", "outdated", "impact", "orphans"]),
    type: z.enum(["npm", "service", "process"]),
    target: z.string().max(4096).optional().describe("Package, service, process, or scoped project directory to analyze"),
    depth: z.number().int().min(0).max(MAX_DEPEND_DEPTH).optional().default(5),
    format: z.enum(["tree", "flat", "json"]).optional().default("tree")
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "git",
    description: "Structured git operations (status, diff, log, read-only show/ls-tree, add, commit, push, pull, branch, checkout, stash, and safe HTTPS clone)",
    schema: SCHEMAS.git,
    args: { action: "string", path: "string (optional)", args: "string (optional)", source_url: "string (clone HTTPS URL)", destination: "string (clone absolute destination)", ref: "string (optional clone ref)", allowed_hosts: "array (optional clone host patterns)" },
    risk: "medium",
    category: "Git & GitHub",
    source: "builtin",
    family: "development",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: sidekick_git,
  }),
  Object.freeze({
    name: "changelog",
    description: "Generate human-readable changelogs from git history. Groups commits semantically and optionally uses LLM for summaries.",
    schema: SCHEMAS.changelog,
    args: { action: "string (generate|preview|save)", from: "string (starting ref: tag, commit, branch)", to: "string (optional, ending ref - default HEAD)", format: "string (optional, markdown|plain|conventional - default markdown)", group_by: "string (optional, type|scope|author - default type)", use_llm: "boolean (optional, generate LLM summary - default false)", include: "string (optional, all|features|fixes|breaking|refactor|deps - default all)", path: "string (optional, git repository path - default current directory)" },
    risk: "medium",
    category: "Development",
    source: "builtin",
    family: "development",
    handler: sidekick_changelog,
  }),
  Object.freeze({
    name: "depend",
    description: "Dependency analyzer for npm packages, systemd services, and processes. Shows dependency trees, reverse dependencies, and impact analysis.",
    schema: SCHEMAS.depend,
    args: { action: "string (tree|reverse|outdated|impact|orphans)", type: "string (npm|service|process)", target: "string (optional, package, service, or PID)", depth: "number (optional, tree depth - default 5)", format: "string (optional, tree|flat|json - default tree)" },
    risk: "medium",
    category: "Development",
    source: "builtin",
    family: "development",
    handler: sidekick_depend,
  }),
]);

module.exports = { descriptors, sidekick_git, sidekick_changelog, sidekick_depend, parseGitExtraArgs, resolveNpmProjectDirectory, runDependencyCommand,
  resolveChangelogRevision, readChangelogFile, writeChangelogFile, MAX_CHANGELOG_BYTES, MAX_CHANGELOG_REVISION_LENGTH };
