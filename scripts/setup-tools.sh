#!/bin/bash
set -e

# Sidekick Server Tooling Setup
# Installs the full tool stack for Sidekick: Docker, databases, media tools,
# development tools, and creates systemd wrappers for Docker-based services.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

USERNAME="sidekick"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/lib/apt-repository.sh"
source "$SCRIPT_DIR/lib/install-ollama.sh"
source "$SCRIPT_DIR/lib/polkit.sh"
source "$SCRIPT_DIR/lib/sudoers.sh"
source "$SCRIPT_DIR/lib/bubblewrap.sh"

PASS=0
FAIL=0
SKIP=0

log()  { echo -e "${GREEN}[SETUP]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; }
info() { echo -e "${BLUE}[INFO]${NC} $1"; }

pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}✓${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}✗${NC} $1"; }
skip() { SKIP=$((SKIP + 1)); echo -e "  ${YELLOW}→${NC} $1 (already installed)"; }

if [ "$EUID" -ne 0 ]; then
  err "This script must be run with sudo privileges"
  exit 1
fi

echo ""
echo "========================================="
echo "  Sidekick Server Tooling Setup"
echo "========================================="
echo ""

# ─────────────────────────────────────────────
# Phase 1: Foundation packages
# ─────────────────────────────────────────────
log "Phase 1: Installing foundation packages..."

apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg polkitd sudo bubblewrap util-linux

# pip3
if command -v pip3 &>/dev/null; then
  skip "pip3 $(pip3 --version 2>/dev/null | awk '{print $2}')"
else
  apt-get install -y -qq python3-pip python3-venv
  pass "pip3 installed"
fi

# ripgrep
if command -v rg &>/dev/null; then
  skip "ripgrep $(rg --version | head -1)"
else
  apt-get install -y -qq ripgrep
  pass "ripgrep installed"
fi

# sqlite3
if command -v sqlite3 &>/dev/null; then
  skip "sqlite3 $(sqlite3 --version)"
else
  apt-get install -y -qq sqlite3
  pass "sqlite3 installed"
fi

# htop, tmux (usually present but verify)
for pkg in htop tmux jq zstd; do
  if command -v "$pkg" &>/dev/null; then
    skip "$pkg"
  else
    apt-get install -y -qq "$pkg"
    pass "$pkg installed"
  fi
done

echo ""

# ─────────────────────────────────────────────
# Phase 2: Docker
# ─────────────────────────────────────────────
log "Phase 2: Installing Docker..."

if command -v docker &>/dev/null; then
  skip "Docker $(docker --version | awk '{print $3}')"
else
  . /etc/os-release
  case "$ID" in
    ubuntu|debian) DOCKER_DISTRO="$ID" ;;
    *) err "Docker repository setup supports Ubuntu and Debian only (found: $ID)"; exit 1 ;;
  esac
  DOCKER_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
  if [[ ! "$DOCKER_CODENAME" =~ ^[a-z0-9][a-z0-9.-]*$ ]]; then
    err "Could not determine a safe Docker repository codename"; exit 1
  fi
  install_verified_apt_key \
    "https://download.docker.com/linux/${DOCKER_DISTRO}/gpg" \
    "/etc/apt/keyrings/docker.gpg" \
    "9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/${DOCKER_DISTRO}
