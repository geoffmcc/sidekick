#!/usr/bin/env bash
set -euo pipefail

VPS="sidekick@149.28.229.13"
REMOTE_DIR="/home/sidekick/mcp-sidekick"
SSH_KEY="${SIDEKICK_SSH_KEY:-$HOME/.ssh/sidekick}"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

run_remote() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$VPS" "$@" 2>&1; }
copy_to_vps() { scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$PROJECT_DIR/$1" "$VPS:$2"; }
restart_service() { echo -e "  \033[33mrestarting $1...\033[0m"; run_remote "sudo systemctl restart $1" >/dev/null; }

changed=()

echo -e "\033[36m=== Deploying Sidekick ===\033[0m"

# Sync src files
echo -e "\033[32mSyncing source files...\033[0m"
for f in tools.js index.js dashboard.js agent.js; do
  copy_to_vps "src/$f" "$REMOTE_DIR/src/$f"
  changed+=("$f")
done

# Sync package.json
copy_to_vps "package.json" "$REMOTE_DIR/package.json"
changed+=("package.json")

# Sync .env if it exists
if [ -f "$PROJECT_DIR/.env" ]; then
  echo -e "\033[32mSyncing .env...\033[0m"
  copy_to_vps ".env" "$REMOTE_DIR/.env"
  changed+=(".env")
else
  echo -e "\033[33mNo local .env found, skipping env sync\033[0m"
fi

# npm install
echo -e "\033[32mRunning npm install on VPS...\033[0m"
run_remote "cd $REMOTE_DIR && npm install 2>&1" >/dev/null

# Restart services
echo -e "\033[32mRestarting services...\033[0m"
restart_service "sidekick-mcp"
restart_service "sidekick-dashboard"

# Agent service: restart if exists, create if not
if run_remote "test -f /etc/systemd/system/sidekick-agent.service"; then
  restart_service "sidekick-agent"
else
  echo -e "\033[33m  creating sidekick-agent service...\033[0m"
  run_remote "sudo tee /etc/systemd/system/sidekick-agent.service > /dev/null << 'UNIT'
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
UNIT
sudo systemctl daemon-reload
sudo systemctl enable sidekick-agent
sudo systemctl start sidekick-agent" >/dev/null
fi

# UFW port check
if ! run_remote "sudo ufw status | grep -q 4099"; then
  echo -e "\033[33m  opening UFW port 4099...\033[0m"
  run_remote "sudo ufw allow 4099/tcp comment 'Sidekick Agent Bridge'" >/dev/null
fi

echo ""
echo -e "\033[36m=== Deploy complete ===\033[0m"
echo "Files synced: ${changed[*]}"
echo ""

# Service status
for svc in sidekick-mcp sidekick-dashboard sidekick-agent; do
  status=$(run_remote "sudo systemctl is-active $svc")
  if [ "$status" = "active" ]; then
    echo -e "  \033[32m$svc : $status\033[0m"
  else
    echo -e "  \033[31m$svc : $status\033[0m"
  fi
done
