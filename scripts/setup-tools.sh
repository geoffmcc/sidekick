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
  curl -fsSL https://get.docker.com | sh
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
  curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
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
if [ -d "$TOOLS_VENV" ]; then
  skip "Python tools venv exists"
else
  python3 -m venv "$TOOLS_VENV"
  chown -R "$USERNAME:$USERNAME" "$TOOLS_VENV"
  pass "Created Python tools venv at $TOOLS_VENV"
fi

source "$TOOLS_VENV/bin/activate"

# yt-dlp
if pip3 show yt-dlp &>/dev/null; then
  skip "yt-dlp $(yt-dlp --version)"
else
  pip3 install -q yt-dlp
  pass "yt-dlp installed"
fi

# Whisper
if pip3 show openai-whisper &>/dev/null; then
  skip "openai-whisper"
else
  pip3 install -q openai-whisper
  pass "Whisper installed"
fi

# DuckDB
if pip3 show duckdb &>/dev/null; then
  skip "DuckDB $(python3 -c 'import duckdb; print(duckdb.__version__)')"
else
  pip3 install -q duckdb
  pass "DuckDB installed"
fi

# Mermaid CLI (needs npm)
if command -v mmdc &>/dev/null; then
  skip "mermaid-cli"
else
  npm install -g @mermaid-js/mermaid-cli
  pass "mermaid-cli installed"
fi

# Symlink tools venv binaries to a shared location
for bin in yt-dlp whisper duckdb; do
  if [ -f "$TOOLS_VENV/bin/$bin" ] && [ ! -f "/usr/local/bin/sidekick-$bin" ]; then
    ln -sf "$TOOLS_VENV/bin/$bin" "/usr/local/bin/sidekick-$bin"
    pass "Linked $bin -> /usr/local/bin/sidekick-$bin"
  fi
done

deactivate

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
if [ -f "$ENV_FILE" ] && grep -q '^SIDEKICK_INFLUX_TOKEN=.' "$ENV_FILE" && ! grep -q '^SIDEKICK_INFLUX_TOKEN=sidekick-influx-token$' "$ENV_FILE"; then
  systemctl enable --now sidekick-metrics.timer 2>/dev/null
  pass "sidekick-metrics.timer enabled"
else
  warn "sidekick-metrics.timer installed but not enabled; set SIDEKICK_INFLUX_TOKEN first"
fi

echo ""

# ─────────────────────────────────────────────
# Phase 8: Ollama
# ─────────────────────────────────────────────
log "Phase 8: Installing Ollama and pulling models..."

if command -v ollama &>/dev/null; then
  skip "Ollama $(ollama --version 2>/dev/null | head -1)"
else
  curl -fsSL https://ollama.com/install.sh | sh
  pass "Ollama installed"
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

cat > /etc/sudoers.d/sidekick << 'SUDOERS'
# Sidekick user permissions - core services
sidekick ALL=(ALL) NOPASSWD: /usr/bin/systemctl start sidekick-mcp, /usr/bin/systemctl stop sidekick-mcp, /usr/bin/systemctl restart sidekick-mcp, /usr/bin/systemctl status sidekick-mcp
sidekick ALL=(ALL) NOPASSWD: /usr/bin/systemctl start sidekick-dashboard, /usr/bin/systemctl stop sidekick-dashboard, /usr/bin/systemctl restart sidekick-dashboard, /usr/bin/systemctl status sidekick-dashboard
sidekick ALL=(ALL) NOPASSWD: /usr/bin/systemctl start sidekick-agent, /usr/bin/systemctl stop sidekick-agent, /usr/bin/systemctl restart sidekick-agent, /usr/bin/systemctl status sidekick-agent
sidekick ALL=(ALL) NOPASSWD: /usr/bin/journalctl -u sidekick-mcp, /usr/bin/journalctl -u sidekick-dashboard, /usr/bin/journalctl -u sidekick-agent

