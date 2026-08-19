# Jellyfin pack: library analytics and metadata completeness

`library_analytics` and `metadata_completeness` are bounded, read-only
observations over Jellyfin's `/Items` response. They report the server's total
record count separately from the returned sample; a sample is not a complete
library inventory. Use `library_id` to narrow the query and `start` or
`start_index` to page through larger libraries.

Analytics summarize item types, aggregate runtime, genres, video codecs, audio
languages and subtitle languages. Runtime totals only include items with a
valid Jellyfin `RunTimeTicks` value; they do not infer runtime from filenames
or filesystem state.

Completeness checks observe overview, primary/backdrop images, production year,
provider IDs, genres and runtime fields. Missing fields are review findings,
not proof of corrupt media, missing files or a need to trigger a metadata
refresh. These actions never refresh metadata, scan libraries or change user
state.
