#!/usr/bin/env bash
set -euo pipefail

PREFIX="${SIDEKICK_NODE_PREFIX:-$HOME/.local/lib/sidekick-execution-node}"
REAL_HOME="$(realpath -e -- "$HOME")"
if [[ -L "$PREFIX" ]]; then
  printf 'Refusing to remove a symlinked execution-node prefix: %s\n' "$PREFIX" >&2
  exit 1
fi
PREFIX="$(realpath -m -- "$PREFIX")"
if [[ "$PREFIX" != "$REAL_HOME/"* || "${PREFIX##*/}" != "sidekick-execution-node" ]]; then
  printf 'Refusing unsafe execution-node prefix: %s\n' "$PREFIX" >&2
  exit 1
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now sidekick-execution-node.service 2>/dev/null || true
fi
rm -f "$HOME/.config/systemd/user/sidekick-execution-node.service"
DROP_IN_DIR="$HOME/.config/systemd/user/sidekick-execution-node.service.d"
if [[ -d "$DROP_IN_DIR" && ! -L "$DROP_IN_DIR" ]]; then
  rm -f -- "$DROP_IN_DIR/workspace.conf"
  rmdir -- "$DROP_IN_DIR" 2>/dev/null || true
fi
rm -rf "$PREFIX"
