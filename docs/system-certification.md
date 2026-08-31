# System Certification

Sidekick includes bounded, read-only diagnostics and deterministic Agent
certification commands. They use the canonical registry and dispatcher; they
do not grant authority or bypass approvals.

## Commands

```bash
node src/cli.js doctor
node src/cli.js doctor --json
node src/cli.js doctor --bundle
node src/cli.js certify
node src/cli.js certify --json
node src/cli.js certify --json --allow-unavailable
npm run certify
```

`certify` runs the hermetic scenarios from `src/certification/scenarios.js`.
Provider and lab-dependent scenarios are separate live scenarios and are
reported as `skipped` when their prerequisites are unavailable. A skipped or
blocked scenario is not a pass, and a report containing either status has an
overall `blocked` verdict.

`--allow-unavailable` is intended for hermetic CI where optional capability
packs are not installed. It preserves the `blocked` report and only permits a
zero process exit when no scenario actually failed; it must not be used for
live acceptance.

The certification report includes a versioned scenario identifier, objective,
initial project/workspace identity, authority envelope label, expected tools,
capability-pack requirements, retry/time bounds, approval/evidence/outcome
contracts, fault-point metadata, and cleanup declarations. Reports are bounded
and passed through the existing redaction functions.

The invariant evaluator is read-only. It checks database/migration state,
canonical descriptor contracts, durable table and foreign-key integrity,
task lifecycle ownership, and operation-receipt verification gates. A registry
failure is critical and cannot be converted into an empty or weakened Agent
catalog.

Doctor combines these checks with path-policy diagnostics and returns severity
levels. `--bundle` returns diagnostic metadata only; it does not read raw
database rows, logs, workspace contents, or secret values, and does not write
or repair state.

## Live certification

Live Agent certification must use the Dashboard Agent API route
`POST /api/agent/run` and then inspect the durable task projection and events.
Use a separate data directory, project, workspace, principal, and bounded
authority envelope. Configure a local provider in that isolated installation
before expecting a model-backed task to complete. Do not use the production
database or broaden network scopes to make a scenario pass.

The local certification harness records failed provider availability and
verification outcomes rather than claiming success. Proxmox and security
research scenarios additionally require an explicitly configured authorized
lab profile and named network scope.
