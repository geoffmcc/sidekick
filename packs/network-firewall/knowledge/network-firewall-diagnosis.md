# Network & Firewall pack: connectivity and DHCP diagnosis

For traffic from A to B, inspect address family and membership, route/default gateway, source and destination interfaces/zones, ordered firewall rules, NAT, VPN routes, and runtime interface/gateway state. Return `allowed` or `denied` only when provider evidence is authoritative; otherwise return `likely_allowed`, `likely_denied`, or `indeterminate` with evidence and limitations.

For DHCP failures, check server/scope state, address range, lease conflicts, reservations, gateway/DNS options, and interface state. A missing lease list can mean permission limitation or unavailable API, not that no clients exist. IPv6 and IPv4 are separate families; do not apply IPv4 NAT assumptions to IPv6.
