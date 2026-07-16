# Overview

Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge, and an optional distributed Compute worker system. Current `main` contains 107 built-in tools across 20 categories, with separately approved generated tools added at runtime.

## Core idea

Sidekick does not replace the connected assistant or agent. It provides a persistent remote machine, governed MCP tools, durable context, and operational services. The companion `AGENTS.md` file is an optional portable template that can teach compatible clients where Sidekick is and how to use its long-lived capabilities.

A normal workflow looks like this:

1. A compatible client connects to the MCP server on port 4097.
2. The client authenticates and discovers the allowed Sidekick tool catalog.
3. Sidekick exposes its tool catalog.
4. The assistant calls tools to execute commands, inspect files, store persistent context, or operate services.
5. Data is written into the Sidekick data directory so the next session can continue from prior state.

## What Sidekick can do

Sidekick is broad by design. The current codebase includes tools for:

- shell, file, search, git, process, service, and archive operations;
- persistent key-value memory, explicit task sessions, handoffs, typed structured memories, and project context;
- GitHub API operations for pull requests, issues, releases, repository data, commit statuses, and read-only check-run/CI inspection;
- webhook receiving and dashboard inspection;
- cron jobs, one-shot delays, file/process/service/endpoint watches, task queues, retry wrappers, and batch tool calls;
- structured parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports;
- system health, snapshots, timelines, network diagnostics, dependency analysis, baselines, circuit breakers, runbooks, and incident captures;
- LLM calls through local Ollama or Groq;
- learned procedures and approval-gated generated tools;
- allowlisted `chat`, `generate`, and `embeddings` jobs routed through enrolled Compute workers, providers, and models.

## Main components

| Component | Role |
|---|---|
| MCP server | The public tool endpoint used by compatible MCP clients and agents. |
| Tool runtime | `src/tools/` owns descriptors, registry, dispatcher, request context, schemas, policy, approvals, result normalization, logging, and registry sync. Most established handlers remain in `src/tools-legacy.js` behind compatibility adapters while modular extraction continues. |
| Dashboard | Browser-facing UI and API for monitoring and management. |
| Agent Bridge | Autonomous task loop that plans and executes tools through the same authoritative dispatcher. |
| Sidekick Compute | Optional enrolled worker agents, provider/model registry, routing, leases, jobs, cancellation, recovery, and artifacts for allowlisted model workloads. |
| Data layer | SQLite-backed persistent storage for KV data, logs, tool registry data, knowledge entries, and named JSON documents, plus file artifacts for transcripts, secrets, snapshots, queues, and exports. |
| Deployment scripts | Bootstrap a remote host, create the `sidekick` user, install Node.js, deploy services, and configure systemd. |

## Recommended operating model

Run Sidekick on a machine that is reliably available to its connected clients: a VPS, home server, mini PC, VM, or Raspberry Pi. Keep the MCP server protected with a strong API key and preferably expose it only over VPN, SSH tunnel, reverse proxy with authentication, or an IP allowlist.
