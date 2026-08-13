# Changelog

All notable changes to Sidekick.

## Unreleased

### Capability Packs v1, and the third-party module lifecycle (B9) that it needed

Sidekick Core had to absorb every new area of functionality directly, because the only way to add tools was to add them to Core. The module subsystem was the intended answer, but its third-party half was unfinished: a module that did not ship inside the repository could reach `configured` and never `enabled`, there was no managed installation location, no whole-package integrity, no upgrade, and no uninstall. **B9 is now complete**, and Capability Packs v1 is built on top of it.

**B9 — third-party module lifecycle**

- Managed module store at `<SIDEKICK_DATA_DIR>/modules/<name>/<version>/`. An installed module never runs from the directory the operator pointed at; installation copies exactly the inspected files, re-hashes the managed copy, and refuses the install if the source changed underneath it. Owning the runtime location is what makes the recorded hash mean anything afterwards.
- Safe package inspection (`inspectPackageForInstall`) reports identity, display name, version, manifest, entry point, files, deterministic whole-package hash, compatibility, contributed tools, configuration requirements and provenance — without requiring, importing or evaluating any package code. It refuses path traversal, symlinks, non-regular files, entry points escaping the package root, malformed manifests, invalid versions, duplicate identity, descriptor collisions (including aliases and generated capability names), built-in tool shadowing, and packaged secrets.
- Verified entry-point loading (`src/modules/entry-loader.js`). Before `require` runs: the installation is inside the managed store, the package still hashes to its recorded value, the entry point resolves inside the installation and still hashes to its recorded value, the manifest is compatible, configuration is satisfied, and the operator left the module runnable. A mutated installed package fails closed and its code never executes.
- Real `install` / `configure` / `enable` / `disable` / `upgrade` / `uninstall` (`src/modules/lifecycle.js`). Upgrade stages the candidate beside the live installation, verifies it, promotes it, preserves compatible configuration, applies module migrations, removes stale descriptors, and retains the previous installation until activation succeeds — a failed upgrade restores and re-enables the previous version rather than destroying it. Same-version and downgrade replacement are refused unless explicitly allowed.
- Uninstall removes runtime contributions, the managed package and the registration row. Historical execution and audit evidence — kernel ledger events, tool logs, completed runs — is preserved by design.
- A derived health model: `healthy`, `disabled`, `unhealthy`, `configuration_required`, `incompatible`, `integrity_failure`, `load_failure`, `restart_required`, `not_installed`, each with per-component evidence.
- Cross-process convergence: each process records the code identity it registered, so an upgrade performed elsewhere drops the stale registration and re-activates from the new installation without a restart. Node's require cache is purged for the installation subtree so the new bytes are the ones that run.
- `platform_extensions` is retired as a module concept. It had no production caller; `platform_modules` is the single module authority. The table and its kernel CRUD stay for backward compatibility and are not part of any lifecycle.

**Capability Packs v1**

- A capability pack is an installable **area of competence** — modules, workflow definitions, knowledge assets and configuration — declared in `sidekick.pack.json` and installed into a managed pack store. Every manifest field has runtime meaning; there are no decorative sections.
- Packs compose the subsystems that already existed. Pack-owned modules install through the module lifecycle, pack-owned workflows register in the workflow definition registry, pack knowledge lands in the ordinary `knowledge` table (tagged `pack:<name>`, so agents find it through the ordinary `knowledge` tool), and pack tools are normal descriptors in the one registry with the one dispatcher. There is no pack-specific runtime, dispatcher or workflow engine.
- Component ownership is recorded in `platform_capability_pack_components` so disable, upgrade and uninstall act coherently across those subsystems without becoming a competing source of truth. Duplicate ownership is refused: two packs cannot claim the same component.
- Install leaves a pack **disabled**. Installing code and activating code are separate operator decisions, and a pack that fails to enable rolls back rather than advertising a partially live capability.
- Pack health is **derived from components**: `healthy`, `disabled`, `degraded`, `configuration_required`, `incompatible`, `integrity_failure`, `component_failure`, `restart_required`. A pack whose required component is unusable is never reported healthy — a tampered owned module surfaces as `integrity_failure` at the pack level.
- First-party bundled packs (under `packs/`) differ from third-party packs in trust and provenance only. They use the same manifest, the same managed store, the same lifecycle and the same health model, so the first-party pack genuinely exercises the platform.

**Workflow definitions become runnable**

- Sidekick already owned workflow *execution* state (`platform_workflows`, `platform_workflow_steps`, the execution ledger) but had nowhere to keep reusable *definitions*, which is why packs could not contribute runnable workflows. `platform_workflow_definitions` is that missing half.
- The runner (`src/workflows/runner.js`) drives the existing primitives rather than replacing them. Each step is dispatched with `callInternalTool`, so it carries schema validation, tool policy, approvals, timeouts, cancellation, redaction and audit. On top of that a run gets durable per-step state, checkpoints, project identity, execution history and provenance (pack name, pack version, workflow version, definition checksum).
- A step requiring approval **parks** the run in `waiting`, records where it stopped and returns the approval id; the operator approves through the normal path and resumes with `workflow action="resume"`. Cancellation is cooperative and cross-process: the execution claim is re-read before every step.
- References in a definition are resolved, never evaluated (`${inputs.x}`, `${steps.y.json.a.b[0]}`, `${steps.y.text}`, `${steps.y.ok}`). A reference to a step that has not run yet is a validation error at registration time, so a broken definition is caught when a pack is inspected rather than when an operator tries to run it.
- `completeWorkflowStep` gained an `advance` option so a step a definition tolerates (`on_error: "continue"`) is recorded as **failed** without stalling the durable cursor. Previously the step row and the cursor could not both be accurate.

**Developer / Software Engineering pack (bundled, first-party)**

- `dev_repo_profile` (low) — a mechanically derived project profile: git state and recent history, languages, ecosystems, package managers with their install commands, workspace/monorepo layout, classified build/test/lint/typecheck scripts, CI and container configuration, migrations, documentation, agent instruction files, and candidate verification commands **each carrying the evidence that produced it**. Nothing is inferred by a language model; a fact that cannot be established from files on disk is reported as absent rather than invented.
- `dev_change_summary` (low) — structured engineering impact for a change set: per-kind classification, affected areas, likely API/schema changes with the symbol names added and removed and which are potentially breaking, dependency version movements, verification-coverage signals, evidence-backed risk indicators, and the untracked files no diff can show.
- `dev_verify` (high) — selects the project's own verification commands and runs them through Sidekick's governed `bash` path, reporting for each what was selected, why, exactly what executed, the exit status, duration and bounded output. Selection is conservative: an intent with no detectable command is reported `not_detected`, never guessed. The TypeScript ecosystem default uses `npx --no-install`, because a verification command must never install a package or reach the network to decide whether a project typechecks.
- Seven runnable workflows: repository reconnaissance, issue investigation, implement change, CI failure triage, pull request review, dependency upgrade, release preparation. Investigation never modifies source; implementation never commits, pushes, merges, tags, releases or publishes; the dependency upgrade requires the operator to supply the exact update command so the workflow never invents a mutation.
- Eight knowledge assets covering recon, change discipline, verification strategy, investigation, CI triage, review, dependency/release safety and handoff expectations. Repository-specific instructions such as `AGENTS.md` remain authoritative; pack knowledge complements them.
- Twelve configuration options with safe defaults, including command overrides and an optional `repository_roots` confinement that applies **in addition to** the global Sidekick path policy.

