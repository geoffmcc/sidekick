# Governed Browser Automation

Sidekick can operate a real Chromium browser through its normal governed
execution architecture. This document covers the **Core browser subsystem**
(`src/browser/`) and the `browser` tool, and the **Governed Browser Automation
capability pack** (`packs/browser-automation`) that builds task-level tools,
workflows and knowledge on top of it (see the "Capability pack" section below).

## What it is

A real, programmatic browser runtime — not shelled-out Playwright scripts, not
`web_fetch`, not HTTP scraping. The subsystem drives Chromium through
`playwright-core` and exposes a single governed tool, `browser`, whose actions
run through the same dispatcher, policy, approval, audit, redaction, timeout and
cancellation path as every other Sidekick tool.

It supports isolated sessions, multi-page navigation, robust element targeting,
accessibility/DOM/text inspection, structured extraction, screenshots and
downloads with real artifact custody, controlled uploads, secret-safe login,
popups/redirects, deterministic UI assertions, and bounded multi-step
sequences.

## Architecture: Core vs pack

**Core owns the safe browser execution primitive and every governance-critical
boundary**, because a browser is a privileged network primitive and those
boundaries must not be bypassable by any pack or caller:

| Concern | Where |
| --- | --- |
| Browser runtime, session lifecycle, egress, artifacts | `src/browser/` (Core) |
| The governed `browser` tool descriptor | `src/tools/families/browser.js` (Core) |
| Task-level tools, workflows, knowledge | `browser-automation` pack (Phase B) |

The pack composes the `browser` tool through the normal dispatcher; it never
reaches Chromium directly. This mirrors the Security Research pack's model,
where Core owns the dangerous primitive and the pack composes it.

### Core files

- `src/browser/config.js` — environment-driven, clamped configuration.
- `src/browser/driver.js` — locates the managed Chromium install; owns the one
  shared browser process; reports runtime health.
- `src/browser/egress.js` — the network boundary: URL-text policy plus a
  per-session loopback proxy that every request traverses.
- `src/browser/sessions.js` — isolated session lifecycle, page/popup adoption,
  download capture, secret tracking and scrubbing, reaping.
- `src/browser/actions.js` — the action implementations (navigate, inspect,
  interact, wait, evidence, assert), all honoring cancellation and output bounds.
- `src/browser/artifacts.js` — screenshot/download custody through the platform
  kernel.
- `src/browser/index.js` — subsystem facade: init, orphan reaping, health,
  action routing, bounded sequences, shutdown.

## Browser runtime installation

Nothing downloads a browser implicitly. Install the pinned Chromium once per
host:

```bash
node scripts/install-browser.js            # install the pinned Chromium
node scripts/install-browser.js --with-deps  # also install OS libraries (needs sudo)
node scripts/install-browser.js --check      # report status, install nothing
```

The Chromium build is pinned by `playwright-core`'s own `browsers.json`, so the
lockfile that pins `playwright-core` transitively pins the browser. It installs
into `SIDEKICK_DATA_DIR/browser/ms-playwright` — under the data directory, not
the application checkout, so a deploy (which replaces the app directory) never
removes it. A missing runtime is a health state and an actionable error, never
a silent runtime download.

## Configuration

All values are read from the environment on each call and clamped to safe
ranges; dangerous posture is never a default. See `.env.example` for the full
list. Key settings:

- `SIDEKICK_BROWSER_ENABLED` (default `true`) — master switch.
- `SIDEKICK_BROWSER_HEADLESS` (default `true`).
- `SIDEKICK_BROWSER_ALLOW_PRIVATE_NETWORK` (default `false`) — an operator
  kill switch/ceiling only. Private egress requires an operator-created named
  `network_scope`; this env var alone and the deprecated
  `allow_private_network=true` flag grant nothing.
- Session/resource bounds: `MAX_SESSIONS`, `MAX_PAGES`, `SESSION_TTL_MS`,
  `IDLE_TIMEOUT_MS`, `NAV_TIMEOUT_MS`, `ACTION_TIMEOUT_MS`,
  `MAX_DOWNLOAD_BYTES`, `MAX_UPLOAD_BYTES`, `MAX_OUTPUT_CHARS`,
  `MAX_SEQUENCE_STEPS`.
- `SIDEKICK_BROWSER_UPLOAD_ROOTS` — filesystem roots the browser may upload
  files from by path. Empty disables path uploads (upload registered artifacts
  instead).

## Sessions and isolation

Each session is one isolated Chromium `BrowserContext` — its own cookies,
localStorage, cache, service workers (blocked) and authentication state — plus
a dedicated egress proxy. Sessions are ephemeral by design:

