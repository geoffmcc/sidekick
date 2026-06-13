# Sidekick: A Persistent MCP-Based Operational Assistant Platform for AI Coding Workflows

## Abstract

Sidekick is a self-hosted operational assistant platform designed to extend opencode and other Model Context Protocol (MCP) clients with persistent, remote, tool-driven capabilities. Rather than functioning as a replacement for an AI coding assistant, Sidekick acts as a durable execution and coordination layer: it provides an MCP server, a browser dashboard, an autonomous agent bridge, and a file-backed state model for memory, logs, procedures, scheduled work, diagnostics, and operational history. The current implementation is a Node.js application composed of three cooperating services and a broad catalog of 60 exported `sidekick_*` tools. These tools enable remote shell execution, file manipulation, project memory, GitHub integration, service control, scheduled jobs, monitoring, network diagnostics, runbook execution, structured parsing, secret management, LLM calls, and experimental self-extension.

This paper describes Sidekick’s motivation, system architecture, data model, tool surface, operational model, security posture, and likely future direction. It argues that Sidekick is best understood as a persistent operational substrate for AI-assisted software development: a system that gives transient AI sessions continuity, environmental awareness, and controlled access to real infrastructure.

## 1. Introduction

Modern AI coding assistants are powerful but often ephemeral. A typical assistant session can inspect code, answer questions, generate patches, and execute available tools, but it usually lacks a durable operational environment that persists across conversations, machines, and restarts. Context must be reintroduced repeatedly. Project decisions may be scattered across chat transcripts. Remote services must be inspected manually. Scheduled checks, deployment state, incident notes, and learned procedures often live outside the assistant’s reach.

Sidekick addresses this gap by giving an MCP-capable coding assistant a persistent remote companion. The platform exposes a catalog of tools over the Model Context Protocol, stores operational memory on disk, and provides both a human-facing dashboard and an autonomous agent loop. Its intended role is not to become the primary AI assistant. Instead, it acts as the assistant’s long-lived machine: a stable environment where commands can run, files can be inspected, services can be managed, project context can accumulate, and follow-up work can be coordinated.

The project is especially relevant for workflows involving opencode, remote Linux hosts, small servers, VPS instances, home labs, or development environments where an AI assistant benefits from continuity. Sidekick allows the user to place an always-on service behind authentication, expose it through a controlled transport, and then let opencode call tools against that host as needed.

## 2. Design Goals

Sidekick’s design reflects several practical goals.

First, it aims to provide persistence across AI sessions. Project memory, key-value data, structured context, logs, debug findings, learned procedures, and agent transcripts are stored under a shared data directory. This lets future sessions recover information without relying entirely on the previous chat state.

Second, it aims to make real infrastructure accessible through structured tools. The platform includes tools for shell execution, file reading and writing, search, Git operations, process inspection, systemd service control, archiving, network diagnostics, endpoint checks, and incident captures. These capabilities make Sidekick useful as an operational interface to a remote host.

Third, it aims to combine reactive and autonomous modes. The MCP server supports direct tool calls from opencode or another MCP client. The Agent Bridge supports higher-level task submission, iterative planning, tool execution, transcript storage, and event streaming. The dashboard gives the user a browser-based control surface for observation and management.

Fourth, it emphasizes practical deployability. The codebase is a Node.js project with simple runtime scripts, environment-based configuration, example systemd units, and deployment scripts. Its storage model uses JSON and JSONL files rather than an external database, making backup and inspection straightforward.

Finally, it provides initial guardrails for a risky class of software. Because Sidekick can execute commands and manage services, it includes API-key authentication, optional IP allowlists, dashboard protections, command blocking patterns, output redaction, scoped sudo guidance, and encrypted secret storage. These controls reduce risk, though they do not turn Sidekick into a full sandbox.

## 3. System Architecture

Sidekick is implemented as a three-service Node.js application with a shared tool module and a shared persistent data directory.

The first service is the MCP server, implemented in `src/index.js`. It creates an MCP server using `@modelcontextprotocol/sdk`, registers the Sidekick tool definitions, and exposes Streamable HTTP endpoints on port 4097 by default. It also supports legacy SSE endpoints for older clients. The MCP server is the main interface used by opencode or another MCP-aware assistant.

The second service is the dashboard, implemented in `src/dashboard.js`. It defaults to port 4098 and serves a browser interface plus JSON API routes. The dashboard provides visibility into logs, key-value memory, system status, service status, tool metadata, webhook captures, and autonomous agent tasks. It also proxies agent requests to the Agent Bridge.

