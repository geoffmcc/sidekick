# Proxmox pack: storage, PBS and backup verification readiness

`storage_backend_audit` reports normalized storage backend, content, capacity,
backup-capability and PBS configuration observations. A configured PBS backend
is evidence that Proxmox knows about the backend, not proof that its datastore
is reachable or healthy.

`backup_verification_audit` combines configured vzdump selections, bounded
recent backup task outcomes, guest coverage and storage capability. Findings
identify missing jobs, failed recent tasks, uncovered guests and unknown PBS
restoreability. These actions never claim that backup contents, retention,
encryption or restoreability have been verified, and never modify jobs or
storage.
