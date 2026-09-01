# Linux Systems Administration: status, health and service actions

`host-health` combines `status` and `health`; interpret service state, process
state, disk, memory, load, and network evidence separately. `service-status`
inspects configured systemd service names and logs. Set `default_services` only
to names the operator intends to inspect. A missing service, unavailable check,
or empty section is not healthy evidence.

The `service` capability owns start, stop, restart, enable, disable, and log
policy, approval, and verification. Confirm the exact unit before a mutation,
capture its current state, and verify it remains active after the operation.
This pack does not install packages, edit arbitrary files, or execute raw shell.
