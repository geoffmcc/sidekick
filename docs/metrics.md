# Metrics And Dashboard Performance

Sidekick uses the existing InfluxDB and Grafana path. The minute collector
continues to write system, tool, database, service, container, and Ollama
measurements. Metrics are best-effort and never change the result of the
operation they observe.

Dashboard requests additionally maintain a bounded in-process RED projection at
`GET /api/dashboard-performance`. It reports request count, errors, active
requests, timeouts, aborted responses, response bytes, total latency, and
latency totals by normalized route template. Query strings, identifiers,
request bodies, filenames, prompts, secrets, and arbitrary exception text are
not metric labels. The endpoint is protected by the normal Dashboard
authentication and IP/CSRF middleware.

Static Dashboard assets use ETag validation and a short one-hour cache. HTML
remains revalidated so deployments do not require a cache purge. List APIs
bound tool statistics to 1,000 rows by default, cap explicit requests, and
support bounded server-side tool filtering.

The operational view should prefer the authenticated Sidekick API for current
health and task state. Grafana remains the historical visualization surface;
it is not used as a second source for data already available cheaply through
the API.
