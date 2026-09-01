# Local AI and Model Operations

Compute is the sole inference authority. Readiness reports query the registered
model/provider/worker state and queue statistics, then label unavailable or
missing capabilities honestly. This pack never calls Ollama or provider URLs
directly, never downloads a model, and never treats a listed model as proof that
it is healthy or suitable for private data.
