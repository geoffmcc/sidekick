# Security Lab and Reproduction: authorization preflight

Run `lab-preflight` before any research run. It should identify the target kind,
an unexpired authorization scope snapshot, an exact named network scope where
needed, isolation, egress, rollback, and evidence disposition. With
`require_isolated` enabled, shared or production-access environments fail
closed; `allowed_target_kinds` limits private IP, hostname, and fixture targets.

This pack authorizes neither public discovery nor arbitrary commands. After a
successful preflight, delegate execution to the governed Security Research
workflow, which owns probes, evidence, and cleanup. A preflight pass is not a
finding and does not replace human authorization or post-run teardown.
