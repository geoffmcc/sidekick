# Capability-Pack Proving

`docs/proving-recipes.json` is the generated, versioned recipe catalog for all
currently bundled packs. Its pack count and names are derived from the
checked-in manifests and it describes
preconditions, bounded discovery, negative checks, cleanup, and whether a live
provider is required.

Recipes are not certification. A proving run must use the canonical dispatcher
for every executable fixture case in every mandatory phase and produce terminal
operation receipts. The runner continues collecting later phase results after a
failure or provider unavailability; it does not turn an unavailable phase into
a pass. A recipe containing only descriptive capability metadata is reported as
`not_evaluated`, never as a passing execution proof. Explicit local fixture
cases must declare `mutation: false`; fixture execution is bounded and still
goes through the canonical dispatcher.

Pack certification accepts only server-validated receipt, workflow, or execution
references that match the installed package hash, configuration fingerprint,
lifecycle epoch, health fingerprint, actor, project, recipe version, and
freshness window. Local fixture evidence is useful for deterministic execution
coverage, but it does not become provider certification.

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

Evidence truth states are preserved rather than collapsed into a boolean:

- `fresh`: current package, configuration, lifecycle, health, and time window
  all match.
- `stale`: the observation is outside the allowed age window or is from the
  future.
- `dirty`: the observation is recent but its package, configuration, lifecycle,
  or health fingerprint no longer matches.
- `malformed`: required evidence fields or timestamps are invalid.
- `expired`: the explicit evidence expiry has passed.
- `missing`: no server-validated evidence was supplied.

The generated compatibility inventory is a repository audit only. Its
`evidence_status` and certification fields remain `not_evaluated` until a
runtime pack record contains attributable, current evidence; inventory files,
fixtures, and provider descriptors cannot self-certify a pack.

Generate and validate the catalog with `npm run proving:recipes`.
