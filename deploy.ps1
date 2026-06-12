param(
  [switch]$Force,
  [string]$IP = "192.168.1.10",
  [string]$Password
)

$ErrorActionPreference = "Stop"

$VPS = "sidekick@$IP"
$REMOTE_DIR = "/home/sidekick/sidekick"
$SSH_KEY = if ($env:SIDEKICK_SSH_KEY) { $env:SIDEKICK_SSH_KEY } else { Join-Path $env:USERPROFILE ".ssh\sidekick" }
$SSH_PUB_KEY = "$SSH_KEY.pub"
$PROJECT_DIR = $PSScriptRoot

$SSH_OPTS = "-o StrictHostKeyChecking=accept-new -o BatchMode=yes"

function Run-Remote {
  param([string]$Cmd)
  ssh -i "$SSH_KEY" $SSH_OPTS.Split(' ') "$VPS" "$Cmd" 2>&1
}

function Run-Remote-Interactive {
  param([string]$Cmd)
  ssh -t -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$VPS" "$Cmd" 2>&1
}

function Copy-ToVPS {
  param([string]$Local, [string]$Remote)
  scp -i "$SSH_KEY" $SSH_OPTS.Split(' ') "$Local" "${VPS}:${Remote}" 2>&1
  return $LASTEXITCODE -eq 0
}

function Restart-SidekickService {
  param([string]$Name)
  Write-Host "  restarting $Name..." -ForegroundColor Yellow
  Run-Remote "sudo systemctl restart $Name" | Out-Null
}

function Ensure-SSHKey {
  if (Test-Path $SSH_KEY) {
    Write-Host "  SSH key found at $SSH_KEY" -ForegroundColor Gray
    return
  }
  Write-Host "  Generating SSH key..." -ForegroundColor Yellow
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N '""' -q
  if (-not (Test-Path $SSH_KEY)) {
    throw "Failed to generate SSH key"
  }
  Write-Host "  SSH key generated" -ForegroundColor Green
}

function Test-SSHConnection {
  $result = ssh -i "$SSH_KEY" $SSH_OPTS.Split(' ') -o ConnectTimeout=5 "$VPS" "echo OK" 2>&1
  return ($result -match "OK")
}

