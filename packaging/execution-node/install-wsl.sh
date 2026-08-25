#!/usr/bin/env bash
set -euo pipefail

PREFIX="${SIDEKICK_NODE_PREFIX:-$HOME/.local/lib/sidekick-execution-node}"
CONFIG_DIR="${SIDEKICK_NODE_CONFIG_DIR:-$HOME/.config/sidekick}"
STATE_DIR="${SIDEKICK_NODE_STATE_DIR:-$HOME/.local/state/sidekick}"
CACHE_DIR="${SIDEKICK_NODE_CACHE_DIR:-$HOME/.cache/sidekick}"
ROOT="${SIDEKICK_NODE_WORKSPACE_ROOT:-/home/geoffrey/Projects/security-research}"

if [[ ! -d "$ROOT" ]]; then
  printf 'Workspace root does not exist: %s\n' "$ROOT" >&2
  exit 1
fi
if [[ "$ROOT" != /home/*/Projects/* || "$ROOT" == /home/*/.ssh* || "$ROOT" == /home/*/.config* ]]; then
  printf 'Refusing unsafe workspace root: %s\n' "$ROOT" >&2
  exit 1
fi

install -d -m 700 "$PREFIX" "$CONFIG_DIR" "$STATE_DIR" "$CACHE_DIR"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
npm install --prefix "$PREFIX" --omit=dev "$REPO" >/dev/null
install -d -m 755 "$HOME/.config/systemd/user"
install -m 644 "$(dirname "$0")/../../systemd/sidekick-execution-node.service" "$HOME/.config/systemd/user/sidekick-execution-node.service"

if [[ ! -f "$CONFIG_DIR/node.json" ]]; then
  umask 077
  printf '{\n  "workspace": "%s",\n  "packs": ["developer"]\n}\n' "$ROOT" > "$CONFIG_DIR/node.json"
fi
chmod 600 "$CONFIG_DIR/node.json"

if command -v systemctl >/dev/null 2>&1 && systemctl --user is-system-running >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable sidekick-execution-node.service
  printf 'Installed. Start with: systemctl --user start sidekick-execution-node.service\n'
else
  printf 'Installed foreground runtime. systemd --user is unavailable; run: node %s run\n' "$PREFIX/node-agent.js"
fi
