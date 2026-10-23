"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const github = require("../src/tools/families/github");

test("GitHub API repository identifiers cannot change the authorized path", () => {
  assert.equal(github.validateRepoName("owner/repository"), true);
  assert.equal(github.validateRepoName("owner.name/repo_name-1.git"), true);
  for (const value of [
    "owner/repository/../../other",
    "owner/../other",
    "../owner/repository",
    "owner//repository",
    "owner/repo?state=all",
    `${"a".repeat(200)}/repository`,
  ]) assert.equal(github.validateRepoName(value), false, value);
});

test("GitHub route identifiers reject path, query, and fragment injection", () => {
  for (const value of [1, "42", "1000000000"]) assert.equal(github.isGithubNumericId(value), true);
  for (const value of [0, -1, "01", "1/../../other", "1?state=all", "1#fragment", "x".repeat(11)]) {
    assert.equal(github.isGithubNumericId(value), false, String(value));
  }

  assert.equal(github.isGithubCommitId("abc1234"), true);
  assert.equal(github.isGithubCommitId("abc123"), true);
  assert.equal(github.isGithubCommitId("f".repeat(40)), true);
  for (const value of ["../../main", "abc1234?x", "abc12g", "g".repeat(40)]) {
    assert.equal(github.isGithubCommitId(value), false, value);
  }

  assert.equal(github.validateGithubRef("refs/heads/feature/update"), true);
  for (const value of ["refs/heads/../../other", "refs/heads/feature?x", "a//b", "../main", "x".repeat(256)]) {
    assert.equal(github.validateGithubRef(value), false, value);
  }
});

test("GitHub tool schema bounds and validates externally supplied targets", () => {
  const schema = github.descriptors.find(descriptor => descriptor.name === "github").schema;
  assert.equal(schema.safeParse({ action: "repo_info", repo: "owner/repository" }).success, true);
  assert.equal(schema.safeParse({ action: "repo_info", repo: "owner/repository/../../other" }).success, false);
  assert.equal(schema.safeParse({ action: "repo_info", repo: "owner/repository", args: "x".repeat(github.MAX_GITHUB_REQUEST_BYTES + 1) }).success, false);
});

test("GitHub API request JSON is bounded before opening a request", () => {
  assert.equal(github.serializeGithubBody({ title: "short" }).error, undefined);
  const tooLarge = github.serializeGithubBody({ body: "x".repeat(github.MAX_GITHUB_REQUEST_BYTES) });
  assert.match(tooLarge.error, /request body exceeded/);
});
