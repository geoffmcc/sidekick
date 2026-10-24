"use strict";

const fs = require("fs");

const MAX_BOUNDED_FILE_READ_BYTES = 50 * 1024 * 1024;
const DEFAULT_FILE_READ_BYTES = 1024 * 1024;

function fileReadError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sameFileIdentity(left, right) {
  return Number.isFinite(left.dev) && Number.isFinite(left.ino) && left.ino !== 0
    && left.dev === right.dev && left.ino === right.ino;
}

function openRegularFile(filePath, { noFollow = false, nonBlocking = true } = {}) {
  const hasNoFollow = noFollow && typeof fs.constants.O_NOFOLLOW === "number";
  let pathStat = null;
  if (noFollow && !hasNoFollow) {
    try { pathStat = fs.lstatSync(filePath); }
    catch { throw fileReadError("Path could not be safely inspected", "FILE_READ_NOT_REGULAR"); }
    if (pathStat.isSymbolicLink()) throw fileReadError("Path is not a regular file (symlinks are not allowed)", "FILE_READ_SYMLINK");
    if (!pathStat.isFile()) throw fileReadError("Path does not refer to a regular file", "FILE_READ_NOT_REGULAR");
  }

  const flags = fs.constants.O_RDONLY
    | (nonBlocking ? (fs.constants.O_NONBLOCK || 0) : 0)
    | (hasNoFollow ? fs.constants.O_NOFOLLOW : 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw fileReadError("Path does not refer to a regular file", "FILE_READ_NOT_REGULAR");
    if (pathStat) {
      let currentPathStat;
      try { currentPathStat = fs.lstatSync(filePath); }
      catch { throw fileReadError("Path changed while it was being opened", "FILE_READ_SYMLINK"); }
      if (currentPathStat.isSymbolicLink() || !sameFileIdentity(pathStat, stat) || !sameFileIdentity(stat, currentPathStat)) {
        throw fileReadError("Path changed while it was being opened", "FILE_READ_SYMLINK");
      }
    }
    return { fd, stat };
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    throw error;
  }
}

function readTextBounded(filePath, { maxBytes = DEFAULT_FILE_READ_BYTES, offset = 0, requireComplete = false, noFollow = false } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BOUNDED_FILE_READ_BYTES) {
    throw fileReadError("File read limit is invalid", "FILE_READ_LIMIT_INVALID");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw fileReadError("File read offset is invalid", "FILE_READ_OFFSET_INVALID");
  }

  const { fd, stat } = openRegularFile(filePath, { noFollow });
  try {
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

module.exports = { openRegularFile, readTextBounded, MAX_BOUNDED_FILE_READ_BYTES, DEFAULT_FILE_READ_BYTES };
