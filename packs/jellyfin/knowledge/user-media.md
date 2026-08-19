# Jellyfin pack: collections, playlists and user media state

`list_collections` and `list_playlists` are bounded server-side catalog reads. They return item identifiers, names, child counts and limited metadata; they do not add, reorder, edit or delete collection or playlist members.

`user_media_state` and `user_unwatched` require an explicit `user_id` or exact `username`. User-scoped results include only the requested user's favorite, played, play-count, resume-position and last-played fields. The pack never silently selects a user and never writes user data.

`user_unwatched` is a bounded unplayed-media view, not a recommendation engine or behavioral inference. Jellyfin's returned ordering and filters are preserved as evidence. User names, watch state and resume positions are private operational data and should not be exposed beyond the requesting operator's authorized context.
