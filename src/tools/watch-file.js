"use strict";

const fs = require("fs");
const { getPathPolicyDecision } = require("./path-policy");

const MAX_WATCH_FILE_BYTES = 1024 * 1024;

/** Check a watch file without returning its contents to actions, events, or logs. */
function checkWatchFile(filePath, pattern, { source = "unknown" } = {}) {
  const decision = getPathPolicyDecision(filePath, "read", source);
  if (!decision.allowed) {
    const error = new Error("watch file target denied by current path policy");
    error.code = "path_policy_denied";
    error.policyDenied = true;
    throw error;
  }

  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { exists: false, matches: false };
    if (stat.size > MAX_WATCH_FILE_BYTES) {
      const error = new Error("watch file exceeds the configured size limit");
      error.code = "watch_file_too_large";
      throw error;
    }
    const buffer = Buffer.alloc(Math.min(MAX_WATCH_FILE_BYTES + 1, stat.size + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_WATCH_FILE_BYTES || fs.fstatSync(fd).size > MAX_WATCH_FILE_BYTES) {
      const error = new Error("watch file exceeds the configured size limit");
      error.code = "watch_file_too_large";
      throw error;
    }
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    return { exists: true, matches: pattern ? content.includes(pattern) : true };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { exists: false, matches: false };
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = Object.freeze({ checkWatchFile, MAX_WATCH_FILE_BYTES });
