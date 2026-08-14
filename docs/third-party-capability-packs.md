# Authoring Third-Party Capability Packs

This guide explains how to build a capability pack that can be inspected and
installed into a Sidekick instance. A pack is a directory with a
`sidekick.pack.json` manifest and zero or more modules, workflow definitions,
and knowledge assets.

Third-party packs use the same lifecycle as bundled packs. The difference is
trust and provenance: third-party modules are executable JavaScript loaded into
the Sidekick process. Sidekick verifies package identity and integrity, but it
does not sandbox or isolate the code. Treat installing or enabling a third-party
pack as deploying code on the server.

## What you can contribute

A pack can contain any combination of:

- **Modules**, which contribute governed MCP tools and optional health checks.
- **Workflow definitions**, which are data-driven reusable workflows executed
  by Sidekick's workflow runner.
- **Knowledge assets**, normally Markdown files installed into the searchable
  knowledge base.
- **Configuration**, validated against a JSON Schema and optionally passed to
  modules that explicitly opt into pack configuration.

The pack owns these components, but does not replace their runtime authorities.
Tool calls still use the shared registry and dispatcher; workflow executions use
the kernel; knowledge uses the knowledge store; and module state uses the module
lifecycle.

## Package layout

The package may have any directory name, but its contents should follow this
layout:

```text
my-pack/
├── sidekick.pack.json
├── modules/
│   └── my-tools/
│       ├── manifest.json
│       ├── entry.js
│       └── lib/
├── workflows/
│   └── my-pack/example.json
├── knowledge/
│   └── operating.md
└── examples/
```

Only files referenced by the manifests are components. Other regular files may
be included as implementation or documentation files, subject to the package
size and sensitive-file checks.

The package must be a directory visible to the Sidekick server. A path on the
developer's workstation is not usable unless that workstation is also the
server or the package has been copied to an approved server-local location.

## Pack manifest

Create `sidekick.pack.json` at the package root. This is a complete small pack
with one module, one workflow, one knowledge asset, and pack configuration:

```json
{
  "schema_version": 1,
  "name": "my-pack",
  "display_name": "My Capability Pack",
  "version": "1.0.0",
  "description": "Adds tools and procedures for a focused area of work.",
  "publisher": "Example Publisher",
  "compatibility": { "sidekick": ">=1.0.0" },
  "modules": [
    {
      "name": "my-tools",
      "path": "modules/my-tools",
      "entry_point": "entry.js",
      "config_from_pack": true
    }
  ],
  "workflows": [
    { "path": "workflows/my-pack/example.json" }
  ],
  "knowledge": [
    {
      "path": "knowledge/operating.md",
      "title": "My pack operating guide",
      "category": "operations",
      "tags": ["my-pack"]
    }
  ],
  "requires": {
    "tools": ["read"],
    "optional_tools": ["notify"]
  },
  "configuration": {
    "schema": {
      "type": "object",
      "properties": {
        "label": { "type": "string", "minLength": 1 }
      },
      "required": ["label"],
      "additionalProperties": false
    },
    "defaults": { "label": "example" }
  }
}
```

Manifest rules:

- `name` and module names are lowercase letters, digits, and hyphens, starting
  with a letter.
- `version` must be valid semantic versioning (`major.minor.patch`).
- All declared paths are relative to the pack root. Absolute paths, `..`
  segments, symlinks, and missing files are rejected.
- Pack module names must match the `name` in the module's own `manifest.json`.
- Required tools block installation when unavailable. Optional tools appear in
  health information but do not block installation.
- A module with `config_from_pack: true` requires the pack to declare
  `configuration.schema`.
- A configuration schema is standard JSON Schema as accepted by the Sidekick
  runtime. Defaults are merged before validation.
- Do not put passwords, API keys, certificates, private keys, or other secrets
  in the package or configuration. Store credentials with Sidekick's `secret`
  facility and reference the secret by name.

## Adding a module

Modules are the way a pack contributes executable tools. A module package needs
its own `manifest.json` and an entry point. The module manifest is pure data;
runtime functions live in `entry.js`.

### Module manifest

This is the minimum useful manifest:

```json
{
  "name": "my-tools",
  "displayName": "My Tools",
  "version": "1.0.0",
  "description": "Tools contributed by My Capability Pack.",
  "author": "Example Publisher",
  "type": "plugin",
  "entryPoint": "entry.js",
  "sidekick": ">=1.0.0",
  "capabilities": ["my-domain"],
  "configSchema": {
    "type": "object",
    "properties": { "label": { "type": "string" } },
    "additionalProperties": false
  },
  "permissions": [
    { "tool": "read", "risk": "low" }
  ],
  "tools": {
    "my_status": { "risk": "low", "category": "My Pack" }
  },
  "lifecycle": {
    "disable": "stop_new_work",
    "uninstall": "retain_data"
  }
}
```

The `tools` object declares the catalog metadata for every descriptor the module
builds. The descriptor's canonical name, aliases, risk, and category must agree
with the manifest. Tool names and aliases must not collide with built-in,
module, generated, or other pack tools.

The manifest also supports declared `dependencies`, `optionalDependencies`,
`workflows`, `agents`, `connectors`, `events`, `dashboard`,
`backgroundServices`, inline data-only `migrations`, and `retention`. Declare
only interfaces supported by the Sidekick version you target. See
[`module-system-design.md`](module-system-design.md) for the full module
contract and trust model.