function Install-SSHKey {
  Write-Host ""
  Write-Host "  SSH key not installed on remote. Installing..." -ForegroundColor Yellow

  $pubKey = Get-Content $SSH_PUB_KEY -Raw

  if ($Password) {
    Write-Host "  Using provided password..." -ForegroundColor Gray
    $installCmd = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$pubKey' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_INSTALLED"
    $result = ssh -o StrictHostKeyChecking=accept-new "$VPS" "echo '$Password' | sudo -S -u sidekick bash -c `"$installCmd`"" 2>&1
    if ($result -match "KEY_INSTALLED") { return $true }
    return $false
  }

  Write-Host "  Enter sidekick password when prompted to install SSH key:" -ForegroundColor Cyan
  $installCmd = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$pubKey' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
  Run-Remote-Interactive "$installCmd"
  return ($LASTEXITCODE -eq 0)
}

function Test-Sudo {
  $result = Run-Remote "sudo -n /usr/bin/systemctl status sidekick-mcp 2>&1 | head -1"
  return ($result -match "sidekick-mcp.service")
}

function Test-ServicesExist {
  $services = @("sidekick-mcp", "sidekick-dashboard", "sidekick-agent")
  foreach ($svc in $services) {
    $exists = Run-Remote "test -f /etc/systemd/system/$svc.service && echo YES || echo NO"
    if (-not ($exists -match "YES")) {
      return $false
    }
  }
  return $true
}

function Initialize-Remote {
  Write-Host ""
  Write-Host "=== Initializing remote server ===" -ForegroundColor Cyan

  Write-Host "  Checking if services are already installed..." -ForegroundColor Yellow
  $servicesExist = Test-ServicesExist

  if (-not $servicesExist) {
    Write-Host "  First-time setup detected..." -ForegroundColor Yellow

    # Setup sudoers if needed
    if (-not (Test-Sudo)) {
      Write-Host "  Setting up sudoers configuration..." -ForegroundColor Yellow

      $sudoersLocal = Join-Path $PROJECT_DIR "systemd\sidekick-sudoers"
      if (-not (Test-Path $sudoersLocal)) {
        throw "sudoers file not found at $sudoersLocal"
      }

      Copy-ToVPS $sudoersLocal "/tmp/sidekick-sudoers" | Out-Null

      if ($Password) {
        Write-Host "  Installing sudoers with provided password..." -ForegroundColor Gray
        Run-Remote "echo '$Password' | sudo -S cp /tmp/sidekick-sudoers /etc/sudoers.d/sidekick" | Out-Null
        Run-Remote "echo '$Password' | sudo -S chmod 440 /etc/sudoers.d/sidekick" | Out-Null
        Run-Remote "rm -f /tmp/sidekick-sudoers" | Out-Null
      } else {
        Write-Host "  Enter sidekick password when prompted to install sudoers:" -ForegroundColor Cyan
        Run-Remote-Interactive "sudo cp /tmp/sidekick-sudoers /etc/sudoers.d/sidekick && sudo chmod 440 /etc/sudoers.d/sidekick && rm -f /tmp/sidekick-sudoers"
      }

      if (-not (Test-Sudo)) {
        throw "Sudoers setup failed"
      }
      Write-Host "  Sudoers configured" -ForegroundColor Green
    } else {
      Write-Host "  Sudoers already configured" -ForegroundColor Gray
    }

    # Install service files (requires password)
    Write-Host "  Installing service files..." -ForegroundColor Yellow
    $services = @("sidekick-mcp", "sidekick-dashboard", "sidekick-agent")
    foreach ($svc in $services) {
      $svcLocal = Join-Path $PROJECT_DIR "systemd\$svc.service"
      Copy-ToVPS $svcLocal "/tmp/$svc.service" | Out-Null
      
      if ($Password) {
        Run-Remote "echo '$Password' | sudo -S cp /tmp/$svc.service /etc/systemd/system/$svc.service" | Out-Null
        Run-Remote "rm -f /tmp/$svc.service" | Out-Null
      } else {
        Run-Remote-Interactive "sudo cp /tmp/$svc.service /etc/systemd/system/$svc.service && rm -f /tmp/$svc.service"
      }
    }

    # daemon-reload and enable (requires password)
    Write-Host "  Enabling services..." -ForegroundColor Yellow
    if ($Password) {
      Run-Remote "echo '$Password' | sudo -S systemctl daemon-reload" | Out-Null
      foreach ($svc in $services) {
        Run-Remote "echo '$Password' | sudo -S systemctl enable $svc" | Out-Null
      }
    } else {
      Run-Remote-Interactive "sudo systemctl daemon-reload && sudo systemctl enable sidekick-mcp sidekick-dashboard sidekick-agent"
    }

    # Open firewall ports (requires password)
    Write-Host "  Checking firewall..." -ForegroundColor Yellow
    $ufwActive = Run-Remote "systemctl is-active ufw 2>&1"
    if ($ufwActive -match "active") {
      if ($Password) {
        Run-Remote "echo '$Password' | sudo -S ufw allow 4097/tcp comment 'Sidekick MCP'" | Out-Null
        Run-Remote "echo '$Password' | sudo -S ufw allow 4098/tcp comment 'Sidekick Dashboard'" | Out-Null
        Run-Remote "echo '$Password' | sudo -S ufw allow 4099/tcp comment 'Sidekick Agent'" | Out-Null
      } else {
        Run-Remote-Interactive "sudo ufw allow 4097/tcp comment 'Sidekick MCP' && sudo ufw allow 4098/tcp comment 'Sidekick Dashboard' && sudo ufw allow 4099/tcp comment 'Sidekick Agent'"
      }
      Write-Host "  Firewall ports opened (4097, 4098, 4099)" -ForegroundColor Green
    } else {
      Write-Host "  UFW not active, skipping firewall config" -ForegroundColor Yellow
    }

    Write-Host "  First-time setup complete" -ForegroundColor Green
  } else {
    Write-Host "  Services already installed, skipping setup" -ForegroundColor Gray
  }

  Write-Host "  Creating remote directories..." -ForegroundColor Yellow
  Run-Remote "mkdir -p $REMOTE_DIR/src $REMOTE_DIR/data" | Out-Null

  Write-Host "  Remote initialization complete" -ForegroundColor Green
}

$changed = @()

try {
  Write-Host "=== Deploying Sidekick to $IP ===" -ForegroundColor Cyan

  Write-Host ""
  Write-Host "--- SSH Setup ---" -ForegroundColor Cyan
  Ensure-SSHKey

  if (-not (Test-SSHConnection)) {
    if (-not (Install-SSHKey)) {
      throw "Failed to install SSH key on remote"
    }
    if (-not (Test-SSHConnection)) {
      throw "SSH connection still fails after key install"
    }
    Write-Host "  SSH key installed successfully" -ForegroundColor Green
  } else {
    Write-Host "  SSH connection OK" -ForegroundColor Green
  }

  Write-Host ""
  Write-Host "--- Remote Setup ---" -ForegroundColor Cyan
  Initialize-Remote

  Write-Host ""
  Write-Host "--- Deploying Files ---" -ForegroundColor Cyan

  Write-Host "  Syncing source files..." -ForegroundColor Green
  $files = @("tools.js", "index.js", "dashboard.js", "agent.js", "redact.js")
  foreach ($file in $files) {
    $localPath = Join-Path $PROJECT_DIR "src\$file"
    if (-not (Test-Path $localPath)) {
      Write-Host "    Warning: $file not found, skipping" -ForegroundColor Yellow
      continue
    }
    if (-not (Copy-ToVPS $localPath "$REMOTE_DIR/src/$file")) {
      throw "Failed to copy $file"
    }
    $changed += $file
  }

  if (-not (Copy-ToVPS (Join-Path $PROJECT_DIR "package.json") "$REMOTE_DIR/package.json")) {
    throw "Failed to copy package.json"
  }
  $changed += "package.json"

  $localEnv = Join-Path $PROJECT_DIR ".env"
  if (Test-Path $localEnv) {
    Write-Host "  Syncing .env..." -ForegroundColor Green
    if (-not (Copy-ToVPS $localEnv "$REMOTE_DIR/.env")) {
      throw "Failed to copy .env"
    }
    $changed += ".env"
  } else {
    Write-Host "  No local .env found, skipping" -ForegroundColor Yellow
  }

  Write-Host ""
  Write-Host "--- Installing Dependencies ---" -ForegroundColor Cyan
  Write-Host "  Running npm install..." -ForegroundColor Green
  $npmOutput = Run-Remote "cd $REMOTE_DIR && npm install --production 2>&1"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  npm install failed:" -ForegroundColor Red
    Write-Host $npmOutput
    throw "npm install failed"
  }

  Write-Host ""
  Write-Host "--- Starting Services ---" -ForegroundColor Cyan
  Restart-SidekickService "sidekick-mcp"
  Restart-SidekickService "sidekick-dashboard"
  Restart-SidekickService "sidekick-agent"

  Write-Host ""
  Write-Host "=== Deploy complete ===" -ForegroundColor Cyan
  Write-Host "Files synced: $($changed -join ', ')"
  Write-Host ""

  foreach ($svc in @("sidekick-mcp", "sidekick-dashboard", "sidekick-agent")) {
    $status = Run-Remote "sudo systemctl status $svc 2>&1 | grep 'Active:' | awk '{print `$2}'"
    $color = if ($status -match "active") { "Green" } else { "Red" }
    Write-Host ("  $svc : ".PadRight(30)) -NoNewline
    Write-Host $status -ForegroundColor $color
  }

  Write-Host ""
  Write-Host "Dashboard: http://$IP`:4098" -ForegroundColor Cyan
  Write-Host "MCP:       http://$IP`:4097/mcp" -ForegroundColor Cyan

} catch {
  Write-Host ""
  Write-Host "=== Deploy failed ===" -ForegroundColor Red
  Write-Host "Error: $_" -ForegroundColor Red
  exit 1
}