# Sidekick Docker wrapper services
sidekick ALL=(ALL) NOPASSWD: /usr/bin/systemctl start sidekick-postgres, /usr/bin/systemctl stop sidekick-postgres, /usr/bin/systemctl restart sidekick-postgres, /usr/bin/systemctl status sidekick-postgres
sidekick ALL=(ALL) NOPASSWD: /usr/bin/systemctl start sidekick-redis, /usr/bin/systemctl stop sidekick-redis, /usr/bin/systemctl restart sidekick-redis, /usr/bin/systemctl status sidekick-redis
sidekick ALL=(ALL) NOPASSWD: /usr/bin/systemctl start sidekick-qdrant, /usr/bin/systemctl stop sidekick-qdrant, /usr/bin/systemctl restart sidekick-qdrant, /usr/bin/systemctl status sidekick-qdrant
sidekick ALL=(ALL) NOPASSWD: /usr/bin/systemctl start sidekick-influxdb, /usr/bin/systemctl stop sidekick-influxdb, /usr/bin/systemctl restart sidekick-influxdb, /usr/bin/systemctl status sidekick-influxdb
sidekick ALL=(ALL) NOPASSWD: /usr/bin/systemctl start sidekick-grafana, /usr/bin/systemctl stop sidekick-grafana, /usr/bin/systemctl restart sidekick-grafana, /usr/bin/systemctl status sidekick-grafana
sidekick ALL=(ALL) NOPASSWD: /usr/bin/systemctl start sidekick-metrics.timer, /usr/bin/systemctl stop sidekick-metrics.timer, /usr/bin/systemctl restart sidekick-metrics.timer, /usr/bin/systemctl status sidekick-metrics.timer
sidekick ALL=(ALL) NOPASSWD: /usr/bin/journalctl -u sidekick-postgres, /usr/bin/journalctl -u sidekick-redis, /usr/bin/journalctl -u sidekick-qdrant, /usr/bin/journalctl -u sidekick-influxdb, /usr/bin/journalctl -u sidekick-grafana

# Docker management (needed for on-demand services)
sidekick ALL=(ALL) NOPASSWD: /usr/bin/docker compose -f /home/sidekick/sidekick/docker/docker-compose.yml *
sidekick ALL=(ALL) NOPASSWD: /usr/bin/docker compose --env-file /home/sidekick/sidekick/.env -f /home/sidekick/sidekick/docker/docker-compose.yml *
sidekick ALL=(ALL) NOPASSWD: /usr/bin/docker start *, /usr/bin/docker stop *, /usr/bin/docker restart *, /usr/bin/docker ps, /usr/bin/docker logs *

# UFW
sidekick ALL=(ALL) NOPASSWD: /usr/sbin/ufw allow 4097/tcp, /usr/sbin/ufw allow 4098/tcp, /usr/sbin/ufw allow 4099/tcp, /usr/sbin/ufw allow 3000/tcp

# WireGuard
sidekick ALL=(ALL) NOPASSWD: /usr/bin/wg, /usr/bin/wg-quick

# Nginx
sidekick ALL=(ALL) NOPASSWD: /usr/sbin/nginx, /usr/sbin/nginx -t, /usr/sbin/nginx -s reload, /usr/bin/systemctl start nginx, /usr/bin/systemctl stop nginx, /usr/bin/systemctl restart nginx, /usr/bin/systemctl reload nginx, /usr/bin/systemctl status nginx

# Data directory
sidekick ALL=(ALL) NOPASSWD: /usr/bin/chown -R sidekick\:sidekick /home/sidekick/sidekick/data/, /usr/bin/chmod -R 755 /home/sidekick/sidekick/data/
SUDOERS

chmod 440 /etc/sudoers.d/sidekick
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
source "$TOOLS_VENV/bin/activate"
python3 -c "import duckdb" 2>/dev/null && pass "DuckDB" || fail "DuckDB"
deactivate

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
