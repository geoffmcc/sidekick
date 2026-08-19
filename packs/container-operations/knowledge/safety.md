# Container Operations: safety and update procedure

Engine access is effectively privileged host access. Do not weaken socket permissions, mount the host root, enable privileged workloads, or add socket/device mounts to make a check work. If a profile cannot reach its socket, fix the administrator-owned service permissions or profile instead.

Start, stop, restart, pull, recreate, and Compose mutation actions are governed mutations. They require an explicitly configured profile with `allow_mutations: true` and still pass Sidekick policy, approval, timeout, cancellation, and audit controls. There is no raw Docker, Podman, Compose, or shell-argument escape hatch.

Before a controlled update, inspect the target and confirm the image, mounts, networks, health state, and persistent-data implications. The current implementation can report rollback unavailable; it must never claim rollback succeeded unless an exact restore operation and postcondition verification exist. Do not prune orphan volumes or images automatically.

Read-only update checks must remain read-only when scheduled through Sidekick's existing watch/scheduler facilities. Registry failures and digest uncertainty are unknown, not current.
