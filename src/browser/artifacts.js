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

let platformKernel = null;
try { platformKernel = require("../platform/kernel"); } catch { platformKernel = null; }

function newArtifactId() {
  return `bra_${crypto.randomBytes(10).toString("hex")}`;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
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
  const sessionDir = path.join(config.artifactsDir, safeName(sessionId, "session"));
  fs.mkdirSync(sessionDir, { recursive: true });
  const destination = path.join(sessionDir, fileName);

  if (bytes !== null) {
    fs.writeFileSync(destination, bytes, { mode: 0o640 });
  } else if (sourcePath) {
    fs.copyFileSync(sourcePath, destination);
    fs.chmodSync(destination, 0o640);
  } else {
    throw new Error("storeArtifact requires bytes or sourcePath");
  }

  const byteSize = fs.statSync(destination).size;
  const sha256 = sha256File(destination);
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

module.exports = { storeArtifact, resolveArtifactFile, newArtifactId };
