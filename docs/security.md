# Security

Sidekick is powerful by design. It can execute commands, read and write files, manage services, store secrets, and call external APIs. Treat it like remote shell access to the host.

## Shell command isolation

Legacy shell commands used by cron jobs, runbooks, custom monitors, and health
checks run through the OS-enforced Bubblewrap boundary. On Linux, Sidekick
requires a verified Bubblewrap and `prlimit` installation; shell startup fails
closed if either isolation setup or namespace creation fails. This legacy
command path has no host workspace mounted and no network access. Commands that
need project files or outbound access must use a governed execution path that
grants those scopes explicitly. Windows and macOS currently have no equivalent
backend for this path, so shell commands are rejected there rather than run
directly on the host. Dedicated service and infrastructure tools remain the
supported way to perform those operations.

Endpoint watches accept HTTP and HTTPS only. They use a direct Node HTTP client,
pin DNS results to the connection, bound response headers and duration, and do not
follow redirects. Public destinations use the default outbound policy; private
destinations require an operator-created network scope. A watch stores the
scope revision selected at creation and fails closed if that scope is changed,
expired, or revoked. A denied scheduled check is audited as failed and cannot
trigger its configured action.

`netdiag` HTTP(S) checks use the same outbound probe and require a current
network scope for private URL targets. URL checks do not also send ping or SSH
probes to the hostname. Host-only diagnostic actions remain separately gated
by the high-risk `netdiag` permission.

InfluxDB metrics requests reject redirects, abort after 15 seconds, and stream
responses through a 5 MiB bound (error bodies are limited to 64 KiB). The
configured Influx URL must still pass the explicit host allowlist, and metrics
operations retain their action-specific identity and risk checks.
The optional systemd metrics collector reads its Influx token from the
protected `SIDEKICK_SECRET_DIR`; installer checks validate that file before
enabling the timer. The collector unit runs as `sidekick` with a restrictive
umask, read-only home access, and systemd filesystem and kernel protections.
It loads non-secret settings from `/etc/sidekick/sidekick.env` rather than the
repository `.env`.

Qdrant memory requests reject redirects and abort after 15 seconds. Semantic
search responses are streamed through an 8 MiB bound, with oversized response
bodies cancelled; the Qdrant endpoint remains an operator-configured service.

GitHub API requests keep their existing 30-second timeout and cap each response
at 8 MiB. CI status pagination is capped at 50 pages; reaching the cap returns
an explicit error instead of silently presenting partial results as complete.

Discord and Slack notification error bodies are capped at 64 KiB and truncated
responses are closed. SMTP responses are drained without retaining their body;
the existing 30-second SMTP deadline remains in effect.

## MCP authentication

The MCP server requires an API key. Clients can send it as:

```http
Authorization: Bearer YOUR_SIDEKICK_API_KEY
```

Query-string API keys are not supported because URLs are routinely exposed in logs, browser history, proxy metadata, and referrer headers.

Set `SIDEKICK_API_KEY` to a strong non-placeholder value before starting the MCP server. Dashboard and Agent do not load this installation-wide client credential. MCP startup validates that its API key differs from the Dashboard-to-Agent proxy key and that any configured scheduler key differs from the proxy key. Agent independently rejects scheduler/proxy key reuse before serving requests.

The Dashboard summary obtains protected MCP session diagnostics with the current authenticated Dashboard identity session. MCP authorizes those details using `dashboard.operations.read` (or `system.configure`); the Dashboard does not use the global MCP API key as an internal service credential.

The Dashboard-to-Agent Bridge uses a separate file-backed
`SIDEKICK_AGENT_PROXY_KEY` (`sidekick_agent_proxy_key`). Generate a distinct
random secret and provide it only to the Dashboard and Agent services. Never
reuse `SIDEKICK_API_KEY` or distribute the proxy key to MCP clients. Both
services require the secret before startup outside test mode.

MCP scheduling tools use `SIDEKICK_AGENT_SCHEDULER_KEY`
(`sidekick_agent_scheduler_key`) for timer reloads. It must be distinct from
the Dashboard proxy key; MCP startup also verifies that the proxy key differs
from the MCP API key, which makes the three configured values distinct. MCP
and Agent both reject scheduler/proxy key reuse. The Agent accepts this identity
only on the exact delay/watch reload POST routes; absent configuration blocks
new delay/watch definitions before they are persisted.

