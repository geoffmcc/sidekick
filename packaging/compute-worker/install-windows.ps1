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
  [string]$OllamaUrl  = "",
  [string]$OllamaModel = "qwen3.5:latest",
  [int]$OllamaTimeoutMs = 120000,
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
$UnsafeAncestorRights = [System.Security.AccessControl.FileSystemRights]"Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership"

function Get-NonAdminWriters {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$IncludeDescendants
  )
  $offenders = @()
  $targets = @()
  $pathExists = Test-Path -LiteralPath $Path
  if ($pathExists) {
    $resolvedPath = (Resolve-Path -LiteralPath $Path).ProviderPath
    $targets += $resolvedPath
    if ($IncludeDescendants -and (Get-Item -LiteralPath $resolvedPath -Force).PSIsContainer) {
      $pendingDirectories = New-Object 'System.Collections.Generic.Stack[string]'
      $pendingDirectories.Push($resolvedPath)
      while ($pendingDirectories.Count -gt 0) {
        $directory = $pendingDirectories.Pop()
        foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($directory)) {
          $attributes = [System.IO.File]::GetAttributes($entry)
          if ($attributes.ToString() -match '(^|,\s*)ReparsePoint(,|$)') {
            $offenders += "$entry is a reparse point in a LocalSystem executable directory"
            continue
          }
          $targets += $entry
          if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
            $pendingDirectories.Push($entry)
          }
        }
      }
    }
  } else {
    # A writable existing parent lets a non-admin precreate a future service
    # directory. Check the nearest existing ancestor as the target in that case.
    $nearestExisting = Split-Path -Parent $Path
    while ($nearestExisting -and -not (Test-Path -LiteralPath $nearestExisting)) {
      $parent = Split-Path -Parent $nearestExisting
      if (-not $parent -or $parent -eq $nearestExisting) { break }
      $nearestExisting = $parent
    }
    if (-not $nearestExisting -or -not (Test-Path -LiteralPath $nearestExisting)) {
      return @("No existing parent could be checked for $Path")
    }
    $targets += (Resolve-Path -LiteralPath $nearestExisting).ProviderPath
  }

  foreach ($target in $targets) {
    $current = $target
    # If the requested leaf does not exist, the nearest existing object is an
    # ancestor: create-child rights alone do not let an attacker replace it.
    $isTarget = $pathExists
    while ($current) {
      try { $acl = Get-Acl -LiteralPath $current }
      catch {
        $offenders += "$current ACL could not be verified: $($_.Exception.Message)"
        break
      }
      $rightsToCheck = if ($isTarget) { $UnsafeRights } else { $UnsafeAncestorRights }
      try { $ownerSid = ([System.Security.Principal.NTAccount]::new($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
      catch { $ownerSid = $acl.Owner }
      if ($TrustedSids -notcontains $ownerSid) {
        $offenders += "$current is owned by non-administrator $($acl.Owner)"
      }
      foreach ($ace in $acl.Access) {
        if ($ace.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
        if ($ace.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        if (($ace.FileSystemRights -band $rightsToCheck) -eq 0) { continue }
        try { $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }
        catch { $sid = $ace.IdentityReference.Value }
        if ($TrustedSids -notcontains $sid) { $offenders += "$current is writable by $($ace.IdentityReference.Value)" }
      }
      $parent = Split-Path -Parent $current
      if (-not $parent -or $parent -eq $current) { break }
      $current = $parent
      $isTarget = $false
    }
  }
  return $offenders
}

function Set-SidekickPrivateAclTree {
  param([Parameter(Mandatory = $true)][string]$Path)
  $resolvedPath = (Resolve-Path -LiteralPath $Path).ProviderPath
  $rootAttributes = [System.IO.File]::GetAttributes($resolvedPath)
  if ($rootAttributes.ToString() -match '(^|,\s*)ReparsePoint(,|$)') {
    throw "Refusing to secure a reparse-point configuration directory: $resolvedPath"
  }

  $targets = @($resolvedPath)
  $pendingDirectories = New-Object 'System.Collections.Generic.Stack[string]'
  if (($rootAttributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
    $pendingDirectories.Push($resolvedPath)
  }
  while ($pendingDirectories.Count -gt 0) {
    $directory = $pendingDirectories.Pop()
    foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $attributes = [System.IO.File]::GetAttributes($entry)
      if ($attributes.ToString() -match '(^|,\s*)ReparsePoint(,|$)') {
        throw "Refusing to secure a reparse point inside Sidekick configuration: $entry"
      }
      $targets += $entry
      if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
        $pendingDirectories.Push($entry)
      }
    }
  }

  $systemSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
  $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
  foreach ($target in $targets) {
    $attributes = [System.IO.File]::GetAttributes($target)
    $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
    $acl = Get-Acl -LiteralPath $target
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($acl.Access)) { $acl.RemoveAccessRuleAll($existingRule) }
    $acl.SetOwner($administratorsSid)
    $inheritance = if ($isDirectory) {
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
      [System.Security.AccessControl.InheritanceFlags]::None
    }
    foreach ($sid in @($systemSid, $administratorsSid)) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
      )
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $target -AclObject $acl
  }
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

# WinSW, worker-agent.js, and every transitive worker module execute as
# LocalSystem. The complete installation tree must be unwritable by
# non-administrators, including when a custom InstallDir is supplied.
$InstallDirWriters = @(Get-NonAdminWriters -Path $InstallDir -IncludeDescendants)
if ($InstallDirWriters.Count -gt 0) {
  $detail = ($InstallDirWriters | Select-Object -Unique) -join "`n  "
  throw "Refusing to install: InstallDir or one of its ancestors/files is writable by a non-administrator.`n`n  $InstallDir`n`n  $detail"
}

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
# Check the nearest existing ancestors before creating either service path. A
# non-admin owner or a parent that can delete/replace a child could race this
# elevated install. Create-child rights alone are allowed: the installer will
# secure and verify the newly created leaf before using it.
$InstallParentWriters = @(Get-NonAdminWriters -Path $InstallDir)
if ($InstallParentWriters.Count -gt 0) {
  $detail = ($InstallParentWriters | Select-Object -Unique) -join "`n  "
  throw "Refusing to create InstallDir beneath an unsafe parent.`n`n  $InstallDir`n`n  $detail"
}
$ConfigParentWriters = @(Get-NonAdminWriters -Path $ConfigDir)
if ($ConfigParentWriters.Count -gt 0) {
  $detail = ($ConfigParentWriters | Select-Object -Unique) -join "`n  "
  throw "Refusing to create ConfigDir beneath an unsafe parent.`n`n  $ConfigDir`n`n  $detail"
}
New-Item -ItemType Directory -Force -Path $InstallDir, $ConfigDir | Out-Null
$configDirectoryAttributes = [System.IO.File]::GetAttributes((Resolve-Path -LiteralPath $ConfigDir).ProviderPath)
if ($configDirectoryAttributes.ToString() -match '(^|,\s*)ReparsePoint(,|$)') {
  throw "Refusing to use a reparse-point ConfigDir: $ConfigDir"
}
Set-SidekickPrivateAclTree -Path $ConfigDir
$ConfigDirWriters = @(Get-NonAdminWriters -Path $ConfigDir)
if ($ConfigDirWriters.Count -gt 0) {
  $detail = ($ConfigDirWriters | Select-Object -Unique) -join "`n  "
  throw "Refusing to use a ConfigDir that can be replaced or modified by a non-administrator.`n`n  $ConfigDir`n`n  $detail"
}
$InstallDirWriters = @(Get-NonAdminWriters -Path $InstallDir -IncludeDescendants)
if ($InstallDirWriters.Count -gt 0) {
  $detail = ($InstallDirWriters | Select-Object -Unique) -join "`n  "
  throw "Refusing to install into a writable InstallDir.`n`n  $InstallDir`n`n  $detail"
}

Write-Host "==> Installing worker files to $InstallDir"
Copy-Item -Path (Join-Path $WorkerSrc "*") -Destination $InstallDir -Recurse -Force

Write-Host "==> Writing config (non-secret)"
$Config = [ordered]@{ serverUrl = $ServerUrl; concurrency = $Concurrency }
if ($OllamaUrl -ne "") {
  if ($OllamaTimeoutMs -lt 5000 -or $OllamaTimeoutMs -gt 600000) { throw "-OllamaTimeoutMs must be between 5000 and 600000." }
  if ($OllamaModel -eq "") { throw "-OllamaModel is required when -OllamaUrl is supplied, so the worker can advertise a schedulable model." }
  $Config.ollama = [ordered]@{ enabled = $true; url = $OllamaUrl; timeoutMs = $OllamaTimeoutMs }
  $Config.ollama.model = $OllamaModel
}
$ConfigPath = Join-Path $ConfigDir "config.json"
$ConfigTempPath = Join-Path $ConfigDir ".config.$([Guid]::NewGuid().ToString('N')).tmp"
$ConfigJson = $Config | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($ConfigTempPath, $ConfigJson, [System.Text.UTF8Encoding]::new($false))
if (Test-Path -LiteralPath $ConfigPath) { Remove-Item -LiteralPath $ConfigPath -Force }
Move-Item -LiteralPath $ConfigTempPath -Destination $ConfigPath

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
$InstallDirWriters = @(Get-NonAdminWriters -Path $InstallDir -IncludeDescendants)
if ($InstallDirWriters.Count -gt 0) {
  $detail = ($InstallDirWriters | Select-Object -Unique) -join "`n  "
  throw "Refusing to register a LocalSystem service from a writable InstallDir.`n`n  $InstallDir`n`n  $detail"
}

Write-Host "==> Enrolling (writes credential; token not persisted)"
$env:SIDEKICK_WORKER_CONFIG_FILE = Join-Path $ConfigDir "config.json"
$env:SIDEKICK_WORKER_CONFIG      = Join-Path $ConfigDir "credential.json"
& $NodeExe (Join-Path $InstallDir "worker-agent.js") enroll --service --token $EnrollToken

Write-Host "==> Installing and starting the service"
& $WinswExe install
& $WinswExe start
Write-Host "==> Done. Manage with: `"$WinswExe`" status|stop|start|uninstall"
