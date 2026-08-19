# Phase 1 — Current-System Threat Model

Status: active phase artifact

Baseline reviewed: `04979ebae34dc2a7a7531508d8e841478179443a` (`origin/main` after PR #467)

Branch: `security-phase-01-threat-model-20260819`

This document records the implementation-grounded threat model for the current
Sidekick runtime. It is an evidence artifact for Phase 1, not a claim that the
remaining security phases are complete.

## System and trust boundaries

Sidekick is a self-hosted agent platform with three separately supervised
network services:

- `sidekick-mcp` exposes the MCP tool surface and is the primary remote agent
  entry point.
- `sidekick-dashboard` exposes the browser/dashboard API and UI.
- `sidekick-agent` exposes the Agent Bridge and autonomous task loop.

The service processes share the Sidekick installation and data ownership model
but have distinct protocol entry points. The main trust boundaries are:

1. Internet/LAN clients → MCP authentication, source identity, dispatcher,
   policy, approval, timeout, redaction, and audit controls.
2. Browser clients → dashboard authentication, session cookies, CSRF controls,
   route authorization, and dashboard-to-agent calls.
3. Agent goals, memory, tool results, repository content, and web content →
   autonomous planning. These are data, not trusted policy or identity.
4. Sidekick process → OS account, subprocesses, filesystem, SQLite database,
   secret store, logs, and deployment commands.
5. Sidekick → outbound providers and targets, including LLM/Compute,
   containers, Proxmox, network/firewall systems, GitHub, web endpoints, and
   browser-controlled pages.
6. Sidekick coordinator → Compute workers/providers. Worker enrollment,
   scoped credentials, placement, job contracts, artifact custody, and
   revocation are the boundary controls.
7. Installed packs/modules → in-process executable code. Installation and
   enablement are therefore code-deployment trust decisions, not ordinary
   configuration.
8. Deployment host → Git remote, deployment account, systemd services,
   backups, package installation, and privileged service-management commands.

## Assets

The highest-value assets are:

- provider credentials, dashboard credentials, MCP credentials, worker
  enrollment credentials, cookies, API keys, and encrypted secret-store keys;
- filesystem contents, project workspaces, downloaded files, browser profiles,
  artifacts, evidence, backups, and temporary files;
- SQLite state, including identities, authorization, approvals, tool logs,
  memory, workflows, schedules, capability/module state, Compute jobs, and
  research records;
- tool policy, risk classification, approvals, execution provenance, source
  identity, audit records, and deployment state;
- infrastructure reachable through Sidekick: hosts, containers, VMs,
  firewalls, network devices, providers, and external services;
- autonomous-agent goals, context, persistent memory, generated capabilities,
  taught procedures, and workflow definitions;
- model prompts, responses, embeddings, private project data, and Compute
  artifacts;
- service availability and the integrity of Sidekick updates and backups.

## Identities and authority

Relevant principals include anonymous network clients, authenticated MCP
clients, dashboard users and roles, Agent Bridge callers, scheduler/watch/
workflow/internal callers, pack/module code, Compute coordinators and workers,
external providers, the Sidekick OS account, deployment administrators, and
the GitHub/repository identity.

Identity must be derived from authenticated server-side context. Caller input,
memory, prompt text, tool output, repository content, or a claimed source
field must not create a higher-trust principal. Every mutation and sensitive
read requires both authentication and authorization, with project/resource
scope where applicable.

## External entry points and execution paths

The current implementation exposes or schedules capability through:

- MCP requests and compatibility aliases;
- dashboard HTTP routes, browser sessions, Basic Auth compatibility, and
  dashboard-to-agent proxy routes;
- Agent Bridge goals, follow-ups, cancellation, continuation, and recovery;
- scheduler, cron, delay, watches, retries, batch, orchestration, runbooks,
  and workflow definitions;
- capability-pack and module lifecycle operations;
- generated/evolved tools and taught procedures;
- Compute job submission, worker enrollment/reconnection, artifact upload,
  model/provider administration, and inference routing;
- browser navigation/actions/downloads and Security Research ingestion,
  probes, evidence, validation, and reporting;
- provider operations for containers, Proxmox, Jellyfin, network/firewall,
  GitHub, webhooks, notifications, tunnels, and remote HTTP endpoints;
- deployment scripts, systemd service control, backups/restores, migrations,
  and package/install/update paths.

All production tool calls are expected to converge on the canonical registry,
dispatcher, policy, approval, timeout/cancellation, redaction, and audit seam.
Phase 2 will verify this exhaustively; this Phase 1 artifact records it as a
critical boundary and does not substitute for that verification.

## Attacker catalogue

Threats considered in later phase gates include:

- unauthenticated remote clients and compromised low-privilege credentials;
- malicious MCP clients, webhooks, prompts, goals, memory, tool results,
  repository content, filenames, symlinks, archives, and downloaded files;
- hostile web pages and browser content attempting prompt injection, SSRF,
  credential theft, local-file access, or artifact exfiltration;
- malicious or compromised capability packs, modules, Compute workers,
  providers, dependencies, repositories, and CI inputs;
- attackers with read access to Sidekick data, logs, backups, or environment
  files;
- attackers attempting privilege escalation from the `sidekick` OS account;
- attackers abusing replay, race, resource exhaustion, cross-project access,
  approval continuation, or stale worker/job state.

## Primary abuse cases

The campaign must establish evidence against these outcomes:

1. A caller bypasses authentication, authorization, source attribution, policy,
   risk classification, approval, or audit by selecting an alternate execution
   route.
2. A low-trust identity, prompt, memory item, tool result, or imported artifact
   gains authority or crosses a project/user boundary.
3. Shell, structured tools, filesystem paths, archives, subprocess environments,
   browser navigation, or provider URLs turn attacker-controlled data into
   code execution, traversal, SSRF, or credential exposure.
4. Secrets reach logs, errors, argv, inherited environments, artifacts,
   prompts, external providers, backups, or unauthorized reads.
5. A module, pack, workflow, generated capability, worker, or provider remains
   executable or trusted after disablement, revocation, failed verification,
   or scope loss.
6. Autonomous execution, schedules, retries, approvals, or recovery create
   unbounded, duplicate, destructive, or unaudited operations.
7. Dashboard sessions permit CSRF, XSS, IDOR/BOLA, fixation, theft, or
   sensitive caching; network interfaces permit unintended remote exposure.
8. Deployment, update, backup, restore, CI, or sudo boundaries permit supply
   chain compromise or OS privilege escalation.

## Phase-gate mapping

The following phases own the detailed verification and remediation of these
boundaries:

| Phase | Gate |
| --- | --- |
| 1 | Current implementation threat model, assets, principals, entry points, trust boundaries, attacker paths, and evidence ledger |
| 2 | Central execution dispatcher and alternate-path/approval-bypass audit |
| 3 | Authentication, identity, authorization, session, and resource-scope audit |
| 4 | Secure defaults, remote exposure, policy, and migration posture |
| 5 | Shell, subprocess, environment inheritance, and structured-command audit |
| 6 | Filesystem, archive, symlink, race, and artifact path audit |
| 7 | Secret flow, redaction, encryption, logging, and sensitive persistence audit |
| 8 | Outbound HTTP, SSRF, TLS, provider, and network policy audit |
| 9 | Dashboard/web CSRF, XSS, headers, sessions, and proxy audit |
| 10–20 | Packs/modules, browser, research, Compute, autonomy, memory, supply chain, deployment, CI, and adversarial verification gates |

## Evidence and current residuals

Phase 1 evidence is the source inventory above, the current service/deployment
layout, the live deployed commit, and the existing security regression suites.
The following are intentionally unresolved until their phase gates:

- completeness of dispatcher convergence and absence of unofficial dispatch;
- full route-by-route authentication and authorization proof;
- complete subprocess, filesystem, secret-flow, SSRF, pack/module, browser,
  research, Compute, memory, deployment, and CI audits;
- the final threat-model finding register, score, and residual-risk acceptance.

No phase is complete merely because an adjacent fix or test exists.
