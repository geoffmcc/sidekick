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

Resources such as `sqlite`, `filesystem`, `subprocess`, `browser`, and
`exclusive` serialize only the conflicting work. No suite may use a fixed port
unless it declares an explicit exception. Local servers bind to `127.0.0.1`
and port `0`; test roots come from `test/helpers/isolated.js` and are cleaned
only when proven to be owned direct children of the OS temp directory.

## Commands

Use `npm test` for the deterministic non-live required tiers, `npm run test:all`
for all non-live suites, `npm run test:security` for security invariants,
`npm run test:coverage` for merged c8 coverage with versioned thresholds, `npm run test:mutation`
for targeted mutation selection, and `npm run test:flake` only as a diagnostic.
`npm run test:live` requires an explicit local opt-in and is never part of the
ordinary PR gate. Property failures print `SIDEKICK_PROPERTY_SEED` and can be
replayed with `SIDEKICK_PROPERTY_RUNS`.

The baseline is in `docs/testing-baseline.json`. Experiments and large model
artifacts under `test/spike-openvino-python` are excluded from discovery and
ordinary packaging/CI; real OpenVINO work is opt-in.
