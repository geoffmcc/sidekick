"use strict";

const fs = require("fs");

function appendAuditLine(filePath, line, io = fs) {
  const noFollow = io.constants.O_NOFOLLOW || 0;
  let before = null;
  try {
    before = io.lstatSync(filePath);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("dashboard audit log must be a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const fd = io.openSync(filePath, io.constants.O_WRONLY | io.constants.O_APPEND | io.constants.O_CREAT | noFollow, 0o600);
  try {
    const opened = io.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || (before && (opened.dev !== before.dev || opened.ino !== before.ino))) {
      throw new Error("dashboard audit log changed while opening or is not a private regular file");
    }
    if (process.platform !== "win32") io.fchmodSync(fd, 0o600);
    const data = Buffer.from(line, "utf8");
    let offset = 0;
    while (offset < data.length) offset += io.writeSync(fd, data, offset, data.length - offset);
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
}

module.exports = { appendAuditLine };
