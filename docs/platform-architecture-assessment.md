# Sidekick Platform Architecture Assessment

Date: 2026-07-15
Branch: `feat/platform-consolidation-foundations`
Baseline: local `main` was clean at `c394c7f` before this branch was created.

## Scope

This assessment verifies the current repository architecture before platform consolidation. It is intentionally evidence-based and cites current files, functions, schemas, and tests. It does not treat historical notes or stored memory as authoritative when the repository disagrees.

## Current Process Boundaries

Sidekick is currently a three-process Node.js application:

- MCP server: `src/index.js` creates the MCP server, registers built-in and generated tools, applies pending migrations at startup, and exposes Streamable HTTP/SSE MCP routes (`src/index.js:1-17`, `src/index.js:1314-1325`).
- Dashboard: `src/dashboard.js` serves the HTML shell and JSON API on port 4098 with Basic/session auth, CSRF origin checks, rate limiting, audit logging, and direct database/file reads (`src/dashboard.js:1-31`, `src/dashboard.js:51-77`, `src/dashboard.js:189-230`).
- Agent Bridge: `src/agent.js` accepts task goals, runs a local planning loop, calls `callTool`, stores transcripts, and owns delay/watch timers (`src/agent.js:8-16`, `src/agent.js:26-96`, `src/agent.js:178-256`).

The architecture document accurately describes the high-level boundary as MCP `:4097`, Dashboard `:4098`, Agent Bridge `:4099`, shared `src/tools.js`, shared SQLite database, and data directory (`docs/architecture.md:3-22`).

## Current Storage Systems

- SQLite `sidekick.db` owns `meta`, `kv_store`, `json_documents`, `tool_logs`, generated capabilities, generated-tool executions, memory intelligence tables, Black Box tables, tool registry, and knowledge tables (`src/db.js:25-157`, `migrations/002_tool_registry.sql:4-72`, `migrations/009_memory_intelligence.sql:35-157`, `migrations/010_blackbox_incidents.sql:4-181`).
- JSON documents inside SQLite still emulate document stores for approvals and other named records (`src/tools.js:438-444`).
- File-backed state remains for agent conversations, audit/error logs, runbooks, and some operational bundles (`src/agent.js:14-24`, `src/dashboard.js:119-153`, `src/tools.js:9381-9398`).
- Black Box evidence uses SQLite metadata plus redacted artifact files under Black Box artifact storage (`src/blackbox.js:553-635`).

## Current Execution Paths

- MCP direct calls are routed through registered tool handlers in `src/index.js`, call `enforceToolPolicy`, invoke the handler, then write a `tool_logs` row via `logToolCall` (`src/index.js:800-811`).
- Agent Bridge calls tools through `callTool` and separately maintains task progress and transcripts (`src/agent.js:8-10`, `src/agent.js:600-788`).
- Dashboard actions often call database helpers directly or call tool handlers through `requireDashboardTool`, depending on endpoint (`src/dashboard.js:8-14`, `src/dashboard.js:1752-1811`).
- Generated tools are dynamic MCP tools stored in SQLite and executed step-by-step by `src/dynamic-tools.js`, which creates `generated_tool_executions` and child step rows (`src/dynamic-tools.js:108-205`, `src/db.js:114-157`).
- Black Box captures execute predefined command collectors with `execFile`, write source metadata and artifacts, then emit feature-local progress events (`src/blackbox.js:428-488`, `src/blackbox.js:553-740`).
- Runbooks execute shell commands directly through `execSync` and keep instance state in `data/runbooks.json` (`src/tools.js:9381-9559`).

## Lifecycle Implementations

Sidekick has multiple independent lifecycle/state systems:

- Tool activity: `tool_logs` with success, source, session/task/correlation fields (`src/db.js:54-68`, `src/tools.js:994-1019`).
- Approvals: encrypted pending payloads in `json_documents('approvals')`, status transitions in application code (`src/tools.js:438-654`).
- Generated tools: `generated_tool_executions` and `generated_tool_execution_steps` (`src/db.js:114-157`, `src/dynamic-tools.js:118-202`).
- Memory task sessions: `memory_task_sessions` (`migrations/009_memory_intelligence.sql:103-129`).
- Black Box incidents/captures/sources/events (`migrations/010_blackbox_incidents.sql:4-181`).
- Agent delays and watches: JSON-backed timers loaded into process memory at Agent Bridge startup (`src/agent.js:26-96`, `src/agent.js:98-256`).
- Runbooks: JSON-backed definitions and instances (`src/tools.js:9381-9559`).

There is not yet one durable execution graph across these systems.

## Trust, Privilege, And Authentication Boundaries

