"use strict";

const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { childProcessEnv } = require("../src/security/child-process");
const { resolveCommandOnPath } = require("../src/security/command-lookup");
const { validateArchiveEntryNames, validateArchiveEntryTypes, validateZipEntryTypes, validateArchiveSourceType, archiveProcessEnv } = require("../src/tools/families/process-mgmt");

for (const entry of [
  "../outside.txt",
  "nested/../../outside.txt",
  "/etc/passwd",
  "C:/Windows/System32/config/SAM",
  "nested\\..\\outside.txt"
]) {
  assert.throws(() => validateArchiveEntryNames([entry]), /archive contains/, `archive traversal accepted: ${entry}`);
}

assert.strictEqual(validateArchiveEntryNames(["./safe.txt", "nested/file.txt", "nested/"]), true);

assert.strictEqual(validateArchiveEntryTypes("-rw-r--r-- 0 0 1 Jan 01 00:00 file.txt\ndrwxr-xr-x 0 0 0 Jan 01 00:00 folder/\n"), true);
for (const typeListing of [
  "lrwxrwxrwx 0 0 0 Jan 01 00:00 link -> ../outside\n",
  "hrw-r--r-- 0 0 0 Jan 01 00:00 alias link to file\n",
  "prw-r--r-- 0 0 0 Jan 01 00:00 pipe\n"
]) {
  assert.throws(() => validateArchiveEntryTypes(typeListing), /link or special file/);
}
assert.throws(() => validateArchiveEntryTypes("unrecognized tar output\n"), /listing is invalid/);
assert.throws(() => validateArchiveEntryTypes(""), /could not be verified/);

const zipEntry = mode => `Central directory entry #1:\n---------------------------\n\n  entry\n  file system or operating system of origin: Unix\n  Unix file attributes (100644 octal):            ${mode}\n`;
assert.strictEqual(validateZipEntryTypes(zipEntry("-rw-r--r--")), true);
assert.strictEqual(validateZipEntryTypes("Central directory entry #1:\n  file system or operating system of origin: MS-DOS, OS/2 or NT FAT\n  MS-DOS file attributes (00 hex):            none\n"), true);
for (const mode of ["lrwxrwxrwx", "hrw-r--r--", "prw-r--r--", "brw-r--r--", "crw-r--r--"]) {
  assert.throws(() => validateZipEntryTypes(zipEntry(mode)), /link or special file/);
}
assert.throws(() => validateZipEntryTypes("unrecognized zipinfo output\n"), /metadata could not be verified/);
assert.throws(() => validateZipEntryTypes("Central directory entry #1:\n  file system or operating system of origin: Unix\n"), /attributes could not be verified/);

function makeZipFixture(name, unixMode) {
  const filename = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(filename.length, 26);
  const localRecord = Buffer.concat([local, filename]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4); // Unix creator, version 2.0.
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(unixMode * 0x10000, 38);
  const centralRecord = Buffer.concat([central, filename]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralRecord.length, 12);
  end.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, end]);
}

const unzip = resolveCommandOnPath("unzip");
if (unzip) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-zip-type-test-"));
  try {
    const inspect = (name, mode) => {
      const archive = path.join(temp, `${name.replace(/[^a-z]/gi, "_")}.zip`);
      fs.writeFileSync(archive, makeZipFixture(name, mode), { flag: "wx", mode: 0o600 });
      return execFileSync(unzip, ["-Z", "-v", archive], {
        timeout: 10000,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        env: childProcessEnv({ UNZIP: null, UNZIPOPT: null, ZIPINFO: null, ZIPINFOOPT: null, LC_ALL: "C" }),
      });
    };
    assert.doesNotThrow(() => validateZipEntryTypes(inspect("regular.txt", 0o100644)));
    assert.doesNotThrow(() => validateZipEntryTypes(inspect("folder/", 0o040755)));
    assert.throws(() => validateZipEntryTypes(inspect("link", 0o120777)), /link or special file/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} else {
  console.log("Info-ZIP integration check skipped: unzip is not installed");
}

const regularFile = { isFile: () => true, isDirectory: () => false };
const directory = { isFile: () => false, isDirectory: () => true };
const specialFile = { isFile: () => false, isDirectory: () => false };
assert.strictEqual(validateArchiveSourceType(regularFile, "list"), null);
assert.strictEqual(validateArchiveSourceType(regularFile, "extract"), null);
assert.strictEqual(validateArchiveSourceType(directory, "create"), null);
assert.strictEqual(validateArchiveSourceType(regularFile, "create"), null);
assert.match(validateArchiveSourceType(directory, "list"), /regular file/);
assert.match(validateArchiveSourceType(specialFile, "create"), /regular file or directory/);
assert.match(validateArchiveSourceType(specialFile, "extract"), /regular file/);
assert.match(validateArchiveSourceType(null, "extract"), /could not be verified/);

const archiveOptionNames = ["TAR_OPTIONS", "GZIP", "ZIPOPT", "UNZIP", "UNZIPOPT", "ZIPINFO", "ZIPINFOOPT"];
const originalArchiveOptions = new Map(archiveOptionNames.map(name => [name, process.env[name]]));
try {
  for (const name of archiveOptionNames) process.env[name] = "--attacker-controlled-option";
  const childEnv = archiveProcessEnv();
  for (const name of archiveOptionNames) assert.equal(childEnv[name], undefined, `${name} must not affect archive commands`);
} finally {
  for (const [name, value] of originalArchiveOptions) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

const source = fs.readFileSync(path.join(__dirname, "..", "src", "tools", "families", "process-mgmt.js"), "utf8");
assert.match(source, /validateArchiveEntryNames\(listing\.split\("\\n"\)\)/, "archive extraction must validate the complete listing first");
assert.match(source, /validateArchiveEntryTypes\(typeListing\)/, "tar extraction must reject link and special-file entries before extraction");
assert.match(source, /\["-tvzf", sourceAbsolute\]/, "tar member types must be inspected before extraction");
assert.match(source, /validateZipEntryTypes\(typeListing\)/, "zip extraction must reject link and special-file entries before extraction");
assert.match(source, /\["-Z", "-v", sourceAbsolute\]/, "zip central-directory Unix attributes must be inspected before extraction");
assert.equal((source.match(/env: archiveProcessEnv\(\)/g) || []).length, 5, "all archive list, preflight, creation, and extraction processes must use sanitized environments");
assert.match(source, /sourceStat = fs\.statSync\(sourcePath\)/, "archive source type must be verified before invoking archive commands");
assert.match(source, /validateArchiveSourceType\(sourceStat, action\)/, "archive operations must reject special source files");
assert.match(source, /const extractTarget = output \? path\.resolve\(output\) : process\.cwd\(\)/, "archive extraction target must be explicit and canonicalized");
assert.match(source, /"-C", extractTarget/, "tar extraction must use the governed extraction target");
assert.match(source, /"-d", extractTarget/, "zip extraction must use the governed extraction target");
console.log("Phase 6 filesystem and archive security tests passed");
