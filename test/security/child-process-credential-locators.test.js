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

test("child-process environments remove URL query credentials but retain non-secret connection options", () => {
  const childEnv = childProcessEnv({
    DATABASE_URL: "postgres://db.internal/app?password=synthetic-db-password",
    REDIS_URL: "rediss://cache.internal/0?access_token=synthetic-cache-token",
    OIDC_ISSUER_URL: "https://example.invalid/issuer?client_secret=synthetic-client-secret",
    JDBC_URL: "jdbc:sqlserver://db.internal;database=app;password=synthetic-jdbc-password",
    AZURE_BLOB_URL: "https://example.invalid/blob?sv=2026-01-01&sig=synthetic-sas-signature",
    GCS_SIGNED_URL: "https://example.invalid/object?X-Goog-Signature=synthetic-object-signature",
    OAUTH_CALLBACK_URL: "https://example.invalid/callback#access_token=synthetic-fragment-token&state=fixture",
    FRAGMENT_SIGNATURE_URL: "https://example.invalid/callback#sig=synthetic-fragment-signature&state=fixture",
    DATABASE_READONLY_URL: "postgres://db.internal/app?sslmode=require",
  });

  assert.equal(childEnv.DATABASE_URL, undefined, "database URL query passwords must not cross the child-process boundary");
  assert.equal(childEnv.REDIS_URL, undefined, "URL query access tokens must not cross the child-process boundary");
  assert.equal(childEnv.OIDC_ISSUER_URL, undefined, "URL query client secrets must not cross the child-process boundary");
  assert.equal(childEnv.JDBC_URL, undefined, "semicolon-style JDBC passwords must not cross the child-process boundary");
  assert.equal(childEnv.AZURE_BLOB_URL, undefined, "signed URL sig parameters must not cross the child-process boundary");
  assert.equal(childEnv.GCS_SIGNED_URL, undefined, "cloud storage URL signatures must not cross the child-process boundary");
  assert.equal(childEnv.OAUTH_CALLBACK_URL, undefined, "OAuth fragment tokens must not cross the child-process boundary");
  assert.equal(childEnv.FRAGMENT_SIGNATURE_URL, undefined, "URL fragment signatures must not cross the child-process boundary");
  assert.equal(childEnv.DATABASE_READONLY_URL, "postgres://db.internal/app?sslmode=require", "non-secret URL options should remain available");
});
