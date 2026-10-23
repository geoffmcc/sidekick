"use strict";

// Browser evidence custody.
//
// Screenshots, downloads and snapshots produced by browser sessions are
// artifacts: bytes are written under the subsystem's own directory in the data
// dir, hashed, and registered with the platform kernel — the single custody
// authority — following the compute custody rules (src/compute/artifact-custody.js):
// register only verified bytes, deterministic ids so registration is
// idempotent, and custody failure is surfaced on the result rather than either
// swallowed or allowed to destroy the work that produced the bytes.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { browserConfig, dataDir } = require("./config");
const { redactSensitive } = require("../redact");

const MAX_BROWSER_ARTIFACT_BYTES = 500 * 1024 * 1024;
const ARTIFACT_COPY_BUFFER_BYTES = 64 * 1024;

let platformKernel = null;
try { platformKernel = require("../platform/kernel"); } catch { platformKernel = null; }

function newArtifactId() {
  return `bra_${crypto.randomBytes(10).toString("hex")}`;
}

function sha256File(filePath, maxBytes = MAX_BROWSER_ARTIFACT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Browser artifact read limit is invalid");
  const hash = crypto.createHash("sha256");
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const nonBlocking = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Browser artifact must be a regular file");
    if (stat.size > maxBytes) throw new Error(`Browser artifact exceeds the ${maxBytes}-byte limit`);
    const buffer = Buffer.allocUnsafe(ARTIFACT_COPY_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      position += count;
      if (position > maxBytes) throw new Error(`Browser artifact exceeds the ${maxBytes}-byte limit`);
      hash.update(buffer.subarray(0, count));
    }
    return { sha256: hash.digest("hex"), byteSize: position };
  } finally {
    fs.closeSync(fd);
  }
}

function ensureArtifactDirectory(config, sessionId) {
  const dataRoot = fs.realpathSync(dataDir());
  fs.mkdirSync(config.artifactsDir, { recursive: true, mode: 0o750 });
  const artifactRoot = fs.realpathSync(config.artifactsDir);
  if (artifactRoot !== dataRoot && !artifactRoot.startsWith(dataRoot + path.sep)) {
    throw new Error("Browser artifact directory resolves outside the data directory");
  }
  const sessionDir = path.join(artifactRoot, safeName(sessionId, "session"));
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o750 });
  const stat = fs.lstatSync(sessionDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Browser session artifact path is not a directory");
  const resolved = fs.realpathSync(sessionDir);
  if (resolved !== artifactRoot && !resolved.startsWith(artifactRoot + path.sep)) {
    throw new Error("Browser session artifact directory escaped its storage root");
  }
  return resolved;
}

function copyArtifactFile(sourcePath, destination, maxBytes = MAX_BROWSER_ARTIFACT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Browser artifact copy limit is invalid");
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const nonBlocking = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  const sourceFd = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
  let destinationFd = null;
  let destinationCreated = false;
  try {
    const stat = fs.fstatSync(sourceFd);
    if (!stat.isFile()) throw new Error("Browser artifact source must be a regular file");
    if (stat.size > maxBytes) throw new Error(`Browser artifact exceeds the ${maxBytes}-byte limit`);
    destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o640);
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(ARTIFACT_COPY_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const count = fs.readSync(sourceFd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      position += count;
      if (position > maxBytes) throw new Error(`Browser artifact exceeds the ${maxBytes}-byte limit`);
      let written = 0;
      while (written < count) written += fs.writeSync(destinationFd, buffer, written, count - written);
    }
  } catch (error) {
    if (destinationCreated) { try { fs.unlinkSync(destination); } catch {} }
    throw error;
  } finally {
    if (destinationFd !== null) fs.closeSync(destinationFd);
    fs.closeSync(sourceFd);
  }
}

function safeName(name, fallback) {
  const cleaned = String(name || fallback).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned || fallback;
}

/**
 * Store bytes (or an already-written file) as a browser artifact and register
 * custody. Returns a record the caller can hand back to the agent:
 * { artifact_id, storage_ref, sha256, byte_size, custody } — never a raw
 * temp path, and never a thrown custody error.
 */
