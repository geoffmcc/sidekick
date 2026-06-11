param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$VPS = "sidekick@149.28.229.13"
$REMOTE_DIR = "/home/sidekick/mcp-sidekick"
$SSH_KEY = if ($env:SIDEKICK_SSH_KEY) { $env:SIDEKICK_SSH_KEY } else { Join-Path $env:USERPROFILE ".ssh\sidekick" }

function Run-Remote {
  param([string]$Cmd)
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$VPS" "$Cmd" 2>&1
}

function Copy-ToVPS {
  param([string]$Local, [string]$Remote)
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$Local" "${VPS}:${Remote}" 2>&1
}

function Restart-Service { param([string]$Name) Write-Host "  restarting $Name..." -ForegroundColor Yellow; Run-Remote "sudo systemctl restart $Name" | Out-Null }

$changed = @()

try {
  Write-Host "=== Deploying Sidekick ===" -ForegroundColor Cyan

  # Verify SSH key exists
  if (-not (Test-Path $SSH_KEY)) {
    throw "SSH key not found at $SSH_KEY"
  }

  # Sync src files
  Write-Host "Syncing source files..." -ForegroundColor Green
  $files = @("tools.js", "index.js", "dashboard.js", "agent.js")
  foreach ($file in $files) {
    $localPath = "src\$file"
    if (-not (Test-Path $localPath)) {
      Write-Host "  Warning: $localPath not found, skipping" -ForegroundColor Yellow
      continue
    }
    if (-not (Copy-ToVPS $localPath "$REMOTE_DIR/src/$file")) {
      throw "Failed to copy $file"
    }
    $changed += $file
  }

  # Sync package.json if changed
  if (-not (Copy-ToVPS "package.json" "$REMOTE_DIR/package.json")) {
    throw "Failed to copy package.json"
  }
  $changed += "package.json"

  # Sync .env if it exists locally (contains API keys, ports, config)
  $localEnv = Join-Path $PSScriptRoot ".env"
  if (Test-Path $localEnv) {
    Write-Host "Syncing .env..." -ForegroundColor Green
    if (-not (Copy-ToVPS $localEnv "$REMOTE_DIR/.env")) {
      throw "Failed to copy .env"
    }
    $changed += ".env"
  } else {
    Write-Host "No local .env found, skipping env sync" -ForegroundColor Yellow
  }

  # Run npm install on VPS if package.json changed
  Write-Host "Running npm install on remote machine..." -ForegroundColor Green
  $npmOutput = Run-Remote "cd $REMOTE_DIR && npm install 2>&1"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "npm install failed:" -ForegroundColor Red
    Write-Host $npmOutput
    throw "npm install failed"
  }

  # Restart services
  Write-Host "Restarting services..." -ForegroundColor Green
  Restart-Service "sidekick-mcp"
  Restart-Service "sidekick-dashboard"

  # Start agent service if it exists, or create it
  $agentExists = Run-Remote "test -f /etc/systemd/system/sidekick-agent.service && echo YES || echo NO"
  if ($agentExists -match "YES") {
    Restart-Service "sidekick-agent"
  } else {
    Write-Host "  creating sidekick-agent service..." -ForegroundColor Yellow
    $serviceContent = @"
[Unit]
Description=Sidekick Agent Bridge
After=network.target

[Service]
WorkingDirectory=$REMOTE_DIR
ExecStart=/usr/bin/node src/agent.js
Restart=always
RestartSec=5
User=sidekick
Group=sidekick
EnvironmentFile=$REMOTE_DIR/.env

[Install]
WantedBy=multi-user.target
"@
    Run-Remote "echo '$serviceContent' | sudo tee /etc/systemd/system/sidekick-agent.service > /dev/null"
    Run-Remote "sudo systemctl daemon-reload"
    Run-Remote "sudo systemctl enable sidekick-agent"
    Run-Remote "sudo systemctl start sidekick-agent"
  }

  # Open UFW port if needed
  $ufwCheck = Run-Remote "sudo ufw status | grep -w 4099"
  if (-not $ufwCheck) {
    Write-Host "  opening UFW port 4099..." -ForegroundColor Yellow
    Run-Remote "sudo ufw allow 4099/tcp comment 'Sidekick Agent Bridge'" | Out-Null
  }

  Write-Host ""
  Write-Host "=== Deploy complete ===" -ForegroundColor Cyan
  Write-Host "Files synced: $($changed -join ', ')"
  Write-Host ""

  # Check service statuses
  foreach ($svc in @("sidekick-mcp", "sidekick-dashboard", "sidekick-agent")) {
    $status = Run-Remote "sudo systemctl is-active $svc 2>&1"
    $color = if ($status -match "active") { "Green" } else { "Red" }
    Write-Host ("  $svc : ".PadRight(30)) -NoNewline
    Write-Host $status -ForegroundColor $color
  }

} catch {
  Write-Host ""
  Write-Host "=== Deploy failed ===" -ForegroundColor Red
  Write-Host "Error: $_" -ForegroundColor Red
  exit 1
}
