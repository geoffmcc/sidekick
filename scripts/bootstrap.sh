#!/bin/bash
set -e

# Sidekick Bootstrap Script
# Prepares a fresh Ubuntu/Debian machine for Sidekick deployment
# Creates sidekick user, installs Node.js, sets up directories, optionally installs services

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default values
USERNAME="sidekick"
NODE_VERSION="22"
INSTALL_SERVICES=false
SSH_PUB_KEY=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --username)
      USERNAME="$2"
      shift 2
      ;;
    --node-version)
      NODE_VERSION="$2"
      shift 2
      ;;
    --install-services)
      INSTALL_SERVICES=true
      shift
      ;;
    --ssh-key)
      SSH_PUB_KEY="$2"
      shift 2
      ;;
    --yes)
      SKIP_CONFIRM=true
      shift
      ;;
    *)
      echo "Unknown parameter: $1"
      exit 1
      ;;
  esac
done

# Logging function
log() {
  echo -e "${GREEN}[BOOTSTRAP]${NC} $1"
}

warn() {
  echo -e "${YELLOW}[WARNING]${NC} $1"
}

error() {
  echo -e "${RED}[ERROR]${NC} $1"
  exit 1
}

# Check if running with sudo
if [ "$EUID" -ne 0 ]; then
  error "This script must be run with sudo privileges"
fi

log "Starting Sidekick bootstrap for user: $USERNAME"

# Detect OS
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
else
  error "Cannot detect OS. This script supports Ubuntu/Debian only."
fi

if [[ "$OS" != "ubuntu" && "$OS" != "debian" ]]; then
  error "Unsupported OS: $OS. This script supports Ubuntu/Debian only."
fi

log "Detected OS: $OS"

# Update package lists
log "Updating package lists..."
apt-get update -qq

# Install required packages
log "Installing required packages..."
apt-get install -y -qq curl ca-certificates gnupg build-essential python3 make g++ git > /dev/null

# Create user if doesn't exist
if id "$USERNAME" &>/dev/null; then
  log "User $USERNAME already exists"
else
  log "Creating user $USERNAME..."
  useradd -m -s /bin/bash "$USERNAME"
  log "User $USERNAME created"
fi

# Add user to sudo group
log "Adding $USERNAME to sudo group..."
usermod -aG sudo "$USERNAME"

# Setup sudoers for passwordless service management
log "Configuring sudoers..."
cat > /etc/sudoers.d/sidekick << 'EOF'
# Sidekick user permissions - allows service management without password
sidekick ALL=(ALL) NOPASSWD: /usr/bin/systemctl start sidekick-mcp, /usr/bin/systemctl stop sidekick-mcp, /usr/bin/systemctl restart sidekick-mcp, /usr/bin/systemctl status sidekick-mcp
sidekick ALL=(ALL) NOPASSWD: /usr/bin/systemctl start sidekick-dashboard, /usr/bin/systemctl stop sidekick-dashboard, /usr/bin/systemctl restart sidekick-dashboard, /usr/bin/systemctl status sidekick-dashboard
sidekick ALL=(ALL) NOPASSWD: /usr/bin/systemctl start sidekick-agent, /usr/bin/systemctl stop sidekick-agent, /usr/bin/systemctl restart sidekick-agent, /usr/bin/systemctl status sidekick-agent
sidekick ALL=(ALL) NOPASSWD: /usr/bin/journalctl -u sidekick-mcp, /usr/bin/journalctl -u sidekick-dashboard, /usr/bin/journalctl -u sidekick-agent
sidekick ALL=(ALL) NOPASSWD: /usr/sbin/ufw allow 4097/tcp, /usr/sbin/ufw allow 4098/tcp, /usr/sbin/ufw allow 4099/tcp
sidekick ALL=(ALL) NOPASSWD: /usr/bin/chown -R sidekick\:sidekick /home/sidekick/sidekick/data/, /usr/bin/chmod -R 755 /home/sidekick/sidekick/data/
EOF

chmod 440 /etc/sudoers.d/sidekick
log "Sudoers configured"

# Install Node.js if not present or wrong version
if command -v node &> /dev/null; then
  NODE_VER=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VER" -ge "$NODE_VERSION" ]; then
    log "Node.js $NODE_VER already installed (meets requirement of v$NODE_VERSION+)"
  else
    log "Node.js version $NODE_VER found, but v$NODE_VERSION+ required. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_$NODE_VERSION.x | bash - > /dev/null
    apt-get install -y -qq nodejs > /dev/null
    log "Node.js $(node --version) installed"
  fi
