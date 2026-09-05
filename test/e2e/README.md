# Dashboard E2E Journeys

These suites launch the production `src/dashboard.js` entrypoint and use the
served `src/dashboard.html` and `static/` assets in a real Chromium browser.
Each suite owns a temporary `SIDEKICK_DATA_DIR` and allocates its Dashboard,
Agent, and MCP ports dynamically on loopback. Failure output includes bounded
page text, service output, and a failure screenshot captured before cleanup.

The Agent journey starts a local Ollama-compatible HTTP fixture only at the
external inference boundary. It does not mock Dashboard routes, frontend
state, or Sidekick APIs.

Run directly with:

```text
node --test test/e2e/*.test.js
```

The e2e manifest already owns `test/e2e/**/*.test.{js,cjs,mjs}`, so adding a
journey file does not require a runner or resource-contract change.
