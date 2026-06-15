# Overview

Sidekick is a self-hosted operational assistant platform for opencode. It provides a remote MCP server, a browser dashboard, and an autonomous agent bridge. The goal is to give an AI coding assistant persistent capabilities that survive across sessions: remote shell execution, file access, project memory, service operations, GitHub integration, scheduled jobs, monitoring, diagnostics, and self-extension.

## Core idea

Sidekick does not replace opencode. It gives opencode a persistent remote machine and a set of tools. The companion `AGENTS.md` file tells opencode what Sidekick is, when to use it, and how to treat the remote service as a long-lived assistant environment.

A normal workflow looks like this:

1. opencode starts and reads `AGENTS.md`.
2. opencode connects to the MCP server on port 4097.
3. Sidekick exposes its tool catalog.
4. The assistant calls tools to execute commands, inspect files, store persistent context, or operate services.
5. Data is written into the Sidekick data directory so the next session can continue from prior state.

## What Sidekick can do

Sidekick is broad by design. The current codebase includes tools for:

- shell, file, search, git, process, service, and archive operations;
- persistent key-value memory and structured project context;
- GitHub API operations for pull requests, issues, releases, repo info, and commit status;
- webhook receiving and dashboard inspection;
- cron jobs, one-shot delays, file/process/service/endpoint watches, task queues, retry wrappers, and batch tool calls;
- structured parsing, validation, templating, hashing, diffs, changelog generation, anonymization, and extraction;
- system health, snapshots, timelines, network diagnostics, dependency analysis, baselines, circuit breakers, runbooks, and incident captures;
- LLM calls through local Ollama or Groq;
- learned procedures and experimental self-extension.

## Main components

| Component | Role |
|---|---|
| MCP server | The public tool endpoint used by opencode or another MCP client. |
| Tool module | Implements all Sidekick tools, tool policy, redaction, logging, and persistent state helpers. |
| Dashboard | Browser-facing UI and API for monitoring and management. |
| Agent Bridge | Autonomous task loop that can plan and execute Sidekick tool calls. |
| Data directory | Persistent storage for KV data, logs, contexts, secrets, snapshots, jobs, transcripts, and state files. |
| Deployment scripts | Bootstrap a remote host, create the `sidekick` user, install Node.js, deploy services, and configure systemd. |

## Recommended operating model

Run Sidekick on a machine that is always available to opencode: a VPS, home server, mini PC, VM, or Raspberry Pi. Keep the MCP server protected with a strong API key and preferably expose it only over VPN, SSH tunnel, reverse proxy with authentication, or an IP allowlist.