**Operator surfaces**

- New `capability` tool (risk **critical** — installing or enabling a pack activates executable module code in the Sidekick process): `list`, `available`, `show`, `inspect`, `install`, `configure`, `enable`, `disable`, `health`, `upgrade`, `uninstall`.
- New `workflow` tool (risk **high**): `list`, `show`, `run`, `resume`.
- Dashboard **Capabilities** page: installed packs with state, health, integrity, configuration validity and contributed components; available bundled packs; and inspection/installation from an approved server-local path. Every mutation POSTs to the dashboard API, which dispatches the governed `capability` tool server-side — browser code never mutates pack state directly, and the existing auth, IP allowlist, rate limiting and Origin/CSRF checks apply. No remote marketplace.

**Trust model, stated plainly**

Installed pack and third-party module code runs **in-process with Sidekick's privileges**. There is no process isolation and none is claimed. What the platform provides is integrity (the bytes are the reviewed bytes), provenance (where they came from and who installed them) and lifecycle control (an operator decided to run them). Treat installing a third-party pack as equivalent to deploying code.

**Schema**

- Migration `036_capability_packs.sql` (schema_version 36, platform kernel schema version 10). Additive: three `platform_modules` columns (`install_path`, `package_hash`, `provenance_json`) and three new tables (`platform_capability_packs`, `platform_capability_pack_components`, `platform_workflow_definitions`). The runtime ensure paths apply the same DDL in the same order, and the parity test confirms both boot paths produce identical `platform_*` schema.

**Verification**

- New suites: `test/modules-third-party-lifecycle.test.js` (18 checks, synthetic fixtures, including tamper-fails-closed and built-in-collision-refused), `test/workflow-definitions.test.js` (12 checks), `test/capability-packs.test.js` (16 checks against the real bundled Developer pack), `test/developer-pack.test.js` (14 checks against real git repositories — the Sidekick repository itself and a purpose-built fixture repository).
- Core registry tool count baseline: 103 -> 105.

### `sidekick_bash` no longer blocks the server while a command runs

`sidekick_bash` executed commands with synchronous `execSync`, which freezes the MCP server's entire event loop for the command's duration. Any command that made an HTTP request to the server's own ports (4097/4098/4099) deadlocked: the server could not answer the request because its event loop was busy, the command hung, and the client aborted the call with `MCP error -32001: Request timed out`. This is a latent design footgun, not a dependency regression.

- `sidekick_bash` now runs commands with promise-based async `exec` (same 60s timeout, same 10 MB `maxBuffer`), so the event loop stays free and in-process HTTP requests are served normally.
- Timeout errors are now reported explicitly (`Timed out after 60000ms (killed by SIGTERM)`) instead of `Exit code: undefined`; non-zero exits still report `Exit code: N` with captured stdout/stderr.
- Added `test/bash-tool.test.js` covering success output, error shape, dangerous-pattern blocking, and a regression case that HTTP-requests an in-process server from inside a command and asserts a prompt round-trip (fails on `execSync`, passes on async `exec`).
- Full suite: 77/77 files passed, 0 failed.

### Dependency audit cleared

`npm audit` reported six advisories across transitive and direct dependencies. All were resolved by version bumps without code changes and without `--force`.