Signed Dashboard and scheduler proxy nonces are consumed in the shared Core
SQLite database, so replay is rejected across Agent processes using that same
database. Migration `101_agent_proxy_nonce_replay_store.sql` keeps only nonce
hashes until the timestamp acceptance window expires and enforces a 10,000
active-entry cap. A multi-host Agent deployment using separate database files
needs an atomic shared nonce backend for the same cross-host guarantee.

## IP allowlists

`SIDEKICK_ALLOWED_IPS` restricts MCP access by IPv4 address or CIDR range. Localhost is always allowed. `SIDEKICK_DASHBOARD_ALLOWED_IPS` provides similar filtering for the dashboard.

IP allowlists are useful but should not be the only protection if the service is public. Prefer VPN, SSH tunnel, reverse proxy auth, and firewall rules.

## Dashboard authentication

Fresh installations use the local identity bootstrap/login flow for dashboard
HTML, API routes, and agent event streams. `SIDEKICK_DASHBOARD_USER` and
`SIDEKICK_DASHBOARD_PASS` enable the legacy Basic Auth compatibility path when
explicitly configured. Static assets remain public so authenticated browsers
can load CSS and fonts. For public exposure, combine authentication with TLS
and network restrictions.

## Dashboard protections

The dashboard includes:

- in-memory rate limiting per IP;
- basic origin checks for mutating requests;
- audit logging of mutating actions;
- frontend error logging;
- optional Basic Auth;
- optional IP allowlist.

## Command safety

Host utility subprocesses launched through Sidekick's filtered environment omit
credential-named variables, known credential-file locators, runtime loader and
injection hooks, and URL values with credentials in userinfo, query parameters,
fragments, signed-URL signatures, or semicolon-style connection parameters.
This applies to both inherited environment values and explicit overrides. It
is a defense-in-depth filter, not general secret discovery: arbitrary values
may still contain sensitive data, so credentials should be retrieved through the
governed secret store only for the operation that needs them.

`bash` blocks commands matching known dangerous patterns, including examples such as recursive root deletion, common flag-order and case variants, block-device writes, filesystem creation, fork-bomb pattern, curl/wget piped to shell, and recursive `chmod 777 /`.

This is a guardrail, not a full sandbox. It will not detect every destructive command. Avoid granting Sidekick broader sudo access than necessary.

## Tool permission policy

Sidekick now supports a config-driven tool policy. Fresh installations default
to `SIDEKICK_TOOL_POLICY=restricted`, which blocks high- and critical-risk tools
unless they are explicitly allowed. Existing installations that explicitly set
the policy remain unchanged; `open` is an intentional opt-in for trusted
deployments.

Set `SIDEKICK_TOOL_POLICY=restricted` to block high and critical risk tools unless they are explicitly allowed. You can also set source-specific policies for `mcp`, `dashboard`, and `agent`:

```env
SIDEKICK_AGENT_TOOL_POLICY=restricted
SIDEKICK_AGENT_ALLOWED_TOOLS=read,search,get,respond
SIDEKICK_BLOCKED_TOOLS=db_restore,evolve
```

Policy lists accept tool names and risk selectors such as `risk:high` or `risk:critical`. Explicit blocklists win over allowlists.

High and critical tools are not removed from the project because trusted operators need them. For internet-reachable or shared deployments, run the agent and MCP source in `restricted` mode and allow only the tools required for the workflow.

The canonical dispatcher also requires an attributable principal for every
medium, high, or critical operation, including higher-risk actions on mixed
tools. A legacy installation-wide API key authenticates the transport but does
not identify a principal, so it cannot run non-low-risk tools through the
dispatcher. Create a scoped credential for an enabled principal with the
required permission and project grant. Explicit low-risk inventory remains
available under the configured source policy. Direct API routes must enforce
their own permission checks and are audited separately.

MCP HTTP bearer authentication also accepts an active Dashboard identity
session token. The session is resolved against current server-side state on
each request, so expiration, logout, and principal disablement take effect
immediately. It carries the principal's current role authority without
machine-credential scope attenuation; use a named scoped service credential
for unattended MCP clients. Keep browser session tokens in the HttpOnly
Dashboard cookie and do not copy them into client configuration, logs, or
persistent machine settings. This bearer support does not itself route
Dashboard or Agent tool dispatch through MCP; those processes still use local
dispatch in the current architecture.

