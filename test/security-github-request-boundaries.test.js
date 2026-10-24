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

test("GitHub pagination stays on the authorized HTTPS resource path", () => {
  const expected = "https://api.github.com/repos/owner/repository/commits/abc123/status?per_page=100";
  assert.equal(
    github.endpointFromGithubUrl("https://api.github.com/repos/owner/repository/commits/abc123/status?per_page=100&page=2", expected),
    "/repos/owner/repository/commits/abc123/status?per_page=100&page=2",
  );
  for (const next of [
    "https://api.github.com/user",
    "https://api.github.com/repos/other/private",
    "https://attacker.example/repos/owner/repository/commits/abc123/status?page=2",
    "http://api.github.com/repos/owner/repository/commits/abc123/status?page=2",
    "https://user@api.github.com/repos/owner/repository/commits/abc123/status?page=2",
  ]) assert.equal(github.endpointFromGithubUrl(next, expected), null, next);
  assert.equal(github.MAX_GITHUB_PAGINATED_RESPONSE_BYTES, 16 * 1024 * 1024);
});

test("GitHub error output redacts exact credentials and sensitive response fields", () => {
  const token = "synthetic-custom-github-token-7f39bda2";
  const result = github.redactGithubError({
    message: `upstream reflected ${token}`,
    authorization: token,
    documentation_url: "https://github.example.invalid/errors",
  }, token);
  assert.ok(!result.includes(token));
  assert.match(result, /\[REDACTED\]/);
  assert.match(result, /documentation_url/);

  const projected = github.redactGithubResult({ content: [
    { type: "text", text: `private PR body contains ${token}` },
    { type: "image", data: "synthetic-image-payload" },
  ] }, token);
  assert.ok(!JSON.stringify(projected).includes(token));
  assert.match(projected.content[0].text, /\[REDACTED\]/);
  assert.equal(projected.content[1].data, "synthetic-image-payload");
});