- MCP requires a non-placeholder `SIDEKICK_API_KEY` and optionally enforces allowed IP ranges (`src/index.js:13-19`).
- Dashboard requires non-placeholder MCP key, can require dashboard Basic Auth/session cookie, can apply IP allowlist, rate limiting, and CSRF origin checks (`src/dashboard.js:20-23`, `src/dashboard.js:45-53`, `src/dashboard.js:189-230`, `src/dashboard.js:232-260`).
- Agent Bridge is a separate HTTP service and directly imports `callTool` plus allowed tool definitions (`src/agent.js:8-10`).
- Risky execution still occurs in the same Node trust domain as the control plane for Bash, runbooks, sandbox, system commands, Black Box collectors, and generated tool steps (`src/tools.js:5`, `src/tools.js:1031-1045`, `src/tools.js:9518-9530`, `src/blackbox.js:575`).
- There is no stable actor/RBAC model yet. Current attribution is mostly `currentSource`, dashboard username, source-specific policy env vars, and optional task/session IDs (`src/tools.js:40-44`, `src/tools.js:349-424`, `src/dashboard.js:121-138`).

## Data Flow Diagram

```text
MCP client / OpenCode
  -> src/index.js auth/session transport
  -> tool policy by source+risk+tool name
  -> src/tools.js handler or src/dynamic-tools.js generated handler
  -> SQLite/files/external commands/services/APIs
  -> tool_logs + optional feature-specific state

Browser dashboard
  -> src/dashboard.js auth/rate-limit/CSRF
  -> dashboard API handlers
  -> SQLite/files, Agent Bridge proxy, selected tool handlers

Agent Bridge
  -> src/agent.js task loop
  -> memory brief + allowed tool catalog
  -> callTool
  -> transcript files + automatic memory

Black Box
  -> sidekick_black_box action
  -> src/blackbox.js incident/capture/source rows
  -> execFile collectors
  -> redacted artifact files + observations + analyses
```

## State Ownership

- Current source of truth for tool metadata is split between `TOOL_DEFS`, `TOOL_RISK`, `TOOL_CATEGORIES`, MCP schemas in `src/index.js`, and SQLite registry sync (`src/tools.js:48-123`, `src/tools.js:125-227`, `src/index.js:41-260`, `src/tools.js:235-315`).
- Database schema ownership is split between bootstrap DDL in `src/db.js`, migrations, and defensive feature-local schema creation (`src/db.js:27-157`, `src/blackbox.js:143-318`).
- Activity ownership is primarily `tool_logs`; generated-tool and Black Box activity have separate tables and emitters (`src/tools.js:994-1019`, `src/dynamic-tools.js:51-54`, `migrations/010_blackbox_incidents.sql:158-170`).

## Confirmed Suspected Issues

1. Confirmed. Multiple subsystems implement task/lifecycle state independently: approvals, generated executions, Black Box captures, memory sessions, runbooks, delays, watches, and tool logs use separate stores and state names.
2. Confirmed. Activity, Agent Bridge, generated tools, Black Box, Memory, procedures, approvals, and schedules do not share one execution graph; correlation is optional and feature-specific.
3. Mostly confirmed. Generated tool executions and memory/Black Box rows are durable, but Agent delays/watches are timer-backed and runbooks are JSON-backed; there is no common lease/checkpoint recovery model after restart.
4. Confirmed. Mutating tools do not share a universal change-plan, verification, and rollback model. Runbooks have local rollback commands; database restore has local pre-backup; most tools rely on handler-specific behavior.
5. Confirmed. Tool registration requires parallel edits across MCP schemas, `TOOL_DEFS`, risk/category maps, handler exports, tests, docs, and database sync metadata.
6. Confirmed. `src/tools.js` is over 11k lines, `src/dashboard.js` is over 1.9k lines, `src/db.js` is over 2.8k lines, and `src/agent.js` mixes scheduling, watch evaluation, model loop, streaming, and task persistence.
7. Confirmed. Policy is source/tool/risk/list based (`src/tools.js:349-424`), not actor/action/resource/capability based.
8. Confirmed. High-risk execution uses child process calls inside the same service codebase (`src/tools.js:5`, `src/blackbox.js:575`, `src/tools.js:9518-9530`).
9. Confirmed. Identity is insufficiently granular; `currentSource`, dashboard Basic username, and environment-specific policy are not stable actor/service-account/RBAC identities.
10. Confirmed. Dashboard documentation and UI are subsystem-tab oriented: Mission Control, system, activity, data, database, config, agent, memory, tools, metrics (`docs/dashboard.md:7-31`, `src/dashboard.html:26-546`).
11. Confirmed. Watches, health checks, schedules, tools, agents, Black Box, and generated tools do not emit a single normalized event model.
12. Confirmed. Tests cover many subsystems, but not restart-safe workflows, capability bypass, approval replay binding, universal rollback, cross-project authorization, or end-to-end acceptance scenarios (`test/run-all.js:16-42`).
13. Confirmed. Trace fields exist opportunistically in `tool_logs`, generated dynamic calls, and Black Box correlation IDs, but there is no OpenTelemetry-compatible trace/span propagation across processes (`src/tools.js:1013-1018`, `src/dynamic-tools.js:158-164`, `src/blackbox.js:672-699`).
14. Confirmed. Model use is governed by environment variables and prompt code, not a model registry, budgets, evaluation gates, or provider health (`src/tools.js:18-20`, `src/agent.js:9-10`).
15. Confirmed. Version/tool count/runtime information has drifted: package version is `1.0.0`, changelog contains tool-count history through 90, `CONTEXT.md` says 83 built-in tools, package engines allow Node `>=22.0.0`, and CI tests 22.x and 24.x (`package.json:3-17`, `CHANGELOG.md:73-100`, `CONTEXT.md:10-44`, `.github/workflows/ci.yml:14-27`).
16. Confirmed. No committed `package-lock.json` exists; CI uses `npm install`, not `npm ci` (`package.json:21-34`, `.github/workflows/ci.yml:26-30`).
17. Confirmed. CI lacks CodeQL, secret scanning workflow, dependency audit policy, SBOM, pinned action SHAs, license checks, container scanning, provenance, or minimal permissions (`.github/workflows/ci.yml:1-30`).
18. Confirmed. Backup helpers create and verify database copies, but no routine fresh-instance restore drill covers DB, artifact/data directory, config, versions, and health checks (`src/db.js:2016-2089`, `src/dashboard.js:1752-1762`).
19. Confirmed. Extension behavior is generated procedures/dynamic tools plus core-file growth; no formal extension manifest or installation lifecycle exists.
20. Confirmed. Documentation duplicates tool counts, runtime requirements, schemas, and tool reference data instead of being generated from one authoritative manifest.