For integrations that need a durable machine identity, the first-run Dashboard
opens Identity after Owner setup and offers **Connect an MCP client**. The flow
creates a separate named service identity for each agent and lets the Owner
choose standard tool execution, pack management, high-risk tools, and
critical-risk tools independently. An authenticated Dashboard Owner can also
provision one with `POST /api/auth/service-credentials`.
Supply a display name plus explicit `permissions` and `scopes`; scopes must be
a subset of the grants, and the initiating identity must currently hold every
requested permission. The endpoint creates the service principal, records its
per-principal grants, and issues its credential atomically. Omit
`expires_at` for a non-expiring credential; it remains revocable, and disabling
the principal invalidates its credentials. The raw token is returned once, so
the client must store it in its protected credential settings and never in
chat, logs, ordinary configuration, or memory. Dashboard-created credentials
expire after 90 days by default; the Owner can select a shorter or longer
lifetime, or explicitly choose no expiration. For example, a pack-management
connection should receive only `packs.read` and `packs.manage`. A client that
also needs to use ordinary low/medium-risk tools requires `tools.execute`; a
pack-management-only credential does not authorize those calls. High- and
critical-risk tools require their own explicit scopes.

The local CLI's MCP stdio transport uses the file-backed `sidekick_mcp_credential`
(`SIDEKICK_MCP_CREDENTIAL_FILE` may point to a protected file). It authenticates
each tool call against the current credential record, so missing, expired, or
revoked credentials cannot run privileged tools. Configure only the scopes the
local client needs; no implicit local owner identity is granted.

Use the tool policy inspector to verify effective access before and after changing environment variables:

```javascript
tools({ action: "policy", source: "mcp,dashboard,agent", name: "bash", format: "json" })
```

It reports the policy decision, active mode, matching selector when applicable, and approval requirement for each inspected source/tool pair.

## Per-action tool risk

Risk was originally a per-**tool** label. That is wrong for a tool whose actions
differ in danger, and the failure mode is not merely cosmetic.

`capability` is the case that exposed it. Installing a pack stores executable
code for review; third-party activation currently fails closed until OS
isolation is available. The capability lifecycle remains high impact because
it changes persistent extension state. But merely *listing* packs is a read — and because the dashboard's
Capabilities tab calls `capability action="list"` when it loads, opening that tab
filed a critical-risk approval request. Rejecting it did not help: the tab
refetched and filed another.

The damage is the erosion, not the noise. An operator who learns that
`capability` prompts are routine UI chatter will wave through the one prompt that
genuinely matters — activation after isolation is delivered — because it looks
exactly like the twenty before it. An approval control spent on browsing
is not protecting anything.

`TOOL_ACTION_RISK` in `src/tools/metadata.js` declares per-action overrides, and
both the approval decision and the tool policy decision resolve risk through
them. Every rule is fail-closed:

- Only actions listed in the table get a different risk. Anything unlisted,
  missing, empty, or non-string keeps the tool-level risk.
- Lookups are own-property only, so `__proto__` or `constructor` cannot inherit a
  truthy value and lower the risk of a mutating call.
- Module-provided and generated tools are resolved **before** the table is
  consulted: their risk is the risk of the code that actually executes, and a
  caller-supplied action must never lower it.
- Callers that pass no arguments get the tool-level decision, unchanged.

The decision is evaluated against the same validated, frozen argument object the
dispatcher goes on to execute (`src/tools/dispatcher.js`), so a per-action risk
decision cannot disagree with what actually runs.

Add an action to the table only when it cannot mutate state, spend credentials,
or execute foreign code. When unsure, leave it out — the cost of omitting one is
an extra prompt; the cost of adding one wrongly is a silent bypass. `capability
inspect` is deliberately absent for this reason: it reads a caller-supplied path.

### Why the table is short

The table covers `capability` and `workflow` only, and that is a measured result
rather than an unfinished job. 30 tools carry high or critical risk and 22 of
them have action enums containing obvious reads (`list`, `status`, `get`,
`check`), so the temptation is to sweep them all. The traffic does not support
it:

- The **dashboard** dispatches exactly three tools — `capability`, `workflow`,
  and `evolve` — plus `db_query`. `evolve`'s read routes query the database
  directly and never dispatch the tool, so only the first two are read paths
  through the dispatcher.
- The **agent** has never called a critical-risk tool at all.
- **MCP** runs with approval mode `off`, so its traffic never produces a prompt
  regardless of risk.

Every other high/critical tool has no read path that reaches an approval
decision. Adding overrides for them would be speculative: entries can only lower
risk, so an unnecessary one is pure downside. Extend the table when a read path
demonstrably exists, not because an action is named `list`.

