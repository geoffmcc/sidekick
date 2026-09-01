# Observability and Incident Response

Use `observability_incident_snapshot` when evidence must be retained and
attributed. It delegates capture to Black Box, including its profile,
redaction, retention, and capture lifecycle. A returned capture request is not
itself proof that every source succeeded; inspect the provider result.

Health review intentionally keeps status and health as separate evidence.
Metrics queries delegate to the configured metrics provider. Provider errors,
empty results, and unsupported operations remain visible as unknown or failed;
the pack does not infer normal operation.
