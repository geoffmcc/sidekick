"use strict";

// Child processes are not trusted with Sidekick's service environment by
// default. In particular, a command supplied to a governed shell-capable tool
// must not inherit file-backed credentials or runtime loader hooks.
const SECRET_ENV_KEY = /(?:API[_-]?KEY|TOKEN|PASSWORD|PASSWD|PASSPHRASE|SECRET|CREDENTIAL)/i;
const LOADER_ENV_KEYS = new Set([
  "BASH_ENV", "ENV", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME",
  "RUBYLIB", "PERL5LIB", "PERL5OPT", "GIT_ASKPASS", "GIT_PAGER",
  "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_SSH_COMMAND", "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "PAGER", "EDITOR", "VISUAL",
]);

function isLoaderEnvKey(key) {
  return LOADER_ENV_KEYS.has(String(key || "").toUpperCase());
}

function childProcessEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_ENV_KEY.test(key) || isLoaderEnvKey(key) || /(?:_FILE|_PATH)$/i.test(key) && SECRET_ENV_KEY.test(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value == null) delete env[key];
    else if (!SECRET_ENV_KEY.test(key) && !isLoaderEnvKey(key)) env[key] = String(value);
  }
  return env;
}

module.exports = { childProcessEnv };