## Filesystem path guardrails

Filesystem operations fail closed until an allowed root is configured. Set comma-separated absolute paths for the directories Sidekick is authorized to access; leaving all allow-list variables empty denies filesystem path operations. Denied paths further narrow access and never create an allow grant:

```env
SIDEKICK_ALLOWED_PATHS=/home/sidekick/sidekick,/home/sidekick/projects
SIDEKICK_DENIED_PATHS=/home/sidekick/.ssh,/etc
SIDEKICK_AGENT_ALLOWED_PATHS=/home/sidekick/projects
```

Allowed entries match the path itself and descendants. Denied entries take precedence over allowed entries. Source-specific allow-lists (`MCP`, `DASHBOARD`, `AGENT`) are separate; a root configured for one source does not authorize another. Existing deployments with empty allow-lists must configure roots before filesystem-backed tools will work. Keep roots as narrow as the authorized project or workspace; broad roots expose all files readable by the Sidekick service account to callers who have the relevant tool permission. Source-specific deny lists are also available, for example `SIDEKICK_AGENT_DENIED_PATHS`.

Paths are canonicalized before they are compared, so a symlink is judged by where it points rather than by where it sits: a link beneath an allowed root cannot reach a target outside it, and a path that resolves into a denied root is denied whichever route reaches it. Resolution follows the path component by component, so a `..` after a symlink applies to the link's target as the kernel applies it, rather than being collapsed away first. Configured roots are canonicalized the same way, so an allowed root that is itself a symlink keeps working. A target that does not exist yet is resolved through its nearest existing ancestor, which is enough to catch an escaping link in the part of the path that does exist. A dangling symlink, a symlink cycle, or a configured root that exists but cannot be resolved is refused rather than guessed past — note that a single unresolvable root denies every path, so a broken entry locks the guard shut rather than opening it.

Three limits are worth stating plainly. A hard link is not a symlink and has no separate target to resolve, so a hard link created inside an allowed root to a file outside it reads as an ordinary file in that root and is permitted; keep allowed roots on filesystems where untrusted users cannot create links to sensitive files. Comparison is case-sensitive, so on a case-insensitive filesystem — a `/mnt/c` DrvFS mount under WSL, for example — a differently-cased spelling of a denied root is not recognised; keep roots on a case-sensitive filesystem where this matters. And this is a check on the path, performed before the operation: it does not close the window between the check and the subsequent filesystem access, so a path that is replaced in that interval can still be followed.

The guard applies to direct path arguments on file, archive, search, diff, database export/backup/restore, media, watch, snapshot, changelog, and ops tools. It does not parse arbitrary commands passed to shell-capable tools. On Linux, canonical `bash` execution uses Bubblewrap namespaces, a cleared environment, read-only system mounts, no network namespace access, an optional explicitly authorized workspace, and kernel-enforced per-process limits through `prlimit`, including an 8 GiB address-space ceiling. This address-space ceiling applies separately to each process; aggregate cgroup quotas remain an open control. Missing or unusable isolation blocks execution before the command starts. Windows and macOS currently have no supported shell isolation backend and therefore fail closed. These controls contain commands; they do not isolate trusted first-party capability modules, which still execute in the Core process. Install `bubblewrap` and `util-linux` (for `/usr/bin/prlimit`) through `scripts/bootstrap.sh` or `scripts/setup-tools.sh`; existing deployments need those packages installed before shell execution can work. Brokered host administration remains open. Keep high-power tools behind policy and approval. The `sandbox` tool's `exec` action remains disabled because its backup/rollback implementation does not provide OS-enforced isolation.

### Media download egress

The `download` tool performs a DNS preflight and refuses private, loopback,
metadata, and link-local destinations. It then gives yt-dlp an ephemeral,
authenticated loopback proxy using the browser subsystem's pinned-DNS egress
policy, so redirects and CDN requests receive the same destination checks.
Ambient yt-dlp configuration and plugin directories are disabled for the call.
The tool also disables call-home/cache behavior, uses a socket timeout,
restricts filenames, caps the download size (`SIDEKICK_MAX_DOWNLOAD_BYTES`,
bounded to 1 MiB–2 GiB), and canonicalizes and revalidates the resulting file
before custody registration. The downloader runs asynchronously, honors the
dispatcher cancellation signal, and the temporary proxy is closed on success,
failure, or cancellation. This is application-level proxy mediation; it is not
an OS network sandbox. A compromised downloader or code path that ignores its
explicit proxy option could still attempt direct egress. Deployments that need
containment against a compromised downloader must apply an OS/network egress
boundary as well.

