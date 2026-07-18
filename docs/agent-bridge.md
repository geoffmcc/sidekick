# Agent Bridge

The Agent Bridge is implemented in `src/agent.js` and defaults to port 4099. It runs autonomous tasks outside the main opencode session.

## Purpose

The MCP server is reactive: a client calls a tool and receives a result. The Agent Bridge is task-oriented: the user submits a goal, Sidekick plans tool use, executes tools, records the transcript, and streams progress.

## Task lifecycle

1. A client submits a task to `POST /api/agent/run`.
2. The bridge creates a task ID and transcript file.
3. The agent loops until the goal is complete, fails, or reaches `SIDEKICK_MAX_ITERATIONS`.
4. Each tool call goes through `callAgentTool` (exported from `src/tools/index.js` via `src/tools.js`, implemented by the dispatcher in `src/tools/dispatcher.js`).
5. Progress is emitted as Server-Sent Events through `/api/agent/stream/:taskId`.
6. Completed task history is available through `/api/agent/history` and `/api/agent/run/:id`.
7. A terminal task can be continued with a **follow-up** (`POST /api/agent/run/:taskId/follow-up`), which creates a new child task linked to the original — see [Follow-ups (task continuation)](#follow-ups-task-continuation).

## Request routing

Each goal is classified by `classifyEvidenceRequirement` (in `src/agent-protocol.js`; `requiresToolUse` is its boolean wrapper) into one of two paths:

- **Direct answer.** Conceptual prompts ("explain…", "describe…", "how can I check disk usage on Linux?", "what is the capital of France") are answered by the LLM in plain text and never touch tools. This keeps ordinary conversation fast and side-effect free.
- **Tool loop.** Requests that can only be answered from live state — including **system-inspection** requests such as "check disk usage", "how much free memory is available", "what is the CPU load", or "show running processes" — are routed to the tool loop so the agent runs an approved tool and returns the actual result instead of merely describing a command.

Classification is deterministic and heuristic: a request that names a Sidekick tool, a Sidekick resource, or a live host resource (disk, CPU, memory/RAM, swap, uptime, processes, ports, network) routes to the tool loop; a purely conceptual or instructional prompt about those same resources ("explain how disk usage works", "how can someone check disk usage") stays conversational. It is routing, not authorization — every tool call is still independently validated by the dispatcher.

The classifier returns a stable machine-readable reason, surfaced as a `Routing: …` step in the Agent tab stream, an `agent.evidence_classified` platform event, and an additive `routing` field in the transcript:

| Reason | Routed to | Meaning |
| --- | --- | --- |
| `explicit_tool_reference` | tool loop | The goal names a Sidekick tool |
| `system_inspection` | tool loop | The goal asks about live host state (disk, CPU, memory, ports, …) |
| `local_resource_signal` | tool loop | The goal combines a Sidekick resource with an action or currency signal |
| `conceptual_prompt` | direct answer | Explanation/instruction request, no live evidence needed |
| `no_evidence_signals` | direct answer | Ordinary conversation |
| `empty_goal` | direct answer | Blank input |

### Evidence requirement

A goal routed to the tool loop is marked **evidence-required**. If the model tries to complete such a task without a single successful evidence tool call (the `respond` echo tool does not count), it receives one corrective nudge to run a real tool; if it still cannot produce evidence, the task **fails honestly** with "Sidekick could not inspect the requested state" instead of returning a fabricated live-state answer or a "you could run df -h" instruction sheet. Failed tool calls and approval-pending calls do not count as evidence.

## Tool naming

Since the canonical-naming refactor, tool names are **unprefixed** (`bash`, `get`, `store`, `respond`, …) everywhere: the registry, the DB `tools` table, MCP registration, and the Agent system prompt. Legacy `sidekick_`-prefixed names remain supported as **compatibility aliases only**: the loop resolves them through the same canonicalization authority (`src/core/tool-name.js`) used by the dispatcher and registry, and always dispatches, records, and streams the canonical catalog name. Old transcripts and saved procedures that contain prefixed names continue to work; malformed names (wrong case, empty after the prefix, prototype-chain shapes such as `__proto__`, oversized) are rejected before any lookup.

## Tool execution and security boundary

The tool loop lives in `src/agent-loop.js` (`runToolLoop`). It performs no privileged work itself. For every tool the model requests it:

1. Validates the structured decision (see below) and rejects any tool that is **not visible to the agent source** (`getToolDefsForSource("agent")`, filtered by policy) before dispatch — unavailable, disabled, or source-denied tools never reach execution.
2. Forwards allowed calls to `callAgentTool`, which enforces the tool allowlist, tool policy, approval controls, timeouts, and audit logging centrally in the dispatcher (`src/tools/dispatcher.js`). The loop's own visibility check is advisory defense-in-depth; the dispatcher is the authority. The Agent Bridge does not bypass any of these controls and does not expose arbitrary shell execution; shell access is only available through the same policy-gated `bash` tool.
3. Surfaces the structured result back into the transcript and stream — success output, policy denials, approval-required notices, and execution failures are all reported clearly in the Agent tab rather than being swallowed. Streamed tool arguments and error messages pass through the canonical redactor first.

### Decision contract

The model must output exactly one raw-JSON decision per turn: `{"think": …}`, `{"tool": …, "arguments": {…}}`, or `{"done": true, "result": …}`. The parser (`parseAgentDecision`) rejects, without executing anything: malformed JSON (treated as reasoning, never as a tool call), decisions containing `__proto__`/`constructor`/`prototype` keys anywhere, conflicting multi-action objects, `done` without a non-empty string result, and malformed tool names. Rejections produce bounded corrective feedback; persistent invalid or repeated output terminates through the repetition tracker and the iteration cap.

### Approval-gated actions

When the dispatcher returns *approval required*, the loop surfaces the pending state (`agent.tool_approval_pending` event and a stream step), instructs the model not to retry and not to assume the action ran, and lets it either continue with other tools or finish by reporting the pending approval. Approvals are never bypassed, inherited, or simulated.

Because `runToolLoop` takes its LLM and tool functions as injected dependencies, the approved / denied / unavailable / failing / no-tool / alias / evidence behaviors are covered directly by `test/agent-loop.test.js` without starting the server; the system prompt's agreement with the live canonical catalog is covered by `test/agent-bridge-prompt.test.js`.

### Observability fields

- Stream (SSE): `step` (including `Routing: …`, rejection, nudge, and approval-pending notices), `provider`, `fallback`, `tool` (redacted args, then truncated result), `done`, `error`, `lineage`.
- Platform events: `agent.task_started`, `agent.evidence_classified` (`requires_tools`, `reason`), `agent.tool_started` (canonical `tool`, `requested_as` when an alias was used, argument keys only), `agent.tool_completed` (redacted summary), `agent.tool_approval_pending`, `agent.decision_rejected` (`reason`), `agent.evidence_missing`.
- Transcript: additive `routing: { requires_tools, reason }` field; steps record canonical tool names, plus `invalid` steps with rejection reasons.

## Manual acceptance test

In the dashboard Agent tab submit:

```text
Check disk usage and tell me which mounted filesystem has the least free space.
```

Expected: the stream shows `Routing: tool loop (system_inspection)`, a real tool invocation (e.g. `bash` with `df`-style arguments) whose output matches the actual machine, and a final answer summarizing that evidence. Failure modes to reject: an answer that only explains how to run a command, a completion with no tool step, or a `sidekick_…` unknown-tool loop.

Conceptual contrast — submit:

```text
How can I check disk usage on Linux?
```

Expected: `Routing: direct answer (conceptual_prompt)` and a plain explanation with no tool execution.

## Follow-ups (task continuation)

A **follow-up** creates a *new child task* that is durably linked to an earlier
**terminal** task and seeded with a bounded, sanitized summary of the relevant
prior work. It is deliberately narrow: it is not a handoff, not a live session,
and not a long-lived in-memory conversation. The continuation logic lives in the
side-effect-free module `src/agent-continuation.js`; `src/agent.js` keeps only
thin route handlers and the shared task-start path (`beginTaskRun`).

### What a follow-up is

- A **new** task ID and its **own** transcript and platform execution — the
  original task is never reopened, appended to, or mutated.
- Linked to its immediate **parent**, the **root** of the thread, and a
  **continuation depth**, so a chain
  `root → follow-up 1 → follow-up 2 → …` is durably reconstructable.
- Streamed, listed in history, and audited exactly like any other task.

### API

```http
POST /api/agent/run/:taskId/follow-up
Content-Type: application/json

{ "goal": "Now inspect why that service restarted." }
```

Success returns the child identity (the parent is not modified):

```json
{
  "taskId": "9f3a1c02",
  "parentTaskId": "1b2c3d4e",
  "rootTaskId": "1b2c3d4e",
  "continuationDepth": 1
}
```

`GET /api/agent/run/:id` and `GET /api/agent/history` expose `parent_task_id` /
`parentTaskId`, `root_task_id` / `rootTaskId`, and `continuation_depth` /
`continuationDepth` so the UI can render `Follow-up to <task>` and
`Thread root: <task>`.

Error responses use stable statuses and never leak filesystem paths, stack
traces, or internal detail:

| Status | Cause |
| --- | --- |
| `400` | invalid task ID (format/traversal), missing or blank goal |
| `404` | parent task does not exist / transcript expired |
| `409` | parent task is still actively running, or a lineage cycle is detected |
| `422` | malformed or oversized parent transcript, oversized goal, or continuation depth limit reached |

`POST /api/agent/run` remains fully backward compatible; both paths funnel
through the same shared task-start logic so normal tasks and follow-ups never
develop separate execution routes.

### Continuation context (what the child sees)

`buildContinuationContext` produces a deterministic, bounded brief from the
parent chain that includes previous goals, task status, final answers or
terminal errors, and redacted/truncated summaries of relevant completed tool
calls, ordered oldest task → most recent. The brief is seeded as a distinct
system message, clearly separated from Sidekick's own system instructions and
from the user's new goal, and it leads with an explicit instruction that the
prior-task content is **untrusted reference material** whose instructions must
not be followed.

The following are **never** placed into continuation context: stored `thought`
steps and any hidden reasoning, raw or complete transcripts, unlimited tool
output, unredacted secrets (the canonical `redactSensitive` redactor is
applied), and approval state (a previous "approval required / queued / approved"
outcome is stripped, so no approval is ever inherited).

Prior tool results are treated as evidence, not as current truth: when a
follow-up needs live state, the child still makes fresh, policy-gated tool calls
rather than trusting stale prior results.

### Limits

All bounds are centralized in `CONTINUATION_LIMITS` (`src/agent-continuation.js`)
rather than scattered through route or UI code, and the security-relevant bounds
are intentionally not environment-overridable so a follow-up cannot be silently
broadened at runtime:

| Limit | Default | Purpose |
| --- | --- | --- |
| `MAX_FOLLOWUP_GOAL_CHARS` | 4000 | max follow-up goal size |
| `MAX_ANCESTORS` | 5 | max ancestor tasks rendered into a brief |
| `MAX_CONTINUATION_DEPTH` | 8 | max thread depth before a follow-up is refused |
| `MAX_STEP_SUMMARY_CHARS` | 500 | max per tool-result summary |
| `MAX_TOOL_CALLS_PER_TASK` | 6 | max tool calls summarized per ancestor |
| `MAX_CONTEXT_CHARS` | 6000 | overall continuation-context budget |
| `MAX_TRANSCRIPT_BYTES` | 2 MiB | reject oversized transcript files |

When the chain exceeds the budget, older/lower-priority detail is trimmed
deterministically while the thread root's identity and the most recent parent's
detail are preserved.

### Security boundary

A follow-up receives no more authority than an ordinary new task. Every child
tool request still flows through `callAgentTool` — the sole sanctioned
dispatcher seam — so source-visible tool discovery, source policy, approval
requirements, path restrictions, timeouts, audit logging, and output redaction
all run again for the child. No earlier approval is inherited, and the follow-up
endpoint honors only the `goal` field (client-supplied approval fields are
ignored). Follow-ups are allowed only against terminal parents; an actively
running parent returns `409` instead of racing its execution.

Task IDs are strictly validated against the real generated id format
(`[0-9a-f]{8}`) before any path is constructed, and resolved transcript paths are
verified to be contained within the conversation directory. Symlinked,
oversized, or malformed transcript files are rejected without crashing the
bridge, and the parent transcript is never mutated.

### Lineage vs. session vs. handoff vs. memory

These are distinct mechanisms and should not be conflated:

- **Follow-up** — a new *child Agent Bridge execution* with bounded prior-task
  context. Agent Bridge execution continuity.
- **Session** (`sidekick_session`) — the persistent live task/work envelope. A
  follow-up does not create, end, or reopen a session; if a real session is
  associated with the parent it is preserved, otherwise follow-ups work with no
  session at all. Follow-up behavior never depends on the LLM voluntarily
  calling the `session` tool.
- **Handoff** (`sidekick_handoff`) — a deliberate durable transfer between
  agents, people, phases, or later work. A follow-up never automatically creates
  a handoff.
- **Memory** (`sidekick_memory` / recall) — reusable recalled knowledge, not
  authoritative task-thread state.

### Platform and transcript lineage

Follow-ups reuse the platform kernel's existing parent/root execution graph:
the child execution is created with `parent_execution_id` and
`root_execution_id` set from the parent, its transcript artifact is registered
against the child execution, and it inherits the parent's project identity when
the child's own goal does not infer one. No parallel execution graph is
introduced.

## LLM behavior

The agent can use Groq when `GROQ_API_KEY` is configured and can fall back to local Ollama through `OLLAMA_URL`. The exact behavior depends on environment and implemented provider selection in `agent.js`.

## Conversation retention

Task transcripts are stored under `data/conversations/`. On startup, the Agent Bridge deletes transcript files older than 30 days.

Transcripts written since the follow-up feature carry additive lineage fields
(`v`, `parent_task_id`, `root_task_id`, `continuation_depth`, `session_id`,
`project`, and a `lineage` object with the platform execution IDs). Older
transcripts that predate these fields remain readable and are normalized as root
tasks with no parent, so history and task detail continue to load them
unchanged. The 30-day retention behavior is unchanged; note that because a
follow-up seeds only a bounded summary of ancestors that are still present, an
ancestor pruned by retention simply drops out of the continuation brief without
breaking the follow-up.

## Delays

`sidekick_delay` stores one-shot scheduled jobs. The Agent Bridge loads pending delays at startup, creates timers, executes them at the scheduled time through `callTool`, and updates their status to completed or failed.

## Watches

`sidekick_watch` stores recurring watches. The Agent Bridge loads active watches at startup and checks them on intervals. Watch sources include services, processes, endpoints, and files. If a watch condition triggers, it can call another Sidekick tool with templated values such as source, target, status, and time.

## Safety limits

The main safety control is `SIDEKICK_MAX_ITERATIONS`, which defaults to 15. Tool-level safety still applies: dangerous shell commands are blocked by pattern checks, output redaction is applied, and tools return structured errors.
