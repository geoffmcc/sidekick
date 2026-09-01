# Network Services

Network, DHCP, VPN, and Nginx inspection is delegated to administrator-
configured providers. A missing provider, unsupported capability, or denied
request is retained as unavailable or unknown; it is never treated as healthy.

`network_nginx_operation` is the only mutation-capable adapter. It forwards
the complete operation to the governed Nginx tool, which owns configuration
validation, policy, approval, reload behavior, and postcondition reporting.
The pack does not accept endpoints, credentials, raw commands, or firewall
rules of its own.