- `@modelcontextprotocol/sdk` `^1.29.0` → `^1.30.0`: unblocks `@hono/node-server` 2.x (its declaration now allows `^1.19.9 || ^2.0.5`). `@hono/node-server` 1.19.14 → 2.1.0 and `hono` 4.12.26 → 4.13.0 clear the path-traversal, JSX escaping, CORS ReDoS, API Gateway header-drop, and per-request context advisories.
- `fast-uri` 3.1.4 → 3.1.5: clears the high-severity backslash authority-introducer host-confusion advisory (already within `ajv`'s `^3.0.1` range).
- `ip-address` 10.2.0 → 10.4.0: clears the high-severity SSRF/trust-boundary advisories (leading-zero octets, CIDR-suffix special-use suppression, IPv4-mapped/NAT64 misclassification), already within `express-rate-limit`'s `^10.2.0` range.
- `fast-xml-parser` `^4.5.0` → `^5.7.0` (resolves 5.10.1): clears the XML comment/CDATA injection advisory. Version 5 keeps the same API; Sidekick uses only `XMLParser` (the `XMLBuilder` import at `src/tools-legacy.js` is unused), and the XML format-detection test passes unchanged.
- Full suite: 76/76 files passed, 0 failed; `npm audit` reports 0 vulnerabilities.

### A parked Brain task no longer reads as failed on the platform timeline

Approval continuation delivers a resumed task's answer back into its transcript, but the platform execution itself told a different story: `finishAgentExecution` mapped a park at `waiting_for_approval` to **failed** (`src/agent.js`), even though the kernel has a real `awaiting_approval` state. So a task that parked, was approved, resumed, and succeeded still ended as *failed* on the execution timeline — the transcript said completed, the timeline said failed.

- `finishAgentExecution` now maps a park to the kernel's `awaiting_approval` state instead of `failed`.
- The kernel admits the two transitions that makes real: `running → awaiting_approval` (the park) and `awaiting_approval → completed` (the resumed success exit). Failures, cancellations, and timeouts already had legal exits from `awaiting_approval`.
- `finalizeResumedTask` now transitions the platform execution to its terminal state on the resumed outcome (completed/failed/cancelled/timed_out) rather than only appending an event, so the timeline closes the same way the transcript does. An execution already terminal (e.g. a legacy park recorded before this fix) is left as-is; the resumed event still records what happened.
- Added `test/execution-control.test.js` coverage for the two new kernel edges, and an end-to-end case in `test/approval-continuation.test.cjs` that parks a real platform execution at `awaiting_approval`, resumes it to `completed`, and closes a resumed failure as `failed`.

### Reconciliation UI for ambiguous executions

Approval continuation shipped with `GET /api/reconciliations` and `POST /api/reconciliations/:taskId/resolve` but no way to reach them from the dashboard, so the designated recovery path for an ambiguous *high-risk* execution was resolvable only by hand-crafting an authenticated request. A task could sit in `reconciling` indefinitely with nothing surfacing it.

- Added an **Ambiguous Executions** section to the Approvals page, shown only when something is waiting. It is deliberately separate from the approval inbox rather than another status filter: these are not approve-or-reject decisions, because the step may already have run, and presenting them alongside ordinary pending approvals would invite treating them like one.
- Each entry carries what an investigation actually needs — tool, risk, task and step id, attempt count, who authorized the original action, when it became ambiguous, and the argument digest — with the arguments themselves renderable on demand through the existing authenticated preview.
- All four permitted decisions are offered, each with its consequence stated on the control. **It did not run** is styled as destructive and requires an explicit confirmation naming the risk, because it redispatches a high-risk tool: asserting an effect did not land when it did produces exactly the double-execution the risk gate exists to prevent, and that is audited but not verifiable.
- Without an authenticated principal the section explains why it cannot be used instead of rendering buttons guaranteed to be refused. The server now reports `can_resolve` and whether the payload is still renderable, so a discarded payload is explained rather than offering a preview control that can only fail.
- Added `test/reconciliation-ui.test.js` (17 assertions) following the repo's convention of asserting frontend behaviour against the served source. It pins the cross-file element-id wiring, checks the offered decisions equal `src/approvals/vocabulary.js`'s closed vocabulary exactly, verifies the confirmation gate precedes the request rather than following it, and asserts ids reaching attribute and JS-string contexts use `attr()`/`jsArg()` rather than `esc()`, which does not escape quotes. Each guard was verified to fail the suite when removed.

### Approval continuation — a parked Brain task now resumes

Implements the accepted architectural contract in `docs/adr-approval-continuation.md`. Previously a Brain task that needed approval parked and never resumed: the approved tool executed standalone, in a different execution tree, and its result was discarded. The mechanism was a single dropped field — the execution context carrying `taskId` and `stepNumber` reached `queueApproval`, which never copied either onto the approval record — and everything downstream followed from it.

- **The task runner is now the only executor of plan steps.** An approval authorizes an action; it never performs one. For a task-originated approval, `executeApprovedTool` is a state transition (mark the approval approved and the task runnable, atomically) and returns. The runner reclaims the task and executes the step through the normal loop, so approved steps and ordinary steps share one code path, one evidence-accumulation rule, and one result-persistence rule. Approvals that did not originate from a task keep today's standalone execution, distinguished by whether `task_id` is present.
- **Approvals became a real table.** Migration `025_` adds `approvals`, `task_checkpoints`, and `task_step_results`, with the runtime `ensure` counterparts several subsystems need. A pending task-originated approval can no longer be silently evicted, a duplicate submission for an unchanged action collides on a unique index instead of creating a second authorization, and the whole-blob read-modify-write races are gone for these rows.
- **The action identity is derived, not random.** `idempotency_key` is a versioned SHA-256 over `(task_id, step_id, plan_version, tool_name, args_digest)` with a fully specified encoding (`akv1:`), separator handling that rejects rather than escapes, and a distinct `skv1:` format for standalone approvals — which key on `approval_id` and so deliberately get no action-level deduplication, exactly as before. The consequence is that the planner cannot re-request a denied action: the key already exists. Anti-loop protection is a storage invariant rather than a prompt instruction.
- **Denial, expiry, cancellation, and supersession are structured step outcomes**, returned to the planner in the same shape a tool error already takes. They are not task failures, and the planner may explain them or choose a materially different route.
- **Recovery after a crash is risk-gated, and the guarantee is stated honestly.** This is *not* exactly-once dispatch and *not* an absence of concurrent effects. It is one claimant of record, write-fenced by a `claim_epoch` that every subsequent write is conditioned on, plus: at-least-once for low/medium risk, at-most-once for high/critical/unknown. An ambiguous high-risk step parks in a new `reconciling` state that no automated process resumes, records *no* step outcome — because whether it ran is precisely what is unknown — and leaves only by an attributed human decision or the task deadline.
- **The risk gate applies only where ambiguity exists.** A step being dispatched for the first time under a fresh authorization is never gated; only a reclaim of an action a previous claimant already held is. The discriminator is the approval's own pre-claim status, never a counter that also advances for unrelated claims.
- **Expiry became a scheduled sweeper rather than a lazy side effect.** It previously ran only inside `listApprovals`, `resolveApproval`, and `claimApprovalExecution`, so an approval nobody looked at never expired — tolerable when an approval merely sits in a queue, not once a task's liveness depends on it. The sweeper is started by the agent service alongside a resume scheduler, specifically so this does not repeat the `recoverStaleApprovals` failure of shipping correct, exported, and called by nothing. Claim-time expiry checking is retained: the sweeper bounds latency, the claim check enforces the rule.
- **Persisted execution content is encrypted at rest.** Plans, arguments, results, goals, reasons, and error detail are ciphertext; only digests, codes, and counters are queryable. Redacted previews are no longer persisted for a task-originated approval — `approvalPreviewArgs` redacts by key name and `redactSensitive` matches known credential shapes, so neither can catch a secret passed as an ordinary-looking value under an ordinary-looking key, and a stored preview is therefore plaintext of unknown sensitivity. Errors are closed-vocabulary codes; a captured exception message can never reach a persisted column.
- **The approval record gains a real approving identity.** `reviewer` was hardcoded to the literal `"dashboard"`, so it was impossible to determine from the record which human approved anything. It is now the authenticated dashboard principal — with a single shared dashboard account that still does not identify an individual, but it is at least distinguishable from an automated actor, which is what the reconciliation check depends on. Reconciliation — which resolves a high-risk ambiguity — additionally *requires* an authenticated human and fails closed without one, leaving the task in `reconciling` rather than accepting an unauthorized resolution.
- **Behavior change:** `SIDEKICK_SECRET_KEY` is now required to *resume* a task, not merely to approve one. A checkpoint that cannot be decrypted fails closed with a distinguishable reason rather than resuming with an empty plan. Key rotation strands parked tasks, which should be drained or explicitly failed first.
- **Not addressed, deliberately:** standalone (non-task) approvals still live in the legacy JSON document and keep the `slice(0, 500)` eviction, so invariant I7 holds for task-originated approvals only. The ADR lists the transition path for that document as provisional and warns that a dual-store period is the riskiest part; cutting the live approval surface over is its own slice.
- Relocated two now load-bearing pieces into shared modules so they have exactly one definition: canonical approval JSON (`src/approvals/canonical-json.js`) is a versioned wire format that stored digests depend on, and the AES-256-GCM value cipher (`src/core/secret-cipher.js`) is needed by storage code that must not require `tools-legacy` at top level. Both preserve their wire formats for every realistic payload, so existing ciphertext and hashes are unaffected; the one deliberate exception is the canonicaliser's new depth bound, described below.
- **Hardened after an adversarial security review that executed real exploits** against the modules, not just read them. It found a critical regression and five other defects, all fixed and pinned by regression tests:
  - **Critical:** post-claim verification recomputed the argument digest from the persisted *plan* but then decrypted and dispatched `args_encrypted` — a separate copy — without ever authenticating it, and never reconciled the plan step's tool against the approval's. Anyone able to write one database column could substitute ciphertext they had legitimately created elsewhere and have it executed under someone else's approval, with the benign digest still recorded in the ledger afterwards. This was a regression against the legacy path, which has always performed that check in `decryptApprovalArgs`. Both the payload and the tool are now verified before dispatch.
  - Task-originated approvals were listed with a placeholder preview and no way to render the real one, so a reviewer approving a critical-risk `bash` step saw a tool name, a risk level, and a hex digest. Added an authenticated, on-demand preview endpoint that decrypts, authenticates against the digest, and redacts at render time without persisting anything.
  - The authorized-step dispatch seam carries the approved-execution capability but treated its `approvalId`/`taskId`/`operationId` as decorative. It now verifies that the approval exists, is `executing`, is bound to the task through the checkpoint, matches the claim's operation id, and names the tool being dispatched.
  - T1's upsert was the only write in the transaction set that was neither state- nor epoch-fenced: re-parking silently reset a `running` checkpoint (stealing a live runner's claim) and resurrected terminal ones. Reachable in practice because `task_id` is 32 bits of entropy and is the checkpoint table's primary key. Now guarded.
  - The per-action attempt ceiling rolled back instead of terminalising, leaving the checkpoint `running` with a dead lease and the approval `executing` — a combination no sweeper pass selects, so the task was reclaimed and refused forever while its approval permanently occupied the one-live-per-task slot. It now fails the task, records the outcome, and releases the slot. A task deadline likewise no longer leaves a live approval behind (except while `reconciling`, where §8.2 requires it be preserved for audit).
  - `isAuthorizedHuman` accepted `unattributed:dashboard` — the exact marker used to mean "there is no attributable human" — along with confusable and zero-width spellings of listed actor names. Now normalised and explicitly rejected. Recovery-event `event_type` and `reconciliation_status` are closed vocabularies too, not just `reason_code`; a second approval in a resumed plan reports its real risk instead of `unknown`; job error logs are redacted; and canonical JSON has a depth bound so a cyclic or deeply nested plan throws a diagnosable error rather than exhausting the stack.
