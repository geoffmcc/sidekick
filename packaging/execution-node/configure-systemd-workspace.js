"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DROP_IN_NAME = "workspace.conf";

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function systemdQuotePath(value) {
  if (/[^\x20-\x7e]/.test(value) || /[\r\n\0]/.test(value)) throw new Error("workspace path contains unsupported characters");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%")}"`;
}

function readConfig(configPath) {
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) {
    throw new Error("execution-node config file is unsafe");
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function configureWorkspaceWritePath({ configPath, home, unitDirectory }) {
  const config = readConfig(configPath);
  const workspace = config.workspaceRoot || config.workspace;
  const outputDirectory = path.join(unitDirectory, "sidekick-execution-node.service.d");
  const dropInPath = path.join(outputDirectory, DROP_IN_NAME);

  if (typeof workspace !== "string" || !path.isAbsolute(workspace) || workspace.split(/[\\/]/).includes("..")) {
    throw new Error("execution-node workspace root must be an absolute, traversal-free path");
  }
  const realHome = fs.realpathSync(home);
  const realWorkspace = fs.realpathSync(workspace);
  const projectsRoot = path.join(realHome, "Projects");
  if (!isWithin(projectsRoot, realWorkspace) || realWorkspace !== path.resolve(workspace)) {
    throw new Error("execution-node workspace must be a real directory under ~/Projects");
  }

  if (config.permissions?.write !== true) {
    try {
      const existing = fs.lstatSync(dropInPath);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("workspace systemd drop-in is unsafe");
      fs.unlinkSync(dropInPath);
      try { fs.rmdirSync(outputDirectory); } catch (error) { if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { writeEnabled: false, dropInPath: null };
  }

  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(outputDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("workspace systemd drop-in directory is unsafe");
  const content = `[Service]\nReadWritePaths=${systemdQuotePath(realWorkspace)}\n`;
  const tempPath = path.join(outputDirectory, `.${DROP_IN_NAME}.${process.pid}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tempPath, dropInPath);
    fs.chmodSync(dropInPath, 0o600);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(tempPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { writeEnabled: true, dropInPath };
}

if (require.main === module) {
  try {
    const configPath = process.argv[2];
    const home = process.argv[3] || process.env.HOME;
    const unitDirectory = process.argv[4] || path.join(home, ".config", "systemd", "user");
    if (!configPath || !home) throw new Error("config path and home directory are required");
    const result = configureWorkspaceWritePath({ configPath, home, unitDirectory });
    process.stdout.write(result.writeEnabled
      ? "Execution-node workspace write access is enabled for its configured workspace.\n"
      : "Execution-node workspace remains read-only at the systemd boundary.\n");
  } catch (error) {
    process.stderr.write(`Execution-node systemd setup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { configureWorkspaceWritePath, systemdQuotePath };
