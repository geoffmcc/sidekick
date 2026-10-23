"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const { hashFile } = require("../../src/core/stream-file-hash");
const { hashFile: hashToolFile, HASH_STREAM_HIGH_WATER_MARK } = require("../../src/tools/families/hashing");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-stream-hash-"));
after(() => {
  for (const name of ["large.bin", "bounded.bin", "target.txt", "link.txt"]) {
    try { fs.unlinkSync(path.join(root, name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  fs.rmdirSync(root);
});

test("file hashing streams bounded chunks and returns the exact byte count", async () => {
  const filePath = path.join(root, "large.bin");
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
  fs.writeFileSync(filePath, bytes);

  const details = await hashFile(filePath, "sha256");
  assert.equal(details.bytesRead, bytes.length);
  assert.equal(details.hash, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(HASH_STREAM_HIGH_WATER_MARK, 64 * 1024);
  assert.equal(await hashToolFile(filePath, "sha256"), details.hash, "the hash tool preserves its established result contract");
});

test("file hashing refuses a file that exceeds its configured byte limit", async () => {
  const filePath = path.join(root, "bounded.bin");
  fs.writeFileSync(filePath, Buffer.alloc(128 * 1024));
  await assert.rejects(hashFile(filePath, "sha256", { maxBytes: 1024 }), error => error.code === "HASH_FILE_TOO_LARGE");
});

test("file hashing refuses directories before streaming", async () => {
  await assert.rejects(hashFile(root, "sha256"), /regular file/i);
});

test("file hashing refuses symlinks on platforms with O_NOFOLLOW", async t => {
  if (typeof fs.constants.O_NOFOLLOW !== "number") return t.skip("platform does not expose O_NOFOLLOW");
  const target = path.join(root, "target.txt");
  const link = path.join(root, "link.txt");
  fs.writeFileSync(target, "sensitive");
  fs.symlinkSync(target, link);
  await assert.rejects(hashFile(link, "sha256"));
});
