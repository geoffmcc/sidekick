#!/usr/bin/env bash
# Sidekick Compute Worker — macOS installer (launchd LaunchDaemon).
#
# Usage (as root):
#   sudo SERVER_URL=http://host:4097 ENROLL_TOKEN=<token> ./install-macos.sh
#
# The enrollment token is used ONLY during `enroll`; it is not persisted.
set -euo pipefail

INSTALL_DIR=/usr/local/sidekick-compute-worker
SUPPORT_DIR="/Library/Application Support/Sidekick Compute Worker"
LOG_DIR=/Library/Logs/Sidekick
PLIST_DEST=/Library/LaunchDaemons/com.sidekick.compute-worker.plist

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [ -f "$PKG_ROOT/worker-agent.js" ]; then WORKER_SRC="$PKG_ROOT"; else WORKER_SRC="$PKG_ROOT/src/compute"; fi
PLIST_SRC="$SCRIPT_DIR/com.sidekick.compute-worker.plist"

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
: "${SERVER_URL:?Set SERVER_URL}"
: "${ENROLL_TOKEN:?Set ENROLL_TOKEN}"
command -v node >/dev/null || { echo "node not found on PATH" >&2; exit 1; }

echo "==> Creating directories"
mkdir -p "$INSTALL_DIR" "$LOG_DIR"
mkdir -p "$SUPPORT_DIR"; chmod 0700 "$SUPPORT_DIR"

echo "==> Installing worker files"
cp -R "$WORKER_SRC"/. "$INSTALL_DIR"/

echo "==> Writing config (non-secret)"
cat > "$SUPPORT_DIR/config.json" <<EOF
{
  "serverUrl": "$SERVER_URL",
  "concurrency": ${CONCURRENCY:-1}
}
EOF
chmod 0644 "$SUPPORT_DIR/config.json"

echo "==> Enrolling (writes credential; token not persisted)"
SIDEKICK_WORKER_CONFIG_FILE="$SUPPORT_DIR/config.json" \
SIDEKICK_WORKER_CONFIG="$SUPPORT_DIR/credential.json" \
  node "$INSTALL_DIR/worker-agent.js" enroll --service --token "$ENROLL_TOKEN"

echo "==> Installing and loading LaunchDaemon"
install -m 0644 -o root -g wheel "$PLIST_SRC" "$PLIST_DEST"
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load -w "$PLIST_DEST"

echo "==> Done. Logs: $LOG_DIR/compute-worker.log"
echo "    (modern alternative: launchctl bootstrap system $PLIST_DEST)"
