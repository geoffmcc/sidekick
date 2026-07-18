#!/usr/bin/env bash
# Sidekick Compute Worker — Linux installer (systemd).
#
# Usage (as root):
#   sudo SERVER_URL=http://host:4097 ENROLL_TOKEN=<token> ./install-linux.sh
#
# The enrollment token is used ONLY to obtain a persistent credential during
# `enroll`; it is never written to the config file or the systemd unit.
set -euo pipefail

SERVICE_USER=sidekick-worker
INSTALL_DIR=/opt/sidekick-compute-worker
CONFIG_DIR=/etc/sidekick-compute-worker
STATE_DIR=/var/lib/sidekick-compute-worker
UNIT_DEST=/etc/systemd/system/sidekick-compute-worker.service

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Resolve the worker entry point and unit template in both the shipped package
# layout (files at package root) and the dev tree (src/compute + systemd/).
if [ -f "$PKG_ROOT/worker-agent.js" ]; then WORKER_SRC="$PKG_ROOT"; else WORKER_SRC="$PKG_ROOT/src/compute"; fi
if [ -f "$PKG_ROOT/systemd/sidekick-compute-worker.service" ]; then UNIT_SRC="$PKG_ROOT/systemd/sidekick-compute-worker.service"; else UNIT_SRC="$SCRIPT_DIR/../../systemd/sidekick-compute-worker.service"; fi

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
: "${SERVER_URL:?Set SERVER_URL}"
: "${ENROLL_TOKEN:?Set ENROLL_TOKEN}"
command -v node >/dev/null || { echo "node not found on PATH" >&2; exit 1; }
[ -f "$WORKER_SRC/worker-agent.js" ] || { echo "worker-agent.js not found under $WORKER_SRC" >&2; exit 1; }

echo "==> Creating service user and directories"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -m 0755 "$INSTALL_DIR" "$CONFIG_DIR"
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR"

echo "==> Installing worker files to $INSTALL_DIR"
cp -r "$WORKER_SRC"/. "$INSTALL_DIR"/
chown -R root:root "$INSTALL_DIR"

echo "==> Writing config (non-secret) to $CONFIG_DIR/config.json"
cat > "$CONFIG_DIR/config.json" <<EOF
{
  "serverUrl": "$SERVER_URL",
  "concurrency": ${CONCURRENCY:-1}
}
EOF
chmod 0644 "$CONFIG_DIR/config.json"

echo "==> Enrolling (writes credential; token is not persisted)"
sudo -u "$SERVICE_USER" \
  SIDEKICK_WORKER_CONFIG_FILE="$CONFIG_DIR/config.json" \
  SIDEKICK_WORKER_CONFIG="$STATE_DIR/credential.json" \
  node "$INSTALL_DIR/worker-agent.js" enroll --service --token "$ENROLL_TOKEN"

echo "==> Installing and starting systemd service"
install -m 0644 "$UNIT_SRC" "$UNIT_DEST"
systemctl daemon-reload
systemctl enable --now sidekick-compute-worker.service
systemctl --no-pager status sidekick-compute-worker.service || true

echo "==> Done. Follow logs with: journalctl -u sidekick-compute-worker -f"
