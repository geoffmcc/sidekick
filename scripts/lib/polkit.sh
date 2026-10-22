#!/bin/bash

install_sidekick_polkit_rule() {
  local username="$1"
  local script_dir="$2"
  local rule_dir="/etc/polkit-1/rules.d"
  local target="$rule_dir/50-sidekick.rules"
  local temp_file

  if [[ ! "$username" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
    echo "Invalid service account name for polkit rule" >&2
    return 1
  fi

  install -d -o root -g root -m 0755 "$rule_dir"
  temp_file="$(mktemp "$rule_dir/.50-sidekick.rules.XXXXXX")"
  if ! sed "s/@SIDEKICK_USER@/$username/g" "$script_dir/../systemd/sidekick-polkit.rules" > "$temp_file"; then
    rm -f "$temp_file"
    return 1
  fi
  chown root:root "$temp_file"
  chmod 0644 "$temp_file"
  mv -f "$temp_file" "$target"
}