### Module entry point

The entry point exports `buildDescriptors` and may export a synchronous
`healthCheck`:

```js
"use strict";

const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function buildDescriptors(services) {
  return [{
    name: "my_status",
    description: "Return the configured pack label.",
    schema: z.object({}),
    args: {},
    risk: "low",
    category: "My Pack",
    handler: async () => result({ ok: true, label: services.config.label })
  }];
}

function healthCheck({ config }) {
  return { ok: Boolean(config && config.label), details: { configured: true } };
}

module.exports = { buildDescriptors, healthCheck };
```

Use the supplied services facade instead of reaching into Sidekick internals:

- `services.dispatch(name, args)` calls another tool through the governed
  dispatcher.
- `services.paths.enforce(path, operation)` applies the shared path policy.
- `services.config` contains validated module configuration.

Do not import handler maps, bypass policy or approvals, access the database
directly, or execute arbitrary shell commands from a module. If a module needs
an existing capability, declare its permission and dispatch the existing tool.
Keep `healthCheck` synchronous, bounded, and cheap; it must return `{ ok,
details? }` rather than a Promise.

## Adding workflows and knowledge

Add workflow JSON files under the package and reference each one in
`workflows[]`. Workflow definitions are validated during inspection, so use an
existing definition as a template:

- [`packs/developer/workflows/repository-recon.json`](../packs/developer/workflows/repository-recon.json)
- the workflow-definition section in [`capability-packs.md`](capability-packs.md)

Workflow names should be namespaced with the pack name, for example
`my-pack/example`, to avoid collisions. Workflows are definitions, not custom
execution engines: use the supported workflow steps and Sidekick tools.

Knowledge files are normally Markdown. Give each asset a stable title and
category in the pack manifest. On installation Sidekick stores the content in
the ordinary knowledge table and tags it with `pack:<name>`, so agents retrieve
it with the normal `knowledge` tool.

## Inspect and test before installation

There is no remote package registry or package-signing system in the current
implementation. Build and distribute the package directory using your normal
trusted source-control or deployment process, then inspect it on the Sidekick
server before installation.

From an MCP client, inspect a server-local package without executing module
code:

```json
{
  "name": "capability",
  "arguments": {
    "action": "inspect",
    "path": "/srv/sidekick-packs/my-pack"
  }
}
```

Inspection reads manifests, walks files, computes a deterministic package hash,
validates module packages and workflow definitions, checks compatibility and
required tools, and reports an explicit `problems` list. It does not import or
execute pack code.

Before installation, test the module's own code and ensure that the package
contains no `.env`, private-key, certificate, credential, or other sensitive
files. Do not use symlinks in the package. A pack's dependencies must already
be available on the Sidekick server; the pack system does not install npm
dependencies or resolve module dependencies automatically.

## Install and operate a third-party pack

Installation and enablement are separate operations. `install` copies the
inspected bytes into the managed store and leaves the pack disabled unless
`enable: true` is supplied.

```json
{
  "name": "capability",
  "arguments": {
    "action": "install",
    "path": "/srv/sidekick-packs/my-pack",
    "config": { "label": "production" },
    "enable": false
  }
}
```

Then operate it by name:

```text
capability action="show" name="my-pack"
capability action="configure" name="my-pack" config={"label":"production"}
capability action="enable" name="my-pack"
capability action="health" name="my-pack"
capability action="disable" name="my-pack"
capability action="uninstall" name="my-pack"
```

The dashboard's **Capabilities** page exposes the same inspect, install,
configure, enable, disable, health, upgrade, and uninstall lifecycle. Every
mutation is the critical-risk `capability` tool and is subject to the active
tool policy, approval mode, redaction, and audit logging.

## Releases and upgrades

Publish a new package version by changing the pack and owned module semantic
versions as appropriate, then inspect the candidate on the target server.
Upgrade with:

```json
{
  "name": "capability",
  "arguments": {
    "action": "upgrade",
    "name": "my-pack",
    "path": "/srv/sidekick-packs/my-pack-1.1.0",
    "config": { "label": "production" }
  }
}
```

Higher versions are accepted by default. Same-version replacement and
downgrades require the corresponding explicit flags. Upgrades are staged and
verified; a failed upgrade preserves the working installation. Configuration
is preserved unless new configuration is supplied, and the new configuration
must pass the new schema.

## Security and compatibility checklist

Before distributing a pack:

1. Pin the Sidekick compatibility range and use semantic versions.
2. Namespace workflow names and tool names to reduce collision risk.
3. Declare every tool permission and keep the risk level as low as the tool's
   behavior permits.
4. Route existing operations through `services.dispatch` and shared path
   policy; do not recreate policy, approval, redaction, or audit behavior.
5. Keep secrets out of source, manifests, configuration, logs, and knowledge.
6. Test inspection, installation, configuration, enablement, health, disable,
   upgrade, and uninstall on a disposable Sidekick instance.
7. Document external services, required tools, configuration, data retention,
   network access, and operational failure modes for users.
8. Ask operators to inspect the package and review its source before enabling
   it. Installation is not sandboxing.

Current platform limits are important for publishers and users: third-party
pack code runs in-process; packages are not signed; there is no remote pack
registry; and package/module dependency resolution is not automatic. These
constraints may change in a future Sidekick release, so use the manifest
compatibility field and re-run inspection when upgrading Sidekick.
