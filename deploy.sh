#!/usr/bin/env bash
set -euo pipefail

# Parse arguments
IP="192.168.1.10"
INITIAL_USER=""
INITIAL_PASSWORD="${SIDEKICK_INITIAL_PASSWORD:-}"

while [[ $# -gt 0 ]]; do
  case $1 in
    -IP|--ip)
      IP="$2"
      shift 2
      ;;
    -InitialUser|--initial-user)
      INITIAL_USER="$2"
      shift 2
      ;;
    -Password|--password)
      INITIAL_PASSWORD="$2"
      shift 2
      ;;
    *)
      echo "Unknown parameter: $1"
      echo "Usage: $0 [-IP <ip>] [-InitialUser <user>] [-Password <password>]"
      exit 1
      ;;
  esac
done

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

detect_initial_user() {
  # Try common default users
  for user in ubuntu admin root; do
    if ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=3 "$user@$IP" "echo OK" 2>/dev/null | grep -q "OK"; then
      echo "$user"
      return 0
    fi
  done
  return 1
}

test_sidekick_user_exists() {
  # Try to SSH as sidekick user
  if ssh -i "$SSH_KEY" $SSH_OPTS -o ConnectTimeout=3 "$VPS" "echo OK" 2>/dev/null | grep -q "OK"; then
    return 0
  fi
  return 1
}

run_bootstrap() {
  echo ""
  echo -e "\033[36m=== Running Bootstrap ===\033[0m"
  
  local user="$1"
  local password="$2"
  
  echo -e "  \033[33mBootstrapping as $user@$IP...\033[0m"
  
  # Copy bootstrap script to remote
  local bootstrap_local="$PROJECT_DIR/scripts/bootstrap.sh"
  if [ ! -f "$bootstrap_local" ]; then
    echo -e "\033[31mERROR: Bootstrap script not found at $bootstrap_local\033[0m"
    exit 1
  fi
  
  echo -e "  \033[33mUploading bootstrap script...\033[0m"
  if [ -n "$password" ]; then
    scp -o StrictHostKeyChecking=accept-new "$bootstrap_local" "$user@$IP:/tmp/bootstrap.sh" <<< "$password" >/dev/null 2>&1 || {
      # Try with sshpass if available
      if command -v sshpass &> /dev/null; then
        sshpass -p "$password" scp -o StrictHostKeyChecking=accept-new "$bootstrap_local" "$user@$IP:/tmp/bootstrap.sh" >/dev/null 2>&1
      else
        echo -e "\033[31mERROR: Failed to copy bootstrap script. Install sshpass or use SSH key authentication.\033[0m"
        exit 1
      fi
    }
  else
    scp -o StrictHostKeyChecking=accept-new "$bootstrap_local" "$user@$IP:/tmp/bootstrap.sh" >/dev/null 2>&1
  fi
  
  echo -e "  \033[33mExecuting bootstrap script...\033[0m"
  if [ -n "$password" ]; then
    # Use sshpass if available for non-interactive execution
    if command -v sshpass &> /dev/null; then
      sshpass -p "$password" ssh -o StrictHostKeyChecking=accept-new "$user@$IP" "echo '$password' | sudo -S bash /tmp/bootstrap.sh --yes && rm /tmp/bootstrap.sh" 2>&1 | grep -E "\[BOOTSTRAP\]|\[WARNING\]|\[ERROR\]" || true
    else
      echo -e "  \033[36mEnter $user password when prompted:\033[0m"
      ssh -o StrictHostKeyChecking=accept-new "$user@$IP" "sudo bash /tmp/bootstrap.sh --yes && rm /tmp/bootstrap.sh" 2>&1 | grep -E "\[BOOTSTRAP\]|\[WARNING\]|\[ERROR\]" || true
    fi
  else
    ssh -o StrictHostKeyChecking=accept-new "$user@$IP" "sudo bash /tmp/bootstrap.sh --yes && rm /tmp/bootstrap.sh" 2>&1 | grep -E "\[BOOTSTRAP\]|\[WARNING\]|\[ERROR\]" || true
  fi
  
  # Verify sidekick user was created
  echo -e "  \033[33mVerifying bootstrap...\033[0m"
  sleep 2
  
  # Try to SSH as sidekick user to verify
  if ssh -i "$SSH_KEY" $SSH_OPTS -o ConnectTimeout=5 "$VPS" "echo OK" 2>/dev/null | grep -q "OK"; then
    echo -e "  \033[32mBootstrap completed successfully\033[0m"
    return 0
  fi
  
  # If SSH key auth doesn't work yet, we need to copy the key
  echo -e "  \033[33mCopying SSH key to sidekick user...\033[0m"
  local pub_key
  pub_key=$(cat "$SSH_PUB_KEY")
  
  if [ -n "$password" ]; then
    if command -v sshpass &> /dev/null; then
      sshpass -p "$password" ssh -o StrictHostKeyChecking=accept-new "$user@$IP" "sudo -u sidekick bash -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo \"$pub_key\" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'" >/dev/null 2>&1
    else
      echo -e "  \033[36mEnter $user password when prompted:\033[0m"
      ssh -o StrictHostKeyChecking=accept-new "$user@$IP" "sudo -u sidekick bash -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo \"$pub_key\" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'" >/dev/null 2>&1
    fi
  else
    ssh -o StrictHostKeyChecking=accept-new "$user@$IP" "sudo -u sidekick bash -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo \"$pub_key\" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'" >/dev/null 2>&1
  fi
  
  # Verify SSH key installation
  if ssh -i "$SSH_KEY" $SSH_OPTS -o ConnectTimeout=5 "$VPS" "echo OK" 2>/dev/null | grep -q "OK"; then
    echo -e "  \033[32mSSH key installed successfully\033[0m"
    echo -e "  \033[32mBootstrap completed successfully\033[0m"
    return 0
  fi
  
  echo -e "\033[31mERROR: Bootstrap verification failed\033[0m"
  return 1
}

