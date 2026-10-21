#!/usr/bin/env bash

# Import an ASCII-armored APT repository key only when its primary fingerprint
# matches the value reviewed into the caller. Network transport is HTTPS; the
# fingerprint is the independent trust anchor before APT is configured.
install_verified_apt_key() {
  local url="$1"
  local destination="$2"
  local expected_fingerprint="${3^^}"
  local raw_key dearmored_key actual_fingerprint

  if [[ ! "$url" =~ ^https:// ]]; then
    echo "Refusing non-HTTPS APT key URL: $url" >&2
    return 1
  fi
  if [[ ! "$expected_fingerprint" =~ ^[A-F0-9]{40}$ ]]; then
    echo "Refusing invalid pinned APT key fingerprint" >&2
    return 1
  fi

  raw_key="$(mktemp "${TMPDIR:-/tmp}/sidekick-apt-key.XXXXXX")" || return 1
  dearmored_key="$(mktemp "${TMPDIR:-/tmp}/sidekick-apt-keyring.XXXXXX")" || {
    rm -f -- "$raw_key"
    return 1
  }

  if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output "$raw_key" "$url"; then
    rm -f -- "$raw_key" "$dearmored_key"
    echo "Failed to download APT signing key" >&2
    return 1
  fi

  actual_fingerprint="$(gpg --batch --show-keys --with-colons "$raw_key" 2>/dev/null | awk -F: '$1 == "fpr" { print toupper($10); exit }')"
  if [[ "$actual_fingerprint" != "$expected_fingerprint" ]]; then
    rm -f -- "$raw_key" "$dearmored_key"
    echo "APT signing key fingerprint mismatch (expected $expected_fingerprint)" >&2
    return 1
  fi

  if ! gpg --batch --yes --dearmor --output "$dearmored_key" "$raw_key"; then
    rm -f -- "$raw_key" "$dearmored_key"
    echo "Failed to convert verified APT signing key" >&2
    return 1
  fi

  install -D -o root -g root -m 0644 -- "$dearmored_key" "$destination"
  local install_status=$?
  rm -f -- "$raw_key" "$dearmored_key"
  return "$install_status"
}
