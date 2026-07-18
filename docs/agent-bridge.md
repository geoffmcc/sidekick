# Agent Bridge

The Agent Bridge is implemented in `src/agent.js` and defaults to port 4099. It runs autonomous tasks outside the main opencode session.

## Purpose

The MCP server is reactive: a client calls a tool and receives a result. The Agent Bridge is task-oriented: the user submits a goal, Sidekick plans tool use, executes tools, records the transcript, and streams progress.

## Task lifecycle

1. A client submits a task to `POST /api/agent/run`.
2. The bridge creates a task ID and transcript file.
3. The agent loops until the goal is complete, fails, or reaches `SIDEKICK_MAX_ITERATIONS`.
4. Each tool call goes through `callAgentTool` from `src/tools.js`.
5. Progress is emitted as Server-Sent Events through `/api/agent/stream/:taskId`.
6. Completed task history is available through `/api/agent/history` and `/api/agent/run/:id`.

## Request routing

Each goal is classified by `requiresToolUse` (in `src/agent-protocol.js`) into one of two paths:

- **Direct answer.** Conceptual prompts ("explain…", "describe…", "what is the capital of France") are answered by the LLM in plain text and never touch tools. This keeps ordinary conversation fast and side-effect free.
- **Tool loop.** Requests that can only be answered from live state — including **system-inspection** requests such as "check disk usage", "how much free memory is available", "what is the CPU load", or "show running processes" — are routed to the tool loop so the agent runs an approved tool and returns the actual result instead of merely describing a command.

Classification is heuristic: a request that names a Sidekick tool, a Sidekick resource, or a live host resource (disk, CPU, memory/RAM, swap, uptime, processes, ports, network) routes to the tool loop; a purely conceptual prompt about those same resources ("explain how disk usage works") stays conversational.

## Tool execution and security boundary

The tool loop lives in `src/agent-loop.js` (`runToolLoop`). It performs no privileged work itself. For every tool the model requests it:

1. Rejects any tool that is **not visible to the agent source** (`getToolDefsForSource("agent")`, filtered by policy) before dispatch — unavailable or disallowed tools never reach execution.
2. Forwards allowed calls to `callAgentTool`, which enforces the tool allowlist, tool policy, approval controls, timeouts, and audit logging centrally in the dispatcher (`src/tools/dispatcher.js`). The Agent Bridge does not bypass any of these controls and does not expose arbitrary shell execution; shell access is only available through the same policy-gated `sidekick_bash` tool.
3. Surfaces the structured result back into the transcript and stream — success output, policy denials, approval-required notices, and execution failures are all reported clearly in the Agent tab rather than being swallowed.

Because `runToolLoop` takes its LLM and tool functions as injected dependencies, the approved / denied / unavailable / failing / no-tool behaviors are covered directly by `test/agent-loop.test.js` without starting the server.

## LLM behavior

The agent can use Groq when `GROQ_API_KEY` is configured and can fall back to local Ollama through `OLLAMA_URL`. The exact behavior depends on environment and implemented provider selection in `agent.js`.

## Conversation retention

Task transcripts are stored under `data/conversations/`. On startup, the Agent Bridge deletes transcript files older than 30 days.

## Delays

`sidekick_delay` stores one-shot scheduled jobs. The Agent Bridge loads pending delays at startup, creates timers, executes them at the scheduled time through `callTool`, and updates their status to completed or failed.

## Watches

`sidekick_watch` stores recurring watches. The Agent Bridge loads active watches at startup and checks them on intervals. Watch sources include services, processes, endpoints, and files. If a watch condition triggers, it can call another Sidekick tool with templated values such as source, target, status, and time.

## Safety limits

The main safety control is `SIDEKICK_MAX_ITERATIONS`, which defaults to 15. Tool-level safety still applies: dangerous shell commands are blocked by pattern checks, output redaction is applied, and tools return structured errors.
