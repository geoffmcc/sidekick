# Sidekick VPS

This project has a remote MCP server running at `64.176.216.202:4097` called **sidekick**.
Use the `sidekick_*` tools when you need to:

- Run shell commands on a remote VPS (`sidekick_bash`)
- Read/write files on the remote VPS (`sidekick_read`, `sidekick_write`, `sidekick_list`)
- Access the web from a different IP (`sidekick_web_fetch`)
- Store data persistently between sessions (`sidekick_store`, `sidekick_get`)

The sidekick is always available - just use the tools directly. To invoke the @sidekick subagent explicitly, use `@sidekick` in your prompt.
