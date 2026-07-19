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
  [string]$WinswSha256 = "b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f"
)
$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run from an elevated (Administrator) PowerShell."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node not found on PATH." }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PkgRoot   = Resolve-Path (Join-Path $ScriptDir "..\..")
$WorkerSrc = if (Test-Path (Join-Path $PkgRoot "worker-agent.js")) { $PkgRoot } else { Join-Path $PkgRoot "src\compute" }
$XmlSrc    = Join-Path $ScriptDir "sidekick-compute-worker.xml"

Write-Host "==> Creating directories"
New-Item -ItemType Directory -Force -Path $InstallDir, $ConfigDir | Out-Null

Write-Host "==> Installing worker files to $InstallDir"
Copy-Item -Path (Join-Path $WorkerSrc "*") -Destination $InstallDir -Recurse -Force

Write-Host "==> Writing config (non-secret)"
@{ serverUrl = $ServerUrl; concurrency = $Concurrency } | ConvertTo-Json | Set-Content -Path (Join-Path $ConfigDir "config.json") -Encoding UTF8

Write-Host "==> Placing winsw service definition"
Copy-Item -Path $XmlSrc -Destination (Join-Path $InstallDir "sidekick-compute-worker.xml") -Force
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
& node (Join-Path $InstallDir "worker-agent.js") enroll --service --token $EnrollToken

Write-Host "==> Installing and starting the service"
& $WinswExe install
& $WinswExe start
Write-Host "==> Done. Manage with: `"$WinswExe`" status|stop|start|uninstall"