## Approval queue

The approval queue is a dashboard review layer for allowed tools. It does not
enable tools that policy blocks. Fresh installations default to
`SIDEKICK_APPROVAL_MODE=strict`, requiring approval for high- and critical-risk
tools; existing installations that explicitly set the mode remain unchanged.

Set `SIDEKICK_APPROVAL_MODE=risky` to queue critical-risk tools for dashboard approval, or `SIDEKICK_APPROVAL_MODE=strict` to queue high and critical tools. Approval lists accept exact tool names and risk selectors, and source-specific variables are available for `MCP`, `DASHBOARD`, and `AGENT` sources:

```env
SIDEKICK_SECRET_KEY=replace-with-a-strong-random-secret
SIDEKICK_APPROVAL_MODE=risky
SIDEKICK_APPROVAL_TTL_SECONDS=3600
SIDEKICK_APPROVAL_REQUIRED_TOOLS=evolve,db_restore
SIDEKICK_APPROVAL_EXEMPT_TOOLS=bash
SIDEKICK_AGENT_APPROVAL_MODE=strict
```

Pending requests appear in the dashboard Approvals tab with structurally redacted argument previews. Full arguments are encrypted with `SIDEKICK_SECRET_KEY`, never returned by the approval-list API, and discarded after approval, rejection, failure, or expiry. Pending approvals expire after `SIDEKICK_APPROVAL_TTL_SECONDS` (default: one hour). If the secret key is missing, Sidekick refuses to queue the action instead of storing its arguments in plaintext.

Delayed tool executions also require `SIDEKICK_SECRET_KEY`. Core signs the exact tool, arguments, deadline, execution ID, and authority context; Agent verifies the signature at dispatch, rechecks current principal/credential state, intersects current credential scopes with the original grant, and re-evaluates the Agent authority envelope. Both services must use the same key file. Unsigned delays from older versions fail closed; review and recreate still-authorized delays after upgrade. Key rotation invalidates outstanding signed delays.

Approving a request executes it under the original source and reuses current tool-policy enforcement while bypassing only the approval check. A tool blocked after it was queued therefore remains blocked at execution time.

## Task-originated approvals and continuation

Approvals raised by a Brain task follow the durable path in `docs/adr-approval-continuation.md` rather than the standalone path above. The security-relevant differences:

### Durable Agent trust boundaries

Migrations 056 and 057 add bounded, redacted Agent task projections and
immutable plan, event, failure, and continuation records. Task checkpoints
contain only safe-boundary state; raw model/tool output remains in governed
transcript, evidence, or artifact stores. Recovery fences platform execution
claims and never recreates an in-flight model generation. A possibly completed
mutating operation is blocked for fresh verification instead of being blindly
repeated. Read-only operations remain subject to current dispatcher policy and
schema checks when resumed.

Plans, repository content, web content, memories, artifacts, prior results,
and model output are untrusted data. They can inform a plan proposal but cannot
add authority, weaken policy, satisfy approval, or execute themselves. The
Agent, verifier, recovery scanner, and UI have no direct handler path: current
schemas, policy, redaction, approval, identity, and audit checks are applied by
the canonical dispatcher immediately before each operation. Child tasks inherit
lineage and selected bounded references, never authority or approval.

The control room reads durable task state rather than treating SSE as the
authority. Browser projections use text-safe rendering for result content.
Pause, resume, cancellation, waiting, stale claims, retry suppression, and
verification outcomes are persisted as auditable state transitions. Workspace
references are opaque governed references; task input cannot provide a raw host
path, traversal target, or unrestricted inherited workspace.