else
  log "Installing Node.js $NODE_VERSION..."
  curl -fsSL https://deb.nodesource.com/setup_$NODE_VERSION.x | bash - > /dev/null
  apt-get install -y -qq nodejs > /dev/null
  log "Node.js $(node --version) installed"
fi

# Setup SSH directory for sidekick user
log "Setting up SSH directory for $USERNAME..."
USER_HOME=$(eval echo ~$USERNAME)
mkdir -p "$USER_HOME/.ssh"
touch "$USER_HOME/.ssh/authorized_keys"
chmod 700 "$USER_HOME/.ssh"
chmod 600 "$USER_HOME/.ssh/authorized_keys"
chown -R "$USERNAME:$USERNAME" "$USER_HOME/.ssh"

# Install SSH key if provided
if [ -n "$SSH_PUB_KEY" ]; then
  log "Installing SSH key for $USERNAME..."
  echo "$SSH_PUB_KEY" >> "$USER_HOME/.ssh/authorized_keys"
  sort -u "$USER_HOME/.ssh/authorized_keys" -o "$USER_HOME/.ssh/authorized_keys"
  chown "$USERNAME:$USERNAME" "$USER_HOME/.ssh/authorized_keys"
  log "SSH key installed"
fi

log "SSH directory configured"

# Create application directories
log "Creating application directories..."
mkdir -p "$USER_HOME/sidekick/src"
mkdir -p "$USER_HOME/sidekick/data"
chown -R "$USERNAME:$USERNAME" "$USER_HOME/sidekick"
log "Directories created: $USER_HOME/sidekick/src, $USER_HOME/sidekick/data"

# Configure UFW if active
if command -v ufw &> /dev/null; then
  UFW_STATUS=$(ufw status | grep Status | awk '{print $2}')
  if [ "$UFW_STATUS" = "active" ]; then
    log "UFW is active, configuring firewall..."
    ufw allow 4097/tcp comment 'Sidekick MCP' > /dev/null
    ufw allow 4098/tcp comment 'Sidekick Dashboard' > /dev/null
    ufw allow 4099/tcp comment 'Sidekick Agent' > /dev/null
    log "Firewall ports opened: 4097, 4098, 4099"
  else
    warn "UFW is not active. Please ensure ports 4097, 4098, 4099 are open."
  fi
else
  warn "UFW not installed. Please ensure ports 4097, 4098, 4099 are open."
fi

# Install services if requested
if [ "$INSTALL_SERVICES" = true ]; then
  log "Installing systemd services..."
  
  # Check for service files in /tmp
  for svc in sidekick-mcp sidekick-dashboard sidekick-agent; do
    if [ -f "/tmp/$svc.service" ]; then
      cp "/tmp/$svc.service" "/etc/systemd/system/$svc.service"
      log "  Installed $svc.service"
    else
      warn "  Service file /tmp/$svc.service not found, skipping"
    fi
  done
  
  # Reload systemd and enable services
  systemctl daemon-reload
  log "Systemd daemon reloaded"
  
  for svc in sidekick-mcp sidekick-dashboard sidekick-agent; do
    if [ -f "/etc/systemd/system/$svc.service" ]; then
      systemctl enable "$svc"
      log "  Enabled $svc"
    fi
  done
  
  # Clean up temp files
  rm -f /tmp/sidekick-*.service
  
  log "Services installed and enabled"
fi

# Final verification
log "Verifying installation..."
if ! id "$USERNAME" &>/dev/null; then
  error "User $USERNAME not found after creation"
fi

if ! command -v node &> /dev/null; then
  error "Node.js not found after installation"
fi

if [ ! -d "$USER_HOME/sidekick" ]; then
  error "Application directory not created"
fi

if [ "$INSTALL_SERVICES" = true ]; then
  for svc in sidekick-mcp sidekick-dashboard sidekick-agent; do
    if [ ! -f "/etc/systemd/system/$svc.service" ]; then
      error "Service $svc not installed"
    fi
  done
fi

log "Bootstrap completed successfully!"
echo ""
if [ "$INSTALL_SERVICES" = true ]; then
  log "Next steps:"
  echo "  On your local machine, run: ./deploy.sh -IP YOUR_VM_IP"
  echo "  The deploy script will sync files and start the application."
else
  log "Next steps:"
  echo "  1. Exit this VM: exit"
  echo "  2. On your local machine, run: ./deploy.sh -IP YOUR_VM_IP"
  echo ""
  log "The deploy script will:"
  echo "  - Install Sidekick services"
  echo "  - Sync source files"
  echo "  - Start the application"
fi
echo ""
