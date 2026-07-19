<#
.SYNOPSIS
  Sidekick Compute Worker - Windows installer (winsw service wrapper).

.DESCRIPTION
  Installs the worker as a Windows service using winsw. The built worker
  package bundles winsw as sidekick-compute-worker.exe, so no download is
  needed. The enrollment token is used ONLY during `enroll` to obtain a
  persistent credential; it is never written to the service definition. Run
  from an elevated PowerShell.

.EXAMPLE
  .\install-windows.ps1 -ServerUrl http://host:4097 -EnrollToken <token>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ServerUrl,
  [Parameter(Mandatory = $true)][string]$EnrollToken,
  [string]$InstallDir = "C:\Program Files\Sidekick\compute-worker",
  [string]$ConfigDir  = "C:\ProgramData\Sidekick\compute-worker",
  [int]$Concurrency   = 1,
  # Optional override: https URL to a winsw release .exe. Normally unnecessary —
  # the built worker package already bundles winsw as sidekick-compute-worker.exe.
  # Needed only when installing from a bare repo checkout without the binary.
  [string]$WinswUrl   = "",
  # SHA-256 a -WinswUrl download must match. Defaults to the pinned winsw
  # v2.12.0 WinSW.NET461.exe; pass the matching hash when overriding the URL.
  [string]$WinswSha256 = "b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f",
  # Explicit path to node.exe for the service to run. Defaults to whatever
  # `node` resolves to on the installing operator's PATH. Must be writable only
  # by administrators (see the node resolution block below).
  [string]$NodeExe = "",
  # Escape hatch: install even when node.exe sits on a non-admin-writable path.
  # This makes any user who can write that path able to run code as LocalSystem.
  # Only use it on a machine where that user is already effectively an admin.
  [switch]$AllowUserWritableNode
)
$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run from an elevated (Administrator) PowerShell."
}
# Absolute paths for the system tools this script shells out to. Resolving them
# by bare name would let a non-admin who controls a PATH entry execute code
# inside this elevated process.
$Sys32  = Join-Path $env:SystemRoot "System32"
$ScExe  = Join-Path $Sys32 "sc.exe"

# --- node resolution -------------------------------------------------------
# The service runs as LocalSystem with the MACHINE PATH, so a user-scoped Node
# (scoop, nvm, fnm) is invisible to it and a bare <executable>node</executable>
# fails with "The system cannot find the file specified". Bake an absolute path
# into the service definition instead.
#
# That path becomes a binary LocalSystem executes at every boot, so it must not
# be writable by a non-administrator: otherwise any code running as that user
# can replace node.exe and get SYSTEM on the next service start.
if ($NodeExe -eq "") {
  $NodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $NodeCmd) { throw "node not found on PATH. Install Node machine-wide, or pass -NodeExe <path to node.exe>." }
  $NodeExe = $NodeCmd.Source
}
if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
  throw "Could not resolve node to an absolute path (got '$NodeExe')."
}
$NodeExe = (Resolve-Path -LiteralPath $NodeExe).ProviderPath
if ([IO.Path]::GetExtension($NodeExe) -ne ".exe") {
  throw "Resolved node is '$NodeExe', not a .exe. A shim (.cmd/.bat) cannot be run by the service; pass -NodeExe <path to the real node.exe>."
}

# Principals that are already effectively machine-admin; write access held by
# anyone else is what makes the service binary hijackable.
$TrustedSids = @(
  "S-1-5-18",       # NT AUTHORITY\SYSTEM
  "S-1-5-32-544",   # BUILTIN\Administrators
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" # TrustedInstaller
)
# Only rights that permit replacing the binary or rewriting its ACL. Read and
# ReadAndExecute deliberately excluded so ordinary read ACEs are not flagged.
$UnsafeRights = [System.Security.AccessControl.FileSystemRights]"WriteData, AppendData, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership"

