"use strict";

const fs = require("fs");

const MAX_BOUNDED_FILE_READ_BYTES = 50 * 1024 * 1024;
const DEFAULT_FILE_READ_BYTES = 1024 * 1024;

function fileReadError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readTextBounded(filePath, { maxBytes = DEFAULT_FILE_READ_BYTES, offset = 0, requireComplete = false } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BOUNDED_FILE_READ_BYTES) {
    throw fileReadError("File read limit is invalid", "FILE_READ_LIMIT_INVALID");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw fileReadError("File read offset is invalid", "FILE_READ_OFFSET_INVALID");
  }

  const nonBlocking = fs.constants.O_NONBLOCK || 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | nonBlocking);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw fileReadError("Path does not refer to a regular file", "FILE_READ_NOT_REGULAR");

    const bytesAvailable = Math.max(0, stat.size - offset);
    if (requireComplete && bytesAvailable > maxBytes) {
      throw fileReadError(`File exceeds the ${maxBytes}-byte read limit`, "FILE_READ_TOO_LARGE");
    }
    const bytesToRead = Math.min(maxBytes, bytesAvailable);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    let bytesRead = 0;
    while (bytesRead < bytesToRead) {
      const count = fs.readSync(fd, buffer, bytesRead, bytesToRead - bytesRead, offset + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }

    const truncated = offset + bytesRead < stat.size;
    if (requireComplete && truncated) {
      throw fileReadError(`File exceeds the ${maxBytes}-byte read limit`, "FILE_READ_TOO_LARGE");
    }
    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      bytesRead,
      size: stat.size,
      offset,
      truncated,
    };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readTextBounded, MAX_BOUNDED_FILE_READ_BYTES, DEFAULT_FILE_READ_BYTES };
