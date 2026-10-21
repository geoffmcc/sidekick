"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(__dirname, ".tmp-git-metadata-"));
const oldEnv = {
  SIDEKICK_DATA_DIR: process.env.SIDEKICK_DATA_DIR,
  SIDEKICK_DB_FILE: process.env.SIDEKICK_DB_FILE,
  SIDEKICK_TOOL_POLICY: process.env.SIDEKICK_TOOL_POLICY,
  SIDEKICK_APPROVAL_MODE: process.env.SIDEKICK_APPROVAL_MODE,
  SIDEKICK_ALLOWED_PATHS: process.env.SIDEKICK_ALLOWED_PATHS,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  GIT_DIR: process.env.GIT_DIR,
  GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  GIT_TRACE: process.env.GIT_TRACE,
};
process.env.SIDEKICK_DATA_DIR = path.join(root, "data");
process.env.SIDEKICK_DB_FILE = path.join(root, "data", "sidekick.db");
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
process.env.HOME = path.join(root, "home");
process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.SIDEKICK_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.HOME, ".gitconfig"), "");

const db = require("../src/db");
db.runPendingMigrations();
const owner = require("./helpers/authorized-context").createOwnerContext({ source: "internal" });
const { callInternalTool } = require("../src/tools/dispatcher");

const secretRepo = path.join(root, "outside", "source-repository");
const allowedRepo = path.join(root, "allowed", "worktree");
const allowedRoot = path.dirname(allowedRepo);
const alternateRepo = path.join(allowedRoot, "alternate-worktree");
const commonDirRepo = path.join(allowedRoot, "common-dir-worktree");
const commonGitDir = path.join(secretRepo, ".git", "worktrees", path.basename(commonDirRepo));
const configRepo = path.join(allowedRoot, "config-repository");
const targetFilterRepo = path.join(allowedRoot, "target-filter-repository");
const fsmonitorScript = path.join(root, "fsmonitor.sh");
const fsmonitorMarker = path.join(root, "fsmonitor-executed.txt");
const hookRepo = path.join(allowedRoot, "hook-repository");
const hookScript = path.join(root, "pre-commit");
const hookMarker = path.join(root, "hook-executed.txt");
const gitTracePath = path.join(root, "out-of-policy-git-trace.log");
const canary = "SYNTHETIC_EXTERNAL_GITDIR_CANARY";

