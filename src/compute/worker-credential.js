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
const WHOAMI = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function windowsSystemEnv(systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows") {
  const root = path.win32.resolve(systemRoot);
  return { SystemRoot: root, WINDIR: root, PATH: path.win32.join(root, "System32") };
}

const WORKER_ID_RE = /^wk_[A-Za-z0-9_-]+$/;
const CREDENTIAL_RE = /^wksec_[A-Za-z0-9_-]+$/;
const MAX_CREDENTIAL_BYTES = 16 * 1024;

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
// A failure is reported to the caller. save() fails closed and removes the
// credential rather than reporting success with an unprotected secret.
function applyWindowsAcl(filePath) {
  try {
    // Environment username values are caller-controlled and may not identify
    // the effective service token (for example, elevated installers or task
    // sandboxes). Resolve the SID from the current process token instead.
    const identity = execFileSync(WHOAMI, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, env: windowsSystemEnv() }).trim();
    const sid = identity.match(/,\s*"(S-1-[0-9-]+)"\s*$/)?.[1];
    if (!sid) return false;
    // Clear any pre-existing explicit grants before installing the narrow ACL.
    // /reset first restores inherited rules; /inheritance:r then removes those
    // rules so a broad parent ACL cannot leak the credential.
    execFileSync(ICACLS, [filePath, "/reset"], { stdio: "ignore", windowsHide: true, env: windowsSystemEnv() });
    execFileSync(ICACLS, [filePath, "/inheritance:r"], { stdio: "ignore", windowsHide: true, env: windowsSystemEnv() });
    execFileSync(ICACLS, [filePath, "/grant:r", `*${sid}:F`], { stdio: "ignore", windowsHide: true, env: windowsSystemEnv() });
    // If the current token is LocalSystem, it already has full control; a
    // second /grant:r for the same SID would replace F with read-only access.
    if (sid !== "S-1-5-18") execFileSync(ICACLS, [filePath, "/grant:r", "*S-1-5-18:(R)"], { stdio: "ignore", windowsHide: true, env: windowsSystemEnv() });
    execFileSync(ICACLS, [filePath, "/grant:r", "*S-1-5-32-544:(R)"], { stdio: "ignore", windowsHide: true, env: windowsSystemEnv() });
    return verifyWindowsAcl(filePath);
  } catch {
    return false;
  }
}

function applyWindowsDirectoryAcl(directoryPath) {
  try {
    const stat = fs.lstatSync(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const identity = execFileSync(WHOAMI, ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8", windowsHide: true, env: windowsSystemEnv(),
    }).trim();
    const sid = identity.match(/,\s*"(S-1-[0-9-]+)"\s*$/)?.[1];
    if (!sid) return false;
    const inheritance = "(OI)(CI)F";
    execFileSync(ICACLS, [directoryPath, "/reset"], { stdio: "ignore", windowsHide: true, env: windowsSystemEnv() });
    execFileSync(ICACLS, [directoryPath, "/inheritance:r"], { stdio: "ignore", windowsHide: true, env: windowsSystemEnv() });
    execFileSync(ICACLS, [directoryPath, "/grant:r", `*${sid}:${inheritance}`], { stdio: "ignore", windowsHide: true, env: windowsSystemEnv() });
    if (sid !== "S-1-5-18") execFileSync(ICACLS, [directoryPath, "/grant:r", `*S-1-5-18:${inheritance}`], { stdio: "ignore", windowsHide: true, env: windowsSystemEnv() });
    execFileSync(ICACLS, [directoryPath, "/grant:r", `*S-1-5-32-544:${inheritance}`], { stdio: "ignore", windowsHide: true, env: windowsSystemEnv() });
    return true;
  } catch {
    return false;
  }
}