- **Approving does not execute.** For a task-originated approval, approval is a state transition; the task runner executes the step. This keeps one executor and one audit path rather than a second execution tree whose result nothing reads.
- **What a human saw is what runs.** Before dispatch the runner recomputes the argument digest from the *persisted plan* and compares it to the approval, and re-checks expiry, plan version, and step membership. A mismatch refuses execution rather than proceeding. Tampering with the stored plan, the digest, or the plan version therefore fails closed rather than executing altered arguments under a human's authorization.
- **A denied action cannot be re-requested.** The action identity is a derived key over `(task_id, step_id, plan_version, tool_name, args_digest)` under a unique index, so re-requesting the same unchanged action collides. A materially different route yields a different key and is permitted. This is a storage invariant, not a prompt instruction — the planner cannot talk its way past it.
- **Ambiguous high-risk executions are never retried automatically.** After a claimant dies between dispatch and recording the result, nothing durable says whether the effect landed. Low and medium risk are retried (at-least-once); high, critical, and *unclassified* risk are not (at-most-once) — the task parks in `reconciling` and waits for a human. Risk classification is therefore a correctness input: a tool misclassified as `low` will be silently retried after a crash.
- **Reconciliation requires an authenticated human.** No automated actor may resolve an ambiguity, and the check fails closed — a deployment without dashboard authentication cannot reconcile at all. The original approver, whoever terminalised the approval, and whoever reconciled it are recorded separately and never overwrite each other.
- **No plaintext execution content is persisted.** Plans, arguments, results, goals, reasons, and error detail are encrypted; only digests, closed-vocabulary codes, and counters are queryable. Redacted previews are no longer stored at all, because redaction matches key names and known credential shapes and so cannot catch a secret passed as an ordinary-looking value — a stored preview is plaintext of unknown sensitivity. Arguments are instead rendered on demand by `GET /api/approvals/:id/preview`, which authenticates the payload against `args_digest` before rendering (so a substituted payload reports as tampered rather than being displayed as genuine) and persists nothing. It requires an authenticated principal **unconditionally** — not merely when dashboard authentication happens to be configured — because a conditional check would disappear in exactly the deployment where it matters most. A key-less or unauthenticated reader sees metadata and digests only.
- **The dispatch seam verifies its own authorization.** The internal seam the task runner uses to execute an authorized step carries the approved-execution capability, so it independently checks that the approval exists, is `executing`, is bound to the task through the checkpoint, matches the operation id recorded by the claim, names the tool being dispatched, and carries arguments matching the approved digest. Its parameters are not treated as trusted caller assertions.

Residual risk, stated plainly: this provides neither exactly-once dispatch nor exclusion of concurrent *effects*. Writes are fenced by a claim epoch so a superseded runner cannot corrupt state, but nothing stops a stalled runner from dispatching a tool after its lease has been reclaimed — that is prevented today only by the single-process deployment, and introducing a second runner process would make it reachable. `SIDEKICK_SECRET_KEY` becomes a resumption dependency: losing or rotating it strands parked tasks, which must then be failed explicitly.

## Memory evidence project scope

The Dashboard endpoint for memory evidence authorizes the memory's own project
and, when the memory links to a handoff, separately authorizes that handoff.
The two records must have matching project scopes. A readable handoff does not
grant access to a memory in another project. Global memories require the
principal's global memory-read permission. Missing or mismatched access returns
the same not-found response used for absent memories. Dashboard handoff detail
and canonical MCP handoff inspection apply the same exact-scope rule when
including extracted memories; compatibility queries that also return legacy
unscoped rows do not broaden a handoff reader's scope.

## Database query safety

The database query tool and dashboard query endpoint default to read-only mode. In that mode they allow single-statement row-returning SQL only (`SELECT`, `WITH`, `EXPLAIN`, and non-mutating `PRAGMA`), reject multi-statement input, and apply bounded row limits. Use `readonly=false` only for deliberate maintenance.

## Sudoers scope

The supplied sudoers file allows the `sidekick` user to run specific systemctl and journalctl commands for the three Sidekick services, plus selected UFW allow commands. Keep this file narrow. Do not give blanket passwordless sudo unless you intentionally want the assistant to have full root-level control.

## Redaction

`src/redact.js` redacts sensitive output patterns before data is returned or
logged, including credential parameters and signed-URL signatures in query
strings or fragments, semicolon-style connection strings, and structured
`sig`/`signature` fields. JSON object and array text up to 1 MiB is parsed and
redacted by key; larger JSON text uses a bounded key/value scan for string
fields. The tests cover private keys, GitHub tokens, and other secret-like
values. Redaction reduces accidental leakage but cannot guarantee every secret
in every format is removed.

## Secret storage

`secret` provides AES-256-GCM encrypted credential management and requires `SIDEKICK_SECRET_KEY`. Production runtime credentials, including the encryption key, are read from protected files under `SIDEKICK_SECRET_DIR`; raw environment values are supported only by test fixtures. API tokens such as the GitHub PAT used by `github` belong in `secret` as encrypted secrets, not in KV memory.

## Dashboard permissions