Suites: ${DOCKER_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.gpg
EOF
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  pass "Docker installed"
fi

# Add sidekick user to docker group
if id -nG "$USERNAME" | grep -qw docker; then
  skip "$USERNAME in docker group"
else
  usermod -aG docker "$USERNAME"
  pass "$USERNAME added to docker group"
fi

# Enable Docker on boot
systemctl enable docker 2>/dev/null
pass "Docker enabled on boot"

# Install Docker Compose plugin
if docker compose version &>/dev/null; then
  skip "Docker Compose $(docker compose version --short)"
else
  apt-get install -y -qq docker-compose-plugin
  pass "Docker Compose plugin installed"
fi

echo ""

# ─────────────────────────────────────────────
# Phase 3: Development tools
# ─────────────────────────────────────────────
log "Phase 3: Installing development tools..."

# Go
if command -v go &>/dev/null; then
  skip "Go $(go version | awk '{print $3}')"
else
  apt-get install -y -qq golang-go
  pass "Go installed"
fi

# build-essential, git
for pkg in build-essential git; do
  if dpkg -l "$pkg" &>/dev/null; then
    skip "$pkg"
  else
    apt-get install -y -qq "$pkg"
    pass "$pkg installed"
  fi
done

echo ""

# ─────────────────────────────────────────────
# Phase 4: Media & document tools
# ─────────────────────────────────────────────
log "Phase 4: Installing media & document tools..."

# ffmpeg
if command -v ffmpeg &>/dev/null; then
  skip "ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"
else
  apt-get install -y -qq ffmpeg
  pass "ffmpeg installed"
fi

# ImageMagick
if command -v convert &>/dev/null; then
  skip "ImageMagick $(convert --version 2>/dev/null | head -1 | awk '{print $3}')"
else
  apt-get install -y -qq imagemagick
  pass "ImageMagick installed"
fi

# pandoc
if command -v pandoc &>/dev/null; then
  skip "pandoc $(pandoc --version | head -1 | awk '{print $2}')"
else
  apt-get install -y -qq pandoc
  pass "pandoc installed"
fi

# LaTeX (minimal for PDF generation)
if command -v pdflatex &>/dev/null; then
  skip "pdflatex"
else
  apt-get install -y -qq texlive-latex-base texlive-latex-recommended
  pass "LaTeX installed"
fi

# Tesseract OCR
if command -v tesseract &>/dev/null; then
  skip "Tesseract $(tesseract --version 2>&1 | head -1 | awk '{print $2}')"
else
  apt-get install -y -qq tesseract-ocr tesseract-ocr-eng
  pass "Tesseract OCR installed"
fi

echo ""

# ─────────────────────────────────────────────
# Phase 5: Networking tools
# ─────────────────────────────────────────────
log "Phase 5: Installing networking tools..."

# Cloudflared
if command -v cloudflared &>/dev/null; then
  skip "cloudflared $(cloudflared --version 2>&1 | awk '{print $2}')"
else
  CLOUDFLARED_VERSION="2026.10.1"
  CLOUDFLARED_SHA256="3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586"
  CLOUDFLARED_TMP="$(mktemp "${TMPDIR:-/tmp}/sidekick-cloudflared.XXXXXX")"
  if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
    --output "$CLOUDFLARED_TMP"; then
    rm -f -- "$CLOUDFLARED_TMP"
    err "Failed to download the pinned cloudflared release"
    exit 1
  fi
  if ! printf '%s  %s\n' "$CLOUDFLARED_SHA256" "$CLOUDFLARED_TMP" | sha256sum --check --status; then
    rm -f -- "$CLOUDFLARED_TMP"
    err "Pinned cloudflared release checksum mismatch"
    exit 1
  fi
  install -o root -g root -m 0755 -- "$CLOUDFLARED_TMP" /usr/local/bin/cloudflared
  rm -f -- "$CLOUDFLARED_TMP"
  pass "cloudflared installed"
fi

# WireGuard
if command -v wg &>/dev/null; then
  skip "WireGuard"
else
  apt-get install -y -qq wireguard
  pass "WireGuard installed"
fi

# Nginx
if command -v nginx &>/dev/null; then
  skip "nginx $(nginx -v 2>&1 | awk -F/ '{print $2}')"
else
  apt-get install -y -qq nginx
  pass "nginx installed"
fi

# Don't auto-start nginx — we'll manage it
systemctl disable nginx 2>/dev/null || true
systemctl stop nginx 2>/dev/null || true

echo ""

# ─────────────────────────────────────────────
# Phase 6: Python packages
# ─────────────────────────────────────────────
log "Phase 6: Installing Python packages..."

# Create a venv for sidekick tools so we don't pollute system Python
TOOLS_VENV="/home/$USERNAME/.sidekick-tools"
if [ -L "$TOOLS_VENV" ]; then
  err "Python tools venv must not be a symbolic link: $TOOLS_VENV"
  exit 1
elif [ -d "$TOOLS_VENV" ]; then
  # Upgrade venvs created by older versions of this script without following
  # symlinks while changing ownership. Package installers run as sidekick below.
  find -P "$TOOLS_VENV" -xdev \( -type d -o -type f \) -exec chown "$USERNAME:$USERNAME" -- {} +
  skip "Python tools venv exists"
else
  python3 -m venv "$TOOLS_VENV"
  chown "$USERNAME:$USERNAME" "$TOOLS_VENV"
  pass "Created Python tools venv at $TOOLS_VENV"
fi

TOOLS_PYTHON="$TOOLS_VENV/bin/python"
if [ ! -x "$TOOLS_PYTHON" ]; then
  err "Python tools venv has no safe interpreter: $TOOLS_PYTHON"
  exit 1
fi

# yt-dlp
if sudo -H -u "$USERNAME" "$TOOLS_PYTHON" -m pip show yt-dlp &>/dev/null; then
  skip "yt-dlp $(sudo -H -u "$USERNAME" "$TOOLS_VENV/bin/yt-dlp" --version)"
else
  sudo -H -u "$USERNAME" "$TOOLS_PYTHON" -m pip install -q yt-dlp
  pass "yt-dlp installed"
fi

# Whisper
if sudo -H -u "$USERNAME" "$TOOLS_PYTHON" -m pip show openai-whisper &>/dev/null; then
  skip "openai-whisper"
else
  sudo -H -u "$USERNAME" "$TOOLS_PYTHON" -m pip install -q openai-whisper
  pass "Whisper installed"
fi

# DuckDB
if sudo -H -u "$USERNAME" "$TOOLS_PYTHON" -c 'import duckdb' &>/dev/null; then
  skip "DuckDB $(sudo -H -u "$USERNAME" "$TOOLS_PYTHON" -c 'import duckdb; print(duckdb.__version__)')"
else
  sudo -H -u "$USERNAME" "$TOOLS_PYTHON" -m pip install -q duckdb
  pass "DuckDB installed"
fi

# Mermaid CLI (needs npm)
TOOLS_NPM_PREFIX="$TOOLS_VENV/npm"
TOOLS_MMDC="$TOOLS_NPM_PREFIX/bin/mmdc"
if [ -x "$TOOLS_MMDC" ]; then
  skip "mermaid-cli"
elif command -v mmdc &>/dev/null; then
  skip "mermaid-cli"
else
  sudo -H -u "$USERNAME" env NPM_CONFIG_PREFIX="$TOOLS_NPM_PREFIX" npm install --global @mermaid-js/mermaid-cli
  pass "mermaid-cli installed"
fi

# Expose the sidekick-owned CLI to system tools without running its install
# hooks or package code as root.
if [ -x "$TOOLS_MMDC" ] && [ ! -e /usr/local/bin/mmdc ] && [ ! -L /usr/local/bin/mmdc ]; then
  ln -s "$TOOLS_MMDC" /usr/local/bin/mmdc
fi

# Symlink tools venv binaries to a shared location
for bin in yt-dlp whisper duckdb; do
  if [ -f "$TOOLS_VENV/bin/$bin" ] && [ ! -f "/usr/local/bin/sidekick-$bin" ]; then
    ln -sf "$TOOLS_VENV/bin/$bin" "/usr/local/bin/sidekick-$bin"
    pass "Linked $bin -> /usr/local/bin/sidekick-$bin"
  fi
done

echo ""

# ─────────────────────────────────────────────
# Phase 7: Docker services setup
# ─────────────────────────────────────────────
log "Phase 7: Setting up Docker services..."

DOCKER_DIR="/home/$USERNAME/sidekick/docker"
mkdir -p "$DOCKER_DIR"
mkdir -p "$DOCKER_DIR/data/postgres"
mkdir -p "$DOCKER_DIR/data/redis"
mkdir -p "$DOCKER_DIR/data/qdrant"
mkdir -p "$DOCKER_DIR/data/influxdb"
mkdir -p "$DOCKER_DIR/data/grafana"
chown -R "$USERNAME:$USERNAME" "$DOCKER_DIR"
# The official postgres:16-alpine image runs as UID/GID 999. The other
# bind-mounted services use the deployment account, but PostgreSQL must own
# its data directory or background workers will repeatedly fail to open files.
chown -R 999:999 "$DOCKER_DIR/data/postgres"

# Copy docker-compose.yml if not already there
if [ -f "$DOCKER_DIR/docker-compose.yml" ]; then
  skip "docker-compose.yml exists"
else
  cp "$SCRIPT_DIR/../docker/docker-compose.yml" "$DOCKER_DIR/docker-compose.yml"
  chown "$USERNAME:$USERNAME" "$DOCKER_DIR/docker-compose.yml"
  pass "docker-compose.yml deployed"
fi

# Install systemd wrapper services
SERVICES=("sidekick-postgres" "sidekick-redis" "sidekick-qdrant" "sidekick-influxdb" "sidekick-grafana")
for svc in "${SERVICES[@]}"; do
  cp "$SCRIPT_DIR/../systemd/$svc.service" "/etc/systemd/system/$svc.service"
  pass "$svc.service installed/updated"
done

for unit in sidekick-metrics.service sidekick-metrics.timer; do
  cp "$SCRIPT_DIR/../systemd/$unit" "/etc/systemd/system/$unit"
  pass "$unit installed/updated"
done

systemctl daemon-reload

# Enable but don't start (on-demand)
for svc in "${SERVICES[@]}"; do
  systemctl enable "$svc" 2>/dev/null
  pass "$svc enabled (not started)"
done

ENV_FILE="/home/$USERNAME/sidekick/.env"
if [ -f "$ENV_FILE" ]; then
  # Compose runs bind-mounted services as the deployment account. Persist the
  # actual host identity so the configuration remains portable across hosts.
  SIDEKICK_UID_VALUE=$(id -u "$USERNAME")
  SIDEKICK_GID_VALUE=$(id -g "$USERNAME")
  if grep -q '^SIDEKICK_UID=' "$ENV_FILE"; then
    sed -i "s/^SIDEKICK_UID=.*/SIDEKICK_UID=$SIDEKICK_UID_VALUE/" "$ENV_FILE"
  else
    printf '\nSIDEKICK_UID=%s\n' "$SIDEKICK_UID_VALUE" >> "$ENV_FILE"
  fi
  if grep -q '^SIDEKICK_GID=' "$ENV_FILE"; then
    sed -i "s/^SIDEKICK_GID=.*/SIDEKICK_GID=$SIDEKICK_GID_VALUE/" "$ENV_FILE"
  else
    printf 'SIDEKICK_GID=%s\n' "$SIDEKICK_GID_VALUE" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  chown "$USERNAME:$USERNAME" "$ENV_FILE"
  pass "Compose bind-mount identity configured ($SIDEKICK_UID_VALUE:$SIDEKICK_GID_VALUE)"
fi
if sudo -u "$USERNAME" node "$SCRIPT_DIR/verify-runtime-secret.js" SIDEKICK_INFLUX_TOKEN /etc/sidekick/secrets >/dev/null 2>&1; then
  systemctl enable --now sidekick-metrics.timer 2>/dev/null
  pass "sidekick-metrics.timer enabled"
else
  warn "sidekick-metrics.timer installed but not enabled; provision a valid SIDEKICK_INFLUX_TOKEN secret file first"
fi

echo ""

# ─────────────────────────────────────────────
# Phase 8: Ollama
# ─────────────────────────────────────────────
log "Phase 8: Installing Ollama and pulling models..."

if command -v ollama &>/dev/null; then
  skip "Ollama $(ollama --version 2>/dev/null | head -1)"
else
  install_ollama_verified
fi

if command -v ollama &>/dev/null; then
  systemctl enable ollama 2>/dev/null || true
  systemctl start ollama 2>/dev/null || true

  for _ in {1..20}; do
    if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      pass "Ollama service reachable"
      break
    fi
    sleep 1
  done

  DEFAULT_OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5-coder:7b}"
  if ollama list 2>/dev/null | grep -q "$DEFAULT_OLLAMA_MODEL"; then
    skip "$DEFAULT_OLLAMA_MODEL already pulled"
  else
    info "Pulling $DEFAULT_OLLAMA_MODEL (this may take a while)..."
    sudo -u "$USERNAME" ollama pull "$DEFAULT_OLLAMA_MODEL"
    pass "$DEFAULT_OLLAMA_MODEL pulled"
  fi

  if ollama list 2>/dev/null | grep -q "llama3.1:8b"; then
    skip "llama3.1:8b already pulled"
  else
    info "Pulling llama3.1:8b (this may take a while)..."
    sudo -u "$USERNAME" ollama pull llama3.1:8b
    pass "llama3.1:8b pulled"
  fi

  if ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
    skip "nomic-embed-text already pulled"
  else
    info "Pulling nomic-embed-text..."
    sudo -u "$USERNAME" ollama pull nomic-embed-text
    pass "nomic-embed-text pulled"
  fi
