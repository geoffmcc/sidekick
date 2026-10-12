# Security review

2026-10-12; baseline b89247b6b80a3e120c9b755592cf416d047108b3 (v2.2.1).

Private local review; no live targets, external accounts, network vulnerability probes or real secrets used. This is not a completed penetration test or current advisory audit.

The v2.2.1 Handlebars patch is present, with locked and installed 4.7.10 and string-only bounded template handling. All 19 behavioral assertions passed locally at baseline, but the suite failed in its cleanup hook because its SQLite handle remained open on Windows. Preserve the assertions and close the owned DB before removal.

Project mismatch in stored resume links is a confirmed fail-open validation defect (SK-003). A malformed or stale pointer can report valid despite differing projects, and cross-project completed handoffs can hide pending work. Reproduction uses synthetic data only; external exploitability and broader resume authorization are not established.

Stale/future evidence (SK-002) and undetected workspace changes (SK-004) can mislead a receiving agent. These checks must fail closed and must never imply current approvals. Secret redaction, scope authorization, dispatcher schema/policy and execution receipts remain required.

Remaining review: identity/ownership matrix across MCP, Dashboard, Agent and resume; handoff path authorization and Git helper execution; symlink/SSRF redirects; pack code privilege boundaries; retrieval injection; redaction by sensitive key; claim token exposure; CI/dependency advisories. No dependency changes or new external services are introduced in this milestone.


## Fix and validation status

SK-001 through SK-004 are fixed for the demonstrated cases. The final 12-case continuity suite passes; all 19 template security assertions and cleanup pass. Dispatcher behavior and cleanup pass after explicitly closing its owned database. Project context, project identity and memory data-isolation regressions pass. This does not close the untested authorization, injection, supply-chain or live-configuration items above.