Dashboard sign-in establishes identity; it does not by itself grant access to every operation. Sync identity reads and changes always require `sync.read` and `sync.manage`. Unscoped sync import, export, and diff also require those dedicated grants. A project-scoped transfer instead requires `memory.read` or `memory.write` and current membership in that project; the dispatcher tools and Dashboard routes enforce the same split. Migration `081_dashboard_sync_event_permissions.sql` grants global sync permissions to owners and administrators; auditors receive event-read access only. Direct event delivery endpoints enforce `events.read` for listing and `events.manage` for subscription and delivery mutations. Other Dashboard routes continue to use their dispatcher or route-specific authorization and remain subject to the platform authorization review.

Dashboard database schema and statistics reads require `database.inspect`; migration status requires `tools.execute_high`. Schema, statistics, migration status, search, query, and backup requests all route through the canonical dispatcher, preserving consistent authorization, policy, and tool auditing. Backups require `tools.execute` and preserve dispatcher approval enforcement. Direct-route permission checks run before dispatch and resource access.

Direct connector endpoints enforce `connectors.read` for connector records, health probes, and lifecycle events, and `connectors.manage` for registration, configuration, and lifecycle changes. Migration `084_dashboard_connector_permissions.sql` grants these permissions to owners and administrators. Connector routes check permission before accessing the platform kernel or starting a health probe.

Dashboard quick actions enforce `dashboard.operations.read` for health, deployment metadata, recent failures, and service logs, and `dashboard.operations.manage` for restarting the Agent service. Migration `085_dashboard_operations_permissions.sql` grants both to owners and administrators. The dispatcher’s own policy remains in force for quick actions that invoke a tool.

Scope snapshot list, create, and evaluation routes require `scopes.read` or `scopes.manage`, an active project, and either project membership at the required access level or explicit global `projects.access.manage` authority. Snapshot evaluation conceals missing or inaccessible snapshot IDs as 404. Migration `086_dashboard_scope_permissions.sql` grants the route permissions to owners and administrators; those grants alone do not replace project authorization.

Webhook intake requires the `webhooks.receive` identity permission, validates the source name and JSON object payload, rejects payloads larger than 256 KiB, and retains at most 1,000 records and 16 MiB total encoded JSON. It writes an audit event containing the generated ID and source without copying the payload. Migration `087_dashboard_webhook_permission.sql` grants intake to owners and administrators. External integrations must authenticate through a supported Dashboard identity; this endpoint does not yet implement provider-specific HMAC signatures or replay timestamps.

Network-scope reads require `network_scopes.read`; validation, creation, update, diagnosis, and state changes require `network_scopes.manage`. Migration `088_dashboard_network_scope_permissions.sql` grants both to owners and administrators. Scope definitions expose outbound allowlists and remain administrator-managed.

Direct Compute reads require `compute.nodes.read` for provider/worker and enrollment views, and `compute.jobs.read` for job details. Job lists require a project filter and active read membership unless the principal has explicit global project-management authority; job details, attempts, artifacts, and aggregate counts are limited to the authorized project. Migration `089_dashboard_compute_read_permissions.sql` grants the read permissions to owners and administrators.

Execution-node administration routes under `/execution-node/admin` require scoped Core credentials and operation-specific permissions. Listing nodes requires `compute.nodes.read`; workspace authorization and worker revocation require `compute.nodes.manage`; job cancellation requires `compute.jobs.cancel`. Migration 099 grants the management permissions to owners and administrators. These routes reject the installation-wide API key and record each successful mutation with its initiating principal.

Compute HTTP administrative routes under `/compute/admin`, enrollment-token creation, and the retained `/compute/jobs`, `/compute/recover`, `/compute/health`, and enrollment-token aliases also require scoped Core credentials; `SIDEKICK_API_KEY` alone is insufficient. Worker views and changes use `compute.nodes.read` and `compute.nodes.manage`. Job create, read, cancel, and retry operations use separate `compute.jobs.*` permissions and additionally enforce active project membership or explicit global project authority. Migration `100_compute_admin_permissions.sql` registers the additional job permissions; lease recovery uses `compute.jobs.recover`, granted only to Owner. Mutation audit records identify the principal and are persisted atomically with the mutation (lease recovery audits inside each per-job transaction).

Dashboard KV record and project-metadata reads require `kv.read`, consistent with the existing administrator-only KV writes. Migration `090_dashboard_kv_read_permission.sql` grants this permission to owners and administrators.

