"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_NAME = "Sidekick";

function defaultHome() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir(), APP_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(process.env.HOME || os.homedir(), "Library", "Application Support", APP_NAME);
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || os.homedir(), ".local", "share"), "sidekick");
}

function getLocalPaths() {
  const home = path.resolve(process.env.SIDEKICK_HOME || defaultHome());
  const data = path.resolve(process.env.SIDEKICK_DATA_DIR || path.join(home, "data"));
  if (!path.isAbsolute(home) || !path.isAbsolute(data)) throw new Error("Sidekick local paths must be absolute");
  return Object.freeze({
    home,
    data,
    db: path.join(data, "sidekick.db"),
    backups: path.join(data, "backups"),
    lock: path.join(home, ".bootstrap.lock")
  });
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Sidekick path is not a real directory: ${directory}`);
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

function acquireBootstrapLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  const started = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), { encoding: "utf8" });
      return () => {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lockPath); } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let lockStat;
      try { lockStat = fs.lstatSync(lockPath); } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }
      if (lockStat.isSymbolicLink() || !lockStat.isFile()) {
        throw new Error("Sidekick bootstrap lock is not a regular file");
      }
      // A crashed initializer must not permanently strand a user's local
      // installation. Only reclaim a lock whose recorded owner is provably no
      // longer alive; malformed locks fail closed and can be removed manually.
      try {
        const rawLock = fs.readFileSync(lockPath, "utf8");
        // The creator writes the record immediately after exclusive creation;
        // another process may observe the tiny interval between those calls.
        if (!rawLock.trim()) {
          if (Date.now() - started >= timeoutMs) throw new Error("Timed out waiting for another Sidekick initialization");
          continue;
        }
        const record = JSON.parse(rawLock);
        if (Number.isInteger(record.pid) && record.pid > 0) {
          try { process.kill(record.pid, 0); }
          catch (probeError) {
            if (probeError.code === "ESRCH") {
              try { fs.unlinkSync(lockPath); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
              continue;
            }
          }
        }
      } catch (readError) {
        // The owner may release the lock after lstatSync succeeds but before
        // readFileSync runs. Treat that observation race like a released lock
        // and retry acquisition instead of failing startup with ENOENT.
        if (readError.code === "ENOENT") continue;
        if (readError instanceof SyntaxError) throw new Error("Sidekick bootstrap lock is invalid");
        throw readError;
      }
      if (Date.now() - started >= timeoutMs) throw new Error("Timed out waiting for another Sidekick initialization");
      // The SQLite migration runner remains the source of truth for schema
      // safety; this short lock only serializes local bootstrap side effects.
      const waitUntil = Date.now() + 100;
      while (Date.now() < waitUntil) {}
    }
  }
}

function prepareLocalEnvironment() {
  const paths = getLocalPaths();
  ensurePrivateDirectory(paths.home);
  ensurePrivateDirectory(paths.data);
  ensurePrivateDirectory(paths.backups);
  process.env.SIDEKICK_LOCAL = "1";
  process.env.SIDEKICK_DATA_DIR = paths.data;
  process.env.SIDEKICK_BACKUP_DIR = paths.backups;
  return paths;
}

module.exports = { getLocalPaths, prepareLocalEnvironment, acquireBootstrapLock };
