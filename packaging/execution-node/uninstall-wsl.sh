#!/usr/bin/env bash
set -euo pipefail

PREFIX="${SIDEKICK_NODE_PREFIX:-$HOME/.local/lib/sidekick-execution-node}"
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now sidekick-execution-node.service 2>/dev/null || true
fi
rm -f "$HOME/.config/systemd/user/sidekick-execution-node.service"
rm -rf "$PREFIX"
