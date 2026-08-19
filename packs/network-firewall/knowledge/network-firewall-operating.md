# Network & Firewall pack: operating model and provider limits

Use named profiles only. `network`, `firewall`, `dhcp`, and `vpn` are bounded reads; `network_change` is critical-risk and requires a fresh preflight. Results label configured versus runtime data. An unavailable or permission-limited subsystem is not healthy.

OpenWrt is the reference adapter and uses rpcd/ubus/UCI over HTTPS. OPNsense, pfSense, and UniFi are version/API negotiated. OPNsense Automation rules are not automatically the complete effective ruleset. pfSense configuration history is sensitive and is not a Sidekick rollback unless an operational restore API is explicitly supported. UniFi API coverage varies by Network Application version and site.
