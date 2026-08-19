# Jellyfin pack: catalog and content health

`library_audit` and `content_health` are bounded, read-only catalog inspections. They query Jellyfin items beneath configured libraries and report the server's `TotalRecordCount` separately from the returned sample. A sample is not a complete filesystem inventory.

Use `list_media` when individual movie or TV titles are needed. It queries Jellyfin's recursive `/Items` collection and supports `library_id`, `genre` (or comma-separated `genres`), `include_item_types` (for example `Movie` or `Series`), `query`, `tags`, `years`, `is_favorite`, `min_community_rating`, `min_premiere_date`, `max_premiere_date`, `sort_by`, `sort_order`, `limit`, and `start`/`start_index`. Results include the title, type, year, premiere date, genres, tags, path, overview, provider ids and runtime. The default item types are movies and series, so seasons and episodes must be requested explicitly when needed.

Set `all=true` to enumerate every matching item across the selected library or server. Enumeration follows Jellyfin pages until the reported total is reached, an empty/short page is returned, or the safety cap is reached. `max_items` defaults to 10,000 and is bounded at that value; inspect `total_record_count` and `truncated` to determine whether the result is complete. Full-library enumeration is still API inventory evidence, not proof that every filesystem media file is reachable.

The audit reports item types, production years, video codecs, overview/image/provider-id presence, runtime availability, audio languages, subtitle languages and normalized item metadata. Missing metadata is an observation from the returned Jellyfin DTO, not proof that a file is corrupt or unreachable. Filesystem accessibility, permissions, mount state and media integrity require an independent host or storage evidence source.

`media_info` is used for a named item, series or season. Series inspection is capped at 100 seasons and 100 returned episodes per season. Episode counts use Jellyfin's `TotalRecordCount` when present; runtime aggregates describe the episodes returned in the bounded response. The action never refreshes metadata, changes user data or mutates the library.

Large libraries should use `library_id` to narrow the audit or consume aggregate results rather than treating the returned item list as exhaustive. Duplicate candidates and metadata findings are evidence for review, never automatic repair instructions.
