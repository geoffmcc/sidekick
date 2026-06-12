#!/usr/bin/env bash
set -euo pipefail

# Parse arguments
IP="192.168.1.10"
INITIAL_USER=""

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
    *)
      echo "Unknown parameter: $1"
      echo "Usage: $0 [-IP <ip>] [-InitialUser <user>]"
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

# ControlMaster configuration for connection reuse
CONTROL_PATH="/tmp/sidekick-ssh-%r@%h:%p"
CONTROL_OPTS="-o ControlMaster=auto -o ControlPath=$CONTROL_PATH -o ControlPersist=60"

run_remote() { ssh -i "$SSH_KEY" $SSH_OPTS "$VPS" "$@" 2>&1; }
copy_to_vps() { scp -i "$SSH_KEY" $SSH_OPTS "$1" "$VPS:$2" 2>&1; }
restart_service() { echo -e "  \033[33mrestarting $1...\033[0m"; run_remote "sudo systemctl restart $1" >/dev/null; }

ensure_ssh_key() {
  if [ -f "$SSH_KEY" ]; then
    echo -e "  \033[90mSSH key found at $SSH_KEY\033[0m"
    # Verify public key exists
    if [ ! -f "$SSH_PUB_KEY" ]; then
      echo -e "  \033[33mPublic key missing, regenerating...\033[0m"
      rm -f "$SSH_KEY"
    else
      return
    fi
  fi
  echo -e "  \033[33mGenerating SSH key...\033[0m"
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -q
  if [ ! -f "$SSH_KEY" ] || [ ! -f "$SSH_PUB_KEY" ]; then
    echo -e "\033[31mERROR: Failed to generate SSH key at $SSH_KEY\033[0m"
    exit 1
  fi
  echo -e "  \033[32mSSH key generated\033[0m"
}

test_ssh_connection() {
  local result
  result=$(ssh -i "$SSH_KEY" $SSH_OPTS -o ConnectTimeout=5 "$VPS" "echo OK" 2>&1) || true
  [[ "$result" == *"OK"* ]]
}

test_sidekick_user_exists() {
  if ssh -i "$SSH_KEY" $SSH_OPTS -o ConnectTimeout=3 "$VPS" "echo OK" 2>/dev/null | grep -q "OK"; then
    return 0
  fi
  return 1
}

