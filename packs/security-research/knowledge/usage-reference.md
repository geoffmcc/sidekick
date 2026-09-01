# Security Research pack: lifecycle and evidence reference

Use the lifecycle in order: create a campaign and scope snapshot, state a
hypothesis, plan and start a run, acquire or select a finalized source snapshot,
execute bounded probes, capture evidence, validate observations, materialize a
report, and clean up the environment. `source-regression` and
`version-regression-check` are bounded workflow compositions, not general
scanners.

Every completed run needs an outcome and evidence. Scope is authoritative and
public reachability never establishes authorization. Proxmox environments are
disposable only when the configured provider permits provisioning and guarded
retirement; cleanup may remain pending/manual when provenance or protection
denies deletion. Comparison and validation are deterministic, while finding
status and impact remain human judgments. Disclosure is a separate action.
