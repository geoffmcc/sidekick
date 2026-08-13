# Proxmox pack: API tokens and least-privilege permissions

The pack authenticates with a **Proxmox API token**, not a username and
password. Tokens are revocable, scoped, and never expire a session.

## Creating a token

In the Proxmox UI: Datacenter → Permissions → API Tokens → Add. The token id is
`user@realm!tokenname` and the secret is shown **once**. With "Privilege
Separation" enabled (recommended), the token has no privileges until you grant
it a role on a path.

Store the secret in Sidekick's secret store, then reference it from the profile:

```text
secret action="store" key="proxmox_production_token" value="<the secret>"
capability action="configure" name="proxmox" config={
  "profiles": { "production": {
    "endpoint": "https://pve.example.internal:8006",
    "token_ref": "secret:proxmox_production_token"
  } }
}
```

The secret value never appears in configuration, tool output, logs, or errors.

## Least privilege by capability

Grant the token the **minimum** role for what you intend to do. Add the ACL at
Datacenter → Permissions → Add → API Token Permission, with Propagate on `/`.

| Intended use | Role | Notes |
|---|---|---|
| Read-only discovery and status | `PVEAuditor` on `/` | Covers cluster/node/guest/storage/task reads and the capability report |
| Guest lifecycle (start/shutdown/reboot) | `PVEAuditor` + `VM.PowerMgmt` | Grant `VM.PowerMgmt` on `/vms` or on specific `/vms/<vmid>` |
| Broader management | project-specific | Not required by this release; grant deliberately, never root-equivalent by default |

A read-only token is sufficient for everything except `proxmox_guest`, and a
profile is read-only unless an administrator also sets `allow_lifecycle: true`.

## Permission failures are not outages

If the token lacks a privilege, the pack returns a `permission_denied` (HTTP
403) error naming it as an authorization problem — distinct from a network or
TLS failure. Note also that Proxmox **silently filters** `/cluster/resources`
by permission: an empty or short guest list can mean the token lacks `VM.Audit`
where guests exist, not that there are no guests. The `list_guests` result says
so explicitly.

## Keep PVE and PBS credentials separate

If you later use Proxmox Backup Server directly, give it its own token and its
own secret-store entry. Never reuse a PVE token for PBS.
