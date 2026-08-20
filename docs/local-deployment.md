# Local Deployment

This is the no-dedicated-server way to use Sidekick: the MCP client launches a
full Sidekick runtime on the user’s workstation through `npx`. It is not a
separate product tier and does not use a reduced registry or dispatcher.

```text
Sidekick
├── Local MCP runtime     no dedicated server; the client launches one stdio child process
└── Dedicated server      server/VM/LXC runs HTTP, dashboard, and Agent Bridge
```

Both topologies use the same MCP registration, tool schemas, dispatcher,
source-aware policy, approvals, execution context, redaction, audit, secrets,
capability packs, workflows, persistence, and Compute subsystems. A local
capability is unavailable only when its normal software, hardware, provider,
credential, target, or network requirement is unavailable.

## Requirements

- Node.js 22 or newer.
- npm, which is installed with Node.js.
- An MCP client that can launch a child-process stdio server.

The local runtime does not require Git, a Sidekick clone, a dedicated server,
a Cloudflare account, or `CLOUDFLARE_API_TOKEN`.

## MCP client configuration

The simplest configuration is:

```json
{
  "mcpServers": {
    "sidekick": {
      "command": "npx",
      "args": ["-y", "github:geoffmcc/sidekick"]
    }
  }
}
```

This shape applies to clients whose configuration calls the field
`mcpServers`, including the usual command-based configurations for Claude
Desktop, Cursor, Windsurf, Cline, Roo-Code, and Continue. Zed exposes the same
command and arguments through its `context_servers` command configuration.
Use the client’s configuration UI or documented file location; the Sidekick
command and arguments do not change.

For supply-chain reproducibility, prefer a published version or immutable Git
tag when available, for example:

```json
{
  "mcpServers": {
    "sidekick": {
      "command": "npx",
      "args": ["-y", "github:geoffmcc/sidekick#v1.2.0"]
    }
  }
}

```

For production use, prefer a pinned GitHub Release tag such as `v1.2.0` over
the mutable branch form. The tag should point to the reviewed release commit
and match the version in `package.json`. The unpinned GitHub form remains
useful for development and for trying the latest branch state; it is not a
reproducible release pin.

The branch form follows mutable repository state. A version or tag pins the
source reference, but dependencies should still be reviewed through the
normal npm supply-chain process.

Do not add API keys, Cloudflare tokens, or unrelated environment secrets to
the default configuration. Optional credentials belong in Sidekick’s governed
secret providers and are requested only by the capability that needs them.

## What `npx` does

`npx` obtains the package and its declared dependencies, resolves the
`sidekick` package executable, and starts it as the MCP child process. The
runtime does not use the npm cache as its database and does not require the
current working directory to be the repository.

The stdio protocol is newline-framed MCP JSON-RPC. stdout is reserved for MCP
messages; startup diagnostics and errors go to stderr. Do not redirect stderr
into stdout in a client wrapper.

## Persistent state

On first runtime startup Sidekick creates a per-user home, applies the normal
database migrations, and initializes the same persistent stores used by the
dedicated topology. Initialization is idempotent and serialized with an
exclusive lock. A crashed initializer can be recovered when its recorded
process is no longer alive; existing state is never deleted automatically.

The default home is platform-aware:

| Platform | Default home | Database |
|---|---|---|
| Windows | `%LOCALAPPDATA%\Sidekick` (or `%APPDATA%\Sidekick`) | `home\data\sidekick.db` |
| macOS | `~/Library/Application Support/Sidekick` | `home/data/sidekick.db` |
| Linux/other Unix | `$XDG_DATA_HOME/sidekick`, or `~/.local/share/sidekick` | `home/data/sidekick.db` |

Set `SIDEKICK_HOME` to an absolute directory when a different location is
required. `SIDEKICK_DATA_DIR` may explicitly select the data directory; the
local launcher still applies private-directory permissions where the platform
supports them. Backups are placed below the data directory’s `backups` path.

State survives MCP client restarts, computer reboots, npm cache cleanup,
package upgrades, and changes to the package cache path. This includes
memories, handoffs, projects, workflows, approvals, audit history,
configuration, capability-pack state, and supported artifacts. Use the normal
Sidekick tools to create and retrieve this state; do not edit SQLite directly.

## CLI commands

The bare command starts the MCP runtime:

```bash
npx -y github:geoffmcc/sidekick
```

Human-facing commands are intentionally small:

```bash
sidekick version  # print package version
sidekick setup    # create the local home and data directories
sidekick status   # show paths and whether the database exists
sidekick doctor   # prepare the home and show status
```

`setup`, `status`, and `doctor` are diagnostic/local-management commands;
they do not start a background service. Ordinary use is owned by the MCP
client process; no Sidekick server needs to be deployed or kept running
separately. The local topology does not silently install a privileged system
service or bind a network listener.

## Compute and capability packs

Local deployment does not disable Compute. It uses the normal provider/model,
placement, worker, job, and artifact-custody paths. Local Ollama or other
supported providers can be used when configured; reachable enrolled remote
workers remain usable. If no eligible provider or worker exists, the normal
Compute tools report an unavailable or unconfigured capability.

Capability packs are discovered, configured, enabled, health-checked, and
executed through the same pack lifecycle as dedicated deployment. A reachable
Proxmox, Jellyfin, developer repository, browser, or other pack target can be
used locally when its requirements and policy permit it.

## Security and troubleshooting

- Keep `SIDEKICK_HOME` on a user-owned filesystem. Do not place it in an npm
  cache, temporary extraction directory, or package directory.
- Local mode does not read file-backed secrets from a repository `.env` file.
  Configure secrets through the existing protected secret-file/provider paths.
- Multiple clients may start Sidekick concurrently; bootstrap locking and
  SQLite migration behavior serialize initialization.
- If startup fails, run `sidekick doctor` and inspect stderr from the MCP
  client. Check Node.js version, directory permissions, and whether another
  Sidekick process is still initializing.
- If a migration fails, preserve the home and database and inspect the error.
  Do not delete the data directory to force startup.
- A missing browser runtime, provider, worker, or remote pack target is an
  environment availability state, not a local feature restriction.

## When a dedicated server is useful

The local runtime is the simplest choice when Sidekick should run on the same
computer as the MCP client and does not need to be available while that client
is closed. Use a dedicated server when multiple clients need shared access,
the runtime must remain available independently of a client, or server-hosted
dashboard/Agent Bridge operation is required.

## Moving to dedicated deployment

Local and dedicated deployments use the same database and artifact concepts.
Use Sidekick’s existing backup/export/import and memory portability tools when
moving state. There is no special local-only database format and no automatic
directory-copy command that claims to migrate a complete installation. Follow
the relevant backup/export procedure for the version being moved.

## Validation boundary

The repository tests the local stdio handshake, tool discovery and schemas,
governed tool execution, negative policy/approval behavior, persistence across
restart, concurrent setup, stdout purity, and clean npm package execution.
The exact GitHub `npx` fetch cannot be tested for an unpublished feature branch;
validate that final step after the branch or release is published.
