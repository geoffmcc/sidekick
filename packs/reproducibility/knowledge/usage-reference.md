# Reproducibility: inputs, custody and limitations

`create-bundle` combines bounded repository profile and semantic evidence with
research evidence custody. Supply a project identifier and only the repository
or platform evidence needed for the question; `max_chars` bounds retained
material. The resulting bundle should reference immutable evidence IDs and
record source versions, hashes, and collection time.

Bundles are secret-safe evidence packages, not a copy of the repository and not
a build or environment recreation. Redaction produces a derivative and never
mutates the original evidence. Do not include credentials, private keys, raw
environment files, or target-specific research in the public source tree.
