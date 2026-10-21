#!/usr/bin/env bash

# Install only a reviewed Ollama release artifact. The version and digests are
# copied from the corresponding official GitHub release asset metadata; update
# them together in a reviewed change. Never pipe a mutable vendor installer to
# a root shell.
install_ollama_verified() {
  local version="0.40.5"
  local arch expected_sha256 bindir prefix archive_url temp_dir members entry candidate install_lock

  case "$(uname -m)" in
    x86_64|amd64)
      arch="amd64"
      expected_sha256="dc5eabc292f9949546c90a97c820f924b035e05243b0de13c7f366182562169c"
      ;;
    aarch64|arm64)
      arch="arm64"
      expected_sha256="fbe71ebb1a10e59b8480c4d2839826b5f9dff1a6d5c142428b2e7db9b1a2c642"
      ;;
    *)
      err "Unsupported Ollama architecture: $(uname -m)"
      return 1
      ;;
  esac

  bindir=""
  for candidate in /usr/local/bin /usr/bin /bin; do
    case ":$PATH:" in
      *":$candidate:"*) bindir="$candidate"; break ;;
    esac
  done
  if [ -z "$bindir" ]; then
    err "No supported Ollama binary directory was found in PATH"
    return 1
  fi

  prefix="$(dirname "$bindir")"
  if [ -e "$prefix/lib/ollama" ] || [ -e "$bindir/ollama" ]; then
    err "Ollama install target already exists; review it before installing the pinned release"
    return 1
  fi

  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/sidekick-ollama.XXXXXX")"
  archive_url="https://github.com/ollama/ollama/releases/download/v${version}/ollama-linux-${arch}.tar.zst"
  if ! curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --output "$temp_dir/ollama.tar.zst" "$archive_url"; then
    rm -rf -- "$temp_dir"
    err "Pinned Ollama release download failed"
    return 1
  fi

  if ! printf '%s  %s\n' "$expected_sha256" "$temp_dir/ollama.tar.zst" | sha256sum --check --status; then
    rm -rf -- "$temp_dir"
    err "Pinned Ollama release checksum verification failed"
    return 1
  fi

  if ! zstd --test "$temp_dir/ollama.tar.zst" >/dev/null; then
    rm -rf -- "$temp_dir"
    err "Pinned Ollama release archive is invalid"
    return 1
  fi
  if ! tar --zstd --list --file "$temp_dir/ollama.tar.zst" > "$temp_dir/members"; then
    rm -rf -- "$temp_dir"
    err "Pinned Ollama release archive cannot be listed"
    return 1
  fi

  while IFS= read -r entry; do
    case "$entry" in
      ""|/*|../*|*/../*|*/..|./*|*/./*|*/.|*\\*)
        rm -rf -- "$temp_dir"
        err "Pinned Ollama archive contains an unsafe path"
        return 1
        ;;
    esac
    case "$entry" in
      bin|bin/|bin/ollama|lib|lib/|lib/ollama|lib/ollama/|lib/ollama/*) ;;
      *)
        rm -rf -- "$temp_dir"
        err "Pinned Ollama archive contains an unexpected path"
        return 1
        ;;
    esac
  done < "$temp_dir/members"

  mkdir -p "$temp_dir/stage"
  if ! tar --zstd --no-same-owner --no-same-permissions --extract --file "$temp_dir/ollama.tar.zst" --directory "$temp_dir/stage"; then
    rm -rf -- "$temp_dir"
    err "Pinned Ollama release extraction failed"
    return 1
  fi
  if [ ! -f "$temp_dir/stage/bin/ollama" ] || [ ! -d "$temp_dir/stage/lib/ollama" ]; then
    rm -rf -- "$temp_dir"
    err "Pinned Ollama release is missing expected files"
    return 1
  fi

  if [ ! -d "$bindir" ] && ! install -d -o root -g root -m 0755 "$bindir"; then
    rm -rf -- "$temp_dir"
    err "Ollama binary directory could not be prepared"
    return 1
  fi
  if [ ! -d "$prefix/lib" ] && ! install -d -o root -g root -m 0755 "$prefix/lib"; then
    rm -rf -- "$temp_dir"
    err "Ollama library directory could not be prepared"
    return 1
  fi
  install_lock="$prefix/lib/.sidekick-ollama-install.lock"
  if ! mkdir "$install_lock" 2>/dev/null; then
    rm -rf -- "$temp_dir"
    err "Another Ollama installation is active or a stale install lock needs review"
    return 1
  fi
  if [ -e "$prefix/lib/ollama" ] || [ -e "$bindir/ollama" ]; then
    rmdir "$install_lock"
    rm -rf -- "$temp_dir"
    err "Ollama install target appeared during setup; review it before retrying"
    return 1
  fi

  if ! mkdir "$prefix/lib/ollama"; then
    rmdir "$install_lock"
    rm -rf -- "$temp_dir"
    err "Ollama library target could not be created"
    return 1
  fi
  if ! install -o root -g root -m 0755 "$temp_dir/stage/bin/ollama" "$bindir/ollama"; then
    rm -rf -- "$prefix/lib/ollama" "$temp_dir"
    rmdir "$install_lock"
    err "Ollama binary installation failed; the newly created library target was removed"
    return 1
  fi
  if ! cp -a "$temp_dir/stage/lib/ollama/." "$prefix/lib/ollama/" \
    || ! chown -R root:root "$prefix/lib/ollama"; then
    rm -f -- "$bindir/ollama"
    rm -rf -- "$prefix/lib/ollama" "$temp_dir"
    rmdir "$install_lock"
    err "Pinned Ollama release installation failed; partial target files were removed"
    return 1
  fi
  rmdir "$install_lock"
  rm -rf -- "$temp_dir"
  pass "Ollama ${version} installed after release checksum verification"
}
