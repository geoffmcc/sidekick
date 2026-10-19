# Network and Firewall pack: action and workflow reference

Use `environment-recon` for provider capabilities and configured state,
`connectivity-diagnosis` for path, DNS, routing, port, DHCP, and VPN evidence,
and `health-assessment` for bounded health observations. `change-preflight`
and `safe-change` are read-only planning workflows. `safe-change` does not
apply changes because caller-supplied management-path claims are not verified.

Provider runtime state and configuration state are distinct. A timeout is not
the same as refusal, authentication failure, or policy denial. Changes must use
Plans are not proof that a change is safe or ready to apply. Named profiles
contain credential references; calls do not accept raw endpoints, tokens, or
arbitrary firewall rules.
