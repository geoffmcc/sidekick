"use strict";

const path = require("node:path");
const { assertSafeSecretDirectory, readSecretFile } = require("../src/core/runtime-secrets");

const REQUIRED_SECRETS = Object.freeze({
  SIDEKICK_API_KEY: "sidekick_api_key",
  SIDEKICK_AGENT_PROXY_KEY: "sidekick_agent_proxy_key"
});

function readRequiredSecret(directory, variableName, fileName) {
  const filePath = path.join(directory, fileName);
  let value;
  try {
    value = readSecretFile(filePath, variableName);
  } catch (error) {
    if (error.message === `${variableName} secret file is unavailable`) {
      throw new Error(`${variableName} is missing at ${filePath}`);
    }
    throw error;
  }
  if (variableName === "SIDEKICK_API_KEY" && ["sk-sidekick-local-dev", "sk-your-key-here"].includes(value)) {
    throw new Error(`${variableName} must not use a placeholder value`);
  }
  return value;
}

function verifyRequiredRuntimeSecrets(directory) {
  if (!path.isAbsolute(directory)) throw new Error("SIDEKICK_SECRET_DIR must be an absolute path");
  const resolved = assertSafeSecretDirectory(directory, "SIDEKICK_SECRET_DIR");

  const values = Object.entries(REQUIRED_SECRETS).map(([name, file]) =>
    readRequiredSecret(resolved, name, file));
  if (values[0] === values[1]) {
    throw new Error("SIDEKICK_AGENT_PROXY_KEY must differ from SIDEKICK_API_KEY");
  }
  return true;
}

if (require.main === module) {
  try {
    verifyRequiredRuntimeSecrets(process.argv[2] || process.env.SIDEKICK_SECRET_DIR || "/etc/sidekick/secrets");
    process.stdout.write("Required runtime secret files are present and valid.\n");
  } catch (error) {
    process.stderr.write(`Runtime secret preflight failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { verifyRequiredRuntimeSecrets };
