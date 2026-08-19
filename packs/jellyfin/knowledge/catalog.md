# Jellyfin pack: catalog and content health

`library_audit` and `content_health` are bounded, read-only catalog inspections. They query Jellyfin items beneath configured libraries and report the server's `TotalRecordCount` separately from the returned sample. A sample is not a complete filesystem inventory.

The audit reports item types, production years, video codecs, overview/image/provider-id presence, runtime availability, audio languages, subtitle languages and normalized item metadata. Missing metadata is an observation from the returned Jellyfin DTO, not proof that a file is corrupt or unreachable. Filesystem accessibility, permissions, mount state and media integrity require an independent host or storage evidence source.

`media_info` is used for a named item, series or season. Series inspection is capped at 100 seasons and 100 returned episodes per season. Episode counts use Jellyfin's `TotalRecordCount` when present; runtime aggregates describe the episodes returned in the bounded response. The action never refreshes metadata, changes user data or mutates the library.

Large libraries should use `library_id` to narrow the audit or consume aggregate results rather than treating the returned item list as exhaustive. Duplicate candidates and metadata findings are evidence for review, never automatic repair instructions.
