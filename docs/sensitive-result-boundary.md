# Sensitive One-Time Results

Enrollment-token creation is the only built-in operation allowed to return a
one-time sensitive result. The dispatcher creates an in-memory branded envelope
only for that exact operation with an authenticated principal and session. The
brand is not a JSON property and cannot survive serialization, replay, retry, or
recovery.

All other results, including objects supplied by third-party packs, are passed
through normal redaction. The token is never persisted in plaintext or written
to logs, events, receipts, metrics, memories, support bundles, or Dashboard
history. Operators receive an explicit warning that the token will not be
shown again.
