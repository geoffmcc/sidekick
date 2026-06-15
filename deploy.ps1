param(
  [switch]$Force,
  [string]$IP = "192.168.1.10",
  [string]$Password = $env:SIDEKICK_INITIAL_PASSWORD,
  [string]$InitialUser = "",
  [switch]$Scp
)

$ErrorActionPreference = "Stop"

$VPS = "sidekick@$IP"
$REMOTE_DIR = "/home/sidekick/sidekick"
$SSH_KEY = if ($env:SIDEKICK_SSH_KEY) { $env:SIDEKICK_SSH_KEY } else { Join-Path $env:USERPROFILE ".ssh\sidekick" }
$SSH_PUB_KEY = "$SSH_KEY.pub"
$PROJECT_DIR = $PSScriptRoot

$SSH_OPTS = "-o StrictHostKeyChecking=accept-new -o BatchMode=yes"

# ControlMaster configuration for connection reuse
$ControlPath = "$env:TEMP\sidekick-ssh-%r@%h:%p"
$ControlOpts = "-o ControlMaster=auto -o ControlPath=$ControlPath -o ControlPersist=60"

function Run-Remote {
  param([string]$Cmd)
  ssh -i "$SSH_KEY" $SSH_OPTS.Split(' ') "$VPS" "$Cmd" 2>&1
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
    # Verify public key exists
    if (-not (Test-Path $SSH_PUB_KEY)) {
      Write-Host "  Public key missing, regenerating..." -ForegroundColor Yellow
      Remove-Item $SSH_KEY -Force
    } else {
      return
    }
  }
  Write-Host "  Generating SSH key..." -ForegroundColor Yellow
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -q
  if (-not (Test-Path $SSH_KEY) -or -not (Test-Path $SSH_PUB_KEY)) {
    throw "Failed to generate SSH key at $SSH_KEY"
  }
  Write-Host "  SSH key generated" -ForegroundColor Green
}

function Test-SSHConnection {
  $result = ssh -i "$SSH_KEY" $SSH_OPTS.Split(' ') -o ConnectTimeout=5 "$VPS" "echo OK" 2>&1
  return ($result -match "OK")
}

function Test-SidekickUserExists {
  $result = ssh -i "$SSH_KEY" $SSH_OPTS.Split(' ') -o ConnectTimeout=3 "$VPS" "echo OK" 2>&1
  return ($result -match "OK")
}