function git(cwd, args) {
  return execFileSync("git", ["-c", `safe.directory=${cwd}`, "-c", "commit.gpgsign=false", "-c", "user.name=Security Test", "-c", "user.email=security-test@example.test", "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitShellPath(value) {
  const text = String(value || "");
  const match = text.match(/^([A-Za-z]):[\\/](.*)$/);
  if (process.platform !== "win32" || !match) return text;
  return `${match[1]}:/${match[2].replace(/\\/g, "/")}`;
}

fs.mkdirSync(secretRepo, { recursive: true });
fs.mkdirSync(allowedRepo, { recursive: true });
git(secretRepo, ["init", "-q"]);
fs.writeFileSync(path.join(secretRepo, "private.txt"), canary);
git(secretRepo, ["add", "private.txt"]);
git(secretRepo, ["commit", "-q", "-m", "synthetic private fixture"]);
const secretCommit = git(secretRepo, ["rev-parse", "HEAD"]).trim();
fs.writeFileSync(path.join(allowedRepo, ".git"), `gitdir: ${path.join(secretRepo, ".git")}\n`);
fs.mkdirSync(alternateRepo, { recursive: true });
git(alternateRepo, ["init", "-q"]);
fs.mkdirSync(path.join(alternateRepo, ".git", "objects", "info"), { recursive: true });
fs.writeFileSync(path.join(alternateRepo, ".git", "objects", "info", "alternates"), `${path.join(secretRepo, ".git", "objects")}\n`);
git(secretRepo, ["worktree", "add", "--detach", commonDirRepo, "HEAD"]);
fs.mkdirSync(configRepo, { recursive: true });
git(configRepo, ["init", "-q"]);
fs.writeFileSync(path.join(configRepo, "tracked.txt"), "synthetic tracked file\n");
git(configRepo, ["add", "tracked.txt"]);
git(configRepo, ["commit", "-q", "-m", "synthetic config fixture"]);
fs.writeFileSync(fsmonitorScript, `require("node:fs").writeFileSync(${JSON.stringify(fsmonitorMarker)}, "ran");\n`);
git(configRepo, ["config", "core.fsmonitor", `node ${gitShellPath(fsmonitorScript)}`]);

test("git reads a gitfile target only when that target also passes path policy", async () => {
  assert.equal(git(alternateRepo, ["show", `${secretCommit}:private.txt`]).trim(), canary, "the Git alternate-object fixture exposes the synthetic object without Sidekick policy");
  assert.equal(git(commonDirRepo, ["show", "HEAD:private.txt"]).trim(), canary, "the real linked-worktree fixture resolves objects through its common directory");
process.env.SIDEKICK_ALLOWED_PATHS = allowedRepo;
  const denied = await callInternalTool("git", { action: "show", path: allowedRepo, args: "HEAD:private.txt" }, owner);
  assert.equal(denied.isError, true, "the external git directory is outside the caller's path allowlist");
  assert.doesNotMatch(denied.content.map((part) => part.text || "").join("\n"), new RegExp(canary));

  process.env.SIDEKICK_ALLOWED_PATHS = `${allowedRepo},${path.join(secretRepo, ".git")}`;
  const allowed = await callInternalTool("git", { action: "show", path: allowedRepo, args: "HEAD:private.txt" }, owner);
  assert.notEqual(allowed.isError, true, "explicitly allowing both the worktree and gitdir preserves linked-worktree use");
  assert.match(allowed.content.map((part) => part.text || "").join("\n"), new RegExp(canary));

  process.env.SIDEKICK_ALLOWED_PATHS = allowedRoot;
  const alternateDenied = await callInternalTool("git", { action: "show", path: alternateRepo, args: `${secretCommit}:private.txt` }, owner);
  assert.equal(alternateDenied.isError, true, "an external alternate object store is denied by path policy");
  assert.doesNotMatch(alternateDenied.content.map((part) => part.text || "").join("\n"), new RegExp(canary));

  process.env.SIDEKICK_ALLOWED_PATHS = `${allowedRoot},${path.join(secretRepo, ".git", "objects")}`;
  const alternateAllowed = await callInternalTool("git", { action: "show", path: alternateRepo, args: `${secretCommit}:private.txt` }, owner);
  assert.notEqual(alternateAllowed.isError, true, "explicitly allowing the alternate object store preserves shared-object use");
  assert.match(alternateAllowed.content.map((part) => part.text || "").join("\n"), new RegExp(canary));

  process.env.SIDEKICK_ALLOWED_PATHS = `${allowedRoot},${commonGitDir}`;
  const commonDenied = await callInternalTool("git", { action: "show", path: commonDirRepo, args: "HEAD:private.txt" }, owner);
  assert.equal(commonDenied.isError, true, "an external common directory is denied even when the worktree gitdir is allowed");
  assert.doesNotMatch(commonDenied.content.map((part) => part.text || "").join("\n"), new RegExp(canary));

  process.env.SIDEKICK_ALLOWED_PATHS = `${allowedRoot},${commonGitDir},${path.join(secretRepo, ".git")}`;
  const commonAllowed = await callInternalTool("git", { action: "show", path: commonDirRepo, args: "HEAD:private.txt" }, owner);
  assert.notEqual(commonAllowed.isError, true, "explicitly allowing the common directory preserves shared worktree use");
  assert.match(commonAllowed.content.map((part) => part.text || "").join("\n"), new RegExp(canary));

  process.env.SIDEKICK_ALLOWED_PATHS = allowedRoot;
  process.env.GIT_DIR = path.join(secretRepo, ".git");
  process.env.GIT_WORK_TREE = configRepo;
  const environmentRedirect = await callInternalTool("git", { action: "show", path: configRepo, args: "HEAD:private.txt" }, owner);
  assert.equal(environmentRedirect.isError, true, "the requested checked repository remains authoritative");
  assert.doesNotMatch(environmentRedirect.content.map((part) => part.text || "").join("\n"), new RegExp(canary), "inherited Git repository overrides must not redirect a checked tool path");
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;

  process.env.GIT_TRACE = gitTracePath;
  git(configRepo, ["status", "--untracked-files=no"]);
  assert.equal(fs.existsSync(gitTracePath), true, "the direct Git fixture confirms GIT_TRACE writes to its configured file");
  fs.rmSync(gitTracePath, { force: true });
  fs.rmSync(fsmonitorMarker, { force: true });
  const traceSuppressed = await callInternalTool("git", { action: "status", path: configRepo }, owner);
  assert.notEqual(traceSuppressed.isError, true, "status remains available without inherited trace settings");
  assert.equal(fs.existsSync(gitTracePath), false, "inherited Git trace variables must not write outside the authorized path");
  delete process.env.GIT_TRACE;

  const configuredHelper = await callInternalTool("git", { action: "status", path: configRepo }, owner);
  assert.equal(fs.existsSync(fsmonitorMarker), false, `repository-controlled fsmonitor must not execute (${JSON.stringify(configuredHelper)})`);

  git(configRepo, ["config", "diff.external", `node ${gitShellPath(fsmonitorScript)}`]);
  fs.writeFileSync(path.join(configRepo, "tracked.txt"), "modified synthetic tracked file\n");
  git(configRepo, ["diff"]);
  assert.equal(fs.existsSync(fsmonitorMarker), true, "the direct Git fixture confirms local diff.external executes");
  fs.rmSync(fsmonitorMarker, { force: true });
  const configuredDiff = await callInternalTool("git", { action: "diff", path: configRepo }, owner);
  assert.notEqual(configuredDiff.isError, true, "diff remains available when external diff config is neutralized");
  assert.equal(fs.existsSync(fsmonitorMarker), false, "repository-controlled diff.external must not execute");

  git(configRepo, ["config", "credential.helper", `!node ${gitShellPath(fsmonitorScript)}`]);
  try {
    execFileSync("git", ["-C", configRepo, "credential", "fill"], {
      input: "protocol=https\nhost=synthetic.invalid\n\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch { /* the synthetic helper intentionally returns no credentials */ }
  assert.equal(fs.existsSync(fsmonitorMarker), true, "the direct Git fixture confirms a configured credential helper executes");
  fs.rmSync(fsmonitorMarker, { force: true });
  const configuredCredentialHelper = await callInternalTool("git", { action: "push", path: configRepo }, owner);
  assert.equal(configuredCredentialHelper.isError, true, "repository-controlled credential helpers must be denied before push");
  assert.equal(fs.existsSync(fsmonitorMarker), false, "denied push must not execute a configured credential helper");
  git(configRepo, ["config", "--unset-all", "credential.helper"]);
  git(configRepo, ["config", "core.sshCommand", `node ${gitShellPath(fsmonitorScript)}`]);
  const configuredSshCommand = await callInternalTool("git", { action: "push", path: configRepo }, owner);
  assert.equal(configuredSshCommand.isError, true, "repository-controlled SSH commands must be denied before push");
  assert.equal(fs.existsSync(fsmonitorMarker), false, "denied push must not execute repository-controlled SSH commands");
  git(configRepo, ["config", "--unset", "core.sshCommand"]);

  git(configRepo, ["config", "filter.synthetic-clean.clean", `node ${gitShellPath(fsmonitorScript)}`]);
  fs.writeFileSync(path.join(configRepo, ".gitattributes"), "filter-fixture.txt filter=synthetic-clean\n");
  fs.writeFileSync(path.join(configRepo, "filter-fixture.txt"), "direct clean filter fixture\n");
  const filterFiles = execFileSync("git", ["-C", configRepo, "ls-files", "--cached", "--others", "-z"], { encoding: "buffer" });
  const filterAttributes = execFileSync("git", ["-C", configRepo, "check-attr", "-z", "--stdin", "filter"], { input: filterFiles, encoding: "buffer" });
  assert.match(filterAttributes.toString("utf8"), /synthetic-clean/, "Git's attribute query identifies the active repository filter without running it");
  git(configRepo, ["add", "filter-fixture.txt"]);
  assert.equal(fs.existsSync(fsmonitorMarker), true, "the direct Git fixture confirms a configured clean filter executes");
  fs.rmSync(fsmonitorMarker, { force: true });
  fs.writeFileSync(path.join(configRepo, "filter-fixture.txt"), "Sidekick clean filter fixture\n");
  const configuredFilter = await callInternalTool("git", { action: "add", path: configRepo, args: "filter-fixture.txt" }, owner);
  assert.equal(fs.existsSync(fsmonitorMarker), false, `repository-controlled clean filter must not execute (${JSON.stringify(configuredFilter)})`);

  fs.mkdirSync(targetFilterRepo, { recursive: true });
  git(targetFilterRepo, ["init", "-q"]);
  fs.writeFileSync(path.join(targetFilterRepo, "tracked.txt"), "base branch\n");
  git(targetFilterRepo, ["add", "tracked.txt"]);
  git(targetFilterRepo, ["commit", "-q", "-m", "base filter fixture"]);
  git(targetFilterRepo, ["checkout", "-q", "-b", "filtered-target"]);
  git(targetFilterRepo, ["config", "filter.synthetic-clean.smudge", `node ${gitShellPath(fsmonitorScript)}`]);
  fs.writeFileSync(path.join(targetFilterRepo, ".gitattributes"), "filter-target.txt filter=synthetic-clean\n");
  fs.writeFileSync(path.join(targetFilterRepo, "filter-target.txt"), "filtered branch content\n");
  git(targetFilterRepo, ["add", ".gitattributes", "filter-target.txt"]);
  git(targetFilterRepo, ["commit", "-q", "-m", "filtered target"]);
  git(targetFilterRepo, ["checkout", "-q", "--detach", "HEAD^"]);
  const checkoutFilter = await callInternalTool("git", { action: "checkout", path: targetFilterRepo, args: "filtered-target" }, owner);
  assert.equal(fs.existsSync(fsmonitorMarker), false, `target-branch smudge filters must be detected before checkout (${JSON.stringify(checkoutFilter)})`);
  assert.equal(checkoutFilter.isError, true, "checkout into a tree with executable filters is denied");
  const pullFilter = await callInternalTool("git", { action: "pull", path: targetFilterRepo }, owner);
  assert.equal(pullFilter.isError, true, "pull is denied because incoming attributes cannot be inspected before Git applies them");

  git(configRepo, ["config", "core.fsmonitor", "false"]);
  fs.mkdirSync(hookRepo, { recursive: true });
  git(hookRepo, ["init", "-q"]);
  git(hookRepo, ["config", "user.name", "Security Test"]);
  git(hookRepo, ["config", "user.email", "security-test@example.test"]);
  fs.writeFileSync(path.join(hookRepo, "tracked.txt"), "hook fixture\n");
  git(hookRepo, ["add", "tracked.txt"]);
  git(hookRepo, ["commit", "-q", "-m", "initial hook fixture"]);
  fs.writeFileSync(hookScript, `#!/bin/sh\nnode ${gitShellPath(fsmonitorScript)}\n`);
  try { fs.chmodSync(hookScript, 0o700); } catch {}
  fs.writeFileSync(path.join(hookRepo, ".git", "hooks", "pre-commit"), `#!/bin/sh\nnode ${gitShellPath(fsmonitorScript)}\n`);
  try { fs.chmodSync(path.join(hookRepo, ".git", "hooks", "pre-commit"), 0o700); } catch {}
  fs.writeFileSync(fsmonitorScript, `require("node:fs").writeFileSync(${JSON.stringify(hookMarker)}, "ran");\n`);
  fs.writeFileSync(path.join(hookRepo, "tracked.txt"), "direct commit should run hook\n");
  git(hookRepo, ["add", "tracked.txt"]);
  git(hookRepo, ["commit", "-m", "direct hook check"]);
  assert.equal(fs.existsSync(hookMarker), true, "direct Git proves the repository pre-commit hook runs");
  fs.rmSync(hookMarker, { force: true });
  fs.writeFileSync(path.join(hookRepo, "tracked.txt"), "Sidekick commit should skip hook\n");
  git(hookRepo, ["add", "tracked.txt"]);
  const sidekickCommit = await callInternalTool("git", { action: "commit", path: hookRepo, args: "-m sidekick-hook-check" }, owner);
  assert.notEqual(sidekickCommit.isError, true, `commit remains available when repository hooks are disabled (${JSON.stringify(sidekickCommit)})`);
  assert.equal(fs.existsSync(hookMarker), false, "repository-controlled pre-commit hook must not execute through Sidekick");
});

after(() => {
  try { db.closeDatabase(); } catch {}
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});
