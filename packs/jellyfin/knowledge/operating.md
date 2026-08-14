# Jellyfin pack: operating model

The pack owns Jellyfin-side evidence and reasoning. It does not manage the host, filesystem, reverse proxy, GPU device mapping, NAS, or hypervisor. Select a configured profile by name; the endpoint is never a model argument.

Read results are bounded and normalized. Diagnostics distinguish observed facts, deterministic conclusions, unknowns, and the next check. Missing optional Jellyfin facilities are reported as unsupported rather than treated as a server failure.
