# Network Services: provider and Nginx action reference

The `network-service-audit` workflow reviews optional `network`, `dhcp`, `vpn`,
and `nginx` providers; `connectivity-review` focuses on reachability and
service evidence. Select the administrator-configured `default_profile` when
one is needed. Missing providers or unsupported operations remain unavailable,
not healthy.

Nginx is the only mutation-capable adapter. `add_site` requires a site name,
domain, and upstream port; removal requires the exact site name. Use
`test_config` before `reload`, capture pre-change status, and verify the site
and service afterward. The pack does not accept endpoints, credentials, raw
commands, or self-defined firewall rules.