else
  warn "Ollama not installed, skipping models"
fi

echo ""

# ─────────────────────────────────────────────
# Phase 9: Update sudoers
# ─────────────────────────────────────────────
log "Phase 9: Updating sudoers for new services..."

install -o root -g root -m 0755 "$SCRIPT_DIR/sidekick-wg-wrapper.sh" /usr/local/sbin/sidekick-wg

cat > /etc/sudoers.d/sidekick << 'SUDOERS'
# Sidekick user permissions - journal access
sidekick ALL=(ALL) NOPASSWD: /usr/bin/journalctl -u sidekick-mcp, /usr/bin/journalctl -u sidekick-dashboard, /usr/bin/journalctl -u sidekick-agent

sidekick ALL=(ALL) NOPASSWD: /usr/bin/journalctl -u sidekick-postgres, /usr/bin/journalctl -u sidekick-redis, /usr/bin/journalctl -u sidekick-qdrant, /usr/bin/journalctl -u sidekick-influxdb, /usr/bin/journalctl -u sidekick-grafana

# UFW
sidekick ALL=(ALL) NOPASSWD: /usr/sbin/ufw allow 4097/tcp, /usr/sbin/ufw allow 4098/tcp, /usr/sbin/ufw allow 4099/tcp, /usr/sbin/ufw allow 3000/tcp

