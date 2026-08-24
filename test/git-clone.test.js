"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const development = require("../src/tools/families/development");
const git = development.descriptors.find(descriptor => descriptor.name === "git");
const cloneSchema = git.schema;

function rejected(args) {
  assert.strictEqual(cloneSchema.safeParse(args).success, false, JSON.stringify(args));
}

async function main() {
  assert.ok(git);
  assert.strictEqual(git.risk, "high");
  assert.strictEqual(git.annotations.openWorldHint, true);
  assert.strictEqual(git.annotations.idempotentHint, false);
  rejected({ action: "clone", source_url: "https://example.test/repo.git", destination: "/tmp/x", args: "--upload-pack=evil" });
  const invalidUrls = ["file:///tmp/repo", "ssh://example.test/repo", "https://user:pass@example.test/repo.git", "https://example.test/repo\n.git"];
  for (const source_url of invalidUrls) {
    const result = await git.handler({ action: "clone", source_url, destination: "/tmp/git-clone-invalid" });
    assert.strictEqual(result.isError, true);
  }
  const invalidDestination = await git.handler({ action: "clone", source_url: "https://example.test/repo.git", destination: "relative" });
  assert.strictEqual(invalidDestination.isError, true);
  const invalidRef = await git.handler({ action: "clone", source_url: "https://example.test/repo.git", destination: "/tmp/git-clone-invalid", ref: "bad\nref" });
  assert.strictEqual(invalidRef.isError, true);

  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "git-clone-empty-"));
  const result = await git.handler({ action: "clone", source_url: "https://127.0.0.1/repo.git", destination });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /private|loopback|Refused/i);
  fs.rmSync(destination, { recursive: true, force: true });
  console.log("All Git clone tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
