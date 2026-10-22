#!/usr/bin/env bash
set -euo pipefail

# Install Sidekick's narrowly scoped systemd unit authorization on an existing
# Debian/Ubuntu host without rerunning the broader setup-tools workflow.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
USERNAME="${1:-sidekick}"

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this installer as root (for example: sudo bash ./scripts/install-polkit-policy.sh)" >&2
  exit 1
fi

if [[ ! "$USERNAME" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  echo "Invalid Sidekick service account name" >&2
  exit 1
fi

if ! id "$USERNAME" >/dev/null 2>&1; then
  echo "Sidekick service account '$USERNAME' does not exist" >&2
  exit 1
fi

if [[ ! -d /run/systemd/system ]] || ! command -v systemctl >/dev/null 2>&1; then
  echo "A running systemd host is required to install Sidekick's Polkit policy" >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer supports Debian/Ubuntu hosts; install polkitd and use the documented platform procedure" >&2
  exit 1
fi

if ! command -v pkaction >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y polkitd
fi

# shellcheck source=scripts/lib/polkit.sh
source "$SCRIPT_DIR/lib/polkit.sh"
install_sidekick_polkit_rule "$USERNAME" "$SCRIPT_DIR"
echo "Installed Sidekick Polkit service-control policy for OS account '$USERNAME'."