function Run-Bootstrap {
  param([string]$User)
  
  Write-Host ""
  Write-Host "=== Running Bootstrap ===" -ForegroundColor Cyan
  Write-Host "  Bootstrapping as $User@$IP..." -ForegroundColor Yellow
  
  # Validate local files
  Write-Host "  Validating local files..." -ForegroundColor Gray
  $bootstrapLocal = Join-Path $PROJECT_DIR "scripts\bootstrap.sh"
  if (-not (Test-Path $bootstrapLocal)) {
    throw "Bootstrap script not found at $bootstrapLocal"
  }
  
  if (-not (Test-Path $SSH_PUB_KEY)) {
    throw "SSH public key not found at $SSH_PUB_KEY"
  }
  
  $pubKey = (Get-Content $SSH_PUB_KEY -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($pubKey)) {
    throw "SSH public key is empty"
  }
  
  # Open control master connection (1 password prompt)
  Write-Host "  Opening SSH connection (1 password prompt)..." -ForegroundColor Yellow
  Write-Host "  Enter password for $User@$IP when prompted:" -ForegroundColor Cyan
  
  $sshResult = ssh -o ControlMaster=yes -o ControlPath="$ControlPath" `
                   -o ControlPersist=60 -o StrictHostKeyChecking=accept-new `
                   -o ConnectTimeout=10 -N "$User@$IP" 2>&1
  
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: Failed to establish SSH connection" -ForegroundColor Red
    Write-Host "Possible causes:" -ForegroundColor Yellow
    Write-Host "  - Incorrect password"
    Write-Host "  - User doesn't exist on remote"
    Write-Host "  - Network connectivity issues"
    throw "SSH connection failed"
  }
  
  Write-Host "  SSH connection established" -ForegroundColor Green
  
  # Upload files using control connection (no password prompts)
  Write-Host "  Uploading bootstrap script..." -ForegroundColor Yellow
  $scpResult = scp -o ControlPath="$ControlPath" "$bootstrapLocal" "$User@$IP`:/tmp/bootstrap.sh" 2>&1
  
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: Failed to upload bootstrap script" -ForegroundColor Red
    ssh -o ControlPath="$ControlPath" -O exit "$User@$IP" 2>$null
    throw "SCP failed"
  }
  Write-Host "    [ok] bootstrap.sh" -ForegroundColor Gray
  
  Write-Host "  Uploading service files..." -ForegroundColor Yellow
  $services = @("sidekick-mcp", "sidekick-dashboard", "sidekick-agent")
  foreach ($svc in $services) {
    $svcLocal = Join-Path $PROJECT_DIR "systemd\$svc.service"
    if (-not (Test-Path $svcLocal)) {
      Write-Host "  ERROR: Service file not found: $svcLocal" -ForegroundColor Red
      ssh -o ControlPath="$ControlPath" -O exit "$User@$IP" 2>$null
      throw "Service file not found"
    }
    
    $scpResult = scp -o ControlPath="$ControlPath" "$svcLocal" "$User@$IP`:/tmp/$svc.service" 2>&1
    
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  ERROR: Failed to upload $svc.service" -ForegroundColor Red
      ssh -o ControlPath="$ControlPath" -O exit "$User@$IP" 2>$null
      throw "SCP failed"
    }
    Write-Host "    [ok] $svc.service" -ForegroundColor Gray
  }
  
  # Run bootstrap using control connection (no password prompt)
  Write-Host "  Executing bootstrap..." -ForegroundColor Yellow
  Write-Host "--- Bootstrap Output ---" -ForegroundColor DarkGray
  
  $bootstrapCmd = "sudo bash /tmp/bootstrap.sh --yes --install-services --ssh-key '$pubKey' && rm /tmp/bootstrap.sh /tmp/sidekick-*.service"
  
  $sshResult = ssh -o ControlPath="$ControlPath" "$User@$IP" $bootstrapCmd 2>&1
  
  # Filter and display output
  $sshResult | Where-Object { $_ -notmatch "Warning: Permanently added" } | ForEach-Object {
    Write-Host $_
  }
  
  $exitCode = $LASTEXITCODE
  Write-Host "--- End Bootstrap Output ---" -ForegroundColor DarkGray
  
  # Close control master connection
  ssh -o ControlPath="$ControlPath" -O exit "$User@$IP" 2>$null
  
  if ($exitCode -ne 0) {
    throw "Bootstrap execution failed (exit code: $exitCode)"
  }
  
  # Verify sidekick user was created and SSH key installed
  Write-Host ""
  Write-Host "  Verifying bootstrap..." -ForegroundColor Yellow
  Start-Sleep -Seconds 2
  
  $result = ssh -i "$SSH_KEY" $SSH_OPTS.Split(' ') -o ConnectTimeout=5 "$VPS" "echo OK" 2>&1
  if ($result -match "OK") {
    Write-Host "  Bootstrap completed successfully" -ForegroundColor Green
    return $true
  }
  
  Write-Host "  ERROR: Bootstrap verification failed" -ForegroundColor Red
  Write-Host "  Could not SSH as sidekick user. Check the bootstrap output above for errors." -ForegroundColor Yellow
  return $false
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
    Write-Host ""
    Write-Host "  ERROR: Services not found after bootstrap." -ForegroundColor Red
    Write-Host "  Please run bootstrap with --install-services flag:" -ForegroundColor Yellow
    Write-Host "    sudo ./scripts/bootstrap.sh --install-services" -ForegroundColor Gray
    throw "Service installation failed - services not found after bootstrap"
  }

  Write-Host "  Services verified" -ForegroundColor Green

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

  # Check if sidekick user exists
  Write-Host "  Checking for sidekick user..." -ForegroundColor Yellow
  if (-not (Test-SidekickUserExists)) {
    Write-Host "  Sidekick user not found. Bootstrap required." -ForegroundColor Yellow
    
    # Get initial user - prompt if not provided
    if (-not $InitialUser) {
      $InitialUser = Read-Host "  Enter initial SSH user for $IP"
      if (-not $InitialUser) {
        throw "Initial user is required for bootstrap"
      }
    }
    
    # Run bootstrap
    if (-not (Run-Bootstrap -User $InitialUser)) {
      throw "Bootstrap failed"
    }
  } else {
    Write-Host "  Sidekick user found" -ForegroundColor Green
  }

  # Verify SSH connection
  if (-not (Test-SSHConnection)) {
    throw "SSH connection failed after bootstrap"
  }
  Write-Host "  SSH connection OK" -ForegroundColor Green

  Write-Host ""
  Write-Host "--- Remote Setup ---" -ForegroundColor Cyan
  Initialize-Remote

  Write-Host ""
  Write-Host "--- Deploying Files ---" -ForegroundColor Cyan

  if ($Scp) {
    Write-Host "  SCP mode: syncing files individually (airgap/offline)" -ForegroundColor Yellow

    Write-Host "  Syncing source files..." -ForegroundColor Green
    $files = @("tools.js", "index.js", "dashboard.js", "agent.js", "redact.js", "env.js", "db.js")
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
      $remoteEnvExists = Run-Remote "test -f $REMOTE_DIR/.env && echo YES || echo NO"
      if ($remoteEnvExists -match "YES") {
        Write-Host "  Remote .env exists, skipping (preserves machine-specific settings)" -ForegroundColor Yellow
      } else {
        Write-Host "  Syncing .env (first deploy)..." -ForegroundColor Green
        if (-not (Copy-ToVPS $localEnv "$REMOTE_DIR/.env")) {
          throw "Failed to copy .env"
        }
        $changed += ".env"
      }
    } else {
      Write-Host "  No local .env found, skipping" -ForegroundColor Yellow
    }
  } else {
    Write-Host "  Git deploy mode" -ForegroundColor Green

    # Detect repo URL from local git remote, fallback to main repo
    $repoUrl = git -C $PROJECT_DIR remote get-url origin 2>$null
    if (-not $repoUrl) { $repoUrl = "https://github.com/geoffmcc/sidekick.git" }

    $remoteHasGit = Run-Remote "test -d $REMOTE_DIR/.git && echo YES || echo NO"

    if ($remoteHasGit -match "YES") {
      Write-Host "  Pulling latest changes..." -ForegroundColor Yellow
      $pullOutput = Run-Remote "cd $REMOTE_DIR && git pull --ff-only 2>&1"
      if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: git pull failed" -ForegroundColor Red
        Write-Host $pullOutput
        throw "git pull failed"
      }
    } else {
      Write-Host "  Cloning repository..." -ForegroundColor Yellow
      
      # Backup existing data and .env before replacing with git clone
      Write-Host "  Backing up existing data..." -ForegroundColor Yellow
      Run-Remote "mkdir -p /tmp/sidekick-backup && cp -r $REMOTE_DIR/data /tmp/sidekick-backup/ 2>/dev/null; cp $REMOTE_DIR/.env /tmp/sidekick-backup/ 2>/dev/null; echo DONE" 2>$null
      
      # Remove existing directory (git clone requires empty or non-existent dir)
      Write-Host "  Removing old deployment directory..." -ForegroundColor Yellow
      $rmOutput = Run-Remote "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR" 2>&1
      if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: Failed to remove old directory" -ForegroundColor Red
        Write-Host $rmOutput
        throw "Failed to remove old directory"
      }
      
      # Clone fresh
      $cloneOutput = Run-Remote "git clone '$repoUrl' $REMOTE_DIR 2>&1"
      if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: git clone failed" -ForegroundColor Red
        Write-Host $cloneOutput
        Write-Host "  Backup preserved at /tmp/sidekick-backup/ on remote" -ForegroundColor Yellow
        throw "git clone failed"
      }
      
      # Restore data and .env from backup
      Write-Host "  Restoring data and .env from backup..." -ForegroundColor Yellow
      Run-Remote "cp -r /tmp/sidekick-backup/data $REMOTE_DIR/ 2>/dev/null; cp /tmp/sidekick-backup/.env $REMOTE_DIR/ 2>/dev/null; echo DONE" 2>$null
      
      # Cleanup backup on success
      Run-Remote "rm -rf /tmp/sidekick-backup" 2>$null
      Write-Host "  Backup cleaned up" -ForegroundColor Green
    }
    $changed += "git"

    # Handle .env on first deploy
    $localEnv = Join-Path $PROJECT_DIR ".env"
    if (Test-Path $localEnv) {
      $remoteEnvExists = Run-Remote "test -f $REMOTE_DIR/.env && echo YES || echo NO"
      if ($remoteEnvExists -notmatch "YES") {
        Write-Host "  Syncing .env (first deploy)..." -ForegroundColor Green
        if (-not (Copy-ToVPS $localEnv "$REMOTE_DIR/.env")) {
          throw "Failed to copy .env"
        }
        $changed += ".env"
      } else {
        Write-Host "  Remote .env exists, preserving" -ForegroundColor Yellow
      }
    } else {
      Write-Host "  No local .env found, skipping" -ForegroundColor Yellow
    }
  }

  # Generate version.json from local git
  Write-Host "  Generating version.json..." -ForegroundColor Green
  $gitCommit = git rev-parse HEAD 2>$null
  $gitBranch = git rev-parse --abbrev-ref HEAD 2>$null
  $gitRemote = git remote get-url origin 2>$null
  $deployTime = Get-Date -Format "o"

  $versionData = @{
    commit = $gitCommit
    branch = $gitBranch
    remote_url = $gitRemote
    deployed_at = $deployTime
  } | ConvertTo-Json

  $versionPath = Join-Path $PROJECT_DIR "version.json"
  # Write UTF-8 without BOM (PowerShell 5.1 Set-Content adds BOM by default)
  [System.IO.File]::WriteAllText($versionPath, $versionData, (New-Object System.Text.UTF8Encoding $false))

  if (-not (Copy-ToVPS $versionPath "$REMOTE_DIR/version.json")) {
    Write-Host "  Warning: Failed to sync version.json" -ForegroundColor Yellow
  }
  Remove-Item $versionPath -Force
  $changed += "version.json"

  # Fix data directory permissions if owned by root
  Write-Host "  Checking data directory permissions..." -ForegroundColor Yellow
  $dataOwner = Run-Remote "stat -c '%U:%G' $REMOTE_DIR/data/ 2>/dev/null || echo 'missing'"
  if ($dataOwner -match "root") {
    Write-Host "  Data directory owned by root, attempting fix..." -ForegroundColor Yellow
    # Try to fix permissions - this works if NOPASSWD includes chown or if running as initial user
    $fixResult = Run-Remote "sudo chown -R sidekick:sidekick $REMOTE_DIR/data/ 2>&1 && sudo chmod -R 755 $REMOTE_DIR/data/ 2>&1 && echo 'FIXED' || echo 'FAILED'"
    if ($fixResult -match "FIXED") {
      Write-Host "  Data directory permissions fixed" -ForegroundColor Green
    } else {
      Write-Host "  Warning: Could not fix data directory permissions automatically." -ForegroundColor Yellow
      Write-Host "  Run manually: sudo chown -R sidekick:sidekick $REMOTE_DIR/data/" -ForegroundColor Yellow
    }
  } else {
    Write-Host "  Data directory permissions OK ($dataOwner)" -ForegroundColor Green
  }

  Write-Host ""
  Write-Host "--- Installing Dependencies ---" -ForegroundColor Cyan
  Write-Host "  Running npm install..." -ForegroundColor Green
  $npmOutput = Run-Remote "cd $REMOTE_DIR && npm install --omit=dev 2>&1"
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
