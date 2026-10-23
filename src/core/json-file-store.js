"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { readTextBounded, MAX_BOUNDED_FILE_READ_BYTES } = require("./bounded-file-read");

const DEFAULT_JSON_STORE_BYTES = 5 * 1024 * 1024;

function storeLimit(maxBytes) {
  const limit = maxBytes == null ? DEFAULT_JSON_STORE_BYTES : Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BOUNDED_FILE_READ_BYTES) {
    throw new Error("JSON store size limit is invalid");
  }
  return limit;
}

function readJsonFile(filePath, { maxBytes = DEFAULT_JSON_STORE_BYTES } = {}) {
  const limit = storeLimit(maxBytes);
  const text = readTextBounded(filePath, { maxBytes: limit, requireComplete: true, noFollow: true }).content;
  return JSON.parse(text);
}

function writeJsonFile(filePath, value, { maxBytes = DEFAULT_JSON_STORE_BYTES, mode = 0o600 } = {}) {
  const limit = storeLimit(maxBytes);
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== "string") throw new Error("JSON store value is not serializable");
  if (Buffer.byteLength(serialized, "utf8") > limit) throw new Error(`JSON store exceeds the ${limit}-byte limit`);

  const directory = path.dirname(path.resolve(filePath));
  const temporaryPath = path.join(directory, `.sidekick-json-${crypto.randomUUID()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temporaryPath, "wx", mode);
    fs.writeFileSync(fd, serialized, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporaryPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

module.exports = { DEFAULT_JSON_STORE_BYTES, readJsonFile, writeJsonFile };
