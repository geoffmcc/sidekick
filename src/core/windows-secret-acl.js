"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ACL_CACHE_TTL_MS = 30_000;
const verifiedAclCache = new Map();

const TRUSTED_SIDS = Object.freeze([
  "S-1-5-18", // LocalSystem
  "S-1-5-32-544", // Builtin Administrators
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", // TrustedInstaller
]);

function windowsSystemEnv(systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows") {
  const root = path.win32.resolve(systemRoot);
  return { SystemRoot: root, WINDIR: root, PATH: path.win32.join(root, "System32") };
}

function getPowerShellPath(systemRoot) {
  return path.win32.join(
    systemRoot || process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
}

function assertWindowsSecretAcl({ directories, secretDirectory, secretFile, name, force = false }) {
  const entries = directories.map(target => ({
    target,
    kind: target === secretDirectory ? "secret-directory" : "ancestor",
  }));
  if (secretFile) entries.push({ target: secretFile, kind: "file" });

  const now = Date.now();
  const pending = [];
  for (const entry of entries) {
    const stat = fs.lstatSync(entry.target);
    if (stat.isSymbolicLink()) throw new Error(`${name} secret path is a reparse point`);
    const normalized = path.win32.normalize(entry.target).toLowerCase();
    const key = `${entry.kind}\0${normalized}`;
    const identity = `${stat.dev}:${stat.ino}`;
    const cached = verifiedAclCache.get(key);
    if (!force && cached && cached.identity === identity && cached.expiresAt > now) continue;
    pending.push({ ...entry, key, identity });
  }
  if (pending.length === 0) return;

  // Paths are embedded only as single-quoted PowerShell literals; doubling
  // apostrophes keeps path data from becoming executable syntax.
  const encodedPaths = pending.map(entry => entry.target)
    .map(target => `'${target.replace(/'/g, "''")}'`).join(", ");
  const encodedSecretDirectory = secretDirectory ? secretDirectory.replace(/'/g, "''") : "";
  const encodedSecretFile = secretFile ? secretFile.replace(/'/g, "''") : "";
  const script = `
$ErrorActionPreference = 'Stop'
$paths = @(${encodedPaths})
$secretDirectory = '${encodedSecretDirectory}'
$secretFile = '${encodedSecretFile}'
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($currentSid, ${TRUSTED_SIDS.map(sid => `'${sid}'`).join(", ")})
$readMask = [int]([System.Security.AccessControl.FileSystemRights]::ReadData -bor [System.Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor [System.Security.AccessControl.FileSystemRights]::ReadAttributes -bor [System.Security.AccessControl.FileSystemRights]::ReadPermissions -bor [System.Security.AccessControl.FileSystemRights]::Read -bor [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [System.Security.AccessControl.FileSystemRights]::Modify -bor [System.Security.AccessControl.FileSystemRights]::FullControl)
$directoryWriteMask = [int]([System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership -bor [System.Security.AccessControl.FileSystemRights]::Modify -bor [System.Security.AccessControl.FileSystemRights]::FullControl)
$ancestorWriteMask = [int]([System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership -bor [System.Security.AccessControl.FileSystemRights]::Modify -bor [System.Security.AccessControl.FileSystemRights]::FullControl)
foreach ($itemPath in $paths) {
  $item = Get-Item -LiteralPath $itemPath -Force
  if ($item.Attributes.ToString() -match '(^|,\\s*)ReparsePoint(,|$)') { exit 21 }
  $acl = Get-Acl -LiteralPath $itemPath
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($trusted -notcontains $ownerSid) { exit 22 }
  $isFile = ($null -ne $secretFile) -and ($itemPath -eq $secretFile)
  $isSecretDirectory = ($null -ne $secretDirectory) -and ($itemPath -eq $secretDirectory)
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if ($trusted -contains $rule.IdentityReference.Value) { continue }
    $rights = [int]$rule.FileSystemRights
    if ($isFile -and (($rights -band $readMask) -ne 0 -or ($rights -band $directoryWriteMask) -ne 0)) { exit 23 }
    if ($isSecretDirectory -and ($rights -band $directoryWriteMask) -ne 0) { exit 24 }
    if (-not $isFile -and -not $isSecretDirectory -and ($rights -band $ancestorWriteMask) -ne 0) { exit 25 }
  }
}
Write-Output 'OK'
`;
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  try {
    const result = execFileSync(getPowerShellPath(), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand,
    ], {
      encoding: "utf8",
      windowsHide: true,
      env: windowsSystemEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    if (result !== "OK") throw new Error("ACL verifier returned an unexpected result");
    for (const entry of pending) {
      verifiedAclCache.set(entry.key, { identity: entry.identity, expiresAt: now + ACL_CACHE_TTL_MS });
    }
  } catch {
    throw new Error(`${name} secret permissions could not be verified against Windows ACLs`);
  }
}

module.exports = { assertWindowsSecretAcl };
