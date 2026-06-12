#!/usr/bin/env bash
set -euo pipefail

IP="${1:-192.168.1.10}"
PASSWORD="${2:-}"

VPS="sidekick@$IP"
REMOTE_DIR="/home/sidekick/sidekick"
SSH_KEY="${SIDEKICK_SSH_KEY:-$HOME/.ssh/sidekick}"
SSH_PUB_KEY="$SSH_KEY.pub"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

SSH_OPTS="-o StrictHostKeyChecking=accept-new -o BatchMode=yes"

run_remote() { ssh -i "$SSH_KEY" $SSH_OPTS "$VPS" "$@" 2>&1; }
run_remote_interactive() { ssh -t -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$VPS" "$@" 2>&1; }
copy_to_vps() { scp -i "$SSH_KEY" $SSH_OPTS "$1" "$VPS:$2" 2>&1; }
restart_service() { echo -e "  \033[33mrestarting $1...\033[0m"; run_remote "sudo systemctl restart $1" >/dev/null; }

ensure_ssh_key() {
  if [ -f "$SSH_KEY" ]; then
    echo -e "  \033[90mSSH key found at $SSH_KEY\033[0m"
    return
  fi
  echo -e "  \033[33mGenerating SSH key...\033[0m"
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -q
  if [ ! -f "$SSH_KEY" ]; then
    echo -e "\033[31mERROR: Failed to generate SSH key\033[0m"
    exit 1
  fi
  echo -e "  \033[32mSSH key generated\033[0m"
}

test_ssh_connection() {
  local result
  result=$(ssh -i "$SSH_KEY" $SSH_OPTS -o ConnectTimeout=5 "$VPS" "echo OK" 2>&1) || true
  [[ "$result" == *"OK"* ]]
}

install_ssh_key() {
  echo ""
  echo -e "  \033[33mSSH key not installed on remote. Installing...\033[0m"

  local pub_key
  pub_key=$(cat "$SSH_PUB_KEY")

  if [ -n "$PASSWORD" ]; then
    echo -e "  \033[90mUsing provided password...\033[0m"
    local install_cmd="mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$pub_key' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_INSTALLED"
    local result
    result=$(ssh -o StrictHostKeyChecking=accept-new "$VPS" "echo '$PASSWORD' | sudo -S -u sidekick bash -c \"$install_cmd\"" 2>&1) || true
    if [[ "$result" == *"KEY_INSTALLED"* ]]; then return 0; fi
    return 1
  fi

  echo -e "  \033[36mEnter sidekick password when prompted to install SSH key:\033[0m"
  local install_cmd="mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$pub_key' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
  run_remote_interactive "$install_cmd"
}

test_sudo() {
  local result
  result=$(run_remote "sudo -n /usr/bin/systemctl status sidekick-mcp 2>&1 | head -1") || true
  [[ "$result" == *"sidekick-mcp.service"* ]]
}

initialize_remote() {
  echo ""
  echo -e "\033[36m=== Initializing remote server ===\033[0m"

  if ! test_sudo; then
    echo -e "  \033[33mSetting up sudoers configuration...\033[0m"

    local sudoers_local="$PROJECT_DIR/systemd/sidekick-sudoers"
    if [ ! -f "$sudoers_local" ]; then
      echo -e "\033[31mERROR: sudoers file not found at $sudoers_local\033[0m"
      exit 1
    fi

    copy_to_vps "$sudoers_local" "/tmp/sidekick-sudoers" >/dev/null

    if [ -n "$PASSWORD" ]; then
      echo -e "  \033[90mInstalling sudoers with provided password...\033[0m"
      run_remote "echo '$PASSWORD' | sudo -S cp /tmp/sidekick-sudoers /etc/sudoers.d/sidekick" >/dev/null
      run_remote "echo '$PASSWORD' | sudo -S chmod 440 /etc/sudoers.d/sidekick" >/dev/null
      run_remote "rm -f /tmp/sidekick-sudoers" >/dev/null
    else
      echo -e "  \033[36mEnter sidekick password when prompted to install sudoers:\033[0m"
      run_remote_interactive "sudo cp /tmp/sidekick-sudoers /etc/sudoers.d/sidekick && sudo chmod 440 /etc/sudoers.d/sidekick && rm -f /tmp/sidekick-sudoers"
    fi

    if ! test_sudo; then
      echo -e "\033[31mERROR: Sudoers setup failed\033[0m"
      exit 1
    fi
    echo -e "  \033[32mSudoers configured\033[0m"
  else
    echo -e "  \033[90mSudoers already configured\033[0m"
  fi

  echo -e "  \033[33mCreating remote directories...\033[0m"
  run_remote "mkdir -p $REMOTE_DIR/src $REMOTE_DIR/data" >/dev/null

  echo -e "  \033[33mChecking service files...\033[0m"
  services_need_install=false
  
  for svc in sidekick-mcp sidekick-dashboard sidekick-agent; do
    local exists
    exists=$(run_remote "test -f /etc/systemd/system/$svc.service && echo YES || echo NO") || true
    if [[ "$exists" != *"YES"* ]]; then
      services_need_install=true
      break
    fi
  done
  
  if [ "$services_need_install" = true ]; then
    echo -e "  \033[33mInstalling service files...\033[0m"
    for svc in sidekick-mcp sidekick-dashboard sidekick-agent; do
      local svc_local="$PROJECT_DIR/systemd/$svc.service"
      copy_to_vps "$svc_local" "/tmp/$svc.service" >/dev/null
      run_remote "sudo cp /tmp/$svc.service /etc/systemd/system/$svc.service && rm -f /tmp/$svc.service" >/dev/null
    done
  else
    echo -e "  \033[90mService files already installed\033[0m"
  fi

  echo -e "  \033[33mEnabling services...\033[0m"
  run_remote "sudo systemctl daemon-reload" >/dev/null
  for svc in sidekick-mcp sidekick-dashboard sidekick-agent; do
    run_remote "sudo systemctl enable $svc" >/dev/null
  done

  echo -e "  \033[33mChecking firewall...\033[0m"
  local ufw_active
  ufw_active=$(run_remote "systemctl is-active ufw 2>&1") || true
  if [[ "$ufw_active" == *"active"* ]]; then
    run_remote "sudo ufw allow 4097/tcp comment 'Sidekick MCP'" >/dev/null
    run_remote "sudo ufw allow 4098/tcp comment 'Sidekick Dashboard'" >/dev/null
    run_remote "sudo ufw allow 4099/tcp comment 'Sidekick Agent'" >/dev/null
    echo -e "  \033[32mFirewall ports opened (4097, 4098, 4099)\033[0m"
  else
    echo -e "  \033[33mUFW not active, skipping firewall config\033[0m"
  fi

  echo -e "  \033[32mRemote initialization complete\033[0m"
}

changed=()

echo -e "\033[36m=== Deploying Sidekick to $IP ===\033[0m"

echo ""
echo -e "\033[36m--- SSH Setup ---\033[0m"
ensure_ssh_key

if ! test_ssh_connection; then
  if ! install_ssh_key; then
    echo -e "\033[31mERROR: Failed to install SSH key on remote\033[0m"
    exit 1
  fi
  if ! test_ssh_connection; then
    echo -e "\033[31mERROR: SSH connection still fails after key install\033[0m"
    exit 1
  fi
  echo -e "  \033[32mSSH key installed successfully\033[0m"
else
  echo -e "  \033[32mSSH connection OK\033[0m"
fi

echo ""
echo -e "\033[36m--- Remote Setup ---\033[0m"
initialize_remote

echo ""
echo -e "\033[36m--- Deploying Files ---\033[0m"

echo -e "\033[32mSyncing source files...\033[0m"
for f in tools.js index.js dashboard.js agent.js redact.js; do
  if [ ! -f "$PROJECT_DIR/src/$f" ]; then
    echo -e "  \033[33mWarning: src/$f not found, skipping\033[0m"
    continue
  fi
  if ! copy_to_vps "$PROJECT_DIR/src/$f" "$REMOTE_DIR/src/$f" >/dev/null; then
    echo -e "\033[31mERROR: Failed to copy $f\033[0m"
    exit 1
  fi
  changed+=("$f")
done

if ! copy_to_vps "$PROJECT_DIR/package.json" "$REMOTE_DIR/package.json" >/dev/null; then
  echo -e "\033[31mERROR: Failed to copy package.json\033[0m"
  exit 1
fi
changed+=("package.json")

if [ -f "$PROJECT_DIR/.env" ]; then
  echo -e "\033[32mSyncing .env...\033[0m"
  if ! copy_to_vps "$PROJECT_DIR/.env" "$REMOTE_DIR/.env" >/dev/null; then
    echo -e "\033[31mERROR: Failed to copy .env\033[0m"
    exit 1
  fi
  changed+=(".env")
else
  echo -e "\033[33mNo local .env found, skipping\033[0m"
fi

echo ""
echo -e "\033[36m--- Installing Dependencies ---\033[0m"
echo -e "\033[32mRunning npm install...\033[0m"
if ! run_remote "cd $REMOTE_DIR && npm install --production 2>&1"; then
  echo -e "\033[31mERROR: npm install failed\033[0m"
  exit 1
fi

echo ""
echo -e "\033[36m--- Starting Services ---\033[0m"
restart_service "sidekick-mcp"
restart_service "sidekick-dashboard"
restart_service "sidekick-agent"

echo ""
echo -e "\033[36m=== Deploy complete ===\033[0m"
echo "Files synced: ${changed[*]}"
echo ""

for svc in sidekick-mcp sidekick-dashboard sidekick-agent; do
  status=$(run_remote "sudo systemctl status $svc 2>&1 | grep 'Active:' | awk '{print \$2}'") || true
  if [[ "$status" == *"active"* ]]; then
    echo -e "  \033[32m$svc : $status\033[0m"
  else
    echo -e "  \033[31m$svc : $status\033[0m"
  fi
done

echo ""
echo -e "\033[36mDashboard: http://$IP:4098\033[0m"
echo -e "\033[36mMCP:       http://$IP:4097/mcp\033[0m"
