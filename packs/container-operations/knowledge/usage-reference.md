# Container Operations: tool and workflow reference

Use `health-assessment` for engine, container, and service health; `troubleshoot`
for unhealthy, restart-loop, reachability, drift, and dangerous-configuration
evidence; and `update-check` for image update candidates. `controlled-update`
is the only packaged mutation path and requires a configured profile that
allows mutations, preflight, approval, and postcondition verification.

Select an administrator-configured Docker or Podman profile. Compose operations
are confined to configured project roots and allowlisted binaries; this pack
does not accept arbitrary CLI arguments or shell commands. Empty inventories,
missing engines, unavailable registries, and provider errors remain unknown or
failed. Inspect health and logs after any approved lifecycle operation.
