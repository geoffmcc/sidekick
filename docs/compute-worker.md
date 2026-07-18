# Sidekick Compute Worker — Production Lifecycle

The compute worker (`src/compute/worker-agent.js`, shipped as the
`sidekick-compute-worker` binary) is a standalone, dependency-free process that
enrolls with a Sidekick server, advertises its capabilities, and processes
allowlisted `chat` / `generate` / `embeddings` jobs. This document covers the
productionized lifecycle: state model, CLI, configuration, credentials,
reconnection, OS-service installation, packaging, and scheduling.

For the server-side view (jobs, leasing, routing, artifacts) see
[`compute.md`](compute.md).

---

## Multi-dimensional state model

A worker's status is tracked as four orthogonal dimensions rather than a single
field, so connection, administration, credential, and health concerns can be
reasoned about independently:

| Dimension | Values | Meaning |
|-----------|--------|---------|
| `connection_state` | `connecting` / `online` / `offline` | Whether heartbeats are current. |
| `admin_state` | `enabled` / `maintenance` / `draining` | Administrative intent. Maintenance/draining keep the worker connected but stop it taking **new** jobs. |
| `credential_state` | `active` / `revoked` | `revoked` is terminal — enable/heartbeat/rotation cannot restore it. |
| `health_state` | `healthy` / `degraded` / `unavailable` / `unknown` | Backend health. |

A legacy `state` column is retained as a **derived** value for backward
compatibility, computed with this precedence:

```
revoked > maintenance > draining > online > offline
```

The server reconciles connections on a timer: a worker whose heartbeat lapses
beyond ~3× the heartbeat interval (default 90s) is moved to
`connection_state = offline`, preserving its `admin_state` and never touching a
revoked credential.

---

## CLI

The binary dispatches subcommands:

```
sidekick-compute-worker <command> [options]

  run                Load config + credential, connect, and process jobs (default)
  enroll             Exchange an enrollment token, write the credential, and exit
  status             Print local worker status (no secrets) and exit
  doctor             Run read-only diagnostics and exit
  rotate-credential  Rotate the worker credential via the server and exit
  version            Print the worker version and exit
```

Global options: `--server <url>`, `--token <token>` (enroll), `--name <name>`,
`--node-id <id>`, `--config <path>` (credential file), `--config-file <path>`
(settings file), `--concurrency <n>`, `--service` (enroll only, no claim loop).

`doctor` performs read-only, individually bounded checks — configuration,
credential presence and permissions, server reachability, an authenticated
heartbeat, protocol version, and OpenVINO/Ollama availability — and exits
non-zero if any hard check fails. It never weakens a security check.

---

## Configuration

Settings resolve with the precedence **CLI > environment > config file >
defaults**. The (non-secret) config file is JSON, validated on load:

```json
{
  "serverUrl": "http://10.0.0.5:4097",
  "nodeId": "node_…",
  "displayName": "lab-worker",
  "concurrency": 4,
  "heartbeatMs": 30000,
  "pollMs": 2000,
  "openvino": { "enabled": true, "pythonPath": "…", "modelsDir": "…" },
  "ollama": { "enabled": true, "url": "http://127.0.0.1:11434" }
}
```

Default config file locations:

| OS | Path |
|----|------|
| Linux | `/etc/sidekick-compute-worker/config.json` |
| macOS | `/Library/Application Support/Sidekick Compute Worker/config.json` |
| Windows | `C:\ProgramData\Sidekick\compute-worker\config.json` |

Point at a specific file with `--config-file` or `SIDEKICK_WORKER_CONFIG_FILE`.

**Stable node identity:** if no node id is supplied, the worker derives a
deterministic one from the hostname and MAC addresses, so it keeps the same
identity across restarts instead of registering as a new node each time.

---

## Credentials, rotation, and re-enrollment

The enrollment token is exchanged once for a persistent **credential**, written
atomically (temp file + rename) with `0600` permissions on POSIX and NTFS ACLs
restricting it to the current user on Windows. The credential file is separate
from the (non-secret) config file. The enrollment token is never persisted.

