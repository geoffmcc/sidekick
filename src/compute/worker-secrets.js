const fs = require("fs");
const path = require("path");
const { assertSafeSecretDirectory } = require("../core/runtime-secrets");

const SECRET_FILES = Object.freeze({
  SIDEKICK_ENROLL_TOKEN: "sidekick_enroll_token",
  COMPUTE_TOKEN: "compute_token",
});

function readSecret(name) {
  const fileName = SECRET_FILES[name];
  if (!fileName) throw new Error(`Unsupported worker secret: ${name}`);

  const directory = process.env.SIDEKICK_SECRET_DIR;
  if (!directory || !path.isAbsolute(directory)) return "";
  let safeDirectory;
  try {
    safeDirectory = assertSafeSecretDirectory(directory, name);
  } catch {
    return "";
  }
  const filePath = path.join(safeDirectory, fileName);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return "";
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return "";
  if (process.platform !== "win32" && ((stat.mode & 0o022) || (stat.mode & 0o004))) return "";

  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || stat.dev !== opened.dev || stat.ino !== opened.ino ||
        (process.platform !== "win32" && ((opened.mode & 0o022) || (opened.mode & 0o004))) ||
        opened.size > 16384) return "";
    let value = fs.readFileSync(fd, "utf8");
    if (Buffer.byteLength(value, "utf8") > 16384) return "";
    if (value.endsWith("\n")) value = value.slice(0, -1);
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (!value || value.includes("\0")) return "";
    return value;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

module.exports = { readSecret };
