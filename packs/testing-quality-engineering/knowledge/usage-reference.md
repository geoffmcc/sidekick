# Testing and Quality Engineering: gate and negative-check reference

Use `quality-gate` to select or run repository verification through `dev_verify`.
`default_mode` controls quick, standard, or full breadth; explicit intents,
dry-run selection, output bounds, timeouts, and failure continuation remain
visible in the result. `negative-verification` checks that an expected unsafe,
invalid, denied, or failing condition is actually observed; it does not turn a
failed command into success without matching the expected negative result.

Semantic index verification is independent of project tests. Missing optional
tools, skipped commands, timeouts, and partial runs are limitations, not passes.
The pack reports evidence and does not imply that a build is deployable or that
any code, service, dependency, or environment was changed.
