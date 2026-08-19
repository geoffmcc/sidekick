# Interpreting image update checks

Digest identity is stronger than a tag comparison. `current` means the engine/provider compared an immutable digest; `update_available` means the candidate digest differs; `pinned` means the deployment names an immutable digest. `unknown`, `registry_unavailable`, and `authentication_required` are operational findings and must not be summarized as current. Mutable tags, local-only images, multi-architecture manifests, rate limits, and private registries can all make the result uncertain.
