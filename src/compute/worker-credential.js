// Secure worker credential persistence (Phase 4).
//
// Stores the worker's bearer credential on disk with an atomic write (temp file
// + rename so a crash never leaves a half-written or empty credential), tight
// permissions (0700 dir / 0600 file on POSIX; NTFS ACLs restricting to the
// current user on Windows), and validation on load.
//
// This file holds a SECRET and is deliberately separate from the (non-secret)
// settings config file handled by worker-config.js.
//
// Dependency-free so it can ship inside the minimal standalone worker package.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// Absolute path: resolving "icacls" by name would let a non-admin who controls
// a PATH entry run code inside the elevated `enroll` the installer performs.
const ICACLS = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");

const WORKER_ID_RE = /^wk_[A-Za-z0-9_-]+$/;
const CREDENTIAL_RE = /^wksec_[A-Za-z0-9_-]+$/;

function defaultCredentialPath() {
  return process.env.SIDEKICK_WORKER_CONFIG || path.join(os.homedir(), ".sidekick", "worker-credential.json");
}

// Restrict the credential file: disable ACL inheritance, drop inherited ACEs,
// grant the running account full control, and grant LocalSystem read.
//
// The SYSTEM grant is required, not optional: the Windows service runs as
// LocalSystem while `enroll` is run elevated as a normal user, so a
// user-only ACL leaves the service unable to read its own credential ("No
// enrollment token" restart loop). It is not a privilege widening either —
// LocalSystem can already take ownership of any file on the machine.
//
// Best-effort — a failure is reported to the caller but never throws.
function applyWindowsAcl(filePath) {
  try {
    execFileSync(ICACLS, [filePath, "/inheritance:r"], { stdio: "ignore" });
    const user = process.env.USERNAME
      ? `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME}`
      : null;
    if (user) execFileSync(ICACLS, [filePath, "/grant:r", `${user}:F`], { stdio: "ignore" });
    execFileSync(ICACLS, [filePath, "/grant:r", "*S-1-5-18:(R)"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Atomically persist the credential record. Returns the path written.
function save(record, pathOverride) {
  if (!record || !WORKER_ID_RE.test(record.workerId || "") || !CREDENTIAL_RE.test(record.credential || "")) {
    throw new Error("Refusing to save malformed worker credential record");
  }
  const credPath = pathOverride || defaultCredentialPath();
  const dir = path.dirname(credPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") { try { fs.chmodSync(dir, 0o700); } catch {} }
  const payload = {
    workerId: record.workerId,
    nodeId: record.nodeId || null,
    credential: record.credential,
    enrolledAt: record.enrolledAt || new Date().toISOString(),
    version: 1,
  };
  const tempPath = `${credPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") { try { fs.chmodSync(tempPath, 0o600); } catch {} }
  fs.renameSync(tempPath, credPath);
  if (process.platform === "win32") applyWindowsAcl(credPath);
  return credPath;
}

// Load and validate the credential record. Tightens loose POSIX permissions in
// place. Returns the record, or null if absent/unreadable/malformed.
function load(pathOverride) {
  const credPath = pathOverride || defaultCredentialPath();
  try {
    const stat = fs.statSync(credPath);
    if (!stat.isFile()) return null;
    if (process.platform !== "win32" && (stat.mode & 0o077)) {
      try { fs.chmodSync(credPath, 0o600); } catch {}
    }
    const parsed = JSON.parse(fs.readFileSync(credPath, "utf8"));
    if (WORKER_ID_RE.test(parsed.workerId || "") && CREDENTIAL_RE.test(parsed.credential || "")) {
      return {
        workerId: parsed.workerId,
        nodeId: parsed.nodeId || null,
        credential: parsed.credential,
        enrolledAt: parsed.enrolledAt || null,
        version: parsed.version || 1,
      };
    }
  } catch {}
  return null;
}

// Delete the credential file so a stale/revoked record cannot be re-loaded.
// Returns true if a file was removed. Absent file is not an error.
function remove(pathOverride) {
  const credPath = pathOverride || defaultCredentialPath();
  try {
    fs.unlinkSync(credPath);
    return true;
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    throw e;
  }
}

// Move a rejected credential aside so it can be restored if the re-enrollment
// that replaces it fails. Returns the parked path, or null if there was nothing
// to park (or it could only be deleted). Callers must eventually restore() or
// discard() the returned path.
function park(pathOverride) {
  const credPath = pathOverride || defaultCredentialPath();
  const parkedPath = `${credPath}.rejected`;
  try {
    fs.renameSync(credPath, parkedPath);
    return parkedPath;
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    // Could not park it; the caller still needs it gone before re-enrolling.
    try { fs.unlinkSync(credPath); } catch {}
    return null;
  }
}

// Put a parked credential back. Best-effort: used on a failure path where
// throwing would mask the original error.
function restore(parkedPath, pathOverride) {
  if (!parkedPath) return false;
  try {
    fs.renameSync(parkedPath, pathOverride || defaultCredentialPath());
    return true;
  } catch { return false; }
}

// Delete a parked credential once it is definitively superseded.
function discard(parkedPath) {
  if (!parkedPath) return false;
  try { fs.unlinkSync(parkedPath); return true; } catch { return false; }
}

module.exports = { defaultCredentialPath, applyWindowsAcl, save, load, remove, park, restore, discard, WORKER_ID_RE, CREDENTIAL_RE };
