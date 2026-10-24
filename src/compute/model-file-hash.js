"use strict";

const crypto = require("crypto");
const fs = require("fs");

const MAX_MODEL_MANIFEST_FILE_BYTES = 50 * 1024 * 1024;
const MODEL_HASH_CHUNK_BYTES = 1024 * 1024;

function fileError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sameFileIdentity(left, right) {
  return Number.isFinite(left.dev) && Number.isFinite(left.ino) && left.ino !== 0
    && left.dev === right.dev && left.ino === right.ino;
}

function openRegularFileNoFollow(filePath) {
  const hasNoFollow = typeof fs.constants.O_NOFOLLOW === "number";
  let before = null;
  if (!hasNoFollow) {
    try { before = fs.lstatSync(filePath); }
    catch { throw fileError("Model manifest file could not be safely inspected", "MODEL_FILE_UNSAFE"); }
    if (before.isSymbolicLink() || !before.isFile()) {
      throw fileError("Model manifest path must be a regular non-symlink file", "MODEL_FILE_UNSAFE");
    }
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (hasNoFollow ? fs.constants.O_NOFOLLOW : 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw fileError("Model manifest path must be a regular file", "MODEL_FILE_UNSAFE");
    if (before) {
      let after;
      try { after = fs.lstatSync(filePath); }
      catch { throw fileError("Model manifest path changed while opening", "MODEL_FILE_UNSAFE"); }
      if (after.isSymbolicLink() || !sameFileIdentity(before, stat) || !sameFileIdentity(stat, after)) {
        throw fileError("Model manifest path changed while opening", "MODEL_FILE_UNSAFE");
      }
    }
    return { fd, stat };
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    throw error;
  }
}

function sha256File(filePath) {
  const { fd, stat: initialStat } = openRegularFileNoFollow(filePath);
  try {
    if (initialStat.size > MAX_MODEL_MANIFEST_FILE_BYTES) {
      throw fileError(`Model manifest file exceeds the ${MAX_MODEL_MANIFEST_FILE_BYTES}-byte integrity limit`, "MODEL_FILE_TOO_LARGE");
    }

    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(MODEL_HASH_CHUNK_BYTES);
    let offset = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > MAX_MODEL_MANIFEST_FILE_BYTES) {
        throw fileError(`Model manifest file exceeds the ${MAX_MODEL_MANIFEST_FILE_BYTES}-byte integrity limit`, "MODEL_FILE_TOO_LARGE");
      }
      hash.update(buffer.subarray(0, bytesRead));
    }

    const finalStat = fs.fstatSync(fd);
    if (offset !== initialStat.size
      || finalStat.size !== initialStat.size
      || finalStat.mtimeMs !== initialStat.mtimeMs
      || finalStat.ctimeMs !== initialStat.ctimeMs) {
      throw fileError("Model manifest file changed during integrity verification", "MODEL_FILE_CHANGED");
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { sha256File, MAX_MODEL_MANIFEST_FILE_BYTES };
