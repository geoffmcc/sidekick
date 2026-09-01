# Storage and Filesystems: source and capacity reference

Use `storage-audit` for host or Proxmox capacity and backend evidence, and
`volume-audit` for container or provider volume inventory. The pack combines
`status` with optional `proxmox` and `containers` sources; select `default_node`
only when the provider supports a node-scoped request. Provider absence,
stale data, and empty inventories must remain visible as unknown.

Capacity, backend health, and volume attachment are different claims. Inspect
free bytes, utilization, allocation, and error state independently before
library, database, or container mutations. This pack does not mount, format,
resize, repair, delete, or otherwise mutate filesystems or volumes.
