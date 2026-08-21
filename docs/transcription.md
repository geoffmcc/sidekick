# Transcription

The `transcribe` tool supports the existing synchronous mode and an
asynchronous mode for media that exceeds the MCP request timeout.

Submit a job with `async: true`:

```json
{"path":"/path/to/media.webm","model":"base","backend":"auto","async":true}
```

Poll it with `{"action":"status","job_id":"tr_..."}` and cancel it with
`{"action":"cancel","job_id":"tr_..."}`. Jobs use a persistent record under
the Sidekick data directory, but the child process is intentionally not
detached: a Sidekick restart marks an in-flight job `orphaned` rather than
claiming that it resumed.

`backend: "auto"` prefers installed `faster-whisper`, then `whisper.cpp`, then
the existing Whisper CLI. Device selection is local: `auto` uses a detected
NVIDIA CUDA device for supported backends, Apple Silicon Metal for
`whisper.cpp`, or a local Vulkan device for `whisper.cpp` (including compatible
AMD GPUs), and otherwise uses CPU. The selected device is recorded with the
job. `SIDEKICK_TRANSCRIPTION_DEVICE=cpu|cuda|metal|vulkan` can override auto
detection; an explicit unsupported device fails closed. GPU hardware is not
treated as usable unless the backend and its runtime report a compatible path.
