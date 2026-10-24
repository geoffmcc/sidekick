"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { childProcessEnv } = require("../../src/security/child-process");

const locatorKeys = [
  "PGPASSFILE", "PGSERVICEFILE", "MYSQL_PWD", "MYSQL_TEST_LOGIN_FILE", "KRB5CCNAME", "KRB5_CONFIG",
  "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AZURE_FEDERATED_TOKEN_FILE", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
];

test("child-process environments remove database, cloud, and agent credential locators", t => {
  const original = new Map(locatorKeys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  for (const key of locatorKeys) process.env[key] = `synthetic-${key.toLowerCase()}`;
  const overrides = Object.fromEntries(locatorKeys.map(key => [key, `override-${key.toLowerCase()}`]));
  overrides.PATH = process.env.PATH;
  overrides.LANG = "C.UTF-8";
  const childEnv = childProcessEnv(overrides);

  for (const key of locatorKeys) {
    assert.equal(childEnv[key], undefined, `${key} must not reach child processes from ambient state or overrides`);
  }
  assert.equal(childEnv.PATH, process.env.PATH, "safe executable discovery must remain available");
  assert.equal(childEnv.LANG, "C.UTF-8", "non-credential runtime settings remain configurable");
});
