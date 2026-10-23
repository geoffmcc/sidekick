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

const credentialEnvKeys = [
  "AWS_ACCESS_KEY_ID", "DOCKER_AUTH_CONFIG", "SSH_AUTH_SOCK", "KUBECONFIG",
  "NPM_CONFIG_USERCONFIG", "PIP_CONFIG_FILE", "AWS_CONFIG_FILE", "AZURE_CONFIG_DIR",
  "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "GH_CONFIG_DIR", "HELM_REGISTRY_CONFIG",
  "TF_CLI_CONFIG_FILE", "TERRAFORM_CLI_CONFIG_FILE", "NETRC", "CURL_HOME", "WGETRC",
  "GNUPGHOME", "GPG_AGENT_INFO", "BOTO_CONFIG", "NUGET_CREDENTIALPROVIDERS_PATH",
];
const previousCredentialEnv = new Map(credentialEnvKeys.map(key => [key, process.env[key]]));
for (const key of credentialEnvKeys) process.env[key] = "attacker-controlled-credential-reference";
const credentialOverrides = Object.fromEntries(credentialEnvKeys.map(key => [key, "override"]));
credentialOverrides.GIT_AUTHOR_NAME = "Sidekick Test";
const filteredCredentials = childProcessEnv(credentialOverrides);
for (const key of credentialEnvKeys) {
  assert.strictEqual(filteredCredentials[key], undefined, `${key} must not cross a child-process boundary`);
}
assert.strictEqual(filteredCredentials.GIT_AUTHOR_NAME, "Sidekick Test", "credential filtering must preserve ordinary Git author settings");
for (const [key, value] of previousCredentialEnv) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const previousUrlCredentials = new Map(["DATABASE_URL", "PIP_INDEX_URL"].map(key => [key, process.env[key]]));
process.env.DATABASE_URL = "postgres://service:synthetic-secret@db.internal/app";
process.env.PIP_INDEX_URL = "https://user:synthetic-secret@packages.internal/simple";
const filteredCredentialUrls = childProcessEnv({
  DATABASE_URL: "postgres://service:synthetic-secret@db.internal/app",
  PROXY_URL: "http://proxy.internal:8080",
});
assert.strictEqual(filteredCredentialUrls.DATABASE_URL, undefined, "URL userinfo must not cross a child-process boundary");
assert.strictEqual(filteredCredentialUrls.PIP_INDEX_URL, undefined, "URL userinfo must be filtered regardless of the variable name");
assert.strictEqual(filteredCredentialUrls.PROXY_URL, "http://proxy.internal:8080", "credential-free URLs remain available to child processes");
for (const [key, value] of previousUrlCredentials) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

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