- bounded count, bounded pages per session;
- maximum lifetime and idle timeout, both reaped on a 60s timer;
- deterministic cleanup on close, cancellation, browser crash and shutdown;
- no persistent profile, and never the operator's personal browser profile;
- a session opened under one project is not usable from a differently-scoped
  call (cross-project isolation).

Orphaned Chromium processes from a crashed Sidekick process are reaped at
startup (every launch carries a `--sidekick-browser-session=<pid>` marker so
orphans are identifiable). There are no `SIGTERM` hooks in Sidekick; systemd
kills the process group on restart and startup reaping closes the gap.

## Network governance (egress)

A browser follows redirects, loads subresources and iframes, opens WebSockets,
and runs attacker-supplied JavaScript — far more than `web_fetch`. Egress is
enforced in two layers, and the deep layer is authoritative:

1. **URL-text policy** (`evaluateBrowserUrl`) at Playwright route interception
   and before agent navigation — fast refusal with a precise reason, plus
   evidence records.
2. **A per-session loopback proxy** that *every* request traverses (Chromium is
   launched with this proxy and a `<-loopback>` bypass so even localhost goes
   through it). The proxy sees every redirect hop, subresource, fetch/XHR and
   WebSocket CONNECT; it resolves DNS itself, validates every resolved address,
   and connects only to the address it validated — closing DNS rebinding, not
   just literal-IP tricks.

Rules (all fail closed):

- schemes limited to http/https (and ws/wss on the same proxy paths); no
  `file:`, `data:`, `chrome:` navigation;
- cloud metadata hosts and link-local addresses are **always** refused;
- private/loopback/CGNAT/unique-local targets require a named `network_scope`
  whose explicit policy allows the destination, plus the operator ceiling;
- `allowed_hosts` (with `*.example.com` wildcards) **narrows** policy — it never
  widens it; a private or metadata host stays refused even when listed;
- embedded URL credentials are refused;
- no proxy/stealth/anti-bot/CAPTCHA-evasion features exist. This is governed
  automation, not evasion software.

## Hostile page content

Every page is treated as untrusted. Page-derived text, snapshots and extracted
data are returned under an explicit `untrusted_page_content` key with an
`untrusted_content_note` warning, and page titles are scrubbed of tracked
secrets. The subsystem never performs an action because a page's text asked for
it — consequential actions originate only from the caller's authorized request.

## Secrets and authentication

Authentication uses Sidekick's existing encrypted secret store. The
`secret_fill` action takes a `secret_ref` (`secret:<name>`) resolved as late as
possible through the platform's authorized resolution path; the plaintext never
reaches the caller in arguments, outputs, logs, audit records, snapshots or
screenshots. Filled secret values are tracked and scrubbed out of every
subsequent page-derived output, so a credential cannot be read back through
inspection or extraction. Filling a secret into a *visible* (non-password) field
marks the page sensitive, which blocks screenshots unless the caller passes
`acknowledge_sensitive=true` (and the artifact is then registered as sensitive).

## Actions

`browser` is a single action-dispatched tool. Sessions: `open`, `close`,
`list`, `status`. Navigation: `navigate`, `back`, `forward`, `reload`.
Observation: `snapshot` (text/aria/interactive/html), `extract`. Interaction:
`click`, `fill`, `secret_fill`, `clear`, `select`, `check`, `press`, `hover`,
`focus`, `scroll`, `wait`. Pages: `pages`, `switch_page`, `close_page`.
Evidence: `screenshot`, `downloads`. Files: `upload`. Verification: `assert`.
Bounded automation: `sequence`.

There is **no** action that evaluates caller-supplied JavaScript. Element
targeting uses robust Playwright locators — role, label, placeholder, text,
test id, or CSS — not just fragile generated selectors.

### Structured extraction

`extract` takes a `fields` array (`{name, target, attr?, all?, required?}`) and
returns bounded JSON. Missing required fields are reported in a `missing` array
rather than invented; row counts and output size are bounded and truncation is
reported.

### Bounded sequences

`sequence` runs a bounded list of steps under **one** dispatch, so the whole
sequence is gated at the tool's risk — batching cannot lower governance below
what the individual actions would face. Sessions cannot be opened or closed
inside a sequence. Each step reports completed/failed/skipped with a duration;
`continue_on_error` is per-step.

## Consequential actions and approval

