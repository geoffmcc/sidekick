#!/usr/bin/env bash
set -euo pipefail

# Parse arguments
IP="192.168.1.10"
INITIAL_USER=""
SCP_MODE=false
INSTALL_TOOLS=true

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
    --scp)
      SCP_MODE=true
      shift
      ;;
    --minimal)
      INSTALL_TOOLS=false
      shift
      ;;
    *)
      echo "Unknown parameter: $1"
      echo "Usage: $0 [-IP <ip>] [-InitialUser <user>] [--scp] [--minimal]"
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
  
  local bootstrap_flags="--yes --install-services"
  if [ "$INSTALL_TOOLS" = true ]; then
    bootstrap_flags="$bootstrap_flags --install-tools"
  fi
  
  local bootstrap_cmd="sudo bash /tmp/bootstrap.sh $bootstrap_flags --ssh-key '$pub_key' && rm -f /tmp/bootstrap.sh /tmp/sidekick-*.service"
  
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

repair_optional_tools() {
  if [ "$INSTALL_TOOLS" != true ]; then
    echo -e "\033[33mSkipping optional server tools (--minimal)\033[0m"
    return 0
  fi

  echo ""
  echo -e "\033[36m--- Repairing Optional Server Tools ---\033[0m"
  local setup_exists
  setup_exists=$(run_remote "test -f $REMOTE_DIR/scripts/setup-tools.sh && echo YES || echo NO") || true
  if [[ "$setup_exists" != *"YES"* ]]; then
    echo -e "\033[33mOptional tools setup script not present on remote; skipping repair.\033[0m"
    echo -e "\033[33mRe-run deploy after the repository is synced, or use git deploy mode.\033[0m"
    return 0
  fi

  echo -e "\033[32mRunning setup-tools.sh to install/repair optional tooling...\033[0m"
  if ! run_remote "cd $REMOTE_DIR && sudo -n bash scripts/setup-tools.sh 2>&1"; then
    echo -e "\033[33mOptional server tools repair was skipped because sudo requires an interactive password.\033[0m"
    echo -e "\033[33mNormal app deploy will continue.\033[0m"
    echo -e "\033[33mTo repair optional tools, SSH into the server and run:\033[0m"
    echo -e "\033[33m  cd /home/sidekick/sidekick && sudo bash scripts/setup-tools.sh\033[0m"
    return 0
  fi
  changed+=("optional-tools")
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
  run_remote "mkdir -p $REMOTE_DIR/src $REMOTE_DIR/scripts $REMOTE_DIR/docs $REMOTE_DIR/migrations $REMOTE_DIR/data" >/dev/null

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

if [ "$SCP_MODE" = true ]; then
  echo -e "\033[33mSCP mode: syncing files individually (airgap/offline)\033[0m"

  echo -e "\033[32mSyncing source files...\033[0m"
  for f in tools.js index.js dashboard.js agent.js memory.js redact.js env.js db.js pg.js redis.js qdrant.js crypto-utils.js; do
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

  if [ -f "$PROJECT_DIR/src/dashboard.html" ]; then
    if ! copy_to_vps "$PROJECT_DIR/src/dashboard.html" "$REMOTE_DIR/src/dashboard.html" >/dev/null; then
      echo -e "\033[31mERROR: Failed to copy dashboard.html\033[0m"
      exit 1
    fi
    changed+=("src/dashboard.html")
  fi

  for f in dashboard.js dashboard.css; do
    if [ ! -f "$PROJECT_DIR/static/$f" ]; then
      echo -e "  \033[33mWarning: static/$f not found, skipping\033[0m"
      continue
    fi
    if ! copy_to_vps "$PROJECT_DIR/static/$f" "$REMOTE_DIR/static/$f" >/dev/null; then
      echo -e "\033[31mERROR: Failed to copy static/$f\033[0m"
      exit 1
    fi
    changed+=("static/$f")
  done

  if ! copy_to_vps "$PROJECT_DIR/package.json" "$REMOTE_DIR/package.json" >/dev/null; then
    echo -e "\033[31mERROR: Failed to copy package.json\033[0m"
    exit 1
  fi
  changed+=("package.json")

  if ! copy_to_vps "$PROJECT_DIR/scripts/seed-knowledge.js" "$REMOTE_DIR/scripts/seed-knowledge.js" >/dev/null; then
    echo -e "\033[31mERROR: Failed to copy seed-knowledge.js\033[0m"
    exit 1
  fi
  changed+=("seed-knowledge.js")

  if ! copy_to_vps "$PROJECT_DIR/docs/knowledge-seed.sql" "$REMOTE_DIR/docs/knowledge-seed.sql" >/dev/null; then
    echo -e "\033[31mERROR: Failed to copy knowledge-seed.sql\033[0m"
    exit 1
  fi
  changed+=("knowledge-seed.sql")

  for migration in "$PROJECT_DIR"/migrations/*.sql; do
    if [ -f "$migration" ]; then
      name=$(basename "$migration")
      if ! copy_to_vps "$migration" "$REMOTE_DIR/migrations/$name" >/dev/null; then
        echo -e "\033[31mERROR: Failed to copy migration $name\033[0m"
        exit 1
      fi
      changed+=("migrations/$name")
    fi
  done

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
else
  echo -e "\033[32mGit deploy mode\033[0m"

  # Detect repo URL from local git remote, fallback to main repo
  REPO_URL=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || echo "https://github.com/geoffmcc/sidekick.git")

  # Check if remote already has a git repo
  remote_has_git=$(run_remote "test -d $REMOTE_DIR/.git && echo YES || echo NO" 2>/dev/null) || true

  if [[ "$remote_has_git" == *"YES"* ]]; then
    echo -e "  \033[33mPulling latest changes...\033[0m"
    if ! run_remote "cd $REMOTE_DIR && git pull --ff-only 2>&1"; then
      echo -e "\033[31mERROR: git pull failed\033[0m"
      exit 1
    fi
  else
    echo -e "  \033[33mCloning repository...\033[0m"
    # Backup existing data and .env before replacing with git clone
    echo -e "  \033[33mBacking up existing data...\033[0m"
    run_remote "mkdir -p /tmp/sidekick-backup && cp -r $REMOTE_DIR/data /tmp/sidekick-backup/ 2>/dev/null; cp $REMOTE_DIR/.env /tmp/sidekick-backup/ 2>/dev/null; echo DONE" >/dev/null 2>&1 || true
    
    # Remove existing directory (git clone requires empty or non-existent dir)
    echo -e "  \033[33mRemoving old deployment directory...\033[0m"
    if ! run_remote "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR" >/dev/null 2>&1; then
      echo -e "\033[31mERROR: Failed to remove old directory\033[0m"
      exit 1
    fi
    
    # Clone fresh
    if ! run_remote "git clone '$REPO_URL' $REMOTE_DIR 2>&1"; then
      echo -e "\033[31mERROR: git clone failed\033[0m"
      echo -e "\033[33mBackup preserved at /tmp/sidekick-backup/ on remote\033[0m"
      exit 1
    fi
    
    # Restore data and .env from backup
    echo -e "  \033[33mRestoring data and .env from backup...\033[0m"
    run_remote "cp -r /tmp/sidekick-backup/data $REMOTE_DIR/ 2>/dev/null; cp /tmp/sidekick-backup/.env $REMOTE_DIR/ 2>/dev/null; echo DONE" >/dev/null 2>&1 || true
    
    # Cleanup backup on success
    run_remote "rm -rf /tmp/sidekick-backup" >/dev/null 2>&1 || true
    echo -e "  \033[32mBackup cleaned up\033[0m"
  fi
  changed+=("git")

  # Handle .env on first deploy
  if [ -f "$PROJECT_DIR/.env" ]; then
    remote_env_exists=$(run_remote "test -f $REMOTE_DIR/.env && echo YES || echo NO")
    if [ "$remote_env_exists" != "YES" ]; then
      echo -e "\033[32mSyncing .env (first deploy)...\033[0m"
      if ! copy_to_vps "$PROJECT_DIR/.env" "$REMOTE_DIR/.env" >/dev/null; then
        echo -e "\033[31mERROR: Failed to copy .env\033[0m"
        exit 1
      fi
      changed+=(".env")
    else
      echo -e "\033[33mRemote .env exists, preserving\033[0m"
    fi
  else
    echo -e "\033[33mNo local .env found, skipping\033[0m"
  fi
fi

repair_optional_tools

echo ""
echo -e "\033[36m--- Installing Dependencies ---\033[0m"
echo -e "\033[32mRunning npm install...\033[0m"
if ! run_remote "cd $REMOTE_DIR && npm install --omit=dev --no-package-lock 2>&1"; then
  echo -e "\033[31mERROR: npm install failed\033[0m"
  exit 1
fi

echo ""
echo -e "\033[36m--- Seeding Knowledge Base ---\033[0m"
seed_available=$(run_remote "cd $REMOTE_DIR && npm run 2>/dev/null | grep -q 'seed:knowledge' && echo YES || echo NO") || true
if [[ "$seed_available" == *"YES"* ]]; then
  if ! run_remote "cd $REMOTE_DIR && npm run seed:knowledge 2>&1"; then
    echo -e "\033[31mERROR: knowledge seed failed\033[0m"
    exit 1
  fi
else
  echo -e "\033[33mKnowledge seed script not present on remote; skipping. Commit/push this change or use --scp to seed automatically.\033[0m"
fi

echo ""
echo -e "\033[36m--- Starting Services ---\033[0m"
restart_service "sidekick-agent"
restart_service "sidekick-dashboard"
restart_service "sidekick-mcp"

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
