# Testing Baseline

This generated baseline records the starting point for the testing
modernization campaign. The machine-readable source is
`docs/testing-baseline.json`; regenerate it with `npm run test:baseline`.

At the start of the campaign, the repository contained 270 tracked JavaScript
test files and 44,825 test lines. The sequential `node test/run-all.js` run was
bounded at 120 seconds and had not completed, so its runtime is recorded as a
lower-bound measurement rather than an invented total. Standalone suites did
not expose a reliable test-case count.

The baseline also records the existing fixed/shared resources, direct process
environment mutation, homemade harnesses, duplicate CI execution, and the
large OpenVINO experiment tree. These are migration findings, not pass/fail
claims about product behavior.
