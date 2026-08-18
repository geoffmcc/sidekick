const fs = require("fs");
const path = require("path");

const SECRET_FILES = Object.freeze({
  SIDEKICK_ENROLL_TOKEN: "sidekick_enroll_token",
  COMPUTE_TOKEN: "compute_token",
});

function readSecret(name) {
  const fileName = SECRET_FILES[name];
  if (!fileName) throw new Error(`Unsupported worker secret: ${name}`);

  const directory = process.env.SIDEKICK_SECRET_DIR;
  if (!directory || !path.isAbsolute(directory)) return "";
  const filePath = path.join(directory, fileName);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return "";
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return "";
  if (process.platform !== "win32" && (stat.mode & 0o022)) return "";

  let value;
  try {
    value = fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
  if (value.endsWith("\n")) value = value.slice(0, -1);
  if (value.endsWith("\r")) value = value.slice(0, -1);
  if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 16384) return "";
  return value;
}

module.exports = { readSecret };
