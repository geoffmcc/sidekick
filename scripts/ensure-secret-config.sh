#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/home/sidekick/sidekick}"
ENV_FILE="$APP_DIR/.env"
SECRET_DIR="${SIDEKICK_SECRET_DIR:-/etc/sidekick/secrets}"

case "$SECRET_DIR" in
  /*) ;;
  *) echo "SIDEKICK_SECRET_DIR must be an absolute path" >&2; exit 1 ;;
esac

mkdir -p "$APP_DIR"
touch "$ENV_FILE"
for secret_name in \
  SIDEKICK_API_KEY SIDEKICK_MCP_CREDENTIAL SIDEKICK_AGENT_PROXY_KEY SIDEKICK_AGENT_SCHEDULER_KEY \
  SIDEKICK_DASHBOARD_PASS SIDEKICK_GRAFANA_ADMIN_PASSWORD \
  SIDEKICK_INFLUX_TOKEN SIDEKICK_INFLUX_PASSWORD SIDEKICK_POSTGRES_PASSWORD \
  SIDEKICK_SECRET_KEY GROQ_API_KEY OPENAI_API_KEY GITHUB_TOKEN \
  SIDEKICK_GITHUB_TOKEN DISCORD_WEBHOOK_URL SLACK_WEBHOOK_URL SMTP_USER SMTP_PASS \
  SIDEKICK_ENROLL_TOKEN SIDEKICK_NODE_ENROLL_TOKEN COMPUTE_TOKEN SIDEKICK_COMPUTE_LIVE_API_KEY \
  SIDEKICK_BOOTSTRAP_TOKEN; do
  if grep -Eq "^[[:space:]]*${secret_name}=[^[:space:]#].*$" "$ENV_FILE"; then
    echo "$secret_name is populated in .env; migrate it to $SECRET_DIR before deploying" >&2
    exit 1
  fi
done
if grep -q '^SIDEKICK_SECRET_DIR=' "$ENV_FILE"; then
  sed -i "s|^SIDEKICK_SECRET_DIR=.*|SIDEKICK_SECRET_DIR=$SECRET_DIR|" "$ENV_FILE"
else
  printf '\nSIDEKICK_SECRET_DIR=%s\n' "$SECRET_DIR" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
echo "Protected secret directory configured: $SECRET_DIR"

# Refuse a deployment before service restarts if required process credentials
# are missing, unsafe, or accidentally shared. Do not generate replacements:
# doing so would silently invalidate existing clients and service trust.
node "$APP_DIR/scripts/verify-runtime-secrets.js" "$SECRET_DIR"
