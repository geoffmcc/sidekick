#!/usr/bin/env bash
# Sidekick Compute Worker — Linux uninstaller (systemd).
#
# Usage (as root):
#   sudo ./uninstall-linux.sh            # remove service + install dir, keep credential/config
#   sudo ./uninstall-linux.sh --purge    # also remove config, credential, and the service user
set -euo pipefail

SERVICE_USER=sidekick-worker
INSTALL_DIR=/opt/sidekick-compute-worker
CONFIG_DIR=/etc/sidekick-compute-worker
STATE_DIR=/var/lib/sidekick-compute-worker
UNIT_DEST=/etc/systemd/system/sidekick-compute-worker.service
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

echo "==> Stopping and disabling service"
systemctl disable --now sidekick-compute-worker.service 2>/dev/null || true
rm -f "$UNIT_DEST"
systemctl daemon-reload

echo "==> Removing install directory"
rm -rf "$INSTALL_DIR"

if [ "$PURGE" -eq 1 ]; then
  echo "==> Purging config, credential, and service user"
  rm -rf "$CONFIG_DIR" "$STATE_DIR"
  id -u "$SERVICE_USER" >/dev/null 2>&1 && userdel "$SERVICE_USER" || true
else
  echo "==> Kept $CONFIG_DIR and $STATE_DIR (use --purge to remove)"
fi

echo "==> Done."
