param(
  [switch]$Force
)

$VPS = "sidekick@64.176.216.202"
$REMOTE_DIR = "/home/sidekick/mcp-sidekick"
$SSH_KEY = "/root/.ssh/sidekick"
$WSL = "wsl -d Ubuntu -u root"

function Run-Remote { param([string]$Cmd) & $WSL -- ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes $VPS $Cmd 2>&1 }

function Copy-ToVPS { param([string]$Local, [string]$Remote) & $WSL -- sh -c "scp -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes '$Local' $VPS`:$Remote 2>&1" }

function Restart-Service { param([string]$Name) Write-Host "  restarting $Name..." -ForegroundColor Yellow; Run-Remote "sudo systemctl restart $Name" | Out-Null }

$changed = @()

Write-Host "=== Deploying Sidekick ===" -ForegroundColor Cyan

# Sync src files
Write-Host "Syncing source files..." -ForegroundColor Green
Copy-ToVPS "C:\Users\geoffrey\Projects\sidekick\src\index.js" "$REMOTE_DIR/src/index.js"
$changed += "index.js"
Copy-ToVPS "C:\Users\geoffrey\Projects\sidekick\src\dashboard.js" "$REMOTE_DIR/src/dashboard.js"
$changed += "dashboard.js"

# agent.js may not exist on VPS yet
Copy-ToVPS "C:\Users\geoffrey\Projects\sidekick\src\agent.js" "$REMOTE_DIR/src/agent.js"
$changed += "agent.js"

# Sync package.json if changed
Copy-ToVPS "C:\Users\geoffrey\Projects\sidekick\package.json" "$REMOTE_DIR/package.json"
$changed += "package.json"

# Run npm install on VPS if package.json changed
Write-Host "Running npm install on VPS..." -ForegroundColor Green
Run-Remote "cd $REMOTE_DIR && npm install 2>&1" | Out-Null

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
  Run-Remote "sudo tee /etc/systemd/system/sidekick-agent.service > /dev/null << 'UNIT'
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
Environment=NODE_ENV=production
Environment=SIDEKICK_AGENT_PORT=4099
Environment=SIDEKICK_DATA_DIR=$REMOTE_DIR/data

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable sidekick-agent
sudo systemctl start sidekick-agent" | Out-Null
}

# Open UFW port if needed
$ufwCheck = Run-Remote "sudo ufw status | grep 4099"
if ($ufwCheck -notmatch "4099") {
  Write-Host "  opening UFW port 4099..." -ForegroundColor Yellow
  Run-Remote "sudo ufw allow 4099/tcp comment 'Sidekick Agent Bridge'" | Out-Null
}

Write-Host ""
Write-Host "=== Deploy complete ===" -ForegroundColor Cyan
Write-Host "Files synced: $($changed -join ', ')"
Write-Host ""

# Check service statuses
foreach ($svc in @("sidekick-mcp", "sidekick-dashboard", "sidekick-agent")) {
  $status = Run-Remote "sudo systemctl is-active $svc"
  $color = if ($status -match "active") { "Green" } else { "Red" }
  Write-Host ("  $svc : ".PadRight(30)) -NoNewline
  Write-Host $status -ForegroundColor $color
}