- The reviewer then re-ran every exploit against the fixes and confirmed each one now fails, which surfaced four smaller items also fixed: the new "Show arguments" control used the HTML escaper in a JS/attribute context (quotes unescaped), a NULL `args_encrypted` authenticated as `{}` because `argsDigest(null || {}) === argsDigest({})`, the preview endpoint's auth check was gated on `DASHBOARD_USER && DASHBOARD_PASS` so it vanished in an unauthenticated deployment, and the authorized-step seam verified the tool but not the arguments — a strictly weaker rule than the runner path, meaning the approved tool could run with unapproved arguments. The seam is also no longer re-exported through `require("./tools")`.
- A PR-readiness review then found two integration defects that every test had missed, because the tests exercised the transactions directly and never crossed the seams where these live. Both fixed and pinned:
  - **Every parked step created a second, still-approvable legacy approval.** A Brain step reaches the dispatcher through `callAgentTool`, which correctly queues a legacy approval — it cannot know the caller is a task — and T1 then created the authoritative row. Both survived, so the Approvals tab showed two entries for one action and approving the legacy one dispatched the tool standalone and discarded the result: verbatim the pre-ADR bug, reachable by clicking the wrong row. The legacy twin is now superseded and its payload discarded once the checkpoint owns the action, on both the cold-park and re-park paths.
  - **A resumed task's answer was discarded.** The runner synthesized a real answer and the scheduler recorded only a state string; meanwhile the transcript still said `waiting_for_approval`, which the platform maps to *failed*. The human who approved the dangerous action got a failed task and no answer. The resumed outcome is now delivered back into the task's transcript — status, result, appended steps, lineage preserved — so the follow-up continuation builder, the task-history UI, and automatic memory all see a normal completed task, and the resumption is recorded on the platform execution timeline.
  - Also from that review: the runtime `ensure`'s check-then-`ALTER` was still racy (it now tolerates `duplicate column name`, which is what actually closes the startup race); checkpoints were never given their platform-execution correlation despite the columns existing; the preview offered a "Show arguments" control for approvals whose payload had been discarded; and the preview path shared the null-versus-empty argument confusion that the dispatch path already closed.
- Added `test/approval-continuation.test.cjs` (123 assertions) covering all ten transactions against a real database: key derivation, separator rejection and the nesting bound, park atomicity and the unique-index rules, T2's two-row rollback, all three action-claim cases, prior-attempt capture, post-claim verification including altered arguments recomputed from the persisted plan, write fencing, ledger-conflict detection, every wake trigger and its exact state pair, all three orphan-recovery branches, the reconciliation lifecycle and its authorization requirement, sweeper liveness, the attempt ceiling, payload and tool authentication before dispatch, the on-demand preview, the authorized-step seam, and end-to-end resumption. Each guard was verified to have teeth by mutation: disabling the risk gate, the epoch fence, the human-authorization check, the wake state check, T2's atomicity check, the ledger-conflict check, the post-rollback audit, or the attempt limit each fails the suite.

### Filesystem path policy symlink escapes

- Fixed the path policy comparing paths lexically, so a symlink was judged by where it sat rather than by where it pointed. A link beneath an allowed root reached any target outside it, and a path could alias into a denied root under a name that matched no deny entry. Verified end to end before the fix: `read` returned the contents of a file outside the allowed root through a link inside it, and `write` overwrote that file. Both are now denied.
- Resolution walks the path component by component, so a `..` following a symlink applies to the link's target as the kernel applies it instead of being collapsed lexically first. Collapsing first erased the link entirely and defeated the check; this held for absolute and relative spellings alike, and the relative case additionally required absolutizing without normalizing.
- Configured roots are canonicalized the same way, so an allowed root that is itself a symlink keeps working. A target that does not exist yet is resolved through its nearest existing ancestor, which catches an escaping link in the part of the path that does exist without creating anything.
- Deny is evaluated lexically first and canonically second, so it can only have grown: a link sitting inside a denied root that points elsewhere stays denied, and an alias reaching into one is now caught.
- **Behavior change, fails closed:** a path containing a dangling symlink is now denied whenever any path policy is configured, where it was previously treated as an ordinary absent path. A dangling link is not distinguishable from an absent file by `existsSync` or `realpath` alone, and walking past one hid wherever it pointed.
- **Operational note:** a single configured root that exists but cannot be resolved denies *every* path rather than being skipped, since silently dropping a deny root would widen access. A rename that leaves a root dangling will lock out all filesystem tools; the returned message deliberately does not name the offending root.
- Not addressed, and documented in `docs/security.md`: the check-to-use race remains open, comparison stays case-sensitive so a case-variant spelling of a denied root is unrecognised on a case-insensitive mount such as WSL `/mnt/c`, and hard links have no separate target to resolve.
- Extended `test/path-policy.test.cjs` with symlink coverage: allowed-root escapes via file, directory and multi-hop links; `..` after a symlink in absolute, raw and cwd-relative spellings; deny-root aliasing in both directions; symlinked allowed and denied roots; nonexistent targets below escaping links; dangling links; unresolvable roots; operation-label independence; and enforcement through the live `read` and `write` handlers.

