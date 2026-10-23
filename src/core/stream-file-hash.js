"use strict";

const crypto = require("crypto");
const fs = require("fs");

const HASH_STREAM_HIGH_WATER_MARK = 64 * 1024;
const HASH_FILE_TIMEOUT_MS = 5 * 60 * 1000;

function hashFile(filePath, algorithm = "sha256", options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || HASH_FILE_TIMEOUT_MS);
  const maxBytes = options.maxBytes == null ? Infinity : Number(options.maxBytes);
  if (!(maxBytes >= 0)) return Promise.reject(new Error("maxBytes must be a non-negative number"));

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    const nonBlocking = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
    let fd = null;
    let stream;
    try {
      // O_NONBLOCK prevents a caller-selected FIFO from blocking before the
      // regular-file check. O_NOFOLLOW closes the final-component symlink gap
      // on platforms that expose it.
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
      if (!fs.fstatSync(fd).isFile()) throw new Error("Hash input must be a regular file");
      stream = fs.createReadStream(null, { fd, autoClose: true, highWaterMark: HASH_STREAM_HIGH_WATER_MARK });
      fd = null;
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      reject(error);
      return;
    }
    let bytesRead = 0;
    let settled = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    timer = setTimeout(() => {
      const error = new Error(`File hashing exceeded the ${timeoutMs}-ms time limit`);
      error.code = "HASH_FILE_TIMEOUT";
      finish(reject, error);
      stream.destroy();
    }, timeoutMs);
    timer.unref?.();

    stream.on("data", chunk => {
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        const error = new Error(`File hashing exceeded the ${maxBytes}-byte limit`);
        error.code = "HASH_FILE_TOO_LARGE";
        finish(reject, error);
        stream.destroy();
        return;
      }
      hash.update(chunk);
    });
    stream.once("error", error => finish(reject, error));
    stream.once("end", () => finish(resolve, { hash: hash.digest("hex"), bytesRead }));
  });
}

module.exports = { hashFile, HASH_STREAM_HIGH_WATER_MARK, HASH_FILE_TIMEOUT_MS };
