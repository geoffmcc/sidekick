"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-download-custody-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_SECRET_KEY = "download-custody-test-key";

const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = (_command, args) => {
  const template = args[args.indexOf("-o") + 1];
  const downloadedFile = template.replace("%(title)s", "fixture-video").replace("%(ext)s", "webm");
  fs.mkdirSync(path.dirname(downloadedFile), { recursive: true });
  fs.writeFileSync(downloadedFile, "fixture-video-bytes");
  return `[download] Destination: ${downloadedFile}\n`;
};

const dbStore = require("../src/db");
const { sidekick_download } = require("../src/tools/families/media");

async function main() {
  const result = await sidekick_download({ url: "https://www.youtube.com/watch?v=fixture" });
  assert.strictEqual(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.strictEqual(payload.status, "success");
  assert.ok(payload.artifact_id, "managed downloads must return an artifact id");
  assert.strictEqual(payload.storage_ref, "downloads/fixture-video.webm");

  const artifact = dbStore.getDb().prepare("SELECT type, storage_ref, byte_size, content_hash, content_type, producer FROM platform_artifacts WHERE artifact_id = ?").get(payload.artifact_id);
  assert.deepStrictEqual(artifact, {
    type: "media_download",
    storage_ref: "downloads/fixture-video.webm",
    byte_size: Buffer.byteLength("fixture-video-bytes"),
    content_hash: "sha256:fef970131a70d412a011d8b7c7401bd2d8efdcd39779cfc735b4cc66ceda2cc8",
    content_type: "video/webm",
    producer: "download",
  });
}

main().then(() => {
  childProcess.execFileSync = originalExecFileSync;
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("Download custody test passed");
}).catch((error) => {
  childProcess.execFileSync = originalExecFileSync;
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.error(error.stack || error);
  process.exitCode = 1;
});
