#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/home/sidekick/sidekick}"
SECRET_DIR="${SIDEKICK_SECRET_DIR:-/etc/sidekick/secrets}"

node "$APP_DIR/scripts/ensure-secret-config.js" "$APP_DIR" "$SECRET_DIR"
