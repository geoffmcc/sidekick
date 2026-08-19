# Network & Firewall pack: safe changes and management-path protection

Before a change, resolve the named profile, read the current target, capture a bounded revision/fingerprint when the provider exposes one, and determine whether the source-to-management path crosses the proposed interface, VLAN, route, VPN, firewall policy, or default gateway. Unknown impact is critical and fails closed. There is no force or skip-safety argument.

OpenWrt UCI native apply uses a rollback timeout and confirm. Do not intentionally lock out a production router to test it. A successful write is not a successful change until management reachability and the requested postcondition are verified. Never place complete provider configuration backups in normal storage: they may contain passwords, certificates, VPN keys, or Wi-Fi secrets.