The `/api/logs` endpoint requires `audit.read` because log entries can contain tool arguments and results. Migration 081 grants this permission to administrators; auditors retain it through the existing role mapping.

## Configuration and secret scanning

Use `security_scan` for a read-only audit before deployments or after configuration changes:

```javascript
security_scan({ path: "/home/sidekick/sidekick", format: "text" })
```

The scanner checks for tracked sensitive files, private-key and high-confidence credential signatures, hardcoded sensitive configuration values or fallbacks, generated credential filenames, runtime `.env` security keys, and permissive sensitive-file modes. It reports paths, key names, line numbers, and severity only; it never returns matched values. Scans obey global and source-specific path policy, skip denied descendants, and are bounded by `max_files`.

Findings are audit results, not automatic mutations. Rotate exposed credentials, remove tracked secrets from history, replace hardcoded defaults with secret injection, and restrict file permissions through a deliberate remediation workflow.

## Exposure recommendations

Recommended safest setup:

1. Bind services to a private interface or firewall them to VPN-only access.
2. Use a strong `SIDEKICK_API_KEY`.
3. Enable dashboard auth if dashboard is reachable by browser clients.
4. Set `SIDEKICK_TOOL_POLICY=restricted` for shared or public-facing deployments.
5. Enable `SIDEKICK_APPROVAL_MODE=risky` or source-specific approval for autonomous/background actions.
6. Keep the Agent Bridge private; access it through the dashboard proxy only.
7. Use HTTPS if crossing an untrusted network.
8. Back up the data directory but protect backups because they can contain sensitive operational history.

## Project-scoped memory access

Memory reads and writes are bound to active project membership. Migration
`082_project_principal_access.sql` adds audited read/write grants managed by
principals with `projects.access.manage`. New projects registered through the
project registry record the authenticated registering principal as owner;
legacy projects without an owner require an explicit grant. Non-manager
Dashboard users must specify a project for memory listing and export, and the
server verifies that grant before returning data. Project names supplied by a
caller do not establish membership. Migration `083_memory_permissions.sql`
adds separate `memory.read` and `memory.write` role grants. Both the operation
permission and project membership are checked, and explicit credential scopes
are intersected. Grant administration is available through
`/api/projects/:project/access` and its grant/revoke routes.

## Runtime configuration diagnostics

`GET /api/config` requires the high-risk `dashboard.config.read` permission
(owner and administrator roles by default). Values whose names identify keys,
passwords, tokens, secrets, credentials, private keys, authentication material,
certificates, signatures, or endpoint/connection strings are redacted. This
endpoint is diagnostic output, not a secret retrieval interface.

## Dashboard operational and catalog reads

Identity-authenticated reads of host/service/metrics state require `dashboard.operations.read`; aggregate execution statistics require `audit.read`; tool inventory requires `dashboard.catalog.read`. Route checks run before local probes or stored log/catalog access. Pre-bootstrap deployments must verify that Dashboard authentication adopts a principal before serving these routes.

### Agent internal service assertions

Dashboard calls to the Agent Bridge are authenticated with the distinct `SIDEKICK_AGENT_PROXY_KEY`; they do not use the MCP client key. Scheduler timer reloads use the separate `SIDEKICK_AGENT_SCHEDULER_KEY`. Identityless services are restricted by service name, HTTP method, and exact route in `src/agent/task-access.js`. The `scheduler` identity can only refresh delay or watch timers. A rejected reload is surfaced as a durable but inactive schedule, not reported as active.

Dashboard Doctor diagnostics require `dashboard.operations.read` before running checks. Support bundles include runtime and reliability metadata; sensitive values are redacted, but operators should review bundles before sharing them.

Dashboard prediction lists, details, and explanations require `predictions.read`
and enforce active project membership plus current credential scopes for
non-global principals. Inaccessible IDs return not found. Engine-wide status and
maintenance diagnostics require `dashboard.operations.read`. Migration
`093_prediction_read_permissions.sql` grants read access to owner,
administrator, operator, and viewer roles; project membership remains an
independent boundary. The canonical MCP/Agent Predict tool still requires a
separate resource-scope audit (RR-22).

Security Research source repositories and snapshots use project membership in
addition to the high-risk tool permission. The module checks project ownership
for campaign, repository, snapshot, comparison, and authority-claim IDs before
reading or mutating its store. Read membership permits inspection; source
imports, selection, indexing, archive/remove, and recovery require write
membership. The Dashboard carries its selected workspace project to these
routes. Global project managers retain global access. See SI-5 and RR-28.