The third service is the Agent Bridge, implemented in `src/agent.js`. It defaults to port 4099 and runs task-oriented autonomous workflows. A user can submit a high-level task, after which the bridge creates a transcript, loops through planning and tool execution, streams progress events, and stores the result. It also reloads and manages delayed jobs and recurring watches.

The core behavior of Sidekick lives in `src/tools.js`. This module exports the `TOOLS` map, dashboard-facing `TOOL_DEFS`, a central `callTool(name, args)` dispatcher, logging functions, source tracking, and the implementations of all 60 exported tools. The MCP server, dashboard, and agent all depend on this shared tool layer.

A simplified architectural view is:

```text
opencode / MCP client
        |
        | Bearer token
        v
MCP Server :4097  ---- registers/calls ----> src/tools.js
        |                                      |
        |                                      v
        |                              SIDEKICK_DATA_DIR
        |
Browser Dashboard :4098 ---- proxy ----> Agent Bridge :4099
                                      ---- calls ----> src/tools.js
```

This architecture gives Sidekick clear boundaries. The MCP server handles protocol exposure. The dashboard handles human interaction and inspection. The Agent Bridge handles autonomous task execution. The tool module handles actual capabilities and shared persistent state.

## 4. MCP Server and Session Behavior

The MCP server exposes `POST /mcp`, `GET /mcp`, and `DELETE /mcp` for Streamable HTTP clients. It also exposes `GET /sse` and `POST /messages` for legacy SSE-based clients, plus `GET /health` for diagnostics.

MCP routes require authentication through either an `Authorization: Bearer <SIDEKICK_API_KEY>` header or an `api_key` query parameter. Header-based authentication is the cleaner and preferred approach. The server can also restrict access with `SIDEKICK_ALLOWED_IPS`, which accepts comma-separated IPv4 addresses or CIDR ranges. Localhost is always allowed.

The MCP server maintains sessions in memory. Each session tracks the server instance, transport, creation time, last access time, and initialization state. Inactive sessions are cleaned up after 24 hours. Streamable HTTP GET and DELETE operations require a valid `mcp-session-id` header. Stale POST sessions return a structured JSON-RPC error and provide a replacement session header so the client can reinitialize.

This session model is important because MCP clients may keep long-running connections or reuse session identifiers. Sidekick’s behavior attempts to be explicit when a session is missing, invalid, or stale, rather than silently accepting ambiguous state.

## 5. Tool Surface

The current source exports 60 Sidekick tools through both `TOOLS` and `TOOL_DEFS`. The tool catalog is broad and can be grouped into several functional areas.

Core file, shell, and code tools include command execution, file reading and writing, directory listing, web fetches, content search, structured Git operations, process management, systemd service operations, and archive creation or extraction. These are the foundation of Sidekick’s ability to act as a remote operational machine.

Persistent memory and project context tools include key-value storage, project-specific retrieval, structured context tracking, debug caches, and project summaries. These tools give the assistant a place to store and recall decisions, patterns, problems, and configuration notes across sessions.

Automation and orchestration tools include cron-style recurring jobs, one-shot delays, file/process/service/endpoint watches, task queues, retry wrappers, batch execution, circuit breakers, and runbooks. This turns Sidekick from a passive tool server into a lightweight operations coordinator.

Monitoring and diagnostics tools include health checks, snapshots, timelines, network diagnostics, dependency analysis, baselines, anomaly detection, and black-box incident captures. These tools are useful when Sidekick is used to operate services or troubleshoot infrastructure.

External integration tools include notifications, GitHub API operations, webhook capture, encrypted secrets, and commit/release-related workflows. These features connect Sidekick to common development and operational systems.

Data transformation tools include structured parsing, validation, templating, hashing, diffs, changelog generation, anonymization, and extraction. These help an assistant process project artifacts and produce structured outputs without repeatedly reinventing parsing logic.

AI and self-extension tools include calls to local Ollama or Groq, learned procedures, predictive suggestions, fresh-perspective analysis, evolution proposals, and `sidekick_respond`. The presence of `sidekick_respond` is notable because older repository text referenced 59 tools, while the reviewed source includes 60 exported handlers.

The result is a tool surface that is more than a basic remote shell. Sidekick functions as a combined execution host, memory store, diagnostics layer, automation engine, and integration broker.

## 6. Persistent Data Model

Sidekick stores state under `SIDEKICK_DATA_DIR`. In local development, this defaults to a `data/` directory relative to the repository. In the documented systemd deployment, the expected path is `/home/sidekick/sidekick/data`.

