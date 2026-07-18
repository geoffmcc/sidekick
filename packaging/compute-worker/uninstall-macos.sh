#!/usr/bin/env bash
# Sidekick Compute Worker — macOS uninstaller (launchd).
#
# Usage (as root):
#   sudo ./uninstall-macos.sh           # remove daemon + install dir, keep config/credential
#   sudo ./uninstall-macos.sh --purge   # also remove config + credential
set -euo pipefail

INSTALL_DIR=/usr/local/sidekick-compute-worker
SUPPORT_DIR="/Library/Application Support/Sidekick Compute Worker"
PLIST_DEST=/Library/LaunchDaemons/com.sidekick.compute-worker.plist
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

echo "==> Unloading and removing LaunchDaemon"
launchctl unload "$PLIST_DEST" 2>/dev/null || true
rm -f "$PLIST_DEST"

echo "==> Removing install directory"
rm -rf "$INSTALL_DIR"

if [ "$PURGE" -eq 1 ]; then
  echo "==> Purging config and credential"
  rm -rf "$SUPPORT_DIR"
else
  echo "==> Kept $SUPPORT_DIR (use --purge to remove)"
fi

echo "==> Done."
