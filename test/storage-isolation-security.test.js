"use strict";

const assert = require("assert");
const context = require("../src/tools/context");
const storage = require("../src/tools/families/storage");

async function asPrincipal(principalId, project, fn) {
  const execution = context.createTestExecutionContext({
    authIdentity: { principal_id: principalId, scopes: ["*"] },
    project,
  });
  return context.runWithContext(execution, fn);
}

async function main() {
  const key = `isolation_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await asPrincipal("security-test-principal-a", "alpha", () => storage.sidekick_store({ key, value: "alpha-secret", project: "alpha" }));

  const crossUser = await asPrincipal("security-test-principal-b", "alpha", () => storage.sidekick_get({ key }));
  assert.strictEqual(crossUser.isError, true, "another principal must not read a known KV key");

  const sameUser = await asPrincipal("security-test-principal-a", "alpha", () => storage.sidekick_get({ key }));
  assert.match(sameUser.content[0].text, /alpha-secret/, "the owner must retain legitimate access");

  const otherProject = await asPrincipal("security-test-principal-a", "beta", () => storage.sidekick_get({ key }));
  assert.strictEqual(otherProject.isError, true, "a project-scoped key must not cross project context");

  await asPrincipal("security-test-principal-a", "alpha", () => storage.sidekick_delete({ key }));
  console.log("storage isolation security tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
