"use strict";

// Child processes are not trusted with Sidekick's service environment by
// default. In particular, a command supplied to a governed shell-capable tool
// must not inherit file-backed credentials or runtime loader hooks.
const SECRET_ENV_KEY = /(?:API[_-]?KEY|TOKEN|PASSWORD|PASSWD|PASSPHRASE|SECRET|CREDENTIAL)/i;
const LOADER_ENV_KEYS = new Set([
  "BASH_ENV", "ENV", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME",
  "RUBYLIB", "PERL5LIB", "PERL5OPT", "GIT_ASKPASS",
]);

function childProcessEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_ENV_KEY.test(key) || LOADER_ENV_KEYS.has(key) || /(?:_FILE|_PATH)$/i.test(key) && SECRET_ENV_KEY.test(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value == null) delete env[key];
    else if (!SECRET_ENV_KEY.test(key) && !LOADER_ENV_KEYS.has(key)) env[key] = String(value);
  }
  return env;
}

module.exports = { childProcessEnv };
