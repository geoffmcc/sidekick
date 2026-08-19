# Network & Firewall Operations capability pack

This first-party Infrastructure & Homelab pack provides bounded, evidence-labelled network and firewall operations for named OpenWrt, OPNsense, pfSense, and UniFi Network profiles. It never accepts a provider endpoint or credential from a tool call. Profiles contain endpoint metadata and `secret:<name>` references; secret values remain in Sidekick's encrypted secret facility.

## Provider model

OpenWrt is the reference provider. It uses HTTPS JSON-RPC to `ubus`, an ACL-scoped rpcd session, UCI reads, and native UCI `apply` with rollback timeout followed by `confirm`. It does not scrape LuCI or use arbitrary SSH. The profile's credential secret contains the username and password on separate lines. A least-privilege rpcd ACL should be configured by the operator; the pack does not install packages, change WAN exposure, or change router ACLs.

OPNsense uses the documented HTTPS API and reports the API's actual scope. In particular, OPNsense's Automation API only sees rules created in the Automation component; it cannot be presented as the complete effective firewall policy. pfSense uses only a configured supported API surface when one exists; configuration-history backup/restore is not represented as automatic rollback unless a real API/session establishes and verifies it. UniFi uses the versioned official Network API and requires a configured site where the selected API requires one. Unsupported, unavailable, permission-limited, and version-dependent capabilities are returned explicitly.

## Tools

`network` reads profiles, system information, interfaces, networks/VLANs, routes, clients, health, capabilities, summaries, and connectivity analysis. `firewall` reads zones/rules/NAT and explains when effective policy is not fully observable. `dhcp` reads DHCP state and leases. `vpn` reads supported tunnel state without private keys. `network_change` provides plan/preflight/apply/rollback state; it does not expose raw UCI, shell, CLI, or arbitrary endpoint arguments.

## Safety

Network changes are critical-risk operations. A change must have a known management-path assessment, current target identity, and provider-native protection before apply. Unknown management-path impact fails closed. OpenWrt applies through UCI's native rollback timer and confirms only after the provider remains reachable. Other providers remain read-only until a provider-supported transactional mechanism and verified postconditions exist. An API response accepting a request is never treated as success.

The normalized model labels `configured`, `runtime`, and `effective` state. Provider data is bounded and retained only as bounded provider metadata. Errors distinguish authentication, TLS, permissions, unsupported capability, reachability, stale/invalid input, provider rejection, verification failure, and unknown outcome.

## TLS and credentials

Profiles require HTTPS origins, reject redirects, validate certificates, and optionally use an explicitly configured pinned CA or CA secret. There is no insecure TLS switch. Credentials are never placed in manifests, configuration diffs, logs, audit evidence, normal pack storage, or tool output. For future users, create a named profile and secret through the normal capability and secret workflows; do not edit source files with local topology.

## Final capability matrix

| Capability | OpenWrt | OPNsense | pfSense | UniFi Network |
|---|---|---|---|---|
| System/interfaces/routes | read | version/API dependent read | API/version dependent read | official API dependent read |
| Networks/VLANs/clients | read | API dependent | API dependent | official API dependent |
| DHCP/firewall/NAT/VPN | read where ubus/UCI exposes it | read with automation/effective-policy limitation | read only where configured API exposes it | read where official Network API exposes it |
| Safe mutation | OpenWrt UCI rule mutations with native apply/confirm | unsupported until transactional API is established | unsupported until supported transactional API is established | unsupported until versioned API and rollback are established |
| Automatic rollback | provider-native UCI timeout/confirm | unavailable unless provider transaction is established | unavailable unless provider transaction is established | unavailable unless provider transaction is established |

This matrix is intentionally conservative and is updated with implementation and live-verification evidence.
