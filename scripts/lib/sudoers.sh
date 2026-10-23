#!/usr/bin/env bash

install_sidekick_deploy_sudoers() {
  local username="$1"
  local script_dir="$2"
  local sudoers_dir="/etc/sudoers.d"
  local target="$sudoers_dir/sidekick-deploy"
  local temp_file

  if [[ ! "$username" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
    echo "Invalid service account name for sudoers policy" >&2
    return 1
  fi
  if ! command -v visudo >/dev/null 2>&1; then
    echo "visudo is required to validate the SSH deployment policy" >&2
    return 1
  fi

  install -d -o root -g root -m 0750 "$sudoers_dir"
  temp_file="$(mktemp "$sudoers_dir/.sidekick-deploy.XXXXXX")"
  if ! sed "s/@SIDEKICK_USER@/$username/g" "$script_dir/../systemd/sidekick-deploy-sudoers" > "$temp_file"; then
    rm -f "$temp_file"
    return 1
  fi
  chown root:root "$temp_file"
  chmod 0440 "$temp_file"
  if ! visudo -cf "$temp_file"; then
    echo "Refusing to install an invalid Sidekick SSH deployment policy" >&2
    rm -f "$temp_file"
    return 1
  fi
  if [[ -e "$target" ]] && ! cmp -s "$target" "$temp_file"; then
    echo "Existing $target differs from the generated policy; review and back it up before replacing" >&2
    rm -f "$temp_file"
    return 1
  fi
  mv -f "$temp_file" "$target"
}