## Current Failure Modes And Recovery Behavior

- Migration startup logs errors but continues process startup (`src/index.js:1314-1322`), which can leave a service running with missing tables.
- SQLite uses WAL, `busy_timeout`, and foreign keys, but migration application is not explicitly locked across processes (`src/db.js:27-32`, `src/db.js:2318-2342`).
- Approval payloads are encrypted and expired, but approval is bound to the queued encrypted args rather than an immutable plan/change-set hash (`src/tools.js:537-654`).
- Black Box captures handle source timeouts and truncation, but collectors are not child executions in a common graph (`src/blackbox.js:553-740`).
- Runbook rollback exists only inside autonomous runbook execution and is not represented as a durable rollback execution (`src/tools.js:9518-9559`).

## Test Inventory

Current test runner includes security/static checks, MCP sessions, approvals, generated tools/Evolve, database tools, Memory, Black Box, integration, dashboard API, health, CI status, deployment metadata, and agent protocol (`test/run-all.js:16-42`). Major gaps are restart recovery, isolated runner behavior, capability/RBAC policy, immutable approvals, normalized events, artifact retention/download authorization, backup fresh-restore drills, extension security, and behavioral evaluations.

## Threat Model Summary

- Primary assets: control-plane API key, dashboard credentials, Sidekick database, artifact/data directory, secret store, infrastructure access, service-management privileges, memory/handoff contents, Black Box evidence, generated tool definitions.
- Primary actors: human owner, OpenCode/MCP clients, dashboard sessions, Agent Bridge, generated tools, schedules/watches, background maintenance, future extensions, external webhooks.
- Main threats: unauthorized mutation, approval replay/input swap, command injection, child-process environment leakage, path traversal in artifacts/exports, stale or malicious memory execution, generated-tool privilege escalation, dashboard CSRF/XSS, event spoofing/replay, database lock/migration corruption, backup restore failure, supply-chain compromise.
- Current mitigations: non-placeholder API key checks, dashboard auth/rate limit/CSRF, redaction, dangerous shell pattern blocking, source-based tool policy, encrypted approval args, Black Box redacted artifacts, SQLite WAL/busy timeout, static secret scan tests.
- Unresolved risks: no capability/RBAC enforcement, no isolated runner, no universal change sets, no common event/execution graph, no immutable approval plan hash, incomplete restart recovery, no fresh restore drill, no supply-chain hardening workflow.

## Phase 0 Baseline Decisions

- Authoritative version source is not yet established. The repository currently says `1.0.0` in `package.json`; this should become the authoritative source or be replaced by a generated release metadata file in a later phase.
- Dependency reproducibility is not complete because there is no lockfile and CI uses `npm install`. A lockfile and `npm ci` should be added after verifying generated dependency changes in WSL.
- Platform consolidation should begin with additive kernel tables and validation primitives, then migrate subsystems through adapters. A flag-day rewrite would risk breaking current MCP/dashboard/agent behavior.

## Initial Implementation Slice

Migration `011_platform_kernel.sql` and `src/platform/kernel.js` establish additive primitives for:

- shared execution records with parent/root correlation, actor/client/project/session fields, state, risk, approval state, trace/span IDs, and result metadata;
- normalized execution events with event family, source, actor, subject, execution/task/session correlation, severity, sensitivity, dedupe key, causation/correlation IDs, and redaction state;
- artifact metadata with safe storage references, hashes, lineage, verification metadata, retention, sensitivity, and execution linkage;
- audited state transitions with explicit validation.

Existing subsystems remain source-of-truth until each is adapted. This keeps the repository runnable and testable while creating a single destination model.
