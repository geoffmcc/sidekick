# Open-Issue Triage — 2026-08-12

Historical verification of all 13 open GitHub issues against the working tree
at `main` @ `4e723d1`. Each verdict was based on the code available at that
snapshot, not the state at filing time. The later inference and Compute changes
through `389a969` supersede provider/max-token line references in this record;
retain this file as triage history and re-check any still-open issue against the
current implementation before acting on it.

Verdicts: **STILL VALID** (keep open), **FIXED** (close), **PARTIALLY FIXED**
(keep open; update body to reflect remaining scope).

| Issue | Verdict | Action |
|---|---|---|
| #249 winsw download in CI | Still valid | Keep open |
| #158 tool-log boundaries | Still valid | Keep open |
| #152 import/sync memory flood | Still valid | Keep open |
| #151 Postgres wiring gap | Still valid | Keep open; broaden to doc default |
| #150 lease recovery unscheduled | Still valid | Keep open; add retry_wait stall |
| #149 runAgent terminal state | Still valid | Keep open; note lease infra landed |
| #148 heartbeat vs current_jobs | Still valid (worse) | Keep open |
| #147 unredacted memory args | Partially fixed | Keep open; update body |
| #146 web_fetch SSRF | Still valid | Keep open; update stale refs |
| #145 task stranded after approval | **Fixed** | **Close** (ref #163) |
| #144 empty brain synthesis | Still valid (worse) | Keep open; update body |
| #126 bridge approval dead-end | Partially fixed | Keep open; retitle |
| #125 routing keyword over-match | Still valid (worse) | Keep open; update body |

## #249 — CI depends on a live winsw download → STILL VALID (keep open)

Nothing in the affected path changed since filing; the last commit touching it
is 991b95c, the one that introduced it. All claims re-confirmed against the
current tree:

- `scripts/build-worker-package.js:27,75` — single live `fetch` of
  WinSW v2.12.0 with a 60s timeout, no retry/backoff/offline fallback; an HTTP
  429/5xx throws identically to a hash mismatch (no transient-vs-fatal
  classification).
- `.github/workflows/ci.yml:21-39` — no `actions/cache` step anywhere in
  `.github/workflows/`, and `dist/` is gitignored (`.gitignore:27`), so every
  CI run is a guaranteed cold download.
- `test/compute-worker-package.test.js:24` — the build runs via `execFileSync`
  at module top level, outside any `test()` wrapper, so a download failure
  kills the whole suite. `critical: false` in `test/run-all.js:118` only skips
  early-stop; the failure still fails the job (`run-all.js:170-176,192`).

**Recommendation.** Keep open. Fix notes: add an `actions/cache` step keyed on
the pinned winsw version, classify transient download errors, and move the
`execFileSync` inside a guarded block so the suite can degrade gracefully.

## #158 — Tool-log execution boundaries → STILL VALID (keep open)