function Get-NonAdminWriters {
  param([Parameter(Mandatory = $true)][string]$Path)
  $offenders = @()
  $current = $Path
  while ($current) {
    try { $acl = Get-Acl -LiteralPath $current } catch { break }
    foreach ($ace in $acl.Access) {
      if ($ace.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
      # Inherit-only ACEs do not apply to this object; the child we already
      # walked shows the effective result.
      if ($ace.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
      if (($ace.FileSystemRights -band $UnsafeRights) -eq 0) { continue }
      try { $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }
      catch { $sid = $ace.IdentityReference.Value }
      if ($TrustedSids -notcontains $sid) { $offenders += "$current is writable by $($ace.IdentityReference.Value)" }
    }
    $parent = Split-Path -Parent $current
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
  return $offenders
}

$NodeWriters = @(Get-NonAdminWriters -Path $NodeExe)
if ($NodeWriters.Count -gt 0) {
  $detail = ($NodeWriters | Select-Object -Unique) -join "`n  "
  if (-not $AllowUserWritableNode) {
    throw @"
Refusing to install: the resolved node.exe is writable by a non-administrator.

  $NodeExe

  $detail

The service runs as LocalSystem, so anyone who can write that path could run
code as SYSTEM. Install Node machine-wide (the official MSI puts it in
C:\Program Files\nodejs) and re-run, or pass -NodeExe <admin-only node.exe>.
Override only if you accept that risk: -AllowUserWritableNode
"@
  }
  Write-Warning "node.exe at $NodeExe is writable by a non-administrator; installing anyway (-AllowUserWritableNode)."
  Write-Warning $detail
}
Write-Host "==> Using node at $NodeExe"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PkgRoot   = Resolve-Path (Join-Path $ScriptDir "..\..")
$WorkerSrc = if (Test-Path (Join-Path $PkgRoot "worker-agent.js")) { $PkgRoot } else { Join-Path $PkgRoot "src\compute" }
$XmlSrc    = Join-Path $ScriptDir "sidekick-compute-worker.xml"
$ServiceId = "sidekick-compute-worker"

# Idempotence: a previous (possibly failed) install can leave the service
# registered, which makes `winsw install` fail with "A service with ID ...
# already exists". Stop and remove it first — before copying files, because the
# running winsw binary is locked while the service is up.
$Existing = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
if ($Existing) {
  Write-Host "==> Existing $ServiceId service found; stopping and removing it"
  $OldWinsw = Join-Path $InstallDir "sidekick-compute-worker.exe"
  if (Test-Path $OldWinsw) {
    & $OldWinsw stop 2>&1 | Out-Null
    & $OldWinsw uninstall 2>&1 | Out-Null
  } else {
    # Orphaned registration with no binary to drive it: fall back to sc.exe.
    & $ScExe stop $ServiceId 2>&1 | Out-Null
    & $ScExe delete $ServiceId 2>&1 | Out-Null
  }
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) {
    throw "Service $ServiceId still exists after removal. Close services.msc (it holds the service open) and re-run."
  }
}

Write-Host "==> Creating directories"
New-Item -ItemType Directory -Force -Path $InstallDir, $ConfigDir | Out-Null

Write-Host "==> Installing worker files to $InstallDir"
Copy-Item -Path (Join-Path $WorkerSrc "*") -Destination $InstallDir -Recurse -Force

Write-Host "==> Writing config (non-secret)"
@{ serverUrl = $ServerUrl; concurrency = $Concurrency } | ConvertTo-Json | Set-Content -Path (Join-Path $ConfigDir "config.json") -Encoding UTF8

Write-Host "==> Placing winsw service definition"
$XmlDest = Join-Path $InstallDir "sidekick-compute-worker.xml"
Copy-Item -Path $XmlSrc -Destination $XmlDest -Force
# Rewrite <executable>node</executable> to the absolute path resolved above.
$Xml = New-Object System.Xml.XmlDocument
$Xml.PreserveWhitespace = $true
$Xml.XmlResolver = $null   # no external entity resolution
$Xml.Load($XmlDest)
$Xml.service.SelectSingleNode("executable").InnerText = $NodeExe
$Xml.Save($XmlDest)
Write-Host "    executable set to $NodeExe"
$WinswExe = Join-Path $InstallDir "sidekick-compute-worker.exe"
if ($WinswUrl -ne "") {
  if (([Uri]$WinswUrl).Scheme -ne "https") { throw "-WinswUrl must be an https URL." }
  if ($WinswSha256 -eq "") { throw "-WinswSha256 is required when -WinswUrl is set." }
  Write-Host "==> Downloading winsw"
  Invoke-WebRequest -Uri $WinswUrl -OutFile $WinswExe
  $ActualSha256 = (Get-FileHash -Algorithm SHA256 -Path $WinswExe).Hash.ToLowerInvariant()
  if ($ActualSha256 -ne $WinswSha256.ToLowerInvariant()) {
    Remove-Item -Path $WinswExe -Force
    throw "winsw SHA-256 mismatch: expected $WinswSha256, got $ActualSha256. Refusing to install an unverified binary."
  }
} elseif (-not (Test-Path $WinswExe)) {
  throw "winsw binary not found at $WinswExe. Pass -WinswUrl <winsw release exe url> (with -WinswSha256) or place it manually."
}

Write-Host "==> Enrolling (writes credential; token not persisted)"
$env:SIDEKICK_WORKER_CONFIG_FILE = Join-Path $ConfigDir "config.json"
$env:SIDEKICK_WORKER_CONFIG      = Join-Path $ConfigDir "credential.json"
& $NodeExe (Join-Path $InstallDir "worker-agent.js") enroll --service --token $EnrollToken

Write-Host "==> Installing and starting the service"
& $WinswExe install
& $WinswExe start
Write-Host "==> Done. Manage with: `"$WinswExe`" status|stop|start|uninstall"
