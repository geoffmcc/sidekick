"use strict";

const assert = require("assert");
const { childProcessEnv } = require("../src/security/child-process");
const { parseGitExtraArgs } = require("../src/tools/families/development");

for (const key of [
  "NODE_OPTIONS", "LD_PRELOAD", "PYTHONPATH", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF",
  "GIT_PAGER", "GIT_EDITOR", "PAGER", "EDITOR", "VISUAL"
]) {
  process.env[key] = "attacker-controlled";
}
const filtered = childProcessEnv({ SAFE_OVERRIDE: "ok", NODE_OPTIONS: "--require evil" });
for (const key of [
  "NODE_OPTIONS", "LD_PRELOAD", "PYTHONPATH", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF",
  "GIT_PAGER", "GIT_EDITOR", "PAGER", "EDITOR", "VISUAL"
]) {
  assert.strictEqual(filtered[key], undefined, `${key} must not cross a child-process boundary`);
}
assert.strictEqual(filtered.SAFE_OVERRIDE, "ok");

for (const args of [
  "-c core.sshCommand=sh -c evil",
  "--config-env=core.sshCommand=EVIL",
  "--upload-pack=sh -c evil",
  "--receive-pack=sh -c evil",
  "--exec-path=/tmp/attacker",
  "--ext-diff",
  "--paginate"
]) {
  assert.throws(() => parseGitExtraArgs(args), /not permitted/, `unsafe Git option accepted: ${args}`);
}

assert.deepStrictEqual(parseGitExtraArgs("--no-pager --stat"), ["--no-pager", "--stat"]);
console.log("Phase 5 subprocess and shell security tests passed");
