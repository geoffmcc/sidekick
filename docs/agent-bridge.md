# Agent Bridge

The Agent Bridge is implemented in `src/agent.js` and defaults to port 4099. It runs autonomous tasks outside the main opencode session.

## Purpose

The MCP server is reactive: a client calls a tool and receives a result. The Agent Bridge is task-oriented: the user submits a goal, Sidekick plans tool use, executes tools, records the transcript, and streams progress.

## Task lifecycle

1. A client submits a task to `POST /api/agent/run`.
2. The bridge creates a task ID and transcript file.
3. The agent loops until the goal is complete, fails, or reaches `SIDEKICK_MAX_ITERATIONS`.
4. Each tool call goes through `callTool` from `src/tools.js`.
5. Progress is emitted as Server-Sent Events through `/api/agent/stream/:taskId`.
6. Completed task history is available through `/api/agent/history` and `/api/agent/run/:id`.

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