The data model is intentionally simple. Important files include `kvstore.json` for persistent memory, `context.json` for structured project context, `procedures.json` for learned workflows, `log.jsonl` for tool call logs, `audit.jsonl` for dashboard audit events, `dashboard-errors.log` for frontend or dashboard errors, `cron.json` for scheduled job metadata, `webhooks.json` for captured webhook payloads, and `conversations/` for agent transcripts. Additional features create their own JSON-backed state files for snapshots, queues, baselines, circuit breakers, runbooks, and incident captures.

The key-value store supports both legacy string values and a richer metadata object format. A current entry can include a value, project, category, source, created timestamp, and updated timestamp. The migration logic preserves backward compatibility by converting simple string values into metadata-backed entries while allowing `sidekick_get` to continue returning only the stored value.

This storage approach has clear advantages. It is transparent, easy to back up, easy to inspect, and does not require a database service. It also has tradeoffs. Very large files, high-frequency writes, or concurrent heavy mutations may become fragile. Sidekick is therefore best treated as a lightweight persistent state layer rather than a high-throughput database.

## 7. Dashboard and Human Control Surface

The dashboard provides Sidekick’s browser-facing interface. It is implemented directly in `src/dashboard.js` and exposes both a web UI and API routes. Through the dashboard, a user can inspect recent tool calls, browse and edit key-value entries, view system statistics, inspect configured tools, submit agent tasks, stream agent progress, view task history, receive webhooks, and clear selected data stores.

Dashboard API routes include endpoints for logs, key-value data, system information, dashboard summaries, LLM status, service status, configuration, statistics, tool metadata, webhook capture, and agent proxying. Mutating routes include key-value writes and deletes, log clearing, conversation clearing, full data resets, and internal error logging.

The dashboard also implements several protections. Basic Auth can be enabled by setting both `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS`. `SIDEKICK_DASHBOARD_ALLOWED_IPS` can restrict access by IP address or CIDR range. The dashboard also includes in-memory rate limiting, origin checks for mutating requests, audit logging, and frontend error logging.

A noteworthy implementation detail is that the dashboard’s root page is intentionally allowed through the Basic Auth middleware in the current code, while API routes are protected when authentication is configured. For private deployments this may be acceptable, but public exposure should use stronger outer protections such as a VPN, reverse proxy authentication, TLS, and firewall rules.

## 8. Agent Bridge and Autonomous Execution

The Agent Bridge is Sidekick’s task-oriented execution service. Unlike the MCP server, which is reactive, the bridge accepts a goal and performs iterative work. A task submitted to `POST /api/agent/run` receives a generated task ID and transcript file. The agent then loops until it completes, fails, or reaches `SIDEKICK_MAX_ITERATIONS`, which defaults to 15. Each tool call is routed through `callTool` in `src/tools.js`, and progress is streamed through Server-Sent Events.

The Agent Bridge stores transcripts under `data/conversations/` and removes transcript files older than 30 days on startup. This provides useful operational history without allowing old conversations to accumulate indefinitely.

The bridge also loads pending one-shot delays created by `sidekick_delay` and active watches created by `sidekick_watch`. Delays are scheduled into timers and executed through Sidekick tools when due. Watches can monitor services, processes, endpoints, or files on intervals and trigger another tool when a condition is met. These features let Sidekick continue useful work independently of an active opencode session.

This autonomous layer is one of the project’s most significant design ideas. It moves Sidekick beyond a set of manually invoked tools and toward a persistent assistant process that can observe, react, and record what it did.

## 9. Security Analysis

Sidekick’s power creates risk. A deployed instance can run shell commands, read and write files, manage services, store secrets, call external APIs, and retain operational logs. For that reason, Sidekick should be treated as remote administrative access to the host.

The primary MCP security control is the API key. The default development value, `sk-sidekick-local-dev`, must be changed before any real deployment. IP allowlists can further restrict the MCP server, and public exposure should preferably be avoided. The safest deployment model is VPN-only, SSH tunnel-only, private reverse proxy, or strict firewall allowlisting.

The dashboard has optional Basic Auth and its own IP allowlist. It also includes rate limiting, audit logging, origin checks, and error logging. These are valuable protections, but they should not be treated as a substitute for network-level access control if the dashboard is reachable from untrusted networks.

The command execution layer includes pattern-based blocking for obviously dangerous commands such as recursive root deletion, block-device writes, filesystem creation, fork-bomb patterns, curl or wget piped directly to a shell, and recursive world-writable permission changes against root. This is useful as a guardrail but should not be mistaken for a sandbox. A sufficiently creative destructive command may bypass simple pattern matching. The correct operational posture is least privilege: run Sidekick as a dedicated user and grant only narrowly scoped sudo permissions.

