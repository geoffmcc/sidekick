const fs = require("fs");
const path = require("path");

function createBlackboxStorage({ rootDir, safeId, redact, hashText, nowIso, defaults }) {
  function within(root, candidate) { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }
  function realRoot() { return fs.realpathSync(path.resolve(rootDir)); }
  function assertNoSymlinkedPath(candidate, root) {
    const lexical = path.resolve(candidate);
    if (!within(path.resolve(rootDir), lexical)) throw new Error("Artifact path escaped blackbox directory");
    let current = path.resolve(rootDir);
    for (const part of path.relative(current, lexical).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) {
        if (error.code === "ENOENT") break;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error("Artifact path contains a symlink");
    }
    const resolved = fs.existsSync(lexical) ? fs.realpathSync(lexical) : lexical;
    if (!within(root, resolved)) throw new Error("Artifact path escaped blackbox directory");
    return resolved;
  }
  function artifactPath(incidentId, captureId, sourceId, stream) { safeId(incidentId, "incident id"); safeId(captureId, "capture id"); safeId(sourceId, "source id"); safeId(stream, "artifact stream"); return path.join(rootDir, incidentId, captureId, `${sourceId}.${stream}.txt`); }
  function writeArtifact(incidentId, captureId, sourceId, stream, content) {
    const safeContent = redact(content);
    const finalPath = artifactPath(incidentId, captureId, sourceId, stream);
    const root = realRoot();
    const dir = path.dirname(finalPath);
    assertNoSymlinkedPath(dir, root);
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    const realDir = fs.realpathSync(dir);
    if (!within(root, realDir)) throw new Error("Artifact directory escaped blackbox directory");
    assertNoSymlinkedPath(finalPath, root);
    const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, safeContent, { encoding: "utf8", mode: 0o640, flag: "wx" });
    fs.renameSync(tempPath, finalPath);
    return { path: finalPath, content, safe_content: safeContent, hash: hashText(safeContent), bytes: Buffer.byteLength(safeContent, "utf8"), redactions: safeContent === String(content || "") ? 0 : 1 };
  }
  function readArtifactByPath(filePath, offset = 0, limit = 65536) {
    if (!filePath) return "";
    const root = realRoot();
    const resolved = assertNoSymlinkedPath(filePath, root);
    return fs.readFileSync(resolved, "utf8").slice(offset, offset + limit);
  }
  function removeIncidentArtifacts(incidentId) {
    safeId(incidentId, "incident id");
    const root = realRoot();
    const incidentPath = path.join(rootDir, incidentId);
    if (!fs.existsSync(incidentPath)) return false;
    const resolved = assertNoSymlinkedPath(incidentPath, root);
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory()) throw new Error("Black Box incident artifact is not a directory");
    fs.rmSync(resolved, { recursive: true, force: true });
    return true;
  }
  function getRetentionConfig() { return { defaultClass: process.env.SIDEKICK_BLACKBOX_DEFAULT_RETENTION_CLASS || "standard", classTtls: { transient: Number(process.env.SIDEKICK_BLACKBOX_TTL_TRANSIENT_DAYS || 3), standard: Number(process.env.SIDEKICK_BLACKBOX_TTL_STANDARD_DAYS || 30), important: Number(process.env.SIDEKICK_BLACKBOX_TTL_IMPORTANT_DAYS || 180), archive: Number(process.env.SIDEKICK_BLACKBOX_TTL_ARCHIVE_DAYS || 3650), pinned: null }, dailyCaptureRate: defaults.dailyLimit, maxStoredBytes: defaults.maxBytes, maxIncidentCount: defaults.maxIncidents, purgeGraceDays: Number(process.env.SIDEKICK_BLACKBOX_PURGE_GRACE_DAYS || 1), autoCompress: process.env.SIDEKICK_BLACKBOX_AUTO_COMPRESS === "1" }; }
  function expiresFor(retentionClass, createdAt, pinned, lifecycleState) { if (pinned || lifecycleState === "open" || lifecycleState === "investigating") return null; const cfg = getRetentionConfig(), ttl = cfg.classTtls[retentionClass] === undefined ? cfg.classTtls[cfg.defaultClass] : cfg.classTtls[retentionClass]; if (!ttl) return null; const date = new Date(createdAt || nowIso()); date.setUTCDate(date.getUTCDate() + ttl); return date.toISOString(); }
  return { artifactPath, writeArtifact, readArtifactByPath, removeIncidentArtifacts, getRetentionConfig, expiresFor };
}
module.exports = { createBlackboxStorage };