install_ssh_key() {
  echo ""
  echo -e "  \033[33mSSH key not installed on remote. Installing...\033[0m"

  local pub_key
  pub_key=$(cat "$SSH_PUB_KEY")

  if [ -n "$INITIAL_PASSWORD" ]; then
    echo -e "  \033[90mUsing provided password...\033[0m"
    local install_cmd="mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$pub_key' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_INSTALLED"
    local result
    result=$(ssh -o StrictHostKeyChecking=accept-new "$VPS" "echo '$INITIAL_PASSWORD' | sudo -S -u sidekick bash -c \"$install_cmd\"" 2>&1) || true
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

test_services_exist() {
  for svc in sidekick-mcp sidekick-dashboard sidekick-agent; do
    local exists
    exists=$(run_remote "test -f /etc/systemd/system/$svc.service && echo YES || echo NO") || true
    if [[ "$exists" != *"YES"* ]]; then
      return 1
    fi
  done
  return 0
}

initialize_remote() {
  echo ""
  echo -e "\033[36m=== Initializing remote server ===\033[0m"

  echo -e "  \033[33mChecking if services are already installed...\033[0m"
  if ! test_services_exist; then
    echo -e "  \033[33mFirst-time setup detected...\033[0m"

    # Setup sudoers if needed
    if ! test_sudo; then
      echo -e "  \033[33mSetting up sudoers configuration...\033[0m"

      local sudoers_local="$PROJECT_DIR/systemd/sidekick-sudoers"
      if [ ! -f "$sudoers_local" ]; then
        echo -e "\033[31mERROR: sudoers file not found at $sudoers_local\033[0m"
        exit 1
      fi

      copy_to_vps "$sudoers_local" "/tmp/sidekick-sudoers" >/dev/null

      if [ -n "$INITIAL_PASSWORD" ]; then
        echo -e "  \033[90mInstalling sudoers with provided password...\033[0m"
        run_remote "echo '$INITIAL_PASSWORD' | sudo -S cp /tmp/sidekick-sudoers /etc/sudoers.d/sidekick" >/dev/null
        run_remote "echo '$INITIAL_PASSWORD' | sudo -S chmod 440 /etc/sudoers.d/sidekick" >/dev/null
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

    # Copy all service files to /tmp first (no password needed)
    echo -e "  \033[33mUploading service files...\033[0m"
    for svc in sidekick-mcp sidekick-dashboard sidekick-agent; do
      local svc_local="$PROJECT_DIR/systemd/$svc.service"
      copy_to_vps "$svc_local" "/tmp/$svc.service" >/dev/null
    done

    # Batch all privileged operations into a single interactive session
    echo -e "  \033[33mInstalling and enabling services...\033[0m"
    
    # Build the command to install all services
    local install_cmd="sudo cp /tmp/sidekick-mcp.service /tmp/sidekick-dashboard.service /tmp/sidekick-agent.service /etc/systemd/system/"
    install_cmd+=" && sudo systemctl daemon-reload"
    install_cmd+=" && sudo systemctl enable sidekick-mcp sidekick-dashboard sidekick-agent"
    install_cmd+=" && rm -f /tmp/sidekick-*.service"
    
    # Check if UFW is active and add firewall commands if needed
    local ufw_active
    ufw_active=$(run_remote "systemctl is-active ufw 2>&1") || true
    if [[ "$ufw_active" == *"active"* ]]; then
      install_cmd+=" && sudo ufw allow 4097/tcp comment 'Sidekick MCP'"
      install_cmd+=" && sudo ufw allow 4098/tcp comment 'Sidekick Dashboard'"
      install_cmd+=" && sudo ufw allow 4099/tcp comment 'Sidekick Agent'"
    fi

    if [ -n "$INITIAL_PASSWORD" ]; then
      # Use password for all operations
      local password_cmd="${install_cmd//sudo/echo '$INITIAL_PASSWORD' | sudo -S}"
      run_remote "$password_cmd" >/dev/null
    else
      # Use interactive password prompt (single prompt for all operations)
      run_remote_interactive "$install_cmd" >/dev/null
    fi

    # Verify services were installed
    if ! test_services_exist; then
      echo -e "\033[31mERROR: Service installation failed - services not found after setup\033[0m"
      exit 1
    fi

    if [[ "$ufw_active" == *"active"* ]]; then
      echo -e "  \033[32mFirewall ports opened (4097, 4098, 4099)\033[0m"
    else
      echo -e "  \033[33mUFW not active, skipping firewall config\033[0m"
    fi

    echo -e "  \033[32mFirst-time setup complete\033[0m"
  else
    echo -e "  \033[90mServices already installed, skipping setup\033[0m"
  fi

  echo -e "  \033[33mCreating remote directories...\033[0m"
  run_remote "mkdir -p $REMOTE_DIR/src $REMOTE_DIR/data" >/dev/null

  echo -e "  \033[32mRemote initialization complete\033[0m"
}

changed=()

echo -e "\033[36m=== Deploying Sidekick to $IP ===\033[0m"

echo ""
echo -e "\033[36m--- SSH Setup ---\033[0m"
ensure_ssh_key

# Check if sidekick user exists
echo -e "  \033[33mChecking for sidekick user...\033[0m"
if ! test_sidekick_user_exists; then
  echo -e "  \033[33mSidekick user not found. Bootstrap required.\033[0m"
  
  # Detect or use provided initial user
  if [ -z "$INITIAL_USER" ]; then
    echo -e "  \033[33mDetecting initial user...\033[0m"
    INITIAL_USER=$(detect_initial_user) || {
      echo -e "\033[31mERROR: Could not detect initial user. Use -InitialUser parameter.\033[0m"
      exit 1
    }
    echo -e "  \033[32mDetected initial user: $INITIAL_USER\033[0m"
  fi
  
  # Run bootstrap
  if ! run_bootstrap "$INITIAL_USER" "$INITIAL_PASSWORD"; then
    echo -e "\033[31mERROR: Bootstrap failed\033[0m"
    exit 1
  fi
else
  echo -e "  \033[32mSidekick user found\033[0m"
fi

# Test SSH connection to sidekick user
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
