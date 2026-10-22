"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const dns = require("dns");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-download-custody-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_SECRET_KEY = "download-custody-test-key";
process.env.SIDEKICK_ALLOWED_PATHS = dataDir;

const originalExecFileSync = childProcess.execFileSync;
const originalLookup = dns.promises.lookup;
dns.promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
let capturedArgs;
childProcess.execFileSync = (_command, args) => {
  capturedArgs = args;
  const template = args[args.indexOf("-o") + 1];
  const downloadedFile = template.replace("%(title)s", "fixture-video").replace("%(ext)s", "webm");
  fs.mkdirSync(path.dirname(downloadedFile), { recursive: true });
  fs.writeFileSync(downloadedFile, "fixture-video-bytes");
  return `[download] Destination: ${downloadedFile}\n`;
};

const dbStore = require("../src/db");
const { callMcpTool } = require("../src/tools");
const { sidekick_download } = require("../src/tools/families/media");
const { runWithContext } = require("../src/tools/context");
const { createOwnerContext } = require("./helpers/authorized-context");
process.env.SIDEKICK_TOOL_POLICY = "open";
process.env.SIDEKICK_APPROVAL_MODE = "off";
const owner = createOwnerContext({ project: "download-custody-test" });

async function main() {
  capturedArgs = undefined;
  const direct = await runWithContext(owner, () => sidekick_download({ url: "https://www.youtube.com/watch?v=must-not-run" }));
  assert.strictEqual(direct.code, "canonical_dispatch_required", "raw download handler calls must fail before starting a process");
  assert.strictEqual(capturedArgs, undefined, "direct denial must happen before invoking yt-dlp");

  const result = await callMcpTool("download", { url: "https://www.youtube.com/watch?v=fixture" }, owner);
  assert.ok(!result.isError, result.content?.[0]?.text);
  const payload = JSON.parse(result.content[0].text);
  assert.strictEqual(payload.status, "success");
  assert.ok(payload.artifact_id, "managed downloads must return an artifact id");
  assert.strictEqual(payload.storage_ref, "downloads/fixture-video.webm");
  assert.ok(capturedArgs.includes("--no-call-home"), "downloads must disable yt-dlp call-home behavior");
  assert.ok(capturedArgs.includes("--no-cache-dir"), "downloads must not persist an unbounded yt-dlp cache");
  assert.ok(capturedArgs.includes("--max-filesize"), "downloads must enforce a maximum file size");
  assert.ok(capturedArgs.includes("--socket-timeout"), "downloads must enforce a network socket timeout");
  assert.ok(capturedArgs.includes("--proxy"), "all yt-dlp requests, including redirects and media segments, must use the governed egress proxy");
  assert.ok(capturedArgs.includes("--ignore-config"), "downloads must not inherit user or system yt-dlp configuration");
  assert.ok(capturedArgs.includes("--no-plugin-dirs"), "downloads must not load ambient yt-dlp plugins");
  const proxyUrl = new URL(capturedArgs[capturedArgs.indexOf("--proxy") + 1]);
  assert.strictEqual(proxyUrl.hostname, "127.0.0.1", "download proxy must be loopback-bound");
  assert.ok(proxyUrl.username && proxyUrl.password, "download proxy must require an ephemeral credential");
  assert.ok(Number(proxyUrl.port) > 0, "download proxy must use its ephemeral listener port");

  dns.promises.lookup = async () => [{ address: "127.0.0.1", family: 4 }];
  const refused = await callMcpTool("download", { url: "https://media.example/video" }, owner);
  assert.strictEqual(refused.isError, true, "DNS-resolved private download targets must be refused");

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
  dns.promises.lookup = originalLookup;
  try { dbStore.getDb().close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("Download custody test passed");
}).catch((error) => {
  childProcess.execFileSync = originalExecFileSync;
  dns.promises.lookup = originalLookup;
  try { dbStore.getDb().close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.error(error.stack || error);
  process.exitCode = 1;
});