run_bootstrap() {
  local user="$1"
  
  echo ""
  echo -e "\033[36m=== Running Bootstrap ===\033[0m"
  echo -e "  \033[33mBootstrapping as $user@$IP...\033[0m"
  
  # Validate local files
  echo -e "  \033[90mValidating local files...\033[0m"
  local bootstrap_local="$PROJECT_DIR/scripts/bootstrap.sh"
  if [ ! -f "$bootstrap_local" ]; then
    echo -e "\033[31mERROR: Bootstrap script not found at $bootstrap_local\033[0m"
    exit 1
  fi
  
  if [ ! -f "$SSH_PUB_KEY" ]; then
    echo -e "\033[31mERROR: SSH public key not found at $SSH_PUB_KEY\033[0m"
    exit 1
  fi
  
  local pub_key
  pub_key=$(cat "$SSH_PUB_KEY")
  if [ -z "$pub_key" ]; then
    echo -e "\033[31mERROR: SSH public key is empty\033[0m"
    exit 1
  fi
  
  # Open control master connection (1 password prompt)
  echo -e "  \033[33mOpening SSH connection (1 password prompt)...\033[0m"
  echo -e "  \033[36mEnter password for $user@$IP when prompted:\033[0m"
  
  if ! ssh -o ControlMaster=yes -o ControlPath="$CONTROL_PATH" \
             -o ControlPersist=60 -o StrictHostKeyChecking=accept-new \
             -o ConnectTimeout=10 -N "$user@$IP" 2>&1; then
    echo -e "\033[31mERROR: Failed to establish SSH connection\033[0m"
    echo "Possible causes:"
    echo "  - Incorrect password"
    echo "  - User doesn't exist on remote"
    echo "  - Network connectivity issues"
    exit 1
  fi
  
  echo -e "  \033[32mSSH connection established\033[0m"
  
  # Upload files using control connection (no password prompts)
  echo -e "  \033[33mUploading bootstrap script...\033[0m"
  if ! scp -o ControlPath="$CONTROL_PATH" "$bootstrap_local" "$user@$IP:/tmp/bootstrap.sh" 2>&1; then
    echo -e "\033[31mERROR: Failed to upload bootstrap script\033[0m"
    ssh -o ControlPath="$CONTROL_PATH" -O exit "$user@$IP" 2>/dev/null
    exit 1
  fi
  echo -e "    \033[90m✓ bootstrap.sh\033[0m"
  
  echo -e "  \033[33mUploading service files...\033[0m"
  for svc in sidekick-mcp sidekick-dashboard sidekick-agent; do
    local svc_local="$PROJECT_DIR/systemd/$svc.service"
    if [ ! -f "$svc_local" ]; then
      echo -e "\033[31mERROR: Service file not found: $svc_local\033[0m"
      ssh -o ControlPath="$CONTROL_PATH" -O exit "$user@$IP" 2>/dev/null
      exit 1
    fi
    
    if ! scp -o ControlPath="$CONTROL_PATH" "$svc_local" "$user@$IP:/tmp/$svc.service" 2>&1; then
      echo -e "\033[31mERROR: Failed to upload $svc.service\033[0m"
      ssh -o ControlPath="$CONTROL_PATH" -O exit "$user@$IP" 2>/dev/null
      exit 1
    fi
    echo -e "    \033[90m✓ $svc.service\033[0m"
  done
  
  # Run bootstrap using control connection (no password prompt)
  echo -e "  \033[33mExecuting bootstrap...\033[0m"
  echo -e "\033[90m--- Bootstrap Output ---\033[0m"
  
  local bootstrap_cmd="sudo bash /tmp/bootstrap.sh --yes --install-services --ssh-key '$pub_key' && rm -f /tmp/bootstrap.sh /tmp/sidekick-*.service"
  
  if ! ssh -t -o ControlPath="$CONTROL_PATH" "$user@$IP" "$bootstrap_cmd"; then
    echo -e "\033[90m--- End Bootstrap Output ---\033[0m"
    echo -e "\033[31mERROR: Bootstrap execution failed\033[0m"
    ssh -o ControlPath="$CONTROL_PATH" -O exit "$user@$IP" 2>/dev/null
    exit 1
  fi
  
  echo -e "\033[90m--- End Bootstrap Output ---\033[0m"
  
  # Close control master connection
  ssh -o ControlPath="$CONTROL_PATH" -O exit "$user@$IP" 2>/dev/null
  
  # Verify sidekick user was created and SSH key installed
  echo -e "  \033[33mVerifying bootstrap...\033[0m"
  sleep 2
  
  if ssh -i "$SSH_KEY" $SSH_OPTS -o ConnectTimeout=5 "$VPS" "echo OK" 2>/dev/null | grep -q "OK"; then
    echo -e "  \033[32mBootstrap completed successfully\033[0m"
    return 0
  fi
  
  echo -e "\033[31mERROR: Bootstrap verification failed\033[0m"
  echo "Could not SSH as sidekick user. Check the bootstrap output above for errors."
  return 1
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
    echo ""
    echo -e "  \033[31mERROR: Services not found after bootstrap.\033[0m"
    echo -e "  \033[33mPlease run bootstrap with --install-services flag:\033[0m"
    echo -e "    \033[90msudo ./scripts/bootstrap.sh --install-services\033[0m"
    exit 1
  fi

  echo -e "  \033[32mServices verified\033[0m"

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
  
  # Get initial user - prompt if not provided
  if [ -z "$INITIAL_USER" ]; then
    read -rp "  Enter initial SSH user for $IP: " INITIAL_USER
    if [ -z "$INITIAL_USER" ]; then
      echo -e "\033[31mERROR: Initial user is required for bootstrap\033[0m"
      exit 1
    fi
  fi
  
  # Run bootstrap
  if ! run_bootstrap "$INITIAL_USER"; then
    echo -e "\033[31mERROR: Bootstrap failed\033[0m"
    exit 1
  fi
else
  echo -e "  \033[32mSidekick user found\033[0m"
fi

# Verify SSH connection
if ! test_ssh_connection; then
  echo -e "\033[31mERROR: SSH connection failed after bootstrap\033[0m"
  exit 1
fi
echo -e "  \033[32mSSH connection OK\033[0m"

echo ""
echo -e "\033[36m--- Remote Setup ---\033[0m"
initialize_remote

echo ""
echo -e "\033[36m--- Deploying Files ---\033[0m"

echo -e "\033[32mSyncing source files...\033[0m"
for f in tools.js index.js dashboard.js agent.js redact.js env.js; do
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
  remote_env_exists=$(run_remote "test -f $REMOTE_DIR/.env && echo YES || echo NO")
  if [ "$remote_env_exists" = "YES" ]; then
    echo -e "\033[33mRemote .env exists, skipping (preserves machine-specific settings)\033[0m"
  else
    echo -e "\033[32mSyncing .env (first deploy)...\033[0m"
    if ! copy_to_vps "$PROJECT_DIR/.env" "$REMOTE_DIR/.env" >/dev/null; then
      echo -e "\033[31mERROR: Failed to copy .env\033[0m"
      exit 1
    fi
    changed+=(".env")
  fi
else
  echo -e "\033[33mNo local .env found, skipping\033[0m"
fi

echo ""
echo -e "\033[36m--- Installing Dependencies ---\033[0m"
echo -e "\033[32mRunning npm install...\033[0m"
if ! run_remote "cd $REMOTE_DIR && npm install --omit=dev 2>&1"; then
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
