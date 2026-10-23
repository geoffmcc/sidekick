"use strict";

// Child processes are not trusted with Sidekick's service environment by
// default. In particular, a command supplied to a governed shell-capable tool
// must not inherit file-backed credentials or runtime loader hooks.
const SECRET_ENV_KEY = /(?:API[_-]?KEY|TOKEN|PASSWORD|PASSWD|PASSPHRASE|SECRET|CREDENTIAL)/i;
const LOADER_ENV_KEYS = new Set([
  "BASH_ENV", "ENV", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME",
  "RUBYLIB", "PERL5LIB", "PERL5OPT", "GIT_ASKPASS", "GIT_PAGER",
  "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_SSH", "GIT_SSH_COMMAND", "SSH_ASKPASS", "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_OBJECT_DIRECTORY_RELATIVE",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM", "PAGER", "EDITOR", "VISUAL",
]);

function isLoaderEnvKey(key) {
  const normalized = String(key || "").toUpperCase();
  return LOADER_ENV_KEYS.has(normalized) || normalized.startsWith("GIT_TRACE") || normalized.startsWith("GIT_CONFIG_");
}

function childProcessEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_ENV_KEY.test(key) || isLoaderEnvKey(key) || /(?:_FILE|_PATH)$/i.test(key) && SECRET_ENV_KEY.test(key)) continue;
    // Windows exposes this key as `Path` in some launch environments while
    // Unix and our child-process callers conventionally use `PATH`. Normalize
    // it so filtered environments retain executable discovery consistently.
    env[key.toUpperCase() === "PATH" ? "PATH" : key] = value;
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value == null) delete env[key];
    else if (!SECRET_ENV_KEY.test(key) && !isLoaderEnvKey(key)) env[key] = String(value);
  }
  return env;
}

module.exports = { childProcessEnv };
