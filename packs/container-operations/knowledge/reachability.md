# Diagnosing unreachable containerized services

Check, in order: engine reachability; container running state; health; container networks; published host ports; port/protocol mapping; and proxy labels. For Traefik, verify the proxy and backend share a usable network, the router rule exists, and the configured service port matches the container port. For Nginx, report configuration as unobservable unless an administrator-configured evidence path is available. DNS, connection-refused, and TLS checks must use existing bounded Sidekick network capabilities; never broad-scan.