### ISO timestamp comparison correctness

- Fixed `generatePlatformDocs()`'s recent-event breakdown, which reported nothing at all. It used `datetime('now', '-24h')`, but `-24h` is not a valid SQLite modifier, so `datetime()` returned NULL and `timestamp > NULL` matched zero of 6,400 rows. Correcting only the modifier would have inverted the fault — timestamp columns store ISO 8601 while `datetime()` returns a space-separated string, and `'T'` (0x54) sorts above `' '` (0x20), so every row would then match. The query now binds an ISO bound.
- Fixed the `expired` and `revalidation_due` memory-intelligence stats, which compared `expires_at` / `revalidate_after` against `datetime('now')`. The fault was latent only because no memory currently carries either field; a memory expiring on the current date would not have been counted.
- Changed two `SET updated_at = datetime('now')` writes (memory enable in the dashboard, memory pin in the tool dispatcher) to store ISO. They were the only writers that could mix a space-separated value into columns that are otherwise entirely ISO, which would have mis-ordered Predict's `memories.updated_at` range query.
- Added `test/timestamp-format.test.js`: demonstrates both silent failure modes (a NULL bound matching nothing, and an ISO value out-sorting a same-date bound), asserts no runtime query compares a column against `datetime()`, and verifies the kernel event window and memory expiry stats against the real migrated schema.

### Tool-log session and project correlation

- MCP tool calls now record the transport's per-connection `sessionId` on `tool_logs`. The field was already plumbed end-to-end (`createMcpExecutionContext` -> `dispatcherMetadata` -> `logToolCall`), but the three MCP registration sites in `src/index.js` passed only `requestId`, so `session_id` was null on every row from every source. Without it each call is its own execution boundary and Predict's sequence detectors correctly produce nothing.
- `project` is now recorded when a tool call explicitly names one, so project-scoped analysis has data to work with. Scope is observed from the call, never guessed.
- Deliberately not used: a constant session identifier from `SIDEKICK_SESSION_ID`. A fixed value would group every call ever made into one sequence and let the detectors infer adjacency between unrelated calls — the same failure mode as the removed `_global` bucket. `toolCallContext()` documents this and `test/tool-log-correlation.test.js` pins it.
- Added `test/tool-log-correlation.test.js` covering session threading, absence handling, shared use of the context builder across all registration sites, project observation, and the resulting sequence boundaries.

### Predict signal quality and lifecycle correctness

- Fixed the root-cause defect behind low-quality predictions: `tool_logs` stores a `success` column and has no `ok` column, but every detector read `log.ok`. That made **every** tool call count as a failure — production showed `github has 33 unknown failures` at `very_high` confidence against an actual 4 failures in 85 calls — while silently disabling the prerequisite and workflow detectors entirely, since both required a successful call. Rows are now normalized before any detector sees them.
- Fixed reversed sequence chronology. Tool logs are read newest-first for recency selection but are now explicitly sorted ascending before analysis, so `knowledge → tools` yields "After knowledge, tools commonly follows" rather than its inverse.
- Removed synthetic global-session stitching. Records without a durable correlation identifier (`session_id`, `correlation_id`, `task_id`) are skipped instead of being merged into one `_global` sequence, and sequences never cross sessions, projects, or a configurable time gap (default 30 minutes).
- Analysis now requires an explicit scope (`project`, `session`, `task`, or a deliberately requested `global`). An empty request no longer triggers a seven-day all-project sweep, and predictions from different projects are never merged into a project-null record.
- Disabled the `relevant_context` detector by default. A recent, pinned, or high-confidence memory is not a prediction; when explicitly enabled it emits only in-scope context carrying an unresolved, actionable condition.
- Prerequisites now require repeated recovery evidence (`A` fails → `B` succeeds → `A` succeeds) within a bounded window and step distance, across at least two sessions. Bare "A failed then B succeeded" adjacency no longer infers a requirement.
- Added detector-specific minimum evidence for failure predictions (≥5 attempts, ≥3 failures, ≥34% failure rate, ≥2 failures in 24h, ≥2 sessions), documented with reasoning in `docs/predict.md`.
- Added a central candidate-admission gate covering type, scope, evidence count, observation count, distinct sessions, probability, confidence, actionability, and contradiction. Rejections are tallied by reason in the analysis summary rather than persisted. Admitted candidates are ranked globally before the creation limit, so detector order no longer decides which survive.
- Introduced a logical prediction identity (`identity_key`) over rule version, type, canonical relation, and scope, protected by a partial unique index on active rows. Reanalysis refreshes, reactivates, or suppresses the existing record instead of appending an equivalent row after expiry; dismissals and recorded outcomes are preserved, never silently rewritten.
- Expiration now follows the time horizon (4h / 12h / 7d / 30d / never) instead of applying a single 72-hour expiry to every prediction, including open-ended ones.
- Added a configurable retention policy with `purge_preview`, `purge` (requires `confirm: true`), and a read-only `diagnose` report. Deletion is transactional, removes child rows explicitly, preserves confirmed predictions and anything carrying feedback, retains all feedback rows, and writes one audit row per operation rather than one per deleted record. Nothing is deleted automatically.
- Made prediction, evidence, and audit insertion atomic, and replaced empty `catch` blocks with bounded, redacted diagnostics.
- Fixed `feedbackWeight()`, which compared `project = '%'` — an equality test against a literal percent sign that matched nothing for the no-project case. Feedback is now scoped to its rule version, project, and prediction type, counted once per prediction, and bounded to ±0.1.
- Replaced recursive stale meta-predictions (`Prediction may be stale: Prediction may be stale: ...`) with explicit lifecycle transitions and reasons on the original record.
- Aligned the dashboard with the backend: corrected prediction type labels and filters to the real enum, replaced status fields the backend never returned, removed a fabricated 30-day retention display, added a visible scope selector, and made Analyze report what changed.
- Raised the `predict` tool's risk classification to `medium`, matching `black_box`, now that it exposes a bulk-delete action.
- Added `test/predict-contract.test.js` and rewrote the Predict suites (67 tests) covering sequence direction, boundary isolation, evidence thresholds, admission, identity and lifecycle, retention safety, feedback scope, and frontend/backend contract alignment.

### Agent Bridge follow-ups (task continuation)

