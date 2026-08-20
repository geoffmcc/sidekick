# Installation and Deployment

## Requirements

- Node.js 22 or newer, matching `package.json`.
- npm.
- Git.
- A Linux host for persistent operation.
- Network access from the MCP client to the MCP server.
- Optional: Ollama for local LLM calls.
- Optional: Groq API key for cloud LLM calls.

## Deployment topologies

Sidekick is one product with two supported topologies:

```text
Sidekick
├── Local MCP runtime (no dedicated server; MCP client launches stdio)
└── Dedicated server (server/VM/LXC with HTTP, dashboard, and Agent Bridge)
```

The local runtime is an alternative to deploying Sidekick on a dedicated
server. It uses the same tool registry, dispatcher, policy, approvals,
audit, memory, workflow, capability-pack, and Compute code as the dedicated
topology. A capability is unavailable only when its normal environment,
provider, credential, target, or hardware requirement is unavailable.

## Use Sidekick without a dedicated server: local `npx` runtime

Any MCP client that supports child-process stdio servers can launch a full
Sidekick runtime on the local workstation, without deploying a separate
Sidekick server or cloning the repository:

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

For reproducible supply-chain behavior, prefer a published version or an
immutable Git tag when one is available. A GitHub branch reference follows
the branch as it changes; `npx` downloads the package and its declared
dependencies, then launches the `sidekick` executable. No repository-local
working directory is required.

The child process speaks newline-framed MCP JSON-RPC on stdout. Diagnostics go
to stderr. On first launch it creates a private per-user Sidekick home and
applies the existing database migrations. The home is outside the npm cache,
so memories, handoffs, projects, workflows, audit history, configuration, and
other supported state survive client restarts, reboots, cache cleanup, and
package upgrades. Set `SIDEKICK_HOME` to choose another absolute home; the
database is stored below its `data` directory. Initialization is serialized by
an atomic local lock and is repeatable without deleting existing state.

Useful local commands are:

```bash
npx -y github:geoffmcc/sidekick version
npx -y github:geoffmcc/sidekick status
npx -y github:geoffmcc/sidekick doctor
```

`setup`/`doctor` prepare or inspect the local home; the bare executable starts
the MCP runtime. No dedicated Sidekick server is required. The local runtime
does not require a Cloudflare account or
`CLOUDFLARE_API_TOKEN`, and it does not add telemetry or hidden network calls.
Optional providers, reachable remote workers, and capability packs are
detected and governed through the same normal Sidekick paths.

## Local development install

```bash
git clone https://github.com/geoffmcc/sidekick.git
cd sidekick
cp .env.example .env
npm install
npm start
```

In separate terminals:

```bash
npm run dashboard
npm run agent
```

Defaults:

- MCP server: `http://127.0.0.1:4097`
- Dashboard: `http://127.0.0.1:4098`
- Agent Bridge: `http://127.0.0.1:4099`

## Deployment scripts

The repo includes `deploy.sh` for Linux/macOS and `deploy.ps1` for Windows. The scripts are designed to bootstrap a fresh remote host, create or use a `sidekick` user, install Node.js, copy the app, sync `.env`, install dependencies, install systemd services, and configure UFW rules if UFW is active.

Linux/macOS:

```bash
./deploy.sh -IP YOUR_REMOTE_IP
./deploy.sh -IP YOUR_REMOTE_IP -InitialUser ubuntu
```

Windows PowerShell:

```powershell
.\deploy.ps1 -IP "YOUR_REMOTE_IP"
.\deploy.ps1 -IP "YOUR_REMOTE_IP" -InitialUser "ubuntu"
```

The scripts use SSH. On a fresh host they may prompt for the initial user's password once, then install a key for later passwordless deployment.

## Manual systemd installation

Assuming the app lives at `/home/sidekick/sidekick` and runs as the `sidekick` user:

```bash
sudo useradd --system --create-home --shell /bin/bash sidekick
sudo mkdir -p /home/sidekick/sidekick
sudo chown -R sidekick:sidekick /home/sidekick/sidekick

sudo -u sidekick git clone https://github.com/geoffmcc/sidekick.git /home/sidekick/sidekick
cd /home/sidekick/sidekick
sudo -u sidekick cp .env.example .env
sudo -u sidekick npm install --omit=dev

sudo cp systemd/sidekick-mcp.service /etc/systemd/system/
sudo cp systemd/sidekick-dashboard.service /etc/systemd/system/
sudo cp systemd/sidekick-agent.service /etc/systemd/system/
sudo cp systemd/sidekick-sudoers /etc/sudoers.d/sidekick
sudo chmod 440 /etc/sudoers.d/sidekick

sudo systemctl daemon-reload
sudo systemctl enable --now sidekick-mcp sidekick-dashboard sidekick-agent
```

Check services:

```bash
systemctl status sidekick-mcp
systemctl status sidekick-dashboard
systemctl status sidekick-agent
```

## MCP client configuration

### Local stdio clients

Claude Desktop, Cursor, Windsurf, Cline/Roo-Code, Zed, and Continue all use an
equivalent `command`/`args` shape when their MCP configuration supports stdio.
Use the local example above; do not add unrelated environment secrets. If a
client uses a different top-level key, keep the same `command` and `args`.

Use Streamable HTTP with the MCP server URL and bearer token. A typical config shape is:

```jsonc
{
  "mcp": {
    "sidekick": {
      "enabled": true,
      "type": "remote",
      "url": "http://YOUR_REMOTE_IP:4097/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SIDEKICK_API_KEY"
      }
    }
  }
}
```

For older clients that need SSE, use the `/sse` endpoint and `/messages` endpoint generated by the SDK transport.

## Firewall and exposure

At minimum, expose port 4097 only to systems that need MCP access. The dashboard and agent ports should usually be private, VPN-only, or reverse-proxied behind authentication. If UFW is active, the supplied scripts can open ports 4097, 4098, and 4099, but that is not the safest public-facing configuration.