All three claims reproduce at HEAD; PR #156's session plumbing covers only the
MCP path, and later project-registration work (#255) touched the platform
kernel, not `tool_logs`.

- **No session from agent/approval/dashboard:** `toolCallContext()`
  (`src/index.js:81-87`) threads `sessionId` for MCP only. Agent call sites
  (`src/agent.js:1009-1013`, `:1105-1109`, `:1512` and others) pass only
  task/execution ids; dashboard passes `{actor: "dashboard"}`
  (`dashboard.js:1822,1904,2465-2469`); approval contexts
  (`dispatcher.js:293-306,370-383`) carry no `sessionId`/`project`. The env
  fallback `SIDEKICK_SESSION_ID` is never set by anything in `src/`.
- **Project never recorded:** `tools-legacy.js:1081` falls back to an env var
  nothing sets. `runAgent` computes `inferredProject` (`agent.js:925`) and
  gives it to the platform execution, but never to `callAgentTool`, so tool
  logs for the task still write `project = null`. Non-MCP paths never pass it.
- **`boundaryId()` unchanged:** `src/predict.js:457-459` still prefers
  `correlation_id` over `task_id`, and agent dispatches mint a fresh per-call
  `traceId` (`context.js:23,30`), shredding a task into one-call segments.
  `test/tool-log-correlation.test.js:120-131` encodes the current behavior, so
  a precedence fix must update it. Nuance: for the approval path
  `correlationId` IS a genuine boundary (`approvalId`), so demoting it below
  `task_id` is safe there; the real defect is per-call synthesis on the agent
  path.

**Recommendation.** Keep open. Fix shape: thread a boundary id per source
(agent → `taskId`; dashboard → HTTP session; approval already has
`approvalId`), forward `inferredProject` into the three `callAgentTool` sites,
then re-rank `boundaryId()` and extend the correlation test beyond MCP.

## #152 — Import/sync paths bypass tool_call exclusion → STILL VALID (keep open)

Every claim reproduces at HEAD; the only db.js commit since filing (ffebdad)
touched migration atomicity only.

- The exclusion policy still lives solely in `recordToolCallMemory`
  (`src/memory.js:219-243`).
- `importMemories` (`src/db.js:1780-1883`, INSERT binds `mem.type` at `:1851`)
  and `importFromSync` (`src/db.js:2568-2744`, `:2711`) insert any type with
  no allowlist; both bypass `upsertMemory` with raw SQL, and `upsertMemory`
  itself (`db.js:985-991`) accepts any type anyway. No CHECK constraint in
  `migrations/003_structured_memory.sql:6`.
- Recall only down-weights telemetry (`tool_call: 0.8`, `src/memory.js:31-40`)
  multiplicatively — never excludes it — so volume still displaces real
  memories.
- No trivial-content gate, no telemetry TTL, no regression test asserting type
  distribution after import.

Scope note for the fix: the conflict-resolution UPDATE branches
(`db.js:1807-1837`, `2617-2646`, `2655-2694`) are additional write paths;
guarding only the INSERTs leaves them refreshing existing telemetry rows.

**Recommendation.** Keep open. Fix at write admission (shared type allowlist
used by `upsertMemory` and both import paths, including UPDATE branches).

## #151 — Postgres wiring gap → STILL VALID (keep open)

`src/pg.js` has been touched exactly once in its history — its creating commit
(2418b9b, 2026-06-16), a month before the issue was filed. All core claims
reproduce at HEAD:

- `docker/docker-compose.yml:15` — `POSTGRES_PASSWORD:
  ${SIDEKICK_POSTGRES_PASSWORD:?}` hard-requires the variable.
- Repo-wide grep: nothing under `src/`, `scripts/`, or `test/` reads
  `SIDEKICK_POSTGRES_PASSWORD` — only `.env.example`, `README.md`, and the
  compose file mention it.
- `src/pg.js:3` — hardcoded fallback
  `postgresql://sidekick:sidekick@127.0.0.1:5432/sidekick`; `getPool()`
  (`:7-17`) passes it into `new Pool()` unvalidated. Only pg connection
  constructor in `src/`.
- `testConnection()` (`src/pg.js:243-252`) swallows the auth failure into
  `{connected: false}`, so the failure surfaces as a misleading "password
  authentication failed".

One sub-claim overstates: `.env.example:66` and `README.md:672` do scope the
variable to the container correctly. The adjacent real defect: both docs
advertise `postgresql://sidekick:sidekick@...` as a working default
(`.env.example:63`, `README.md:667`) — exactly the credential that cannot work
once the compose stack is up.

**Recommendation.** Keep open; optionally broaden to cover the misleading
documented default. Fix notes: pass discrete `user`/`password`/`host` fields
to `new Pool()` (sidesteps URL-escaping), and note `src/pg.js` reads env at
import time into a module const, so late `process.env` writes are ignored.

## #150 — Expired-lease recovery never scheduled → STILL VALID (keep open)

All claims reproduce at HEAD; no relevant commit has touched the path since
filing (recent cancellation/runbook-ledger/execution-project work is
unrelated — the runbook step-claim lease is a separate concept and table).

- `src/compute/index.js:19-27` — the reconciliation timer still runs only
  `reconcileWorkerStates`; `recoverExpiredLeases` is called only at boot
  (`compute/index.js:39`) and from two manual triggers (`src/index.js:935`,
  `src/dashboard.js:1560`).
- No `setInterval` in the process touches expired leases (all audited).
- `claimNextJob` only promotes `retry_wait` rows (`job-manager.js:499,554-558`);
  expired `leased`/`running` rows are invisible to it.
- Second-order stall not in the original issue: even after recovery, jobs land
  in `retry_wait`, and only `releaseRetryWaitJobs` inside `claimNextJob`
  requeues them — so requeue is *also* gated on incidental claim traffic.
- One acceptance criterion is already satisfied: retry-attempt accounting on
  re-lease (`job-manager.js:530,633`) with a correct dead-letter guard.

**Recommendation.** Keep open; add the second-order `retry_wait` stall to the
body. Fix remains a near-one-liner: call `recoverExpiredLeases()` (own
try/catch) plus `releaseRetryWaitJobs()` in the timer body at
`src/compute/index.js:22`, and add a timer-path regression test.

## #149 — runAgent has no terminal-state guarantee → STILL VALID (keep open)

All four defects reproduce at HEAD (line numbers drifted; `runAgent` now
starts at `src/agent.js:923`):

- `finishAgentExecution` is still the bare final statement (`agent.js:1183`)
  with no try/finally; unguarded transcript writes sit between `running` and
  finalization (`agent.js:1160-1162`). Worse than filed: the `done` emit
  (`:1178-1179`) comes after the write, so an `ENOSPC`/`EACCES` there loses
  the completed answer from disk AND the stream while the row stays `running`.
  The caller's `.catch` (`:1204`) emits a generic error but never finalizes.
  Post-filing commit e461c04 made the write atomic but added a second
  unguarded syscall to the window.
- **No reaper can help:** the claim/lease/reaper contract landed 2026-08-10
  (b83cd96, bfa45fc, c260073) but was wired only to delay/watch/cron/runbook.
  Agent executions never claim or heartbeat, and `recoverOrphanedExecutions`
  (`kernel.js:1389`) requires a claim row, so stranded agent rows are
  structurally invisible to it.
- Four declared budgets (`MAX_RETRIES_PER_STEP`, `MAX_STEP_MS`,
  `MAX_MEMORY_RETRIEVAL_MS`, `MAX_GENERATION_MS`,
  `src/brain/config.js:30-35`) have zero references outside their declaration.
  `MAX_TOTAL_TASK_MS` is enforced but only cooperatively between steps.
- Agent tool calls pass no `timeoutMs`/`signal`, so the dispatcher
  short-circuit (`dispatcher.js:88`) returns unbounded promises — the
  mechanism that makes the stranding fire in practice.

**Recommendation.** Keep open; update the body to note the 2026-08-10 lease
infrastructure exists and only needs wiring to the agent path. Minimum fix:
try/finally around `runAgent`, guard the transcript write, thread `timeoutMs`
into the three `callAgentTool` sites, enforce-or-delete the four dead budgets.

## #148 — Worker heartbeat overwrites current_jobs → STILL VALID (keep open)

`src/compute/worker-manager.js` is untouched since the day before filing. All
claims confirmed at HEAD:

- `worker-manager.js:378` — heartbeat splices unvalidated `currentJobs`
  straight into `UPDATE compute_workers` (no clamp, floor, or type check).
- `job-manager.js:503-506,541` — claim path transactionally re-reads/increments
  the same (poisonable) column; heartbeat is the sole non-transactional writer.
- `placement.js:268` — the only worker-wide admission gate reads that column.
- No validation upstream (`src/index.js:767-774` HTTP, `compute/tools.js:148`
  MCP) and no DB CHECK/trigger (`migrations/013_compute.sql:82`).

Severity is higher than filed: the first-party worker agent itself zeroes the
counter mid-job (`worker-agent.js:385` post-rotation verify, `:826` doctor
path). One sibling call site was hardened client-side in 792e5aa
(`credentialAccepted()` omits `currentJobs`, `worker-agent.js:738-742`) but
that's a one-site workaround, not the server-side invariant. No test asserts
the invariant.

**Recommendation.** Keep open; note the two remaining first-party trigger
sites. Strongest fix: treat heartbeat `currentJobs` as telemetry only
(`utilization_json`), never writing `current_jobs`, which is already fully
maintained transactionally.

## #147 — Tool arguments written to auto-memory unredacted → PARTIALLY FIXED (keep open)

**What changed since filing.** Redaction now exists on every path the issue
named:

- `src/memory.js:121-124` — `truncate()` runs `redactSensitive` over every
  value, and `summarizeArgs` (`src/memory.js:126-144`) routes all arg values
  through it. At filing there was no redaction at all.
- `src/tools-legacy.js` `formatArgs` — tool_logs args also pass each value
  through `redactSensitive`.
- `src/evolve/common.js:48-50` — `summarizeResult` redacts result summaries
  before they reach `tool_logs` and auto-memory.

**What is still broken.**

1. **Redaction is value-only; the key-aware check is still missing.**
   `summarizeArgs` and `formatArgs` both apply `redactSensitive` to the bare
   value, then prepend the key (`${key}=${redactedValue}`). The key-name
   patterns in `src/redact.js:27-28` (`password|secret|token|…[:=]value`) can
   never match because the key is not in the scanned string. A generic
   credential with no recognizable shape — `{password: "hunter2abc"}`,
   `secret action=store value=<plaintext>` — is stored verbatim. This is
   exactly the asymmetry the issue described: `approvalPreviewArgs`
   (`src/tools-legacy.js:308-325`) redacts recursively by key name; the memory
   and tool_logs paths still do not.

2. **`shouldRememberTool` still does not exclude the `secret` tool**
   (`src/memory.js:187-196` — exclusions are `context`, `knowledge`, `get`,
   `list`, `read`).

3. **`secret` tool results still leak into logs and memory.**
   `secret action=get` returns the raw decrypted value as the result text
   (`src/tools/families/secret.js:55`); `rotate` returns `New value: <hex>`
   (`:115`). The dispatcher takes `result.content[0].text` as the log summary
   (`src/tools/dispatcher.js:116-117`), and pattern-based redaction cannot
   catch arbitrary secret values (random hex, generic passwords). These land
   in `tool_logs.result_summary` and auto-memory `summary`, and recalled
   memories still flow into LLM prompts via `memoryText`
   (`src/memory.js:537-551`, includes `args` and `summary`).

**Recommendation.** Keep open. Update the body: pattern redaction landed; the
remaining work is (a) key-aware redaction in `summarizeArgs`/`formatArgs`
matching `approvalPreviewArgs`, (b) exclude `secret` from
auto-memory/summary capture (or special-case its result summary), (c) audit
existing `tool_logs`/context rows for stored plaintext.

## #146 — web_fetch SSRF, no URL validation → STILL VALID (keep open)

Fully reproducible at HEAD. The only change since filing is a pure refactor
(ec48ea3, #243) that moved `sidekick_web_fetch` verbatim from
`src/tools-legacy.js` into `src/tools/families/net-fetch.js` — the issue's
file references are stale but the substance is unchanged.

- `net-fetch.js:16-17` — any scheme accepted; non-HTTPS falls back to the
  `http` client. Zero host inspection in the file: loopback, RFC1918,
  link-local, and cloud metadata (169.254.169.254) all reachable.
- `net-fetch.js:26-28` — caller headers merged over defaults with no denylist
  (`Host`, `Authorization`, `Cookie`); malformed JSON silently swallowed.
- `net-fetch.js:34-38` — unbounded response accumulation.
- The existing guard `src/compute/endpoint-guard.js` (`validateEndpoint`) is
  still wired only into `src/compute/tools.js`, not net-fetch.
- Still `risk: "medium"` — now duplicated in `src/tools/metadata.js:27` AND
  `net-fetch.js:58` — and `getApprovalDecision` never gates medium in any
  approval mode, so it remains un-approval-gated.

Nuances to add to the body: embedded URL credentials are accepted but not
forwarded (Node drops them), and redirects are not followed today, so
redirect-based SSRF is moot until someone adds redirect following.

**Recommendation.** Keep open; update stale file refs. Fix: call
`validateEndpoint` (or a stricter loopback-denying variant) at the top of the
handler, add a header denylist, cap the response, and raise risk to `high` in
BOTH duplicated locations.

## #145 — Brain task stranded after approval → FIXED (close)

Fixed by the approval-continuation work that landed after filing: ADR accepted
in #153 (34449cd, `docs/adr-approval-continuation.md`), implementation in #163
(58e92be — `src/approvals/*`, `src/brain/resume.js`, `src/brain/scheduler.js`,
migration 025), operator surface in #165 (34e7cc9).

- Park now writes a durable checkpoint and **fails closed** if it can't
  (`src/brain/brain.js:310-343,379`), superseding the legacy twin approval so
  the out-of-band copy can't be approved (`brain.js:350-363`).
- `executeApprovedTool` no longer dispatches task-originated approvals — it
  atomically marks the task runnable and returns `task_runnable`
  (`src/tools/dispatcher.js:310-350`); a continuation-storage failure returns
  an error rather than falling through to standalone execution. Denials
  symmetrically wake the task with a structured refusal
  (`src/tools-legacy.js:689-718`).
- Resume is real and wired at boot: `resumeBrainTask`
  (`src/brain/resume.js:129`), scheduler (`src/brain/scheduler.js:47,96`),
  started from `agent.js:1503,1545`. The transcript is rewritten to terminal
  status with the real answer under the original task id
  (`agent.js:1418-1451`).
- The 409 on forking a parked task remains, but is now intentional — the task
  reaches a genuine terminal state after approval and forks from there.
- Regression coverage: `test/approval-continuation.test.cjs` (~2k lines),
  registered critical in `test/run-all.js:31`.

Residual (narrower, distinct): a crash after the approved step runs but before
the next park terminalises the task as `failed` with an `orphaned_checkpoint`
recovery event (`resume.js:316-345`) — loud, not stranded. Worth a follow-up
issue if desired.

**Recommendation.** Close with reference to #163/58e92be and the ADR.

## #144 — Brain synthesis returns empty answer under dense evidence → STILL VALID, worse (keep open)

All claims confirmed at HEAD (lines drifted): `MAX_GENERATED_TOKENS: 2048`
(`src/brain/config.js:36`), bare `answer = res.response || ""` fallback
(`src/brain/index.js:205-206`), unconditional hard fail
(`src/brain/brain.js:404`), and the misleading `evidence_count: 0` on failure
(`brain.js:410`).

Two new findings:

1. **Regression since filing:** 58e92be (#163) duplicated the same unguarded
   synthesis path for resumed tasks (`src/brain/resume.js:439-449`), so a fix
   must land in the shared `makeSynthesizer` (`src/brain/index.js:194`) or be
   applied twice.
2. **The issue's proposed fix would be a no-op as written:** `maxTokens` never
   reaches the model on either path — `src/agent.js:525-539` omits it from the
   `inferenceService.chat` request, and the direct Ollama call
   (`agent.js:674`) sends only `temperature`, no `num_predict`. The effective
   limit is Ollama's default; raising the constant changes nothing until
   `maxTokens` is threaded through `callLLM`. `done_reason` is also discarded
   everywhere, so length-truncation is indistinguishable from an empty answer.

No test references "synthesis produced no answer".

**Recommendation.** Keep open; update the body with the resume.js duplicate
and the maxTokens-not-threaded finding, which reorders the fix: (1) thread
`maxTokens`, (2) surface `done_reason`, (3) budget/retry, (4) fix
`evidence_count` on failure.

## #126 — Agent Bridge inspection requests dead-end on gated tools → PARTIALLY FIXED (keep open, retitle)

The dead-end itself was fixed the day the issue was filed (28b11ee, #128):
approval-pending results are surfaced honestly in the loop
(`src/agent-loop.js:216-218,240-249`), don't count as evidence (`:228`), and
evidence-required tasks fail honestly rather than fabricating. The issue's
stated root cause is also inaccurate: strict approval mode never hides tools
(`getApprovalDecision`, `tools-legacy.js:221-249`, only sets `required`);
visibility is lost only under `SIDEKICK_TOOL_POLICY=restricted`/allowlist
(`tools-legacy.js:252-282`), and the deployed config is `open` with approvals
off.

Still-valid residue (the real remaining work):

1. `buildSystemPrompt` still hardcodes `bash` + `df -h` as the system-state
   example (`src/agent.js:494-501`) — steering toward a critical-risk tool —
   while `status` (medium risk, ungated even under strict mode) already covers
   the use case (`tools-legacy.js:1343`).
2. A tool filtered from the visible set never reaches the dispatcher, so the
   loop still emits the misleading "tool does not exist"
   (`agent-loop.js:178-186`) under restricted/allowlist config.
3. Tool descriptions given to the model omit `approval_required`
   (`agent.js:470-472`).
4. `teach.js:102` template still demonstrates `sidekick_bash df -h`.

**Recommendation.** Keep open but retitle/correct: it's a tool-policy
visibility + prompt-steering issue, not an approval dead-end (fixed by #128).
Scope to the four residue items.

## #125 — Agent Bridge routing over-matches resource nouns → STILL VALID, slightly worse (keep open)

- `src/agent-protocol.js:222` — bare `disk|cpu|ram|swap|bandwidth|storage|
  uptime` still match with no inspection verb; live classifier reproduces the
  issue's examples ("I bought a new CPU cooler", "what does RAM stand for" →
  `system_inspection`).
- 28b11ee (#128) **broadened** the pattern with `drives?|volumes?|mount(s|ed)?`
  — new false positives: "How tall is Mount Everest?", "Turn the volume down",
  "The drive to the airport takes an hour".
- Same commit partially mitigated leading-verb phrasings via
  `conceptualPromptPattern` (`:217`, evaluated first at `:226-230`), but
  mid-sentence/declarative mentions — the case the issue describes — are
  uncovered.
- Impact remains routing-only (UX), per `agent-protocol.js:196-205` and the
  consumer at `agent.js:959-960`. No false-positive tests were added
  (`test/agent-protocol.test.js:204-208` only covers verb-led phrasings).

**Recommendation.** Keep open; update the body to note the new
`drive/volume/mount` over-match surface. All three proposed remedies are still
outstanding.