// Validate the credential and its dedicated containing directory before
// reading it. The installer separately validates and protects the complete
// ancestor chain. ACL enforcement is performed by Windows, outside this Node
// process; the current token, SYSTEM, Administrators and TrustedInstaller are
// the only principals accepted for credential access.
function verifyWindowsAcl(filePath) {
  try {
    const absolutePath = path.win32.resolve(filePath);
    const parentPath = path.win32.dirname(absolutePath);
    const quotedFile = `'${absolutePath.replace(/'/g, "''")}'`;
    const quotedParent = `'${parentPath.replace(/'/g, "''")}'`;
    const script = `
$ErrorActionPreference = 'Stop'
$filePath = ${quotedFile}
$parentPath = ${quotedParent}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($currentSid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$fileReadWrite = [int]([System.Security.AccessControl.FileSystemRights]::ReadData -bor [System.Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor [System.Security.AccessControl.FileSystemRights]::ReadAttributes -bor [System.Security.AccessControl.FileSystemRights]::ReadPermissions -bor [System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership)
$directoryWrite = [int]([System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership)
$paths = @(@{ Path = $filePath; Kind = 'file' }, @{ Path = $parentPath; Kind = 'directory' })
foreach ($entry in $paths) {
  $item = Get-Item -LiteralPath $entry.Path -Force
  if ($item.Attributes.ToString() -match '(^|,\\s*)ReparsePoint(,|$)') { exit 21 }
  $acl = Get-Acl -LiteralPath $entry.Path
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($trusted -notcontains $ownerSid) { exit 22 }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if ($trusted -contains $rule.IdentityReference.Value) { continue }
    $rights = [int]$rule.FileSystemRights
    if ($entry.Kind -eq 'file' -and ($rights -band $fileReadWrite) -ne 0) { exit 23 }
    if ($entry.Kind -eq 'directory' -and ($rights -band $directoryWrite) -ne 0) { exit 24 }
  }
}
Write-Output 'OK'
`;
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
    const output = execFileSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], {
      encoding: "utf8", windowsHide: true, env: windowsSystemEnv(), stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
    }).trim();
    return output === "OK";
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
  let moved = false;
  try {
    // Create exclusively so a pre-created temp path cannot redirect this
    // write. On Windows, secure the empty file before placing secret bytes in
    // it; the ACL moves atomically with the file into its final name.
    if (process.platform === "win32" && !applyWindowsDirectoryAcl(dir)) {
      throw new Error("Windows credential directory ACL could not be secured");
    }
    fs.writeFileSync(tempPath, "", { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") {
      if (!applyWindowsAcl(tempPath)) throw new Error("Windows ACL verification failed");
    } else {
      try { fs.chmodSync(tempPath, 0o600); } catch {}
    }
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { flag: "w", mode: 0o600 });
    fs.renameSync(tempPath, credPath);
    moved = true;
    if (process.platform === "win32" && !verifyWindowsAcl(credPath)) throw new Error("Windows ACL verification failed after rename");
  } catch {
    let cleanupFailed = false;
    try { fs.unlinkSync(moved ? credPath : tempPath); } catch { cleanupFailed = true; }
    if (process.platform === "win32") {
      throw new Error(`Unable to secure the worker credential file; credential persistence was refused${cleanupFailed ? " and cleanup failed" : ""}`);
    }
    throw new Error("Unable to persist the worker credential file");
  }
  return credPath;
}

// Load and validate the credential record. Tightens loose POSIX permissions in
// place. Returns the record, or null if absent/unreadable/malformed.
function load(pathOverride) {
  const credPath = pathOverride || defaultCredentialPath();
  let fd;
  try {
    const dirPath = path.dirname(credPath);
    let dirStat = fs.lstatSync(dirPath);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    if (process.platform !== "win32" && (dirStat.mode & 0o077)) {
      fs.chmodSync(dirPath, 0o700);
      dirStat = fs.lstatSync(dirPath);
      if (!dirStat.isDirectory() || (dirStat.mode & 0o077)) return null;
    }

    let stat = fs.lstatSync(credPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (process.platform === "win32" && !verifyWindowsAcl(credPath)) return null;
    if (process.platform !== "win32" && (stat.mode & 0o077)) {
      fs.chmodSync(credPath, 0o600);
      stat = fs.lstatSync(credPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) return null;
    }
    const flags = fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0);
    fd = fs.openSync(credPath, flags);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || stat.dev !== opened.dev || stat.ino !== opened.ino || opened.size > MAX_CREDENTIAL_BYTES) return null;
    const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_CREDENTIAL_BYTES) return null;
    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
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
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
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

module.exports = { defaultCredentialPath, applyWindowsAcl, applyWindowsDirectoryAcl, verifyWindowsAcl, windowsSystemEnv, save, load, remove, park, restore, discard, WORKER_ID_RE, CREDENTIAL_RE };
