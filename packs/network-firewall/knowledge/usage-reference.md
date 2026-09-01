# Network and Firewall pack: action and workflow reference

Use `environment-recon` for provider capabilities and configured state,
`connectivity-diagnosis` for path, DNS, routing, port, DHCP, and VPN evidence,
and `health-assessment` for bounded health observations. `change-preflight`
must precede `safe-change`; the latter is the governed mutation path and must
receive an explicit management-path-safe decision.

Provider runtime state and configuration state are distinct. A timeout is not
the same as refusal, authentication failure, or policy denial. Changes must use
the provider revision, preserve rollback information, and verify the resulting
state. Named profiles contain credential references; calls do not accept raw
endpoints, tokens, or arbitrary firewall rules.
