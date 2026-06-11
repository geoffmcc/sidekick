# Agent Bridge

The agent bridge is implemented in `src/agent.js` and listens on `127.0.0.1:<SIDEKICK_AGENT_PORT>`, default `127.0.0.1:4099`.

## Purpose

The bridge turns a user goal into an autonomous tool-using loop. It is designed to run independently from an opencode session and is normally accessed through the dashboard.

## Task Lifecycle

1. A client posts `{ "goal": "..." }` to `/api/agent/run`.
2. The bridge creates an eight-character task ID from a UUID and returns it.
3. The bridge starts `runAgent(goal, taskId)` asynchronously.
4. A client connects to `/api/agent/stream/:taskId` for Server-Sent Events.
5. The agent calls the configured LLM repeatedly until the task is done, an error occurs, or `SIDEKICK_MAX_ITERATIONS` is reached.
6. The transcript is saved to `data/conversations/<taskId>.json`.
7. If possible, the bridge analyzes whether the tool sequence should become a reusable procedure.

## LLM Selection

The bridge uses Groq when `GROQ_API_KEY` is set. Otherwise, it calls local Ollama at `127.0.0.1:11434` with model `phi3:mini`.

Groq calls use:

- `GROQ_MODEL`, default `llama-3.1-8b-instant`.
- Temperature `0.3` for agent decisions.
- Retry behavior for HTTP 429 responses.

## Decision Protocol

The agent system prompt instructs the LLM to emit raw JSON in one of three forms:

```json
{ "think": "reasoning text" }
```

```json
{ "tool": "sidekick_tool_name", "arguments": { "key": "value" } }
```

```json
{ "done": true, "result": "final answer" }
```

The bridge parses the first valid JSON object from the model response. If no JSON is found, it treats the response as a thought.

## Safeguards

The bridge includes several execution controls:

- `SIDEKICK_MAX_ITERATIONS` limits loop length.
- Repeated identical tool calls are blocked if the same tool and arguments were used recently.
- Hallucinated tool calls in thought text are detected with simple pattern checks and corrected by prompting the LLM to issue an actual tool call.
- Tool outputs added to model history are truncated.
- Conversation transcripts are pruned at startup if older than 30 days.

## Delays and Watches

The agent bridge also schedules pending one-shot delays and active watches:

- `delays.json` is loaded at startup and pending entries are scheduled with `setTimeout()`.
- `watches.json` is loaded at startup and active watches are scheduled with `setInterval()`.
- `/api/delays/reload` reloads delay schedules.
- `/api/watches/reload` clears existing watch intervals and reloads active watches.

Because these timers are in memory, they depend on the bridge process being alive.

## Procedure Suggestion

After a task completes, the bridge may analyze the tool-call transcript. If the task used at least three tool calls and Groq is configured, it asks the LLM whether the sequence is reusable.

If the LLM returns a valid save recommendation, the bridge calls `sidekick_teach` with action `teach_procedure`. The procedure becomes available as `sidekick_<name>` after the MCP server restarts.

## Agent API

| Method | Path | Description |
|---|---|---|
| POST | `/api/agent/run` | Start a task. Body must include `goal`. Returns `taskId`. |
| GET | `/api/agent/stream/:taskId` | Stream task events as Server-Sent Events. |
| GET | `/api/agent/history` | Return the 20 most recent saved transcripts. |
| GET | `/api/agent/run/:id` | Return a saved transcript by ID. |
| GET | `/api/health` | Return `{ "ok": true }`. |
| POST | `/api/delays/reload` | Reload delay timers from storage. |
| POST | `/api/watches/reload` | Reload watch intervals from storage. |
