# Capability Catalog

Sidekick exposes a read-only, bounded capability projection through the
existing governed `capability` tool:

```json
{ "action": "catalog", "source": "agent", "kind": "tool", "limit": 50 }
```

The projection combines installed and bundled packs, registered modules,
canonical tools, generated tools, and workflow definitions. Each entry reports
its owner, lifecycle state, availability and reasons, dependencies,
configuration, health, evidence-based pack maturity, permissions, and required
network scopes. Tool entries also include the source-specific policy and
approval decision.

`offset` and `limit` are bounded, and `query`, `kind`, `owner`, `state`, and
`available` are deterministic filters. This is discovery data only. Actual
Agent, Dashboard, and MCP execution continues through the canonical registry
and dispatcher, which revalidates schemas, authorization, policy, approval,
and module state.

## Pack maturity

Pack maturity is a projection, not a manifest claim:

| Level | Requirement |
|---|---|
| `foundation` | The installed package and manifest are available for inspection. |
| `operational` | The pack is enabled, healthy, and its required tools and dependencies are ready. |
| `integrated` | Fresh attributed evidence proves canonical dispatch, Agent discovery, and workflow execution. |
| `certified` | Fresh integrated evidence additionally proves a safe single-pack task, a cross-pack task, and independent skeptical verification. |

Evidence is stored in the existing pack repository metadata and is bound to a
fingerprint of the installed package, version, configuration, lifecycle epoch,
and health state. It expires after 30 days and becomes invalid immediately when
that fingerprint changes. The `capability` tool exposes the projection with
`action="maturity"`; the Dashboard exposes it at
`GET /api/capabilities/:name/maturity`.

Evidence can be requested or recorded with `capability action="prove"` and
`capability action="record_verification"`, or through
`POST /api/capabilities/:name/prove`. Recording requires server-verifiable
evidence references, an attributed actor, a project/pack binding, and checks
that match the installed package and current health/configuration fingerprints.
Caller-supplied booleans or declarations are not certification evidence.
Optional providers are reported as `not_required` or `not_verified`, and do not
turn into a false failure or a certification claim. The proving contract and
recipe boundaries are documented in `pack-proving.md`.

The Dashboard exposes the same projection at
`GET /api/capabilities/catalog`; its request is dispatched as the Dashboard
source rather than reading lifecycle state from browser code.
