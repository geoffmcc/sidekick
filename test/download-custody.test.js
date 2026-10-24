"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const dns = require("dns");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-download-custody-"));
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_SECRET_KEY = "download-custody-test-key";
process.env.SIDEKICK_ALLOWED_PATHS = dataDir;

const originalExecFile = childProcess.execFile;
const browserEgress = require("../src/browser/egress");
const originalCreateSessionProxy = browserEgress.createSessionProxy;
let createdProxy = null;
let proxyProbe = null;
browserEgress.createSessionProxy = async (...args) => {
  createdProxy = await originalCreateSessionProxy(...args);
  return createdProxy;
};
const originalLookup = dns.promises.lookup;
dns.promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
let capturedArgs;
let failDownloader = false;
let cancelDownloader = false;
function proxyRequest(proxyUrl, authenticated) {
  return new Promise((resolve, reject) => {
    const headers = { Host: "127.0.0.1" };
    if (authenticated) headers["Proxy-Authorization"] = "Basic " + Buffer.from(`${proxyUrl.username}:${proxyUrl.password}`).toString("base64");
    const request = http.request({
      hostname: "127.0.0.1",
      port: Number(proxyUrl.port),
      method: "GET",
      path: "http://127.0.0.1:80/",
      headers,
      agent: false,
    }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

childProcess.execFile = (_command, args, _options, callback) => {
  capturedArgs = args;
  const proxyUrl = new URL(args[args.indexOf("--proxy") + 1]);
  Promise.all([proxyRequest(proxyUrl, false), proxyRequest(proxyUrl, true)]).then(([unauthenticated, privateTarget]) => {
    proxyProbe = { unauthenticated, privateTarget };
    if (cancelDownloader) {
      if (!_options.signal) return callback(new Error("downloader did not receive the execution signal"));
      _options.signal.addEventListener("abort", () => {
        const error = new Error("synthetic abort");
        error.name = "AbortError";
        callback(error);
      }, { once: true });
      return;
    }
    const template = args[args.indexOf("-o") + 1];
    if (failDownloader) {
      callback(new Error(`synthetic downloader failure: ${args[args.indexOf("--proxy") + 1]} source=${args[args.length - 1]}`));
      return;
    }
    const downloadedFile = template.replace("%(title)s", "fixture-video").replace("%(ext)s", "webm");
    fs.mkdirSync(path.dirname(downloadedFile), { recursive: true });
    fs.writeFileSync(downloadedFile, "fixture-video-bytes");
    callback(null, `[download] Destination: ${downloadedFile}\n`, "");
  }, callback);
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

  const syntheticUrlCredential = "synthetic-download-ticket-value";
  const sourceUrl = `https://www.youtube.com/watch?v=fixture&download_ticket=${syntheticUrlCredential}`;
  const result = await callMcpTool("download", { url: sourceUrl }, owner);
  assert.ok(!result.isError, result.content?.[0]?.text);
  const payload = JSON.parse(result.content[0].text);
  assert.strictEqual(payload.status, "success");
  assert.strictEqual(payload.url, "https://www.youtube.com", "download results must expose only the source origin");
  assert.ok(!result.content[0].text.includes(syntheticUrlCredential), "download results must not expose URL query credentials");
  const loggedArguments = dbStore.getDb().prepare("SELECT args_summary FROM tool_logs WHERE tool_name = 'download' ORDER BY id DESC LIMIT 1").get()?.args_summary || "";
  assert.ok(!loggedArguments.includes(syntheticUrlCredential), "download tool logs must not persist URL query credentials");
  assert.ok(loggedArguments.includes("https://www.youtube.com"), "download logs retain the source origin for attribution");
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
  assert.deepStrictEqual(proxyProbe, { unauthenticated: 407, privateTarget: 403 }, "the downloader's active proxy authenticates clients and blocks private destinations before connecting");
  assert.strictEqual(createdProxy.server.listening, false, "the per-download egress proxy must close after yt-dlp exits");

  failDownloader = true;
  const failedDownload = await callMcpTool("download", { url: `https://www.youtube.com/watch?v=synthetic-failure&download_ticket=${syntheticUrlCredential}` }, owner);
  const failedText = failedDownload.content?.[0]?.text || "";
  assert.strictEqual(failedDownload.isError, true, "downloader errors must be surfaced as failures");
  assert.ok(!failedText.includes("@127.0.0.1:"), "temporary proxy credentials must not escape through downloader error messages");
  assert.ok(!failedText.includes(syntheticUrlCredential), "downloader errors must not expose arbitrary URL query credentials");
  assert.strictEqual(createdProxy.server.listening, false, "the proxy must close after downloader failure too");
  failDownloader = false;

  cancelDownloader = true;
  const controller = new AbortController();
  const cancelledPromise = callMcpTool("download", { url: "https://www.youtube.com/watch?v=synthetic-cancel" }, { ...owner, signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  const cancelled = await cancelledPromise;
  assert.strictEqual(cancelled.code, "cancelled", "dispatcher cancellation must reach the downloader execution context");
  for (let attempt = 0; createdProxy.server.listening && attempt < 20; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.strictEqual(createdProxy.server.listening, false, "the per-download proxy must close after cancellation");
  cancelDownloader = false;

  dns.promises.lookup = async () => [{ address: "127.0.0.1", family: 4 }];
  const refused = await callMcpTool("download", { url: "https://media.example/video" }, owner);
  assert.strictEqual(refused.isError, true, "DNS-resolved private download targets must be refused");

  const artifact = dbStore.getDb().prepare("SELECT type, storage_ref, byte_size, content_hash, content_type, producer, metadata_json, verification_json FROM platform_artifacts WHERE artifact_id = ?").get(payload.artifact_id);
  assert.deepStrictEqual(artifact, {
    type: "media_download",
    storage_ref: "downloads/fixture-video.webm",
    byte_size: Buffer.byteLength("fixture-video-bytes"),
    content_hash: "sha256:fef970131a70d412a011d8b7c7401bd2d8efdcd39779cfc735b4cc66ceda2cc8",
    content_type: "video/webm",
    producer: "download",
    metadata_json: JSON.stringify({ source_url: "https://www.youtube.com", audio_only: false }),
    verification_json: JSON.stringify({ verified: true, method: "sha256", source_url: "https://www.youtube.com" }),
  });
  assert.ok(!JSON.stringify(artifact).includes(syntheticUrlCredential), "artifact persistence must not contain URL query credentials");
}

main().then(() => {
  childProcess.execFile = originalExecFile;
  browserEgress.createSessionProxy = originalCreateSessionProxy;
  dns.promises.lookup = originalLookup;
  try { dbStore.getDb().close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("Download custody test passed");
}).catch((error) => {
  childProcess.execFile = originalExecFile;
  browserEgress.createSessionProxy = originalCreateSessionProxy;
  dns.promises.lookup = originalLookup;
  try { dbStore.getDb().close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.error(error.stack || error);
  process.exitCode = 1;
});
