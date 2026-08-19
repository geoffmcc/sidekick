# Proxmox pack: storage health and backup history

`storage_health` reports disabled, inactive, high-usage and capacity-unknown
findings from Proxmox storage rows. Missing capacity is preserved as unknown;
the action does not probe host filesystems, ZFS/Ceph internals or PBS.

`backup_history` summarizes a bounded recent set of Proxmox-side vzdump tasks,
including completed and failed counts and the latest successful or failed task
when present. It does not claim that a backup can be restored, that PBS
retention is sufficient, or that datastore contents were inspected.
