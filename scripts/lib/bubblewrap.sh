#!/usr/bin/env bash

# Test the same minimum OS boundary required by the Core shell executor as the
# actual service identity, with NoNewPrivileges enabled. This is diagnostic
# only: failure keeps Sidekick installable, while the command executor itself
# remains fail-closed.
sidekick_bubblewrap_smoke_test() {
  local username="$1"
  local mount
  local -a args=(--unshare-all --die-with-parent --new-session --cap-drop ALL)

  [[ -x /usr/bin/bwrap && -x /usr/bin/prlimit && -x /usr/bin/setpriv ]] || return 1
  id "$username" >/dev/null 2>&1 || return 1

  for mount in /usr /bin /lib /lib64 /sbin; do
    [[ -e "$mount" ]] && args+=(--ro-bind "$mount" "$mount")
  done
  args+=(--proc /proc --dev /dev --size 1048576 --tmpfs /tmp --dir /workspace --chdir /workspace -- /bin/true)

  runuser -u "$username" -- /usr/bin/setpriv --no-new-privs -- \
    /usr/bin/prlimit \
    --cpu=300:300 \
    --nproc=64:64 \
    --nofile=1024:1024 \
    --fsize=268435456:268435456 \
    --core=0:0 \
    -- /usr/bin/bwrap "${args[@]}" >/dev/null 2>&1
}
