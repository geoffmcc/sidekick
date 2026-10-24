const fs = require("fs");
const path = require("path");

const SECRET_FILES = Object.freeze({
  SIDEKICK_ENROLL_TOKEN: "sidekick_enroll_token",
  COMPUTE_TOKEN: "compute_token",
});

// Keep this check local: the standalone worker package is intentionally
// forbidden from depending on Core. Mirror the Core secret-directory rule so
// the same credentials remain protected in the packaged worker runtime.
function assertSafeSecretDirectory(directoryPath) {
  if (!path.isAbsolute(directoryPath)) throw new Error("secret directory path must be absolute");
  const resolved = path.resolve(directoryPath);
  const root = path.parse(resolved).root;
  const segments = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let currentDirectory = root;
  for (const segment of segments) {
    currentDirectory = path.join(currentDirectory, segment);
    const stat = fs.lstatSync(currentDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("secret directory is not a real directory");
    const writableByOthers = process.platform !== "win32" && (stat.mode & 0o022) !== 0;
    const secureStickyAncestor = currentDirectory !== resolved && (stat.mode & 0o1000) !== 0;
    if (writableByOthers && !secureStickyAncestor) throw new Error("secret directory is writable by other users");
  }
  return resolved;
}

function readSecret(name) {
  const fileName = SECRET_FILES[name];
  if (!fileName) throw new Error(`Unsupported worker secret: ${name}`);

  const directory = process.env.SIDEKICK_SECRET_DIR;
  if (!directory || !path.isAbsolute(directory)) return "";
  let safeDirectory;
  try {
    safeDirectory = assertSafeSecretDirectory(directory);
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
