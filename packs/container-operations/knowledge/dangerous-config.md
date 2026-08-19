# Dangerous container configuration

Flag, do not silently rewrite, privileged mode; host PID, IPC, or network namespaces; host-root or sensitive bind mounts; Docker/Podman socket mounts; device passthrough; broad added capabilities; and writable sensitive host paths. Engine administration is effectively host-level privilege, so profile reachability and mutation enablement deserve the same care as a privileged infrastructure connector.
