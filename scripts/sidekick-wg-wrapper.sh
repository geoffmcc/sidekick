#!/usr/bin/env bash
set -euo pipefail

# Root-owned wrapper for the narrow WireGuard operations Sidekick needs.
# Keep the privileged surface smaller than allowing the sidekick account to
# invoke wg/wg-quick with arbitrary arguments.
WG=/usr/bin/wg

iface_re='^[a-zA-Z0-9_.-]{1,32}$'
key_re='^[A-Za-z0-9+/]{43}=$'
ips_re='^[0-9A-Fa-f:./, -]+$'
endpoint_re='^[A-Za-z0-9._:-]{1,255}:[0-9]{1,5}$'

fail() { echo "sidekick-wg: $*" >&2; exit 2; }
valid_iface() { [[ "$1" =~ $iface_re ]] || fail "invalid interface"; }
valid_key() { [[ "$1" =~ $key_re ]] || fail "invalid public key"; }
valid_ips() { [[ "$1" =~ $ips_re ]] || fail "invalid allowed IPs"; }

case "${1:-}" in
  show)
    case "${2:-}" in
      all) [[ $# -eq 2 ]] || fail "invalid show all arguments"; exec "$WG" show all ;;
      *)
        [[ "${2:-}" =~ $iface_re && "${3:-}" == peers && $# -eq 3 ]] || fail "invalid peer listing arguments"
        exec "$WG" show "$2" peers
        ;;
    esac
    ;;
  set)
    [[ $# -ge 5 ]] || fail "invalid set arguments"
    valid_iface "$2"
    [[ "$3" == peer ]] || fail "only peer updates are allowed"
    valid_key "$4"
    if [[ "$5" == remove && $# -eq 5 ]]; then
      exec "$WG" set "$2" peer "$4" remove
    fi
    [[ "$5" == allowed-ips && $# -ge 6 && $# -le 8 ]] || fail "invalid peer update"
    valid_ips "$6"
    if [[ $# -eq 6 ]]; then
      exec "$WG" set "$2" peer "$4" allowed-ips "$6"
    fi
    [[ $# -eq 8 && "$7" == endpoint && "${8}" =~ $endpoint_re ]] || fail "invalid endpoint"
    exec "$WG" set "$2" peer "$4" allowed-ips "$6" endpoint "$8"
    ;;
  *)
    fail "unsupported operation"
    ;;
esac
