# Phase 5 — Subprocess and shell security

Baseline for this phase: `6308fb8ba7141a805f88bd7621d487647be87939` (current deployed `main`).

## Finding F5-01 — child processes inherited privileged execution environment

Severity: High. An authenticated caller who could reach a governed subprocess-backed tool, or an operator invoking a production helper with a contaminated environment, could pass service credentials, runtime loader hooks, Git helper settings, pagers, editors, or external-diff configuration into a child process. This creates secret exposure and alternate code-execution paths outside the intended command argument boundary.

Evidence was found in the implementation: the development Git tool passed `process.env` to Git, the changelog Git invocation had no environment policy, the browser installer copied `process.env`, and the deployment helper inherited the parent environment. Other production subprocesses already used `childProcessEnv`.

Fix: extend the shared child-process policy to remove Git helper/editor/pager and common process-injection variables case-insensitively. Route the identified Git, browser-install, and deployment subprocesses through that policy. Explicit non-sensitive values such as `GIT_DIR`, `GIT_WORK_TREE`, and `PLAYWRIGHT_BROWSERS_PATH` remain supported through validated call-site overrides.

Regression coverage: `test/security-phase-05-subprocess-shell.test.js` verifies loader/helper environment removal and safe overrides.

## Finding F5-02 — structured Git arguments could activate external helpers

Severity: High. The `git` tool accepted arbitrary extra Git options. Options such as `-c core.sshCommand=...`, `--upload-pack=...`, `--receive-pack=...`, `--exec-path=...`, `--ext-diff`, and `--paginate` can invoke attacker-selected programs or attacker-controlled pager/editor behavior. Direct `execFileSync` prevented shell metacharacter injection but did not prevent Git's own helper mechanisms.

Fix: reject options that alter Git configuration, helper executables, execution paths, transport commands, external diff, or pagers. Normal action-specific options such as `--no-pager` and `--stat` remain available. This is defense in depth; the dispatcher still supplies authentication, source attribution, policy, risk, approval, timeout, and audit controls.

Regression coverage: the Phase 5 test rejects each helper-execution class and accepts ordinary display options.

## Production subprocess inventory

| Component | Call sites / model | Classification | Controls |
| --- | --- | --- | --- |
| `src/tools/families/shell.js`, `runbook.js`, `scheduling.js`, `monitoring.js` | Governed arbitrary shell strings | 4 — governed arbitrary shell | Dispatcher policy, risk/approval, timeouts, bounded output, filtered environment, audit |
| `src/tools/families/security.js` | Sandbox command string | 4 — governed arbitrary shell | Critical policy/approval, sandbox path policy, filtered environment, timeout/output bounds |
| `src/tools/families/process-mgmt.js` | Fixed executable plus argument arrays | 2 — validated dynamic arguments | Identifier/argument validation, filtered environment, timeout/output bounds |
| `src/tools/families/development.js` Git | `git` plus action and constrained extra arguments | 2 — validated dynamic arguments | Action allowlist, path policy, helper-option rejection, filtered environment, dispatcher policy |
| `src/tools/families/development.js` changelog/depend | `git`, `npm`, `systemctl`, `ps`, `pstree` plus validated refs/identifiers | 2 — validated dynamic arguments | Path/identifier validation, filtered environment, timeout/output bounds |
| `src/tools/families/media.js` | `tesseract`, `ffprobe`, `ffmpeg`, Python plus validated paths/options | 2 — validated dynamic arguments | Path/format/option validation, filtered environment, timeout/output bounds |
| `src/tools/families/filesystem.js` | `which`, `rg`, `grep` plus validated search args | 2 — validated dynamic arguments | Path policy, bounded pattern/args, filtered environment, timeout/output bounds |
| `src/tools/families/networking.js` | `cloudflared`, `pkill`, `ps` plus validated identifiers/ports | 2 — validated dynamic arguments | Identifier/port validation, filtered environment, bounded logs |
| `src/tools/families/operations.js` | Fixed `git`, `systemctl`, `sudo systemctl` commands | 1 — direct executable/static or fixed validated args | Fixed service allowlist, critical dispatcher policy/approval, filtered environment |
| `src/tools/families/observability.js`, `src/agent/watch-runtime.js` | Fixed diagnostics plus validated service/process/URL inputs | 2 — validated dynamic arguments | Input validation, filtered environment, timeout/output bounds |
| `src/compute/openvino-helper-manager.js` | Fixed runtime and `taskkill` argument arrays | 1 — direct executable/static arguments | Fixed executable/args, process lifecycle controls |
| `scripts/install-browser.js` | Node Playwright CLI with fixed arguments and explicit managed path | 1 — direct executable/static arguments | Operator-run script, pinned dependency/browser revision, filtered environment |
| `scripts/git-deploy.js` | Fixed `git`/`npm`/service commands with deployment-derived paths | 2 — validated deployment arguments | Deployment lock, fixed service/repository scope, filtered environment, redacted errors |
| `src/dashboard.js` | Fixed command wrapper (`execFileSync`) | 2 — validated dynamic arguments | Allowlisted command callers, filtered environment, timeout |

No production call site in this inventory uses an ungoverned shell as an alternate dispatcher. Tests and development-only probes are excluded from the production inventory.

## Residual risk

Sidekick intentionally exposes governed shell, runbook, sandbox, scheduling, and infrastructure operations. These remain powerful capabilities and depend on correct dispatcher policy, OS account privilege, approvals, and deployment configuration. The child environment filter is defense in depth, not a replacement for authorization or OS isolation. In-process third-party modules remain trusted code and are addressed in the module phase.
