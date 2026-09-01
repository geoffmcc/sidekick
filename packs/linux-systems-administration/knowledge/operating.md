# Linux Systems Administration

This pack is an adapter, not a second host-management implementation. Host
status and health are delegated to the governed `status` and `health` tools.
Systemd actions are delegated to `service`, which owns authorization,
approval, timeout, redaction, and audit behavior.

The default service scope is limited to Sidekick services. A service action
must name exactly one service. Start, stop, restart, enable, and disable are
mutations and can be refused by policy; a request being accepted is not proof
that the service reached the requested state.
