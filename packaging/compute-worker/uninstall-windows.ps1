<#
.SYNOPSIS
  Sidekick Compute Worker - Windows uninstaller (winsw).

.EXAMPLE
  .\uninstall-windows.ps1              # remove service + install dir, keep config/credential
  .\uninstall-windows.ps1 -Purge       # also remove config + credential
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\Program Files\Sidekick\compute-worker",
  [string]$ConfigDir  = "C:\ProgramData\Sidekick\compute-worker",
  [switch]$Purge
)
$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run from an elevated (Administrator) PowerShell."
}

$WinswExe = Join-Path $InstallDir "sidekick-compute-worker.exe"
if (Test-Path $WinswExe) {
  Write-Host "==> Stopping and uninstalling the service"
  & $WinswExe stop 2>$null
  & $WinswExe uninstall 2>$null
}

Write-Host "==> Removing install directory"
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }

if ($Purge) {
  Write-Host "==> Purging config and credential"
  if (Test-Path $ConfigDir) { Remove-Item -Recurse -Force $ConfigDir }
} else {
  Write-Host "==> Kept $ConfigDir (use -Purge to remove)"
}

Write-Host "==> Done."
