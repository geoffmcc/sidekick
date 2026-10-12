# Quality contracts

2026-10-12; baseline b89247b6b80a3e120c9b755592cf416d047108b3 (v2.2.1).

Draft platform contracts grounded in existing interfaces; only the targeted subset is validated this milestone.

| Subsystem | Required invariant and completion evidence |
| --- | --- |
| Dispatcher | Input schema, source identity, current project/resource policy and approvals are checked on every execution and alias. Failure returns normalized redacted status; timeout does not prove mutation cancellation. Cross-interface tests required. |
| Persistence | A checkpoint and its audit event commit or roll back together. Historical packets remain readable; schema migration never fabricates evidence. Fault injection plus reopen tests required. |
| Handoff | Capture -> validate -> atomic commit -> scoped discovery -> fresh preflight -> explicit reconciliation -> governed continuation. Objective, status, next action, completed work, decisions, acceptance and provenance are source state; extensions hold development/research/infra details. Missing or unobservable state is explicit. |
| Receiver | Current workspace mismatch, unverified/unavailable capture, stale/future evidence, project mismatch or competing ownership must not silently permit resume. Preflight never grants authority or replays unknown operations. |
| Agent/recovery | Durable receipts own effect outcomes. Ambiguous mutation stays parked until fresh authoritative evidence or human direction. Completion requires independent acceptance evidence. |
| Memory | Retrieved text is data, preserves source and project scope, and cannot overwrite newer authoritative execution records by summary ranking alone. Requires stale/conflicting/injection corpus evaluation. |
| Workflow/events | Each step uses canonical dispatch; cancellation and lease expiry are explicit; duplicates and retries cannot silently repeat uncertain mutations. Delivery semantics documented per operation. |
| Compute/packs | Enrollment and workloads are scoped, bounded and cancellable where supported; pack code activation is explicit trusted in-process code. Health and completion require observable evidence. |
| Interfaces/operations | Correlate task/project/request and errors; distinguish pending, failed, unverified and safely retryable. Redact outputs and preserve compatibility. |

A simple research handoff need not invent a Git repo. The existing receiver implementation currently expects repository proof for readiness; non-Git contract extensions remain design work. No new irrelevant mandatory packet fields are introduced in this milestone.