# WireGuard
sidekick ALL=(ALL) NOPASSWD: /usr/local/sbin/sidekick-wg

# Nginx
sidekick ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t

# Data directory
sidekick ALL=(ALL) NOPASSWD: /usr/bin/chown -R sidekick\:sidekick /home/sidekick/sidekick/data/, /usr/bin/chmod -R 700 /home/sidekick/sidekick/data/
SUDOERS

chmod 440 /etc/sudoers.d/sidekick
visudo -cf /etc/sudoers.d/sidekick
install_sidekick_deploy_sudoers "$USERNAME" "$SCRIPT_DIR"
install_sidekick_polkit_rule "$USERNAME" "$SCRIPT_DIR"
pass "Sudoers updated with Docker service permissions"

echo ""

# ─────────────────────────────────────────────
# Phase 10: Verification
# ─────────────────────────────────────────────
echo ""
echo "========================================="
echo "  Verification"
echo "========================================="
echo ""

log "Verifying all installations..."
echo ""

# Foundation
info "Foundation:"
command -v pip3 &>/dev/null && pass "pip3" || fail "pip3"
command -v rg &>/dev/null && pass "ripgrep" || fail "ripgrep"
command -v sqlite3 &>/dev/null && pass "sqlite3" || fail "sqlite3"
if sidekick_bubblewrap_smoke_test "$USERNAME"; then
  pass "Bubblewrap namespaces and kernel limits under NoNewPrivileges"