function storeArtifact({
  sessionId,
  kind, // screenshot | download | snapshot
  name,
  bytes = null,
  sourcePath = null,
  contentType = null,
  sensitivity = "normal",
  executionContext = null,
  metadata = {},
}) {
  const config = browserConfig();
  const artifactId = newArtifactId();
  const fileName = `${artifactId}-${safeName(name, kind)}`;
  const sessionDir = ensureArtifactDirectory(config, sessionId);
  const destination = path.join(sessionDir, fileName);

  if (bytes !== null) {
    const byteLength = typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes?.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength > MAX_BROWSER_ARTIFACT_BYTES) {
      throw new Error(`Browser artifact exceeds the ${MAX_BROWSER_ARTIFACT_BYTES}-byte limit`);
    }
    fs.writeFileSync(destination, bytes, { mode: 0o640, flag: "wx" });
  } else if (sourcePath) {
    copyArtifactFile(sourcePath, destination);
  } else {
    throw new Error("storeArtifact requires bytes or sourcePath");
  }

  let digest;
  try {
    digest = sha256File(destination);
  } catch (error) {
    try { fs.unlinkSync(destination); } catch {}
    throw error;
  }
  const byteSize = digest.byteSize;
  const sha256 = digest.sha256;
  const storageRef = path.relative(dataDir(), destination).split(path.sep).join("/");

  const record = {
    artifact_id: artifactId,
    kind,
    name: safeName(name, kind),
    storage_ref: storageRef,
    sha256,
    byte_size: byteSize,
    content_type: contentType,
    sensitivity,
  };

  if (!platformKernel || typeof platformKernel.registerArtifact !== "function") {
    record.custody = { status: "failed", error: "platform kernel unavailable" };
    return record;
  }
  try {
    platformKernel.registerArtifact({
      artifact_id: artifactId,
      type: `browser_${kind}`,
      name: record.name,
      execution_id: executionContext?.executionId || null,
      project_id: executionContext?.project || null,
      task_id: executionContext?.taskId || null,
      session_id: executionContext?.sessionId || null,
      producer: "browser-subsystem",
      storage_ref: storageRef,
      content_type: contentType,
      byte_size: byteSize,
      content_hash: `sha256:${sha256}`,
      sensitivity,
      redaction_state: "none",
      verification: { hash_verified: true, verified_by: "browser-subsystem" },
      metadata: { browser_session_id: sessionId, ...metadata },
      source: "browser",
    });
    record.custody = { status: "registered" };
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error && error.message))) {
      record.custody = { status: "already" };
    } else {
      record.custody = {
        status: "failed",
        error: redactSensitive(String(error && error.message || error)).slice(0, 300),
      };
    }
  }
  return record;
}

/**
 * Resolve a platform artifact to its on-disk location for governed upload.
 * Only artifacts whose storage_ref resolves inside the data dir are usable.
 * Returns { path, artifact } or { error }.
 */
function resolveArtifactFile(artifactId, { project = undefined } = {}) {
  if (!platformKernel || typeof platformKernel.getArtifact !== "function") {
    return { error: "platform kernel unavailable" };
  }
  let artifact = null;
  try { artifact = platformKernel.getArtifact(String(artifactId)); } catch (error) {
    return { error: String(error.message || error).slice(0, 300) };
  }
  if (!artifact) return { error: `artifact "${artifactId}" not found` };
  // A browser session is project-scoped. Do not let a caller use an artifact
  // from another project (or a global artifact) as an upload source merely by
  // guessing its opaque id.
  if (project !== undefined && String(artifact.project_id || "") !== String(project || "")) {
    return { error: "artifact belongs to a different project" };
  }
  const root = path.resolve(dataDir());
  const lexical = path.resolve(root, String(artifact.storage_ref || ""));
  // Guard the lexical path against `..`/absolute storage_ref, then realpath and
  // re-check so a symlink under the data dir cannot point the upload at a file
  // outside it.
  if (lexical !== root && !lexical.startsWith(root + path.sep)) {
    return { error: "artifact storage_ref resolves outside the data directory" };
  }
  if (!fs.existsSync(lexical) || !fs.statSync(lexical).isFile()) {
    return { error: `artifact "${artifactId}" has no readable file at its storage_ref` };
  }
  let resolved;
  try { resolved = fs.realpathSync(lexical); } catch {
    return { error: `artifact "${artifactId}" file could not be resolved` };
  }
  const realRoot = fs.realpathSync(root);
  if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
    return { error: "artifact file (after resolving symlinks) is outside the data directory" };
  }
  return { path: resolved, artifact };
}

module.exports = { storeArtifact, resolveArtifactFile, newArtifactId, sha256File, copyArtifactFile, MAX_BROWSER_ARTIFACT_BYTES };
