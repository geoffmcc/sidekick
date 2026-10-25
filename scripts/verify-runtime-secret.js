"use strict";

const { readSecret } = require("../src/core/runtime-secrets");

const name = process.argv[2];
const directory = process.argv[3] || "/etc/sidekick/secrets";

if (!name) process.exit(2);
process.env.NODE_ENV = "production";
process.env.SIDEKICK_SECRET_DIR = directory;
delete process.env[name];
delete process.env[`${name}_FILE`];

try {
  const value = readSecret(name);
  process.exit(value && value !== "sidekick-influx-token" ? 0 : 1);
} catch {
  process.exit(1);
}