else
  fail "Bubblewrap isolation unavailable for $USERNAME; shell calls will fail closed"
fi

# Docker
info "Docker:"
command -v docker &>/dev/null && pass "Docker $(docker --version 2>/dev/null | awk '{print $3}')" || fail "Docker"
docker compose version &>/dev/null && pass "Docker Compose" || fail "Docker Compose"
docker info &>/dev/null && pass "Docker daemon running" || fail "Docker daemon not running"

# Development
info "Development:"
command -v go &>/dev/null && pass "Go $(go version 2>/dev/null | awk '{print $3}')" || fail "Go"
command -v node &>/dev/null && pass "Node.js $(node --version)" || fail "Node.js"

# Media
info "Media & Documents:"
command -v ffmpeg &>/dev/null && pass "ffmpeg" || fail "ffmpeg"
command -v convert &>/dev/null && pass "ImageMagick" || fail "ImageMagick"
command -v pandoc &>/dev/null && pass "pandoc" || fail "pandoc"
command -v pdflatex &>/dev/null && pass "pdflatex" || fail "pdflatex"
command -v tesseract &>/dev/null && pass "Tesseract" || fail "Tesseract"

# Networking
info "Networking:"
command -v cloudflared &>/dev/null && pass "cloudflared" || fail "cloudflared"
command -v wg &>/dev/null && pass "WireGuard" || fail "WireGuard"
command -v nginx &>/dev/null && pass "nginx" || fail "nginx"

