# Testing Architecture

Sidekick uses Node's built-in `node:test` runner as the execution API. The
async orchestrator in `test/suite-runner.js` discovers suites recursively,
loads small domain manifests, validates ownership, buffers output, enforces
timeouts, terminates process groups, and schedules bounded workers with named
resource locks. `node test/run-all.js test/security.test.js` runs one exact
suite; `--test-name-pattern` forwards an exact test-name filter to Node test
files.

## Tiers and domains

`unit` is pure deterministic behavior, `contract` validates registry/pack and
protocol boundaries, `integration` exercises local SQLite/filesystem/process
boundaries, `security` asserts fail-closed trust boundaries, `e2e` uses local
services, and `live` is explicitly opt-in. Legacy root suites use the
compatibility manifest and are not a license for new custom harnesses. New
domain suites under `test/core`, `test/security`, `test/agent`, `test/packs`, or
`test/workflows` must import `node:test`.

Manifest resources require explicit `resource_contracts` metadata. Each
contract names a registered provisioner and cleanup handler from
`test/suite-resources.json`; arbitrary, generic, or unknown names fail closed.
The runner creates an owned per-suite temp root and passes only child-scoped
values such as `SIDEKICK_TEST_DATA_DIR`, `SIDEKICK_TEST_DB_FILE`, fixture/workspace roots,
and `SIDEKICK_TEST_PORT` in the child environment. SQLite files, directories,
workspaces, environment scopes, process/browser scopes, and loopback ports have
real built-in provisioners. Cleanup runs after normal exit, assertion failure,
timeout, cancellation, and spawn/termination failure; an unsuccessful cleanup
or surviving owned resource makes the suite fail and is reported as a leak.
Locks still control shared/exclusive scheduling independently of provisioning.
Loopback port allocation closes the reservation before child execution, so it
is collision-resistant rather than a hermetic port namespace. These controls do
not prove hermeticity: tests can still access inherited host resources or create
unregistered resources, and live/operator resources remain explicitly opt-in.
The runner never scans suite source text to infer fixture ownership.

Each run reports elapsed time, completed/total progress, pass/fail/skip counts,
current and queued suites, lock waiters, periodic heartbeats, slow-suite
warnings, queue and lock wait duration, peak concurrency,
skipped/cancelled/timed-out/not-run suites, and the slowest suites. Human
progress is written to stderr; `--json` keeps stdout to one JSON result line.
Child output is bounded by `--max-output-chars` (default 12000) and the result
is written to `artifacts/test-results.json` by `scripts/run-tests.js`.

## Commands

Use `npm test` for the deterministic non-live required tiers, `npm run test:all`
for all non-live suites, `npm run test:security` for security invariants,
`npm run test:coverage` for merged c8 coverage with the versioned policy in
`docs/coverage-policy.json` (including separate security-domain thresholds),
`npm run test:mutation` for genuine isolated critical-module mutations with a
versioned structured inventory in `docs/mutation-policy.json`, per-group
baseline validation, bounded digests, strict outcome classification, numeric
score and threshold, and `npm run test:flake` for bounded repetition of
Dashboard, Agent, Compute, pack, browser, and runner boundary suites. Flake
reports retain deterministic seeds, varied safe concurrency, transitions, and
reproduction commands; a detected pass/fail transition fails the diagnostic.
`npm run test:live` requires an explicit local opt-in and is never part of the
ordinary PR gate. The required hermetic E2E tier is
`test/e2e/dashboard-capability-maturity.test.js`; it starts one real temporary
Dashboard service on a dynamic loopback port, then checks authenticated pack
installation and maturity/UI behavior, unauthenticated API and shell rejection,
configuration redaction, and bounded capability catalog/health responses.
Property failures print `SIDEKICK_PROPERTY_SEED` and can be replayed with
`SIDEKICK_PROPERTY_RUNS`. `npm run test:changed` builds a bounded reverse
dependency view from relative CommonJS/ES module imports and re-exports,
JSON/runtime file loads, and unresolved paths retained for deletes and renames.
It also classifies manifests, shared fixtures, packs, workflows, knowledge,
configuration, migrations, persistence, Dashboard assets, GitHub workflows,
package/lockfiles, and CI/test scripts. Suite manifest ownership is used for
metadata.

An impactful change that has no graph match is never silently ignored. The
script selects the documented conservative fallback suites below and requires
each selected fallback to execute:

| Change category | Fallback coverage |
| --- | --- |
| Dashboard/static assets | `dashboard-api`, `dashboard-shell` |
| Packs/workflows/knowledge | pack manifest, capability, workflow, and knowledge suites |
| Migrations/persistence | migration parity, self-containment, and database suites |
| Package/lockfile/GitHub/CI | GitHub setup, CI status, release manifest, and script suites |
| Configuration/fixtures/dynamic registration | configuration, discovery, static-quality, and architecture suites |
| Unknown impactful files | static-quality and architecture suites |

The fallback list excludes flake, resource-contract, monolith, and legacy
integration-monolith suites. A missing fallback, a fallback that was not
returned by the runner, a failed run, or a run with zero passing tests returns
a non-zero exit status, so CI cannot pass while an impactful unmatched change
was untested. Documentation-only changes may have no graph match, but the
command still runs a safe fallback rather than succeeding with zero tests.

`npm run test:flake` reports current repetitions separately from historical
evidence supplied in `SIDEKICK_FLAKE_HISTORY` (or
`artifacts/flake-history.json`). Only `passed` and attributable `failed`
observations count. A suite is quarantined in the report only after at least
five valid observations, two failures, and a failure rate between 20% and 80%;
timeouts, cancellations, skips, and not-run suites are inconclusive. The
diagnostic continues to report reproducible failures and current failures, but
does not label a small pass/fail transition as a historical flake.

The baseline is in `docs/testing-baseline.json`. Experiments and large model
artifacts under `test/spike-openvino-python` are excluded from discovery and
ordinary packaging/CI; real OpenVINO work is opt-in.

Mutation testing defaults to the targeted inventory. Use
`SIDEKICK_MUTATION_MODE=full npm run test:mutation` for the materially broader
inventory. A single maintained entry can be reproduced with
`SIDEKICK_MUTATION_MODE=full SIDEKICK_MUTATION_MUTANT=<id> npm run test:mutation`.
AST-target resolution, parse failures, missing targets, failed baselines,
timeouts, and infrastructure failures never count as assertion kills; any of
those conditions fails the gate closed.
