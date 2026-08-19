# Update preflight

Before an authorized update, capture the stable engine profile and target identity, current container ID and image identity, health/restart state, mounts and persistent-data indicators, networks, ports, dependencies, configuration identity, and rollback feasibility. Re-resolve the target immediately before mutation. If no exact restore hook exists, say rollback is unavailable. A pull request being accepted is not proof that the new image was deployed or verified.