# Python tools
info "Python tools:"
[ -d "$TOOLS_VENV" ] && pass "Tools venv at $TOOLS_VENV" || fail "Tools venv"
[ -f "$TOOLS_VENV/bin/yt-dlp" ] && pass "yt-dlp" || fail "yt-dlp"
[ -f "$TOOLS_VENV/bin/whisper" ] && pass "whisper" || fail "whisper"
sudo -H -u "$USERNAME" "$TOOLS_PYTHON" -c "import duckdb" 2>/dev/null && pass "DuckDB" || fail "DuckDB"

# Mermaid
command -v mmdc &>/dev/null && pass "mermaid-cli" || fail "mermaid-cli"

# Docker services
info "Docker services (enabled, not started):"
for svc in "${SERVICES[@]}"; do
  systemctl is-enabled "$svc" &>/dev/null && pass "$svc enabled" || fail "$svc not enabled"
done

# Ollama models
info "Ollama models:"
if command -v ollama &>/dev/null; then
  ollama list 2>/dev/null | while read -r line; do
    pass "$line"
  done
fi

echo ""
echo "========================================="
echo "  Summary"
echo "========================================="
echo ""
echo -e "  ${GREEN}Passed: $PASS${NC}"
echo -e "  ${RED}Failed: $FAIL${NC}"
echo -e "  ${YELLOW}Skipped: $SKIP${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  warn "$FAIL items failed verification. Review the output above."
else
  log "All checks passed!"
fi

echo ""
info "Docker services are enabled but NOT started (on-demand)."
info "Start them with: sudo systemctl start sidekick-postgres"
info "Or via Sidekick: sidekick_service action='start' service='sidekick-postgres'"
echo ""
