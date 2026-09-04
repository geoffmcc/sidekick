# Capability-Pack Proving

`docs/proving-recipes.json` is the generated, versioned recipe catalog for all
currently bundled packs. Its pack count and names are derived from the
checked-in manifests and it describes
preconditions, bounded discovery, negative checks, cleanup, and whether a live
provider is required.

Recipes are not certification. A proving run must use the canonical dispatcher
for every executable fixture case and produce terminal operation receipts. A
recipe containing only descriptive capability metadata is reported as
`not_evaluated`, never as a passing execution proof. Pack certification accepts only
server-validated receipt, workflow, or execution references that match the
installed package hash, configuration fingerprint, lifecycle epoch, health
fingerprint, actor, project, recipe version, and freshness window.

Fixture-backed and local deterministic results are labeled separately from live
provider results. Provider-required recipes return `unavailable` when no
authorized provider is reachable; that state is not a pass and cannot promote
pack maturity.

The supported maturity levels are derived as follows:

- `foundation`: installed pack metadata is present.
- `operational`: enabled pack health is healthy.
- `integrated`: current verified evidence covers canonical dispatch, Agent
  discovery, and workflow execution.
- `certified`: integrated evidence additionally covers single-pack, cross-pack,
  and independent skeptical verification.

Changing the package, configuration, lifecycle state, or health state makes
previous evidence stale. Legacy metadata verification entries remain historical
and cannot certify a pack.

Generate and validate the catalog with `npm run proving:recipes`.
