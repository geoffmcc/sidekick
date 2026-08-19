# Diagnosing restart loops

A restarting state or repeated restart count is deterministic evidence of instability, not proof of a root cause. Inspect the last exit code and finish time, health-check failures, image identity, resource stats, OOM evidence if the provider exposes it, mounts, and dependencies. Do not repeatedly restart a loop. Preserve bounded evidence before a governed mutation.
