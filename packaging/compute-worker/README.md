# Sidekick Compute Worker — OS Service Integration

Run the compute worker as a managed OS service that auto-starts at boot and
restarts on crash — but **stays stopped when its credential is revoked**.

## Restart policy (important)

The worker exits with code **0** on a terminal condition (revoked/invalid
credential, or an incompatible protocol version) and simply keeps retrying —
without exiting — during transient outages (server down/restarting). All three
service definitions therefore restart **only on a non-zero exit**:

| Platform | Mechanism | Restart directive |
|----------|-----------|-------------------|
| Linux    | systemd   | `Restart=on-failure` |
| macOS    | launchd   | `KeepAlive → SuccessfulExit: false` |
| Windows  | winsw     | `<onfailure action="restart"/>` (zero exit = no restart) |

A revoked worker (exit 0) is left stopped so it does not hot-loop; recover it by
re-enrolling (`enroll` with a re-enrollment token).

## Secrets

The enrollment **token** is passed to the installer only to perform `enroll`,
which exchanges it for a persistent credential written to a `0600` / ACL'd file.
The token is **never** stored in the config file or the service definition, and
the credential is referenced by **path** only.

## Files

- `../../systemd/sidekick-compute-worker.service` — systemd unit (Linux)
- `com.sidekick.compute-worker.plist` — launchd LaunchDaemon (macOS)
- `sidekick-compute-worker.xml` — winsw service definition (Windows)
- `install-linux.sh` / `uninstall-linux.sh`
- `install-macos.sh` / `uninstall-macos.sh`
- `install-windows.ps1` / `uninstall-windows.ps1`

## Install

### Linux (systemd)
```bash
sudo SERVER_URL=http://host:4097 ENROLL_TOKEN=<token> ./install-linux.sh
journalctl -u sidekick-compute-worker -f
```

### macOS (launchd)
```bash
sudo SERVER_URL=http://host:4097 ENROLL_TOKEN=<token> ./install-macos.sh
```

### Windows (winsw)
winsw is a small, dependency-free .NET service wrapper. The built worker package
bundles a pinned, SHA-256-verified winsw release as `sidekick-compute-worker.exe`
(see `THIRD_PARTY_NOTICES.md`), so installing from the package needs no download:
```powershell
# elevated PowerShell
.\install-windows.ps1 -ServerUrl http://host:4097 -EnrollToken <token>
```
When installing from a bare repo checkout instead of the package, supply the
binary with `-WinswUrl <winsw release exe url>` or place it manually.

## Uninstall

```bash
sudo ./uninstall-linux.sh            # keep config/credential
sudo ./uninstall-linux.sh --purge    # also remove them
```
```powershell
.\uninstall-windows.ps1              # keep config/credential
.\uninstall-windows.ps1 -Purge       # also remove them
```

Live install/registration is exercised in Phase 11 acceptance; these definitions
are statically validated by `test/compute-worker-service.test.js`.