Risk is per-action. The `browser` tool is `high` at the tool level (browser
actions spend the server's network identity and can mutate remote state).
Read-only observation of an already-open session — `list`, `status`,
`snapshot`, `extract`, `assert`, `pages`, `downloads` — is downgraded in
`TOOL_ACTION_RISK`; everything that navigates, interacts, uploads, screenshots a
sensitive page, or runs a sequence keeps the `high` rating. The existing
policy/approval architecture is authoritative — the subsystem builds no second
approval system. To require approval on browser interaction specifically, set
`SIDEKICK_APPROVAL_REQUIRED_TOOLS=browser` or raise the relevant actions.

## Evidence and artifacts

Screenshots are real PNG captures; downloads are captured intentionally with a
size limit. Both are hashed and registered with the platform kernel — the single
custody authority — following the compute-custody rules: register only verified
bytes, deterministic ids (idempotent registration), and custody failure surfaced
on the result rather than swallowed or allowed to destroy the work. Callers
receive an artifact reference (`artifact_id`, `storage_ref`, `sha256`,
`byte_size`, custody status), never a raw host path.

## Uploads

Uploads require explicit provenance: a registered platform artifact
(`artifact_id`) or a path inside `SIDEKICK_BROWSER_UPLOAD_ROOTS` that also passes
the tool path policy. Size limits and existence checks apply. An agent cannot
upload an arbitrary host file.

## Cancellation and reliability

Each action races the dispatcher's cancellation signal: a cancelled navigation
stops loading, waits abort, and the session is left consistent. Failures produce
structured, categorized errors (`timeout`, `blocked_by_policy`,
`element_not_found`, `ambiguous_locator`, `navigation_failed`, `target_closed`,
`cancelled`, …) — the subsystem does not swallow failures and report success.

## Health

`browser action="status"` (and the subsystem's `health()`) reports the runtime
state: `disabled`, `missing_runtime`, `launch_failed`, `ready` or `running`,
plus open-session counts and effective limits. Pass `deep=true` to perform a
real launch probe.

## Troubleshooting

- **`browser_runtime_missing`** — run `node scripts/install-browser.js`. On a
  headless server also run it with `--with-deps` (or install the Chromium system
  libraries) so the browser can launch.
- **Navigation refused with a private/loopback message** — set
  `SIDEKICK_BROWSER_ALLOW_PRIVATE_NETWORK=true` *and* open the session with
  `allow_private_network=true`.
- **Off-list host refused** — the session was opened with `allowed_hosts`;
  add the host (wildcards allowed) or open a session without the allowlist.
- **Screenshot refused as sensitive** — a secret was filled into a visible
  field; pass `acknowledge_sensitive=true` to capture it as a sensitive
  artifact.

## Capability pack: Governed Browser Automation

`packs/browser-automation` is the operator-facing capability pack built on the
Core `browser` tool. It adds task-level structure; it never touches Chromium
directly and reimplements no boundary. It requires the `browser` tool and
installs/enables/uninstalls through the normal capability lifecycle
(`capability action="install" name="browser-automation"`, then `enable`).

**Tools** (each opens an ephemeral isolated session, works, and always closes
it — every step dispatches through the Core `browser` tool):

- `web_capture` — navigate and capture evidence in one call: a real screenshot
  registered in artifact custody plus a bounded visible-text snapshot.
- `web_extract` — navigate a JS-rendered page and return bounded, deterministic
  structured data from caller-supplied field locators; missing required fields
  are reported, never invented.
- `web_check` — navigate and evaluate deterministic UI assertions, returning a
  pass/fail verdict, optionally with a screenshot as evidence.

**Workflows** (bounded step sequences over the `browser` tool, run through the
governed workflow runner):

- `browser-automation/ui-smoke` (read-only) — navigate, assert content, capture
  evidence, report pass/fail.
- `browser-automation/authenticated-ui-check` (mutating) — governed login using
  a `secret:<name>` reference bound to `expected_host`, verify a post-login
  state, capture evidence.
- `browser-automation/download-verification` (read-only) — trigger a permitted
  download and report its artifact reference, size and hash.

**Configuration**: `default_allowed_hosts` (default host allowlist that a call
may override; narrows egress, never widens it), `allow_private_network`
(default for private/loopback requests — still gated by the Core operator
ceiling), `full_page`, and `max_text_chars`. Secrets never belong in pack
configuration; pass a `secret:<name>` reference instead.

**Pack health** reports the pack's own state plus best-effort browser runtime
readiness (`healthy` when the runtime is installed, `degraded` when it is not,
with the install instruction). The pack tools are `medium` risk (bounded
read/capture/verify); open-ended consequential interaction stays on the Core
`browser` tool, which carries the full governed action surface. This pack does
not provide screenshot pixel-diff comparison — verification is assertion-based.

## Security model summary

Isolated ephemeral sessions; centrally-enforced fail-closed egress with DNS
pinning and redirect/subresource/WebSocket coverage; page content treated as
untrusted; secrets resolved late and never leaked back; artifact custody for all
evidence; governed upload provenance; per-action risk feeding the existing
approval architecture; bounded output, lifetimes and resources; deterministic
cleanup and startup orphan reaping. No arbitrary JavaScript, no arbitrary file
upload, no personal browser profile, no evasion features.
