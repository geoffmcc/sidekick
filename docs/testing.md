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

Manifest resources require explicit `resource_scopes` metadata. The reviewed
`test/suite-resources.json` map opts individual suites into namespaced
resources; resources not listed there retain the manifest's shared lock. A
manifest may mark a declared resource as shared with `shared_resources`;
`exclusive` remains the escape hatch for an actually global resource. No suite
may use a fixed port unless it declares an explicit exception. Local servers
bind to `127.0.0.1` and dynamically allocated ports; test roots come from
`test/helpers/isolated.js` and are cleaned only when proven to be owned direct
children of the OS temp directory. The runner never scans suite source text to
infer fixture ownership.

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
dependency view from relative CommonJS/ES module imports and selects directly
changed suites or suites that import changed files. Suite manifest ownership is
used for metadata; an unknown file does not trigger every domain.

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
