"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-db-backup-paths-"));
const envNames = ["SIDEKICK_DATA_DIR", "SIDEKICK_DB_FILE", "SIDEKICK_BACKUP_DIR"];
const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const dataDir = path.join(fixtureRoot, "data");
const backupDir = path.join(dataDir, "backups");
fs.mkdirSync(backupDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
process.env.SIDEKICK_DB_FILE = path.join(dataDir, "sidekick.db");
process.env.SIDEKICK_BACKUP_DIR = backupDir;

const dbStore = require("../src/db");
const victimPath = path.join(fixtureRoot, "synthetic-outside-target.bin");
const originalVictim = Buffer.from("synthetic target must remain unchanged");
const originalVictimDigest = crypto.createHash("sha256").update(originalVictim).digest("hex");
fs.writeFileSync(victimPath, originalVictim);
const assertVictimUnchanged = () => assert.equal(
  crypto.createHash("sha256").update(fs.readFileSync(victimPath)).digest("hex"),
  originalVictimDigest,
  "backup and restore must not overwrite a hard-link target",
);

test.after(() => {
  dbStore.closeDatabase();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("raw backup temp files cannot write through pre-planted hard links", () => {
  const destination = path.join(backupDir, "raw-link-test.db");
  fs.linkSync(victimPath, `${destination}.tmp`);
  const result = dbStore.createBackup(destination, false);
  assert.equal(result.path, destination);
  assertVictimUnchanged();
  assert.equal(fs.statSync(`${destination}.tmp`).nlink, 2, "the pre-planted decoy link is left untouched");
});

test("compressed backup output cannot write through a pre-planted hard link", () => {
  const destination = path.join(backupDir, "compressed-link-test.db");
  fs.linkSync(victimPath, `${destination}.gz`);
  const result = dbStore.createBackup(destination, true);
  assert.equal(result.path, `${destination}.gz`);
  assertVictimUnchanged();
});

test("compressed restore temp files cannot write through pre-planted hard links", () => {
  const source = dbStore.createBackup(path.join(backupDir, "restore-seed.db"), false);
  const compressedSource = path.join(backupDir, "restore-source.db.gz");
  fs.writeFileSync(compressedSource, zlib.gzipSync(fs.readFileSync(source.path)), { flag: "wx", mode: 0o600 });
  fs.linkSync(victimPath, compressedSource.replace(/\.gz$/, ".tmp"));
  const result = dbStore.restoreBackup(compressedSource);
  assert.equal(result.success, true);
  assertVictimUnchanged();
});
