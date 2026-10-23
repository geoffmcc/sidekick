#!/usr/bin/env bash
set -euo pipefail

# GitHub's Ubuntu 24.04 runners restrict unprivileged user namespaces with
# AppArmor. Load Ubuntu's packaged, Bubblewrap-specific profile only when the
# exact isolation probe fails; never disable the host-wide restriction.
sudo apt-get update
sudo apt-get install --no-install-recommends -y bubblewrap apparmor apparmor-profiles apparmor-utils

# setup-node places its runtime under /opt/hostedtoolcache, which is correctly
# hidden from Sidekick's sandbox. Copy the selected CI runtime into the mounted
# system path so shell integration tests can invoke it without exposing /opt.
sudo install -m 0755 "$(command -v node)" /usr/local/bin/node

probe_bubblewrap() {
  local -a args=(--unshare-all --die-with-parent --new-session --cap-drop ALL)
  local mount
  for mount in /usr /bin /lib /lib64 /sbin; do
    [[ -e "$mount" ]] && args+=(--ro-bind "$mount" "$mount")
  done
  args+=(--proc /proc --dev /dev --size 1048576 --tmpfs /tmp --dir /workspace --chdir /workspace -- /bin/true)
  /usr/bin/bwrap "${args[@]}"
}

if ! probe_bubblewrap; then
  profile=/usr/share/apparmor/extra-profiles/bwrap-userns-restrict
  if [[ ! -r "$profile" ]]; then
    echo "Ubuntu's packaged bwrap-userns-restrict AppArmor profile is unavailable" >&2
    exit 1
  fi
  sudo apparmor_parser -r "$profile"
fi

# Require the same network, process, and mount namespace initialization used
# by Sidekick before allowing tests to run. A failed probe is a CI setup error.
probe_bubblewrap
