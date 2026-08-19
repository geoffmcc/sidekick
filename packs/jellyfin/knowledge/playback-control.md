# Jellyfin pack: targeted playback control

`jellyfin_playback` sends a targeted `PlayNow` command to an active Jellyfin
device session. It is separate from the read-only `jellyfin` tool and requires
the selected profile to set `allow_playback_control: true` in addition to the
normal Sidekick policy decision.

Select a target with an exact `session_id`, exact `device_id`, or an exact
case-insensitive `device_name`. If no selector is supplied, the tool proceeds
only when exactly one eligible media-control session exists; it refuses to
guess when several TVs or users are active. A disconnected device, a session
without media-control support, or a session without a resolved Jellyfin
`UserId` fails closed.

The session's `UserId` is authoritative for watch-state ownership. Before
issuing playback, the item is resolved through `/Users/{UserId}/Items/{ItemId}`
so the requested user's access and identity are preserved without assuming a
username or a global default user. The result reports the resolved user,
device, item, command, and bounded postcondition evidence; it never claims
playback was verified unless the target session reports the requested item as
now playing.

The control surface supports `play` (`PlayNow`), `pause`, `resume`, `stop`,
`seek`, `fast_forward`, `rewind`, and `set_volume`. Seek accepts either an
absolute `position_seconds` or a signed relative `offset_seconds`. The named
`fast_forward` and `rewind` actions accept a positive `offset_seconds` amount;
for example, 30 minutes is `1800` seconds. These commands are sent only to
the selected session and report bounded postcondition evidence. Mute and
other remote-control commands are not implemented and must not be invented or
substituted by an agent.