- Added a first-class follow-up system: `POST /api/agent/run/:taskId/follow-up` creates a new child task durably linked to a terminal parent (immediate parent, thread root, and continuation depth), seeded with a bounded, redacted, untrusted-labeled summary of prior work. The original task is never reopened or mutated, and `POST /api/agent/run` stays fully backward compatible via a shared task-start path.
- Added `src/agent-continuation.js`, a side-effect-free module for strict task-ID validation, contained/symlink-safe transcript loading, transcript normalization (old transcripts normalize to roots), lineage resolution with cycle and depth bounding, and deterministic bounded continuation-context construction. All limits are centralized in `CONTINUATION_LIMITS`.
- The continuation brief reaches both the direct-answer and tool-loop routing paths as a distinct system message, clearly separated from Sidekick system instructions and the user goal. `thought` steps, hidden reasoning, raw transcripts, unredacted secrets, and approval state are never included; prior tool output is labeled untrusted reference material.
- Preserved the security boundary: every child tool call still flows through `callAgentTool`, so tool policy, approval, path restrictions, timeouts, audit, and redaction are re-evaluated per call. No earlier approval is inherited; follow-ups are refused against an actively running parent (`409`), and errors never leak paths, stack traces, or secrets.
- Added the Agent tab follow-up UI (terminal-task follow-up control with duplicate-submit protection, child selection via the existing SSE stream, and parent/root lineage rendering) and lineage fields in `/api/agent/history` and `/api/agent/run/:id` with old-transcript compatibility.
- Added `test/agent-continuation.test.js`, `test/agent-bridge-followup.test.js`, and `test/agent-followup-ui.test.js` covering continuation-context construction, lineage/API behavior, path-traversal and malformed-transcript handling, the tool-execution boundary, and the UI controls.

### Agent Bridge tool execution

- Fixed the Agent tab routing so system-inspection requests ("check disk usage", "how much free memory", "CPU load", "running processes", uptime, swap, ports) reach the tool loop and run approved tools instead of only explaining commands. `requiresToolUse` now recognizes live host-resource requests while keeping conceptual prompts ("explain how disk usage works") conversational.
- Extracted the planning/tool-execution loop into `src/agent-loop.js` (`runToolLoop`) with injected LLM and tool functions. All tool calls still flow through `callAgentTool`, preserving the tool allowlist, policy, approval controls, and audit logging in the dispatcher; no arbitrary shell execution is exposed.
- Added `test/agent-loop.test.js` covering successful approved execution, denied/unauthorized tools, unavailable tools, tool execution failures, and requests that should not invoke tools, plus expanded system-inspection routing coverage in `test/agent-protocol.test.js`.

### Licensing

- Sidekick is now licensed under the GNU General Public License v3.0 only (`GPL-3.0-only`).

### Evolve workflow learning and dynamic tools

- Replaced the legacy LLM-confidence Evolve flow with deterministic workflow mining, candidate scoring, validation, explicit lifecycle states, trial activation, promotion, feedback, and deprecation.
- Added redacted telemetry fields for source/session/task boundaries, normalized argument shape, fingerprints, errors, retries, generated-procedure calls, and result summaries.
- Added DB-backed generated capability and generated-tool audit tables plus dynamic registry sync for `sidekick_generated_<name>` tools.
- Added focused tests for chronology, false cross-session sequences, retries/failures, parameter inference, validation, dynamic discovery, persistence, deprecation, audit retention, feedback, and legacy procedure compatibility.
- Corrected documentation to distinguish stored procedures, generated dynamic MCP tools, and native built-in tools.

### Security configuration scanner

- Added `sidekick_security_scan`, a read-only audit for tracked sensitive files, credential signatures, hardcoded security settings, runtime `.env` safety, and sensitive-file permissions.
- Scanner output contains metadata only and obeys filesystem path policy, including denied descendants.
- Added bounded scanning, text/JSON output, dedicated tests, and database-first operating guidance.

### Health and smoke probes

- Fixed `sidekick_health check=all` report crashes when process, disk, or network commands fail.
- Replaced the synchronous MCP self-probe with an asynchronous child process so `/health` can respond while `sidekick_ops` is running.
- Added composite health regression coverage and stable failure result shapes.

## 2026-06-17

### Memory System Complete (PR #19, #20, #21)

The memory system is now fully implemented with all planned features from the persistence roadmap.

