# Infrastructure as Code: plan and preflight reference

Use `iac-plan` for provider-authoritative inspection and normalized plan output;
use `iac-preflight` to validate the proposed configuration and dependencies
before any separate change process. Compose inputs are resolved only through
administrator-configured profiles and allowlisted project roots. Optional
providers such as `parse`, `diff`, and `network` may be unavailable; that state
must remain visible.

This pack is plan-only. `allow_apply` is fixed to false, and neither workflow
applies Compose, firewall, network, or infrastructure changes. A valid plan is
not evidence that the target is healthy or that a later apply will succeed.
Review provider revisions, drift, unknown values, and rollback before acting.