Sidekick also includes output redaction through `src/redact.js`, with tests covering private keys, GitHub tokens, and other secret-like values. Redaction reduces accidental leakage in tool results and logs, but no redaction system can guarantee complete protection against every possible secret format. Encrypted credential storage is available through `sidekick_secret` using AES-256-GCM, but it requires `SIDEKICK_SECRET_KEY` and careful management of that key outside the repository.

## 10. Deployment and Operations

The project’s runtime scripts are straightforward: `npm start` runs the MCP server, `npm run dashboard` runs the dashboard, and `npm run agent` runs the Agent Bridge. The main dependencies include the MCP SDK, Express, CORS, Zod, AJV, YAML, INI, fast XML parser, and Handlebars.

The documented systemd deployment expects the project at `/home/sidekick/sidekick` and runs the services as the `sidekick` user and group. Operational commands include checking and restarting `sidekick-mcp`, `sidekick-dashboard`, and `sidekick-agent` with `systemctl`, and inspecting logs with `journalctl`.

Health checks are exposed at `http://127.0.0.1:4097/health` for the MCP server, `http://127.0.0.1:4099/api/health` and `/api/agent/status` for the Agent Bridge, and `http://127.0.0.1:4098/api/system` for the dashboard.

The most important operational asset is the data directory. Backups should include `SIDEKICK_DATA_DIR`, especially `kvstore.json`, `context.json`, `procedures.json`, webhook state if used, and relevant conversation transcripts. The `.env` file should also be backed up securely because it can contain API keys and secrets.

Common operational failure modes include missing dependencies, incorrect working directories, stale MCP sessions, unavailable LLM providers, and invalid opencode MCP configuration. For example, a `Cannot find module express` error generally means `npm install --omit=dev` was not run from the project directory. A `Missing key mcp.sidekick.enabled` error indicates that opencode expects an `enabled: true` property in the MCP configuration entry.

## 11. Strengths and Limitations

Sidekick’s strongest feature is its breadth. It combines remote execution, persistent memory, service management, automation, diagnostics, dashboard inspection, and agentic task execution in a single deployable project. This makes it useful for solo developers, home-lab operators, and AI-assisted development workflows where continuity matters.

Another strength is transparency. Because state is JSON and JSONL backed, a user can inspect, back up, repair, or migrate data without specialized infrastructure. The Node.js service split is also easy to understand: MCP for tool access, dashboard for humans, agent bridge for autonomous work.

The project’s main limitation is also tied to its simplicity. File-backed storage is easy to operate but not ideal for heavy concurrent use. Pattern-based command safety is useful but incomplete. The autonomous agent loop is powerful but requires careful operational constraints, especially when combined with tools that can mutate files, restart services, or call external APIs.

Sidekick should therefore be deployed as a trusted personal or small-team tool, not as an open multi-tenant platform. Its best operating model is controlled access, strong authentication, least-privilege service permissions, regular backups, and careful review of newly added tools.

## 12. Future Direction

The project naturally points toward several future improvements.

A more formal permission model would strengthen safety. Tools could be grouped into read-only, mutating, privileged, network, and destructive categories, with per-client or per-task authorization. This would let opencode use safe inspection tools broadly while requiring explicit approval for risky operations.

A stronger persistence layer could improve reliability as the amount of state grows. SQLite would preserve the simplicity of local deployment while offering safer concurrent writes, queryable history, migrations, and transactional updates.

The dashboard could evolve into a fuller operations console with richer task timelines, per-tool audit views, approval queues, configuration editors, and incident reports. The Agent Bridge could benefit from more explicit planning state, dry-run modes, and policy checks before executing mutating tools.

Finally, Sidekick’s self-extension features could become more reliable if generated tools moved through a structured lifecycle: proposal, static review, test execution, human approval, staged enablement, and rollback.

## 13. Conclusion

Sidekick is a practical attempt to solve a real limitation in AI-assisted software development: the lack of a persistent, operationally aware companion environment. By combining an MCP server, shared tool layer, browser dashboard, autonomous agent bridge, and file-backed memory model, it gives opencode a durable set of capabilities that survive across sessions.

The reviewed codebase shows a broad and ambitious platform. Its 60 exported tools cover not only shell and file operations, but also project memory, GitHub integration, scheduling, monitoring, diagnostics, runbooks, incident capture, structured data processing, LLM calls, and self-extension. This makes Sidekick less like a simple MCP utility and more like a lightweight operational substrate for AI-driven development.

The correct deployment posture is cautious but optimistic. Sidekick is powerful enough to be useful and powerful enough to require respect. When placed behind strong authentication, network restrictions, scoped permissions, and regular backups, it can become a valuable bridge between an AI coding assistant and the real systems that assistant is helping manage.
