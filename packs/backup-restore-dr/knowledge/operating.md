# Backup, Restore and Disaster Recovery

Backups and restores are separate operations. `backup_database` delegates to
the governed database backup tool and inherits its path, size, compression,
audit, and retention controls. `restore_database` delegates to the critical
database restore tool and defaults verification on; it is never simulated by
this pack.

`backup_dr_readiness` uses Proxmox's provider-native coverage, history, and
verification actions. Missing PBS or unavailable task data is evidence of an
unknown or incomplete check, not evidence of successful backups. A backup
request being accepted is not proof of recoverability; perform an authorized
restore test separately.