- **Rotation** (`rotate-credential`): the worker requests a new credential using
  the current one, persists it atomically *before* switching in memory, then
  verifies it with a heartbeat. A crash mid-rotation still leaves a usable
  credential on disk.
- **Re-enrollment** (credential recovery): an admin issues an enrollment token
  scoped to an existing node (`reEnrollmentOf`); the worker re-runs `enroll` and
  the server reuses the worker identity with a fresh credential, invalidating the
  old one. An active node cannot be silently taken over — re-enrollment requires
  a node-scoped token or an already-revoked node.

---

## Reconnection behavior

Request outcomes are classified so the worker rides out outages but stops
cleanly on terminal conditions:

- **Transient** (network error/timeout, `408`/`429`, any `5xx`): retry with
  exponential backoff + jitter. A single "lost connection" and "reconnected"
  line are logged per outage. Server restarts are ridden out transparently.
- **Permanent** (`401`/`403` while enrolled = revoked/invalid credential;
  `426` = incompatible protocol): the worker logs `FATAL` and **exits 0**. Exit 0
  (not a crash code) means a service manager set to restart-on-failure will
  **not** hot-loop a worker that can only recover via re-enrollment.

---

## OS service installation

The worker installs as a managed service that auto-starts at boot and restarts
on crash — but stays stopped when its credential is revoked (matching the exit-0
contract above). Definitions and installers live in
[`../packaging/compute-worker/`](../packaging/compute-worker/) and
[`../systemd/sidekick-compute-worker.service`](../systemd/sidekick-compute-worker.service).

| Platform | Mechanism | Restart directive |
|----------|-----------|-------------------|
| Linux | systemd | `Restart=on-failure` |
| macOS | launchd | `KeepAlive → SuccessfulExit: false` |
| Windows | winsw | `<onfailure action="restart"/>` |

```bash
# Linux
sudo SERVER_URL=http://host:4097 ENROLL_TOKEN=<token> ./install-linux.sh
# macOS
sudo SERVER_URL=http://host:4097 ENROLL_TOKEN=<token> ./install-macos.sh
```
```powershell
# Windows (elevated) — winsw is a small dependency-free .NET service wrapper
.\install-windows.ps1 -ServerUrl http://host:4097 -EnrollToken <token> `
  -WinswUrl https://github.com/winsw/winsw/releases/download/vX.Y.Z/WinSW-net461.exe
```

Each installer creates the config/credential directories, writes a non-secret
`config.json`, runs `enroll --service` to obtain the credential, then registers
and starts the service. No secret is placed in any service definition.

---

## Standalone package

Build a self-contained, dependency-free worker package:

```bash
npm run package:worker
# → dist/sidekick-compute-worker-<version>/  (worker modules, OpenVINO helper,
#   service definitions/installers, package.json with zero dependencies, SHA256SUMS)
```

The build statically walks the worker's module graph and fails if it ever
reaches server-only code, guaranteeing the package excludes the MCP server,
dashboard, and database layers. Verify integrity of a downloaded package with:

```bash
sha256sum -c SHA256SUMS
```

---

## Scheduling enforcement

Compute is pull-based: workers claim jobs. The claim path enforces eligibility —
a worker in `maintenance` or `draining`, or with a revoked credential, is
refused new leases (`claimed: false, reason: …`) while keeping any in-flight
work. Revoked credentials are additionally rejected at authentication.

---

## Live acceptance checklist (Windows)

Run once per release on a real Windows host using the packaged worker + winsw
installer:

- [ ] Fresh install registers and auto-starts the service.
- [ ] OpenVINO reports ready; a submitted job completes.
- [ ] Stop the service → dashboard shows the worker `offline`.
- [ ] Start the service → `online`; a job completes.
- [ ] Reboot → service auto-starts and reconnects.
- [ ] Restart the Sidekick server → worker reconnects without re-enrollment.
- [ ] Put the worker in maintenance → it claims no new jobs; heartbeat still visible.
- [ ] Revoke → the worker exits and stays stopped; re-enroll with a scoped token → it works again.
