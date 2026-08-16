#!/usr/bin/env node
"use strict";

// Headless local administration. Sensitive values are accepted from stdin,
// never required as command-line arguments where shell history could retain them.
require("../src/env");
const db = require("../src/db");
db.runPendingMigrations();
const identity = require("../src/core/identity");
const authentication = require("../src/core/authentication");

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}
function stdinValue() {
  return require("fs").readFileSync(0, "utf8").trim();
}
function usage() {
  console.error("Usage: identity-admin.js bootstrap | recovery-token --owner <principal_id> | recover-owner --token-stdin --password-stdin | create-credential --principal <id> --name <name> [--scope <scope>] | revoke-credential --id <credential_id>");
  process.exitCode = 2;
}

try {
  const command = process.argv[2];
  if (command === "bootstrap") {
    const username = option("username");
    const displayName = option("display-name") || username;
    const password = option("password-stdin") !== null ? stdinValue() : null;
    if (!username || !password) throw new Error("bootstrap requires --username and --password-stdin");
    console.log(JSON.stringify(identity.bootstrapOwner({ username, displayName, password }), null, 2));
  } else if (command === "recovery-token") {
    const result = authentication.createOwnerRecoveryToken(option("owner"));
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "recover-owner") {
    if (option("token-stdin") === null || option("password-stdin") === null) throw new Error("recover-owner requires --token-stdin and --password-stdin");
    const input = stdinValue().split(/\r?\n/);
    if (input.length < 2 || !input[0] || !input[1]) throw new Error("stdin must contain token on line 1 and new password on line 2");
    console.log(JSON.stringify(authentication.recoverOwnerPassword(input[0], input[1]), null, 2));
  } else if (command === "create-credential") {
    const scopes = [];
    for (let index = 3; index < process.argv.length - 1; index += 1) {
      if (process.argv[index] === "--scope") scopes.push(process.argv[index + 1]);
    }
    const result = authentication.createCredential({ principalId: option("principal"), displayName: option("name"), scopes });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "revoke-credential") {
    console.log(JSON.stringify({ revoked: authentication.revokeCredential(option("id")) }));
  } else {
    usage();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { db.close(); } catch {}
}
