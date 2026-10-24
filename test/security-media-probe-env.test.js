"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const originalExecFileSync = childProcess.execFileSync;
const calls = [];
let failProbe = false;
let media;
childProcess.execFileSync = (command, args, options) => {
  calls.push({ command, args, options });
  if (failProbe) throw new Error("synthetic utility unavailable");
  return "synthetic device";
};
try {
  media = require("../src/tools/families/media");
} finally {
  childProcess.execFileSync = originalExecFileSync;
}

test("media hardware probes receive the filtered child environment", () => {
  const key = "SIDEKICK_MEDIA_TEST_API_KEY";
  const previous = process.env[key];
  process.env[key] = "synthetic-media-probe-secret";
  try {
    assert.equal(media.localCudaAvailable(), true);
    assert.equal(media.localVulkanAvailable(), true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.command), ["nvidia-smi", "vulkaninfo"]);
    assert.deepEqual(calls.map(call => call.args), [["--query-gpu=name", "--format=csv,noheader"], ["--summary"]]);
    assert.deepEqual(calls.map(call => call.options.timeout), [2000, 3000]);
    for (const { options } of calls) {
      assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
      assert.equal(options.env[key], undefined, "probe must not inherit the synthetic service credential");
      assert.equal(options.env.PATH, process.env.PATH, "normal executable discovery remains available");
    }
    failProbe = true;
    assert.equal(media.localCudaAvailable(), false, "a failed optional probe degrades to unavailable");
    assert.equal(media.localVulkanAvailable(), false, "a failed optional probe degrades to unavailable");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("transcription output reads are bounded and report truncation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-transcript-read-"));
  const file = path.join(root, "transcript.txt");
  try {
    fs.writeFileSync(file, "x".repeat(128));
    assert.equal(media.readTranscriptionText(file, 16), `${"x".repeat(16)}\n[transcript truncated at 16 bytes]`);
    fs.writeFileSync(file, "small transcript");
    assert.equal(media.readTranscriptionText(file, 32), "small transcript");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("transcription outputs are confined to each invocation's private directory", () => {
  const root = path.join(os.tmpdir(), "sidekick-private-transcription-fixture");
  assert.equal(media.transcriptionOutputPath("whisper.cpp", "recording.wav", root), path.join(root, "transcript.txt"));
  assert.equal(media.transcriptionOutputPath("faster-whisper", "recording.wav", root), path.join(root, "recording.txt"));
  assert.equal(path.dirname(media.transcriptionOutputPath("whisper", "..\\outside.wav", root)), root);
});
