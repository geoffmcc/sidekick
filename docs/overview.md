# Overview

Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It supports two ways to run the same product: a local stdio runtime launched directly by an MCP client without a dedicated server, and a dedicated server deployment with HTTP, dashboard, and Agent Bridge services. Both provide the same dynamically discovered tool catalog, persistent memory and knowledge, governed dispatcher, capability packs, workflows, and optional distributed Compute worker system. Query the live `tools` manifest for the current count and enabled state.

## Core idea

Sidekick does not replace the connected assistant or agent. It provides a persistent remote machine, governed MCP tools, durable context, and operational services. The companion `AGENTS.md` file is an optional portable template that can teach compatible clients where Sidekick is and how to use its long-lived capabilities.

A dedicated-server workflow looks like this:

1. A compatible client connects to the MCP server on port 4097.
2. The client authenticates and discovers the allowed Sidekick tool catalog.
3. Sidekick exposes its tool catalog.
4. The assistant calls tools to execute commands, inspect files, store persistent context, or operate services.
5. Data is written into the Sidekick data directory so the next session can continue from prior state.

For the no-dedicated-server option, the MCP client launches
`npx -y github:geoffmcc/sidekick` as a child process over stdio. The process
uses a platform-aware per-user data
home outside the npm cache, so the same durable state survives client restarts
and package upgrades. See `local-deployment.md` for configuration and local
troubleshooting.

## What Sidekick can do

Sidekick is broad by design. The current codebase includes tools for:

- shell, file, search, git, process, service, and archive operations;
- persistent key-value memory, explicit task sessions, handoffs, typed structured memories, and project context;
- GitHub API operations for pull requests, issues, releases, repository data, commit statuses, and read-only check-run/CI inspection;
- webhook receiving and dashboard inspection;
- cron jobs, one-shot delays, file/process/service/endpoint watches, task queues, retry wrappers, and batch tool calls;
- structured parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports;
- system health, snapshots, timelines, network diagnostics, dependency analysis, baselines, circuit breakers, runbooks, and incident captures;
- LLM calls routed through Compute across configured providers and models;
- learned procedures and approval-gated generated tools;
- allowlisted `chat`, `generate`, and `embeddings` jobs routed through enrolled Compute workers, providers, and models.

Bundled capability packs extend these foundations with API contract testing,
repository intelligence, browser automation, container and infrastructure
operations, database and storage administration, Jellyfin and Proxmox
integrations, networking, observability and incident response, security
research, supply-chain and reproducibility checks, testing and release
engineering, and continuity/proving workflows. The live `capability` and
`workflow` catalogs are authoritative for what a deployment has installed and
enabled.

## Main components

| Component | Role |
|---|---|
| MCP server | The public tool endpoint used by compatible MCP clients and agents. |
| Tool runtime | `src/tools/` owns descriptors, registry, dispatcher, request context, schemas, policy, approvals, result normalization, logging, and registry sync. Every handler is owned by a descriptor family under `src/tools/families/`, the `data-utilities` module, or `src/compute/tools.js`; `src/tools-legacy.js` retains only policy/approval/audit machinery, ordering anchors, and compatibility exports. |
| Dashboard | Browser-facing UI and API for monitoring and management. |
| Agent Bridge | Autonomous task loop that plans and executes tools through the same authoritative dispatcher. |
| Sidekick Compute | Optional enrolled worker agents, provider/model registry, routing, leases, jobs, cancellation, recovery, and artifacts for allowlisted model workloads. |
| Data layer | SQLite-backed persistent storage for KV data, logs, tool registry data, knowledge entries, and named JSON documents, plus file artifacts for transcripts, secrets, snapshots, queues, and exports. |
| Deployment scripts | Bootstrap a remote host, create the `sidekick` user, install Node.js, deploy services, and configure systemd. |

## Recommended operating model

Run Sidekick on a machine that is reliably available to its connected clients: a VPS, home server, mini PC, VM, or Raspberry Pi. Keep the MCP server protected with a strong API key and preferably expose it only over VPN, SSH tunnel, reverse proxy with authentication, or an IP allowlist.