#### PR #19: Memory Conflict Detection
- Token-overlap similarity detection for conflicting memories
- Automatic supersession with metadata tracking (superseded_by, reason, similarity score)
- Project-aware conflict matching
- Confidence-aware supersession (low-confidence can't supersede high-confidence)
- Dedup-safe extraction (no duplicate goals from notes)

#### PR #20: Memory Phase 2
- **Memory Brief**: Structured context injected into Agent Bridge before each task (preferences, facts, decisions, open threads, related context)
- **Import/Export**: JSON-based memory portability with filtering (project, type, disabled, automatic)
- **Review UI**: New Memory page in dashboard with stats, filtering, management actions, expire stale button
- **Qdrant Embeddings**: Semantic recall via Ollama nomic-embed-text + Qdrant, merged with keyword search
- **Memory Lifecycle**: Auto-expiration (90 days stale), confirmation decay scoring, last_confirmed_at tracking, stats dashboard
- **New MCP Tools**: sidekick_memory_export, sidekick_memory_import
- **Database Migrations**: 004 (lifecycle), 005 (sync support)

#### PR #21: Memory Deferred Features
- **State Tracking**: Full lifecycle states (active, pending, confirmed, superseded, expired, deleted)
- **Confirmation Workflow**: requires_confirmation flag for high-value memories, confirmMemory action with confirmed_by tracking
- **Soft-Delete & Expiration**: deleted_at/expired_at with reason tracking, restore capability
- **Auto-Expire**: setAutoExpire and processAutoExpirations for scheduled expiration
- **New MCP Tool**: sidekick_memory_manage (9 actions: confirm, set_requires_confirmation, delete, expire, restore, set_auto_expire, list_by_state, pending_confirmations, process_auto_expirations)
- **Database Migration**: 006 (state tracking, confirmation, soft-delete)

#### Cross-Machine Sync
- Stable machine identity (auto-generated UUID) and user identity (user-configurable)
- Origin tracking on each memory (origin_machine_id, origin_user_id)
- Sync metadata (sync_version, last_synced_at)
- Sync export/import with 5 conflict resolution strategies (newest, highest_confidence, most_confirmed, merge, skip)
- Incremental sync with since parameter
- **New MCP Tools**: sidekick_sync_identity, sidekick_sync_export, sidekick_sync_import, sidekick_sync_diff

#### Test Coverage
- automatic-memory.test.js (297 lines)
- memory-lifecycle.test.js (140 lines)
- memory-sync.test.js (213 lines)
- memory-deferred.test.js (180 lines)
- **Total: 830 lines of memory tests**

#### Summary
- Total MCP tools: 83 → 90
- Database migrations: 001-006
- All 10 sections of the persistence roadmap complete

### Grafana Fix
- Removed deprecated Angular plugin (grafana-simple-json-datasource)
- Fixed alerting provisioning config
- Fixed data directory permissions

## 2026-06-15

### v1.19: Security Policy and Documentation Audit
- Added config-driven tool policy with global and source-specific allow/block lists.
- Added risk classifications for all 83 built-in MCP tools.
- Dashboard Tools tab now shows tool risk and active policy status.
- MCP and Agent Bridge execution paths enforce the active tool policy.
- Agent Bridge prompt only advertises tools enabled for the `agent` source.
- Updated README, AGENTS.md, CONTEXT.md, Roadmap, and docs to align on 83 built-in MCP tools.
- Documented recommended restricted mode for shared or public-facing deployments.

## 2026-06-13

### Dashboard: Tools Tab
- Added dedicated **Tools** tab to the dashboard (6th tab)
- Browsable catalog of all 59 tools with search and category filtering
- 15 tool categories with Font Awesome icons (Core, Storage, Git & GitHub, Services, Scheduling, Communication, Context & Learning, Data Pipeline, Monitoring, Workflow, Meta, Efficiency, Security, Development, Reliability, Archive)
- Click any tool card to see detailed argument info in a modal
- Added `GET /api/tools` endpoint returning `TOOL_DEFS` from `src/tools.js`

### v1.18: Operations Platform Expansion (10 new tools)
- **`sidekick_anonymize`** — Replace sensitive data with realistic fake values. Consistent mapping, custom patterns, safety net via redact.
- **`sidekick_sandbox`** — Execute operations with automatic file backup and rollback. Safe experimentation on remote systems.
- **`sidekick_changelog`** — Generate release notes from git history. Groups by type/scope/author, optional LLM summaries.
- **`sidekick_netdiag`** — Unified network diagnostics: DNS, routing, port scanning, connectivity checks, local listeners.
- **`sidekick_timeline`** — Build chronological timelines from multiple sources (log.jsonl, journalctl, git, files).
- **`sidekick_circuit`** — Generic circuit breaker for any tool call. Fast-fail when targets are down, configurable thresholds.
- **`sidekick_baseline`** — Behavioral baseline and anomaly detection. Learns patterns, detects statistical deviations.
- **`sidekick_depend`** — Dependency analyzer for npm, systemd services, processes. Trees, reverse deps, impact analysis.
- **`sidekick_runbook`** — Operational runbook executor with autonomous and guided modes. Verification, rollback, step-by-step.
- **`sidekick_black_box`** — Incident time capsule capturing full system context. Rate limited (5/day, 7-day TTL, 3 active max).
- Total tools: 49 → 59

## 2026-06-11

### v1.15: Meta-Capabilities (evolve, orchestrate, predict)
- **`sidekick_evolve`** — Self-modification with safety: analyze tool usage patterns, propose improvements, test and approve changes
  - Analyzes tool usage logs to find frequent patterns
  - Proposals require testing and explicit approval
  - Rate limited to 10 proposals per day
  - Tracks proposal history and feedback
- **`sidekick_orchestrate`** — Multi-agent coordination: create task graphs, execute subtasks with dependencies
  - Supports parallel and sequential execution
  - Dependency tracking between subtasks
  - Resource limits (timeout, concurrent tasks)
  - Progress tracking across all subtasks
- **`sidekick_predict`** — Anticipatory intelligence: analyze patterns, predict needs, track prediction usefulness
  - Analyzes context and tool usage patterns
  - Generates predictions with confidence scores
  - Tracks prediction usefulness via feedback
  - Suggests actions based on past predictions
- Total tools: 34 → 37

### v1.14: Workflow & Reliability (validate, template, queue, retry)
- **`sidekick_validate`** — Validate data against JSON Schema using ajv
  - Supports JSON Schema draft-07
  - Returns detailed error messages with paths
  - Auto-parses JSON strings
- **`sidekick_template`** — Render Handlebars templates with data
  - Supports variables, conditionals, loops, and helpers
  - For config generation and dynamic content
- **`sidekick_queue`** — Persistent task queue with priorities
  - Priority-based task scheduling
  - Status tracking (pending/processing/completed/failed)
  - Automatic retry tracking with attempt counts
- **`sidekick_retry`** — Retry wrapper for tool calls with backoff
  - Exponential, linear, and fixed backoff strategies
  - Configurable max attempts and initial delay
- Total tools: 30 → 34

### v1.13: Core Data Utilities (parse, diff, hash)
- **`sidekick_parse`** — Parse structured data formats with auto-detection
  - Supports JSON, YAML, XML, INI, CSV
  - Auto-detects format from content
  - Returns parsed JSON structure
- **`sidekick_diff`** — Semantic comparison with structure-aware diffing
  - Text diff (line-by-line)
  - JSON/YAML diff (structure-aware, shows added/removed/modified fields)
  - Output formats: unified, summary, JSON
- **`sidekick_hash`** — Checksum generation and verification
  - Algorithms: MD5, SHA1, SHA256, SHA512
  - Can hash strings or files
  - Verification mode to check against expected hash
- Added dependencies: yaml, fast-xml-parser, ini
- Total tools: 27 → 30

### v1.12: Companion Tools Phase 1 (transform, health)
- **`sidekick_transform`** — Data manipulation pipeline
  - Actions: filter, extract, sort, format, map
  - Format options: json, csv, table, text
  - Enables tool composition (bash | transform | context)
- **`sidekick_health`** — Composite system health checks
  - Checks: services, processes, disk, network, custom
  - Scoring system (0-100)
  - Threshold-based alerting
  - Stores health history for trending
- Total tools: 25 → 27

### v1.11: Companion Tools Phase 2 (delay, snapshot)
- **`sidekick_delay`** — One-shot task scheduling
  - Time formats: 10s, 5m, 2h, 1d, or ISO date
  - Agent bridge loads delays on startup
  - /api/delays/reload endpoint for live updates
- **`sidekick_snapshot`** — State capture and drift detection
  - Capture types: processes, services, disk, packages, network, files
  - Compare snapshots to detect added/removed/changed items
  - Stores snapshots in data/snapshots/
- Total tools: 23 → 25

### v1.10: Companion Tools Phase 3 (watch, secret)
- **`sidekick_watch`** — Event-driven monitoring
  - Sources: service, process, endpoint, file
  - Conditions: status!=active, not_running, status!=200, content_matches
  - Configurable intervals (30s, 5m, 1h)
  - Triggers tool calls when conditions met
  - Agent bridge loads watches on startup
- **`sidekick_secret`** — Encrypted credential management
  - AES-256-GCM encryption
  - Requires SIDEKICK_SECRET_KEY in .env
  - Actions: store, get, delete, list, rotate
  - Rotation with random value generation
- Total tools: 21 → 23

### Companion Tools Expansion (v1.10-v1.15)
- Implemented 10 new companion tools in 3 stages
- Stage 1 (Core Data Utilities): parse, diff, hash
- Stage 2 (Workflow & Reliability): validate, template, queue, retry
- Stage 3 (Meta-Capabilities): evolve, orchestrate, predict
- All tools follow Unix philosophy: single responsibility, composable
- Total tools: 21 → 37

### v1.5: sidekick_teach - Meta-Learning and Self-Extension
- **`sidekick_teach`** — Revolutionary tool that enables sidekick to learn new procedures and generate new tools dynamically
- Actions: teach_procedure, generate_tool, learn_from_example, execute, list, remove
- Uses LLM to generate procedure steps from natural language descriptions
- Stores procedures as JSON for safety and portability
- Transforms sidekick from a fixed tool server into a self-extending platform
- Total tools: 20 → 21

### v1.4: sidekick_context - Persistent Intelligent Context Management
- **`sidekick_context`** — Tracks projects, decisions, problems, and patterns across sessions
- Actions: track_project, track_decision, track_problem, track_pattern, recall, suggest, summarize, list
- Semantic similarity search for intelligent recall
- Proactive suggestions based on past context
- Stores context in `data/context.json`
- Total tools: 19 → 20

### v1.3: Automation and Integration Tools
- **`sidekick_cron`** — Schedule recurring tasks using system crontab
  - Actions: add, list, remove, run
  - Stores jobs in `data/cron.json`
  - Syncs with system crontab for execution
- **`sidekick_github`** — Full GitHub API integration
  - Actions: pr_list, pr_create, pr_get, pr_merge, issue_list, issue_create, issue_close, commit_status, release_create, repo_info
  - Uses stored `github_token` from KV
- **`sidekick_webhook`** — Receive and manage webhooks from external services
  - Actions: list, get, clear
  - Webhook endpoint: `POST /api/webhook/:source` on dashboard
  - Stores webhooks in `data/webhooks.json` (max 1000)
- Total tools: 16 → 19

### v1.2: VPS Management Tools
- **`sidekick_process`** — Manage processes (list, top CPU/memory, kill, tree)
  - Actions: list, top, kill, tree
  - Filter by name, kill by PID or name
- **`sidekick_service`** — Manage systemd services safely
  - Actions: start, stop, restart, status, enable, disable, logs
  - Validates service names, prevents dangerous commands
- **`sidekick_archive`** — Create, extract, or list archives
  - Actions: create, extract, list
  - Formats: tar.gz, tgz, zip
- Total tools: 13 → 16

### v1.1: Core Utility Tools
- **`sidekick_search`** — Fast file content search using ripgrep (falls back to grep)
  - Supports regex patterns and file filtering
  - Much faster than manual bash grep
- **`sidekick_git`** — Structured git operations
  - Actions: status, diff, log, add, commit, push, pull, branch, checkout, stash
  - Safer than raw bash for git commands
  - Validates actions, prevents dangerous operations
- **`sidekick_notify`** — Send notifications to Discord, Slack, or email
  - Discord/Slack via webhooks
  - Email via SMTP (requires SMTP_HOST, SMTP_USER, SMTP_PASS env vars)
- Total tools: 10 → 13

### SSH Key Infrastructure
- Generated new ED25519 SSH key on VPS
- Added to authorized_keys for both root and sidekick users
- Saved to `C:\Users\geoffrey\.ssh\sidekick` on Windows
- Replaced old broken key that wasn't working
- All deploys now use the new key successfully

## 2026-06-10

### Dashboard Security Hardening
- Added rate limiting (200 requests per 15 minutes per IP)
- Added request size limits (1MB max)
- Added CSRF protection via Origin header validation
- Added IP whitelist support (`SIDEKICK_DASHBOARD_ALLOWED_IPS`)
- Added audit logging for all state-changing operations (PUT/DELETE)
- Added error logging endpoint for frontend errors
- Added `credentials: 'same-origin'` to all 15 fetch() calls
- Replaced all 14 silent `.catch(()=>{})` with proper error handler (`apiError`)
- Added toast notification system for user-friendly error messages
- Added centralized error logging to `/data/dashboard-errors.log`
- Added tab-aware auto-refresh (only refresh when System tab visible)
- Added Page Visibility API check to reduce unnecessary API calls

### Dashboard Syntax Fix
- Fixed template literal escape sequences in frontend JavaScript (commits `d806a4f`, `3279cdd`)
- Lines 749, 768: Inner template literals needed escaping (`\`` and `\${}`)
- Lines 982, 1109, 1113, 1116, 1155: Single-quoted onclick handlers needed double backslash (`\\'` instead of `\'`)
- Root cause: Inside Node.js template literal, `\'` is unrecognized escape → Node strips backslash → bare `'` breaks browser JS

### Sensitive Data Redaction
- All tool outputs automatically scanned for sensitive data and redacted before logging or display
- Patterns: SSH keys (RSA, EC, DSA, OPENSSH), GitHub tokens (ghp_, github_pat_), API keys (sk-*), AWS keys (AKIA*, aws_secret_*), passwords in env vars, Bearer tokens, database connection strings, Stripe keys, JWT tokens

### Project Labeling System
- KV store supports project-based organization via `project` parameter
- Dashboard shows project badges and filtering
- Better context grouping across sessions

### Enhanced Dashboard UI
- Timestamps with relative time display ("Created 2h ago", "Updated 5m ago")
- Source badges showing where data came from (mcp/agent/dashboard)
- Expandable value previews — click to see full content in a modal
- Age filtering — filter by today/this week/this month/all time
- Failed command highlighting — red background and border for errors
- Sort by updated date — newest entries first

### Testing Strategy
- Comprehensive testing strategy developed: 7 priority levels, 19 hours estimated
- Priority 1: Security tests (redaction, auth, dangerous commands) — 4 hours
- Priority 2: Error handling — 3 hours
- Priority 3: MCP protocol compliance — 3 hours
- Priority 4: Agent bridge — 3 hours
- Priority 5: Dashboard APIs — 2 hours
- Priority 6: Performance — 2 hours
- Priority 7: Backward compatibility — 2 hours
- Tests written and ready for local validation

## 2026-06-09

### Initial VPS Deployment
- Migrated to new VPS (149.28.229.13)
- Set up SSH keys and authentication
- Deployed all services (MCP, Dashboard, Agent)
- Initial KV store seeding with 35 system reference keys (IP, services, security, software, deployment)
- Created `sidekick` user with restricted sudo (service management only)
- Configured fail2ban, UFW, unattended-upgrades

### Core Architecture
- MCP Server (`:4097`) — 10 tools, session-aware transport (new McpServer+Transport per session)
- Dashboard (`:4098`) — web UI with System, Activity, Data, Config, and Agent tabs
- Agent Bridge (`:4099`) — autonomous LLM agent that calls tools directly (bypasses MCP HTTP)
- Ollama (`:11434`) — local Phi-3-mini fallback, cloud Groq API when `GROQ_API_KEY` is set

### AGENTS.md Integration
- Leveraged opencode's AGENTS.md mechanism for persistent collaboration
- Sidekick reads instructions on every session start
- KV store provides cross-session memory
- `@sidekick` subagent for complex multi-step tasks
