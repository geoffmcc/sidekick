"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_ARCHIVE_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const COPY_CHUNK_BYTES = 64 * 1024;

function archiveSnapshotError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sameFileVersion(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function archiveSuffix(sourcePath) {
  const normalized = String(sourcePath).toLowerCase();
  if (normalized.endsWith(".tar.gz")) return ".tar.gz";
  if (normalized.endsWith(".tgz")) return ".tgz";
  if (normalized.endsWith(".zip")) return ".zip";
  return ".archive";
}

async function createArchiveSnapshot(sourcePath, sourceName = sourcePath) {
  let source;
  let destination;
  let directory;
  try {
    const pathStat = await fs.promises.lstat(sourcePath, { bigint: true });
    if (!pathStat.isFile()) throw archiveSnapshotError("archive source must be a regular, non-symlink file", "ARCHIVE_SOURCE_NOT_REGULAR");
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
    source = await fs.promises.open(sourcePath, flags);
    const before = await source.stat({ bigint: true });
    if (!before.isFile()) throw archiveSnapshotError("archive source must be a regular file", "ARCHIVE_SOURCE_NOT_REGULAR");
    if (before.dev !== pathStat.dev || (before.ino !== 0n && pathStat.ino !== 0n && before.ino !== pathStat.ino)) {
      throw archiveSnapshotError("archive source path changed while being opened", "ARCHIVE_SOURCE_CHANGED");
    }
    if (before.size > BigInt(MAX_ARCHIVE_SOURCE_BYTES)) {
      throw archiveSnapshotError(`archive source exceeds the ${MAX_ARCHIVE_SOURCE_BYTES}-byte staging limit`, "ARCHIVE_SOURCE_TOO_LARGE");
    }

    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sidekick-archive-"));
    if (process.platform !== "win32") await fs.promises.chmod(directory, 0o700);
    const snapshotPath = path.join(directory, "source" + archiveSuffix(sourceName));
    destination = await fs.promises.open(snapshotPath, "wx", 0o600);

    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    const sourceSize = Number(before.size);
    let offset = 0;
    while (offset < sourceSize) {
      const wanted = Math.min(buffer.length, sourceSize - offset);
      const { bytesRead } = await source.read(buffer, 0, wanted, offset);
      if (bytesRead === 0) throw archiveSnapshotError("archive source changed while being staged", "ARCHIVE_SOURCE_CHANGED");
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, null);
        if (result.bytesWritten === 0) throw archiveSnapshotError("unable to complete archive staging write", "ARCHIVE_STAGE_WRITE_FAILED");
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }

    const after = await source.stat({ bigint: true });
    if (!sameFileVersion(before, after)) throw archiveSnapshotError("archive source changed while being staged", "ARCHIVE_SOURCE_CHANGED");
    await destination.sync();
    await destination.close();
    destination = null;
    await source.close();
    source = null;

    return {
      path: snapshotPath,
      async cleanup() {
        await fs.promises.rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (destination) await destination.close().catch(() => {});
    if (source) await source.close().catch(() => {});
    if (directory) await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { createArchiveSnapshot, MAX_ARCHIVE_SOURCE_BYTES };
