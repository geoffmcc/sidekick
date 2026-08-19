# Container Operations (Docker / Podman)

The `container-operations` first-party pack belongs to the **Infrastructure & Homelab** category. It is independent of Proxmox and operates Docker and Podman engines through configured profiles.

Profiles use a local engine socket (`socket`) or authenticated HTTPS (`endpoint`). HTTPS profiles require TLS verification; IP endpoints require `tls.servername`. Credentials and client certificates are referenced with `secret:<name>` and are never accepted inline. The pack never changes socket ownership or permissions.

Fresh installs include a read-only `local-docker` profile for the standard Sidekick deployment at `/home/sidekick/sidekick`. It includes Docker Compose validation for `/home/sidekick/sidekick/docker`. Deployments using another application root should override `repository_roots` and the profile's `compose.project_roots` during pack configuration; the default never enables lifecycle mutations.

Install, configure, enable, health-check, disable, re-enable, upgrade, and uninstall through the normal `capability` lifecycle. Use `containers` for bounded inspection and `container_lifecycle` for governed lifecycle actions. Use `compose` for provider-authoritative validation under configured `project_roots`. Workflows are `docker-podman/health-assessment`, `docker-podman/update-check`, `docker-podman/troubleshoot`, and `docker-podman/controlled-update`.

The pack ships ten agent-facing Knowledge assets covering operating model, safety, unhealthy containers, restart loops, reachability, update interpretation, preflight, Compose drift, dangerous configuration, and orphan candidates. Schedule the read-only `docker-podman/update-check` workflow through Sidekick's existing scheduler/watch facilities; the pack does not create a second scheduler.

The pack reports provider failures, authentication failures, permission limits, unsupported operations, and unknown update state distinctly. Logs, labels, names, health output, and registry metadata are untrusted and bounded. Orphan detection is read-only; cleanup and volume deletion are intentionally not exposed.

A controlled update is policy- and approval-governed. It captures current provider configuration, pulls an explicitly supplied image reference, recreates the selected container, and verifies the replacement. Exact rollback is unavailable unless an explicit restore hook is added; the pack does not fabricate rollback success.

Known limitation: registry digest comparison and full Compose project/deployment drift analysis require provider- and deployment-specific metadata that is not always available from the engine API. The pack reports uncertainty instead of calling a failed check current.
