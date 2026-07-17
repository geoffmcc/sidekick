# Sidekick retrieval bake-off review

Source report: `C:\Users\geoff\Projects\sidekick\test\spike-openvino-python\sidekick-doc-retrieval-bakeoff\probe-results\sidekick-doc-bakeoff-report.json`

## Metric summary

| Retrieval path | Recall@1 | Recall@5 | Recall@10 | MRR | nDCG@10 |
|---|---:|---:|---:|---:|---:|
| E5 CPU | 0.460317 | 0.761905 | 0.809524 | 0.574966 | 0.540967 |
| Qwen NPU | 0.428571 | 0.761905 | 0.841270 | 0.569763 | 0.561243 |
| RRF fusion (top-10 union) | 0.460317 | 0.761905 | 0.888889 | 0.587169 | 0.586365 |
| Perfect-router upper bound | 0.539683 | 0.857143 | 0.904762 | 0.667788 | 0.503483 |

The perfect-router row is diagnostic only; it is not a deployable method.

## Disagreement review

Review whether the labeled relevant section is correct and whether either model returned a genuinely useful neighboring section. Large ranks can reflect label or chunk-boundary noise.

### blackbox_capture

**Query:** How do I capture a time-limited incident bundle with Sidekick?

**Labeled relevant IDs:** `docs:blackbox.md:black-box-incident-explorer-mcp-actions:1, docs:blackbox.md:black-box-incident-explorer-mcp-actions:2`

**Best labeled rank:** E5 `305`; Qwen `5`

#### E5 top results

1. `tool-usage-guide.md — Operations and diagnostics` (score 0.870583)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Operations and diagnostics Use `sidekick_status` for a compact system overview. Use `sidekick_health` for a scored health check. Use `sidekick_tail` for recent logs. Use `sidekick_ne
2. `tool-usage-guide.md — Automation` (score 0.868331)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Automation Use `sidekick_delay` for one-shot future actions. The Agent Bridge loads pending delays at startup and executes them at the scheduled time. Use `sidekick_watch` for recurr
3. `blackbox.md — Retention` (score 0.864392)
   Document: blackbox.md Section: Black Box Incident Explorer > Retention Environment settings include: `SIDEKICK_BLACKBOX_TTL_TRANSIENT_DAYS` `SIDEKICK_BLACKBOX_TTL_STANDARD_DAYS` `SIDEKICK_BLACKBOX_TTL_IMPORTANT_DAYS` `SIDEKICK_BLACKBOX_TTL_
4. `tools-reference.md — Full inventory` (score 0.862732)
   Document: tools-reference.md Section: Tools Reference > Full inventory Requires sidekick-redis service. | `{ action: "string (get|set|del|keys|ttl|info|flush)", key: "string (optional)", value: "string (optional)", ttl: "string (optional)",
5. `tools-reference.md — Full inventory` (score 0.860480)
   Document: tools-reference.md Section: Tools Reference > Full inventory | Workflow | Packaged Sidekick operations workflows for deploy verification, restart smoke tests, deployments, and incident snapshots. | `{ action: "string (verify_deplo

#### Qwen top results

1. `blackbox.md — Concepts` (score 0.576129)
   Document: blackbox.md Section: Black Box Incident Explorer > Concepts Incident: durable troubleshooting record with lifecycle, severity, tags, retention, summaries, and links. Capture: one collection event for an incident. Incidents can hav
2. `blackbox.md — Retention` (score 0.560366)
   Document: blackbox.md Section: Black Box Incident Explorer > Retention Environment settings include: `SIDEKICK_BLACKBOX_TTL_TRANSIENT_DAYS` `SIDEKICK_BLACKBOX_TTL_STANDARD_DAYS` `SIDEKICK_BLACKBOX_TTL_IMPORTANT_DAYS` `SIDEKICK_BLACKBOX_TTL_
3. `tool-usage-guide.md — Operations and diagnostics` (score 0.552541)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Operations and diagnostics Use `sidekick_status` for a compact system overview. Use `sidekick_health` for a scored health check. Use `sidekick_tail` for recent logs. Use `sidekick_ne
4. `overview.md — What Sidekick can do` (score 0.543735)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
5. `blackbox.md — MCP Actions` (score 0.542339) **[labeled relevant]**
   Document: blackbox.md Section: Black Box Incident Explorer > MCP Actions Structured actions include: `capture_status` `cancel_capture` `list_incidents` `get_incident` `list_captures` `get_capture` `list_sources` `get_source` `search` `compa

#### RRF fused top results

1. `tool-usage-guide.md — Operations and diagnostics` (RRF 0.03226646; E5 rank 1; Qwen rank 3)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Operations and diagnostics Use `sidekick_status` for a compact system overview. Use `sidekick_health` for a scored health check. Use `sidekick_tail` for recent logs. Use `sidekick_ne
2. `blackbox.md — Retention` (RRF 0.03200205; E5 rank 3; Qwen rank 2)
   Document: blackbox.md Section: Black Box Incident Explorer > Retention Environment settings include: `SIDEKICK_BLACKBOX_TTL_TRANSIENT_DAYS` `SIDEKICK_BLACKBOX_TTL_STANDARD_DAYS` `SIDEKICK_BLACKBOX_TTL_IMPORTANT_DAYS` `SIDEKICK_BLACKBOX_TTL_
3. `tool-usage-guide.md — Safe experimentation` (RRF 0.02877847; E5 rank 10; Qwen rank 9)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Safe experimentation Use `sidekick_sandbox` when a command may change files and you want automatic backup and rollback support. Use `sidekick_snapshot` before and after operational c
4. `blackbox.md — Concepts` (RRF 0.01639344; E5 rank None; Qwen rank 1)
   Document: blackbox.md Section: Black Box Incident Explorer > Concepts Incident: durable troubleshooting record with lifecycle, severity, tags, retention, summaries, and links. Capture: one collection event for an incident. Incidents can hav
5. `tool-usage-guide.md — Automation` (RRF 0.01612903; E5 rank 2; Qwen rank None)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Automation Use `sidekick_delay` for one-shot future actions. The Agent Bridge loads pending delays at startup and executes them at the scheduled time. Use `sidekick_watch` for recurr

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### database_query_safety

**Query:** What protections apply to database queries executed through Sidekick?

**Labeled relevant IDs:** `docs:security.md:security-database-query-safety:1`

**Best labeled rank:** E5 `262`; Qwen `14`

#### E5 top results

1. `technical-paper.md — 15. Security Model` (score 0.879429)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Core protections: MCP bearer token authentication. Optional MCP IP allowlist. Dashboard Basic Auth. Optional dashboard IP allowlist. C
2. `configuration.md — Security and tool policy` (score 0.875395)
   Document: configuration.md Section: Configuration > Security and tool policy env SIDEKICK_TOOL_POLICY=restricted SIDEKICK_AGENT_ALLOWED_TOOLS=sidekick_read,sidekick_search,sidekick_get,sidekick_respond SIDEKICK_BLOCKED_TOOLS=sidekick_db_res
3. `technical-paper.md — 15. Security Model` (score 0.875215)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Sidekick should be treated like remote shell access to the host. Its safety model is defense in depth, not a claim that powerful tools
4. `technical-paper.md — 9. Dashboard` (score 0.872027)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 9. Dashboard Dashboard protections include: optional Basic Auth; optional IP allowlist; in-memory rate limiting; JSON body size limit; same-origin checks
5. `security.md — Tool permission policy` (score 0.871790)
   Document: security.md Section: Security > Tool permission policy Sidekick now supports a config-driven tool policy. The default `SIDEKICK_TOOL_POLICY=open` preserves existing behavior: tools are allowed unless explicitly blocked. Set `SIDEK

#### Qwen top results

1. `README.md — Sidekick Documentation` (score 0.636596)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr
2. `platform-architecture-assessment.md — Current Storage Systems` (score 0.636399)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Current Storage Systems SQLite `sidekick.db` owns `meta`, `kv_store`, `json_documents`, `tool_logs`, generated capabilities, generated-tool e
3. `README.md — Agent Information Access` (score 0.625588)
   Document: README.md Section: Sidekick Documentation > Agent Information Access The database file is `SIDEKICK_DB_FILE` when set, otherwise `SIDEKICK_DATA_DIR/sidekick.db`. In the standard deployment that resolves to `/home/sidekick/sidekick
4. `configuration.md — Security and tool policy` (score 0.615981)
   Document: configuration.md Section: Configuration > Security and tool policy env SIDEKICK_TOOL_POLICY=restricted SIDEKICK_AGENT_ALLOWED_TOOLS=sidekick_read,sidekick_search,sidekick_get,sidekick_respond SIDEKICK_BLOCKED_TOOLS=sidekick_db_res
5. `security.md — Security` (score 0.614680)
   Document: security.md Section: Security Sidekick is powerful by design. It can execute commands, read and write files, manage services, store secrets, and call external APIs. Treat it like remote shell access to the host.

#### RRF fused top results

1. `configuration.md — Security and tool policy` (RRF 0.03175403; E5 rank 2; Qwen rank 4)
   Document: configuration.md Section: Configuration > Security and tool policy env SIDEKICK_TOOL_POLICY=restricted SIDEKICK_AGENT_ALLOWED_TOOLS=sidekick_read,sidekick_search,sidekick_get,sidekick_respond SIDEKICK_BLOCKED_TOOLS=sidekick_db_res
2. `technical-paper.md — 15. Security Model` (RRF 0.03154496; E5 rank 1; Qwen rank 6)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Core protections: MCP bearer token authentication. Optional MCP IP allowlist. Dashboard Basic Auth. Optional dashboard IP allowlist. C
3. `technical-paper.md — 15. Security Model` (RRF 0.03079839; E5 rank 3; Qwen rank 7)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Sidekick should be treated like remote shell access to the host. Its safety model is defense in depth, not a claim that powerful tools
4. `technical-paper.md — 18. Summary` (RRF 0.02899160; E5 rank 8; Qwen rank 10)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 18. Summary Sidekick's current architecture is best understood as a self-hosted agent platform with a centralized governed tool runtime, durable data and
5. `README.md — Sidekick Documentation` (RRF 0.01639344; E5 rank None; Qwen rank 1)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### memory_remaining_work

**Query:** What work remains for Sidekick memory intelligence?

**Labeled relevant IDs:** `docs:structured-memory-plan.md:structured-memory-and-memory-intelligence-status-remaining-logical-steps:1`

**Best labeled rank:** E5 `283`; Qwen `134`

#### E5 top results

1. `structured-memory-plan.md — Structured Memory And Memory Intelligence Status` (score 0.869365)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status Sidekick's automatic memory stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON doc
2. `configuration.md — Automatic Memory` (score 0.855990)
   Document: configuration.md Section: Configuration > Automatic Memory Automatic memory is enabled by default. Sidekick stores bounded, redacted summaries of useful tool calls and completed Agent Bridge tasks in the `memories` table, with com
3. `overview.md — What Sidekick can do` (score 0.853693)
   Document: overview.md Section: Overview > What Sidekick can do The current codebase includes tools for: shell, file, search, git, process, service, and archive operations; persistent key-value memory, explicit task sessions, handoffs, typed
4. `README.md — Sidekick Documentation` (score 0.847722)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr
5. `architecture.md — Dashboard: `src/dashboard.js`` (score 0.846507)
   Document: architecture.md Section: Architecture > Service boundaries > Dashboard: `src/dashboard.js` Memory shows what Sidekick learned from `memories`. The dashboard categorizes rows as durable, sessions, unresolved, or operational; existi

#### Qwen top results

1. `structured-memory-plan.md — Structured Memory And Memory Intelligence Status` (score 0.738466)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status Sidekick's automatic memory stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON doc
2. `configuration.md — Automatic Memory` (score 0.663916)
   Document: configuration.md Section: Configuration > Automatic Memory Automatic memory is enabled by default. Sidekick stores bounded, redacted summaries of useful tool calls and completed Agent Bridge tasks in the `memories` table, with com
3. `overview.md — What Sidekick can do` (score 0.650576)
   Document: overview.md Section: Overview > What Sidekick can do Sidekick is broad by design.
4. `overview.md — What Sidekick can do` (score 0.642320)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
5. `overview.md — Overview` (score 0.639912)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,

#### RRF fused top results

1. `structured-memory-plan.md — Structured Memory And Memory Intelligence Status` (RRF 0.03278689; E5 rank 1; Qwen rank 1)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status Sidekick's automatic memory stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON doc
2. `configuration.md — Automatic Memory` (RRF 0.03225806; E5 rank 2; Qwen rank 2)
   Document: configuration.md Section: Configuration > Automatic Memory Automatic memory is enabled by default. Sidekick stores bounded, redacted summaries of useful tool calls and completed Agent Bridge tasks in the `memories` table, with com
3. `overview.md — Overview` (RRF 0.03053613; E5 rank 6; Qwen rank 5)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
4. `overview.md — What Sidekick can do` (RRF 0.02991071; E5 rank 10; Qwen rank 4)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
5. `overview.md — Core idea` (RRF 0.02941176; E5 rank 8; Qwen rank 8)
   Document: overview.md Section: Overview > Core idea Sidekick does not replace the connected assistant or agent. It provides a persistent remote machine, governed MCP tools, durable context, and operational services. The companion `AGENTS.md

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### memory_types

**Query:** What structured memory types does Sidekick support?

**Labeled relevant IDs:** `docs:structured-memory-plan.md:structured-memory-and-memory-intelligence-status-memory-types:1`

**Best labeled rank:** E5 `169`; Qwen `29`

#### E5 top results

1. `structured-memory-plan.md — Structured Memory And Memory Intelligence Status` (score 0.895557)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status Sidekick's automatic memory stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON doc
2. `configuration.md — Automatic Memory` (score 0.894167)
   Document: configuration.md Section: Configuration > Automatic Memory Automatic memory is enabled by default. Sidekick stores bounded, redacted summaries of useful tool calls and completed Agent Bridge tasks in the `memories` table, with com
3. `overview.md — What Sidekick can do` (score 0.890593)
   Document: overview.md Section: Overview > What Sidekick can do The current codebase includes tools for: shell, file, search, git, process, service, and archive operations; persistent key-value memory, explicit task sessions, handoffs, typed
4. `structured-memory-plan.md — Implemented Scope` (score 0.879491)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status > Implemented Scope Add `sidekick_memory_export`, `sidekick_memory_import`, `sidekick_memory_manage`, `sidekick_sync_identity`, `sidekick_sync_exp
5. `configuration.md — Automatic Memory` (score 0.879252)
   Document: configuration.md Section: Configuration > Automatic Memory `sidekick_context` writes compatibility context entries such as decisions, problems, patterns, and `sess_...` sessions into the `context` document. Exact IDs can be recall

#### Qwen top results

1. `configuration.md — Automatic Memory` (score 0.718117)
   Document: configuration.md Section: Configuration > Automatic Memory `sidekick_context` writes compatibility context entries such as decisions, problems, patterns, and `sess_...` sessions into the `context` document. Exact IDs can be recall
2. `structured-memory-plan.md — Structured Memory And Memory Intelligence Status` (score 0.716458)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status Sidekick's automatic memory stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON doc
3. `structured-memory-plan.md — Implemented Scope` (score 0.694258)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status > Implemented Scope Add `sidekick_memory_export`, `sidekick_memory_import`, `sidekick_memory_manage`, `sidekick_sync_identity`, `sidekick_sync_exp
4. `configuration.md — Automatic Memory` (score 0.672445)
   Document: configuration.md Section: Configuration > Automatic Memory Set `SIDEKICK_AUTO_MEMORY=0` to disable automatic memory. Increase or decrease `SIDEKICK_AUTO_MEMORY_MAX` to control how many automatic memory entries are retained. Set `S
5. `tool-usage-guide.md — Persistent memory` (score 0.669072)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Persistent memory Semantic recall uses Ollama embeddings and Qdrant when available, and can be disabled with `SIDEKICK_EMBEDDINGS=0`. They are meant for continuity, not as complete r

#### RRF fused top results

1. `structured-memory-plan.md — Structured Memory And Memory Intelligence Status` (RRF 0.03252247; E5 rank 1; Qwen rank 2)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status Sidekick's automatic memory stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON doc
2. `configuration.md — Automatic Memory` (RRF 0.03177806; E5 rank 5; Qwen rank 1)
   Document: configuration.md Section: Configuration > Automatic Memory `sidekick_context` writes compatibility context entries such as decisions, problems, patterns, and `sess_...` sessions into the `context` document. Exact IDs can be recall
3. `structured-memory-plan.md — Implemented Scope` (RRF 0.03149802; E5 rank 4; Qwen rank 3)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status > Implemented Scope Add `sidekick_memory_export`, `sidekick_memory_import`, `sidekick_memory_manage`, `sidekick_sync_identity`, `sidekick_sync_exp
4. `configuration.md — Automatic Memory` (RRF 0.03128055; E5 rank 2; Qwen rank 6)
   Document: configuration.md Section: Configuration > Automatic Memory Automatic memory is enabled by default. Sidekick stores bounded, redacted summaries of useful tool calls and completed Agent Bridge tasks in the `memories` table, with com
5. `configuration.md — Automatic Memory` (RRF 0.03033088; E5 rank 8; Qwen rank 4)
   Document: configuration.md Section: Configuration > Automatic Memory Set `SIDEKICK_AUTO_MEMORY=0` to disable automatic memory. Increase or decrease `SIDEKICK_AUTO_MEMORY_MAX` to control how many automatic memory entries are retained. Set `S

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### workflow_engine

**Query:** How does Sidekick represent and execute durable multi-step workflows?

**Labeled relevant IDs:** `docs:architecture.md:architecture-service-boundaries-durable-workflow-engine-and-isolated-runner-sessions:1, docs:architecture.md:architecture-service-boundaries-durable-workflow-engine-and-isolated-runner-sessions:2, docs:architecture.md:architecture-service-boundaries-durable-workflow-engine-and-isolated-runner-sessions:3, docs:architecture.md:architecture-service-boundaries-durable-workflow-engine-and-isolated-runner-sessions:4`

**Best labeled rank:** E5 `133`; Qwen `31`

#### E5 top results

1. `overview.md — What Sidekick can do` (score 0.885497)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
2. `overview.md — What Sidekick can do` (score 0.881371)
   Document: overview.md Section: Overview > What Sidekick can do The current codebase includes tools for: shell, file, search, git, process, service, and archive operations; persistent key-value memory, explicit task sessions, handoffs, typed
3. `overview.md — Core idea` (score 0.881273)
   Document: overview.md Section: Overview > Core idea A normal workflow looks like this: A compatible client connects to the MCP server on port 4097. The client authenticates and discovers the allowed Sidekick tool catalog. Sidekick exposes i
4. `technical-paper.md — 1. Design Goals` (score 0.881176)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 1. Design Goals Sidekick is optimized for a trusted operator who wants an AI assistant to keep continuity across sessions and operate a remote machine. T
5. `tool-usage-guide.md — Automation` (score 0.880534)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Automation Use `sidekick_queue`, `sidekick_retry`, `sidekick_batch`, and `sidekick_orchestrate` to reduce repeated planning overhead and handle multi-step execution.

#### Qwen top results

1. `tool-usage-guide.md — Automation` (score 0.719996)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Automation Use `sidekick_queue`, `sidekick_retry`, `sidekick_batch`, and `sidekick_orchestrate` to reduce repeated planning overhead and handle multi-step execution.
2. `overview.md — Overview` (score 0.646426)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
3. `overview.md — What Sidekick can do` (score 0.643090)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
4. `overview.md — Core idea` (score 0.633558)
   Document: overview.md Section: Overview > Core idea Sidekick does not replace the connected assistant or agent. It provides a persistent remote machine, governed MCP tools, durable context, and operational services. The companion `AGENTS.md
5. `overview.md — What Sidekick can do` (score 0.621262)
   Document: overview.md Section: Overview > What Sidekick can do Sidekick is broad by design.

#### RRF fused top results

1. `overview.md — What Sidekick can do` (RRF 0.03226646; E5 rank 1; Qwen rank 3)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
2. `tool-usage-guide.md — Automation` (RRF 0.03177806; E5 rank 5; Qwen rank 1)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Automation Use `sidekick_queue`, `sidekick_retry`, `sidekick_batch`, and `sidekick_orchestrate` to reduce repeated planning overhead and handle multi-step execution.
3. `README.md — Sidekick Documentation` (RRF 0.02919864; E5 rank 9; Qwen rank 8)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr
4. `overview.md — What Sidekick can do` (RRF 0.01612903; E5 rank 2; Qwen rank None)
   Document: overview.md Section: Overview > What Sidekick can do The current codebase includes tools for: shell, file, search, git, process, service, and archive operations; persistent key-value memory, explicit task sessions, handoffs, typed
5. `overview.md — Overview` (RRF 0.01612903; E5 rank None; Qwen rank 2)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### sqlite_schema

**Query:** What important data is stored in the Sidekick SQLite schema?

**Labeled relevant IDs:** `docs:data-model.md:data-model-sqlite-schema:1, docs:data-model.md:data-model-sqlite-schema:2, docs:data-model.md:data-model-sqlite-schema:3`

**Best labeled rank:** E5 `122`; Qwen `21`

#### E5 top results

1. `architecture.md — Shared storage` (score 0.903560)
   Document: architecture.md Section: Architecture > Shared storage All services use the same `SIDEKICK_DATA_DIR`. By default, this is `data/` relative to the project during local development, and `/home/sidekick/sidekick/data` in the example 
2. `data-model.md — Data Model` (score 0.903169)
   Document: data-model.md Section: Data Model Sidekick stores core persistent state in SQLite (`sidekick.db`) under `SIDEKICK_DATA_DIR`. Some feature-specific state still uses JSON/JSONL files where file artifacts are simpler or intentionally
3. `platform-architecture-assessment.md — Current Storage Systems` (score 0.888063)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Current Storage Systems SQLite `sidekick.db` owns `meta`, `kv_store`, `json_documents`, `tool_logs`, generated capabilities, generated-tool e
4. `data-model.md — Storage backends` (score 0.887314)
   Document: data-model.md Section: Data Model > Storage backends | `sidekick.db` (SQLite) | Primary database: KV store, structured memories, tool logs, named JSON documents, tool registry, tool categories, knowledge base, schema metadata. | |
5. `README.md — Agent Information Access` (score 0.883901)
   Document: README.md Section: Sidekick Documentation > Agent Information Access The database file is `SIDEKICK_DB_FILE` when set, otherwise `SIDEKICK_DATA_DIR/sidekick.db`. In the standard deployment that resolves to `/home/sidekick/sidekick

#### Qwen top results

1. `platform-architecture-assessment.md — Current Storage Systems` (score 0.751687)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Current Storage Systems SQLite `sidekick.db` owns `meta`, `kv_store`, `json_documents`, `tool_logs`, generated capabilities, generated-tool e
2. `data-model.md — Data Model` (score 0.751026)
   Document: data-model.md Section: Data Model Sidekick stores core persistent state in SQLite (`sidekick.db`) under `SIDEKICK_DATA_DIR`. Some feature-specific state still uses JSON/JSONL files where file artifacts are simpler or intentionally
3. `data-model.md — Storage backends` (score 0.718671)
   Document: data-model.md Section: Data Model > Storage backends | `sidekick.db` (SQLite) | Primary database: KV store, structured memories, tool logs, named JSON documents, tool registry, tool categories, knowledge base, schema metadata. | |
4. `data-model.md — KV store (SQLite)` (score 0.703138)
   Document: data-model.md Section: Data Model > KV store (SQLite) json { "value": "some value", "project": "sidekick", "category": "config", "source": "mcp", "created": "2026-06-13T00:00:00.000Z", "updated": "2026-06-13T00:00:00.000Z" }
5. `README.md — Sidekick Documentation` (score 0.697088)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr

#### RRF fused top results

1. `platform-architecture-assessment.md — Current Storage Systems` (RRF 0.03226646; E5 rank 3; Qwen rank 1)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Current Storage Systems SQLite `sidekick.db` owns `meta`, `kv_store`, `json_documents`, `tool_logs`, generated capabilities, generated-tool e
2. `data-model.md — Data Model` (RRF 0.03225806; E5 rank 2; Qwen rank 2)
   Document: data-model.md Section: Data Model Sidekick stores core persistent state in SQLite (`sidekick.db`) under `SIDEKICK_DATA_DIR`. Some feature-specific state still uses JSON/JSONL files where file artifacts are simpler or intentionally
3. `data-model.md — Storage backends` (RRF 0.03149802; E5 rank 4; Qwen rank 3)
   Document: data-model.md Section: Data Model > Storage backends | `sidekick.db` (SQLite) | Primary database: KV store, structured memories, tool logs, named JSON documents, tool registry, tool categories, knowledge base, schema metadata. | |
4. `architecture.md — Shared storage` (RRF 0.03067916; E5 rank 1; Qwen rank 10)
   Document: architecture.md Section: Architecture > Shared storage All services use the same `SIDEKICK_DATA_DIR`. By default, this is `data/` relative to the project during local development, and `/home/sidekick/sidekick/data` in the example 
5. `README.md — Agent Information Access` (RRF 0.03053613; E5 rank 5; Qwen rank 6)
   Document: README.md Section: Sidekick Documentation > Agent Information Access The database file is `SIDEKICK_DB_FILE` when set, otherwise `SIDEKICK_DATA_DIR/sidekick.db`. In the standard deployment that resolves to `/home/sidekick/sidekick

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### redaction

**Query:** How does Sidekick redact secrets from logs and returned output?

**Labeled relevant IDs:** `docs:security.md:security-redaction:1`

**Best labeled rank:** E5 `63`; Qwen `3`

#### E5 top results

1. `technical-paper.md — `tool_logs`` (score 0.880181)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 6. Core Tables > `tool_logs` `tool_logs` stores redacted activity entries for tool calls. Each row records timestamp, tool name, argument summary, durati
2. `operations.md — Backups` (score 0.869031)
   Document: operations.md Section: Operations > Backups Back up `SIDEKICK_DATA_DIR`. A simple backup: bash tar -czf sidekick-data-$(date +%F).tar.gz -C /home/sidekick/sidekick data For systemd deployments, also back up `.env`, but store it se
3. `configuration.md — Security and tool policy` (score 0.866918)
   Document: configuration.md Section: Configuration > Security and tool policy env SIDEKICK_TOOL_POLICY=restricted SIDEKICK_AGENT_ALLOWED_TOOLS=sidekick_read,sidekick_search,sidekick_get,sidekick_respond SIDEKICK_BLOCKED_TOOLS=sidekick_db_res
4. `project-review.md — Tool recommendations` (score 0.865753)
   Document: project-review.md Section: Project Review > Tool recommendations `sidekick_fs_guard` or a shared path guard used by file-capable tools. `sidekick_approval_queue` for queued high-risk actions that require dashboard approval. `sidek
5. `security.md — Secret storage` (score 0.865542)
   Document: security.md Section: Security > Secret storage `sidekick_secret` provides AES-256-GCM encrypted credential management and requires `SIDEKICK_SECRET_KEY`. Store the secret key outside the repository and include it in your host secr

#### Qwen top results

1. `security.md — Security` (score 0.683913)
   Document: security.md Section: Security Sidekick is powerful by design. It can execute commands, read and write files, manage services, store secrets, and call external APIs. Treat it like remote shell access to the host.
2. `overview.md — What Sidekick can do` (score 0.666043)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
3. `security.md — Redaction` (score 0.626382) **[labeled relevant]**
   Document: security.md Section: Security > Redaction `src/redact.js` redacts sensitive output patterns before data is returned or logged. The tests cover private keys, GitHub tokens, and other secret-like values. Redaction reduces accidental
4. `tool-usage-guide.md — Safe experimentation` (score 0.614480)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Safe experimentation Use `sidekick_sandbox` when a command may change files and you want automatic backup and rollback support. Use `sidekick_snapshot` before and after operational c
5. `overview.md — Overview` (score 0.613476)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,

#### RRF fused top results

1. `overview.md — What Sidekick can do` (RRF 0.03128055; E5 rank 6; Qwen rank 2)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
2. `configuration.md — Security and tool policy` (RRF 0.03102453; E5 rank 3; Qwen rank 6)
   Document: configuration.md Section: Configuration > Security and tool policy env SIDEKICK_TOOL_POLICY=restricted SIDEKICK_AGENT_ALLOWED_TOOLS=sidekick_read,sidekick_search,sidekick_get,sidekick_respond SIDEKICK_BLOCKED_TOOLS=sidekick_db_res
3. `technical-paper.md — `tool_logs`` (RRF 0.01639344; E5 rank 1; Qwen rank None)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 6. Core Tables > `tool_logs` `tool_logs` stores redacted activity entries for tool calls. Each row records timestamp, tool name, argument summary, durati
4. `security.md — Security` (RRF 0.01639344; E5 rank None; Qwen rank 1)
   Document: security.md Section: Security Sidekick is powerful by design. It can execute commands, read and write files, manage services, store secrets, and call external APIs. Treat it like remote shell access to the host.
5. `operations.md — Backups` (RRF 0.01612903; E5 rank 2; Qwen rank None)
   Document: operations.md Section: Operations > Backups Back up `SIDEKICK_DATA_DIR`. A simple backup: bash tar -czf sidekick-data-$(date +%F).tar.gz -C /home/sidekick/sidekick data For systemd deployments, also back up `.env`, but store it se

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### development_safety

**Query:** What implementation safety practices should tool developers follow?

**Labeled relevant IDs:** `docs:development.md:development-implementation-notes:1, docs:development.md:development-implementation-notes:2`

**Best labeled rank:** E5 `5`; Qwen `62`

#### E5 top results

1. `project-review.md — Highest-priority follow-ups` (score 0.852653)
   Document: project-review.md Section: Project Review > Highest-priority follow-ups This makes onboarding clearer and lets clients select only the tier they need. Add audit context for high-risk calls. Tool logs should include source, authent
2. `platform-architecture-assessment.md — Threat Model Summary` (score 0.849953)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Threat Model Summary Current mitigations: non-placeholder API key checks, dashboard auth/rate limit/CSRF, redaction, dangerous shell pattern 
3. `project-review.md — Highest-priority follow-ups` (score 0.849926)
   Document: project-review.md Section: Project Review > Highest-priority follow-ups `sidekick_cron`, `sidekick_delay`, and `sidekick_watch` can persist tool execution beyond the current user session. The new policy can block these tools; the 
4. `tool-architecture.md — Risk Behavior` (score 0.848843)
   Document: tool-architecture.md Section: Tool Architecture > Risk Behavior Built-in descriptors must have explicit risk metadata. Missing built-in risk metadata fails registry construction. Generated tools are untrusted runtime data. Missing
5. `development.md — Implementation notes` (score 0.847614) **[labeled relevant]**
   Document: development.md Section: Development > Implementation notes Avoid undocumented environment variables; add them to `.env.example` and `configuration.md`. Keep dashboard endpoints consistent with audit logging and CSRF checks when mu

#### Qwen top results

1. `tools-reference.md — Risk classification` (score 0.527959)
   Document: tools-reference.md Section: Tools Reference > Risk classification Risk is based on what a tool can change or expose, not whether its implementation is currently safe. | Risk | Tools | Default recommendation | | Critical | `bash`, 
2. `security.md — Tool permission policy` (score 0.526535)
   Document: security.md Section: Security > Tool permission policy High and critical tools are not removed from the project because trusted operators need them. For internet-reachable or shared deployments, run the agent and MCP source in `re
3. `tool-creation.md — Quick Reference` (score 0.526439)
   Document: tool-creation.md Section: Tool Creation Guide > Quick Reference **Files to edit (in order):** `src/tools.js` - implementation + TOOLS export + TOOL_DEFS entry `src/index.js` - TOOL_SCHEMAS Zod schema `src/tools.js` - TOOL_CATEGORI
4. `architecture.md — Evolve and dynamic tools` (score 0.506115)
   Document: architecture.md Section: Architecture > Service boundaries > Evolve and dynamic tools The Evolve implementation is intentionally split out of the large tool module: `src/evolve/analyzer.js` restores chronological log order, segmen
5. `project-review.md — Tool recommendations` (score 0.502711)
   Document: project-review.md Section: Project Review > Tool recommendations Gate by policy rather than deleting: `sidekick_bash`, `sidekick_write`, `sidekick_db_restore`, `sidekick_runbook`, `sidekick_ops`, `sidekick_sandbox`, `sidekick_evol

#### RRF fused top results

1. `tool-architecture.md — Risk Behavior` (RRF 0.03055037; E5 rank 4; Qwen rank 7)
   Document: tool-architecture.md Section: Tool Architecture > Risk Behavior Built-in descriptors must have explicit risk metadata. Missing built-in risk metadata fails registry construction. Generated tools are untrusted runtime data. Missing
2. `project-review.md — Highest-priority follow-ups` (RRF 0.01639344; E5 rank 1; Qwen rank None)
   Document: project-review.md Section: Project Review > Highest-priority follow-ups This makes onboarding clearer and lets clients select only the tier they need. Add audit context for high-risk calls. Tool logs should include source, authent
3. `tools-reference.md — Risk classification` (RRF 0.01639344; E5 rank None; Qwen rank 1)
   Document: tools-reference.md Section: Tools Reference > Risk classification Risk is based on what a tool can change or expose, not whether its implementation is currently safe. | Risk | Tools | Default recommendation | | Critical | `bash`, 
4. `platform-architecture-assessment.md — Threat Model Summary` (RRF 0.01612903; E5 rank 2; Qwen rank None)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Threat Model Summary Current mitigations: non-placeholder API key checks, dashboard auth/rate limit/CSRF, redaction, dangerous shell pattern 
5. `security.md — Tool permission policy` (RRF 0.01612903; E5 rank None; Qwen rank 2)
   Document: security.md Section: Security > Tool permission policy High and critical tools are not removed from the project because trusted operators need them. For internet-reachable or shared deployments, run the agent and MCP source in `re

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### predict_confidence

**Query:** How does Sidekick assign confidence to predictions?

**Labeled relevant IDs:** `docs:predict.md:predict-confidence:1`

**Best labeled rank:** E5 `52`; Qwen `3`

#### E5 top results

1. `predict.md — Predict` (score 0.901456)
   Document: predict.md Section: Predict Predict is Sidekick's evidence-backed decision-support engine. It suggests likely next actions, failure risks, missing prerequisites, relevant context, incident recurrence, and workflow automation oppor
2. `project-review.md — Product direction` (score 0.861857)
   Document: project-review.md Section: Project Review > Product direction That framing makes the security model clearer: Sidekick is not a generic chatbot. It is remote administrative capability with an AI interface.
3. `platform-architecture-assessment.md — Confirmed Suspected Issues` (score 0.855671)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Confirmed Suspected Issues Model use is governed by environment variables and prompt code, not a model registry, budgets, evaluation gates, o
4. `technical-paper.md — 1. Design Goals` (score 0.855391)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 1. Design Goals Sidekick is optimized for a trusted operator who wants an AI assistant to keep continuity across sessions and operate a remote machine. T
5. `overview.md — What Sidekick can do` (score 0.854134)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel

#### Qwen top results

1. `predict.md — Predict` (score 0.717262)
   Document: predict.md Section: Predict Predict is Sidekick's evidence-backed decision-support engine. It suggests likely next actions, failure risks, missing prerequisites, relevant context, incident recurrence, and workflow automation oppor
2. `overview.md — What Sidekick can do` (score 0.628891)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
3. `predict.md — Confidence` (score 0.617984) **[labeled relevant]**
   Document: predict.md Section: Predict > Confidence Confidence is based on evidence quantity and score thresholds. Sparse evidence remains `low` or `medium`; `high` and `very_high` require larger sample sizes. A successful prediction record 
4. `tool-usage-guide.md — LLM tools` (score 0.600414)
   Document: tool-usage-guide.md Section: Tool Usage Guide > LLM tools Use `sidekick_llm` for direct model calls. Use `sidekick_fresheyes` when the main assistant wants an independent second look at a problem using Sidekick's configured LLM.
5. `predict.md — Evidence Sources` (score 0.596049)
   Document: predict.md Section: Predict > Evidence Sources Predict analyzes bounded local Sidekick data: recent tool logs structured memories handoffs incidents workflow and generated-tool records Operational telemetry is treated as evidence,

#### RRF fused top results

1. `predict.md — Predict` (RRF 0.03278689; E5 rank 1; Qwen rank 1)
   Document: predict.md Section: Predict Predict is Sidekick's evidence-backed decision-support engine. It suggests likely next actions, failure risks, missing prerequisites, relevant context, incident recurrence, and workflow automation oppor
2. `overview.md — What Sidekick can do` (RRF 0.03151365; E5 rank 5; Qwen rank 2)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
3. `predict.md — Evidence Sources` (RRF 0.03030999; E5 rank 7; Qwen rank 5)
   Document: predict.md Section: Predict > Evidence Sources Predict analyzes bounded local Sidekick data: recent tool logs structured memories handoffs incidents workflow and generated-tool records Operational telemetry is treated as evidence,
4. `project-review.md — Product direction` (RRF 0.01612903; E5 rank 2; Qwen rank None)
   Document: project-review.md Section: Project Review > Product direction That framing makes the security model clearer: Sidekick is not a generic chatbot. It is remote administrative capability with an AI interface.
5. `platform-architecture-assessment.md — Confirmed Suspected Issues` (RRF 0.01587302; E5 rank 3; Qwen rank None)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Confirmed Suspected Issues Model use is governed by environment variables and prompt code, not a model registry, budgets, evaluation gates, o

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### health_checks

**Query:** How do I check whether the Sidekick services are healthy?

**Labeled relevant IDs:** `docs:operations.md:operations-health-checks:1`

**Best labeled rank:** E5 `168`; Qwen `126`

#### E5 top results

1. `tool-usage-guide.md — Operations and diagnostics` (score 0.894508)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Operations and diagnostics Use `sidekick_status` for a compact system overview. Use `sidekick_health` for a scored health check. Use `sidekick_tail` for recent logs. Use `sidekick_ne
2. `service.md — Check Status` (score 0.879808)
   Document: service.md Section: Service Management > Check Status bash sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent
3. `operations.md — Packaged operations workflows` (score 0.873377)
   Document: operations.md Section: Operations > Packaged operations workflows `restart_and_smoke_test`: restarts `sidekick-dashboard` and `sidekick-agent`, checks MCP health, and optionally schedules an MCP restart with `restart_mcp: true`.
4. `operations.md — Packaged operations workflows` (score 0.870821)
   Document: operations.md Section: Operations > Packaged operations workflows Use `sidekick_ops` when you need a compact verdict instead of separate raw tool outputs. Available actions: `verify_deployed_commit`: confirms the fixed Sidekick ho
5. `README.md — Documentation map` (score 0.867073)
   Document: README.md Section: Sidekick Documentation > Documentation map Day-to-day service commands, health checks, troubleshooting, backups, and maintenance. | | `development.md` | Source layout, testing, extension workflow, and implementa

#### Qwen top results

1. `tool-usage-guide.md — Operations and diagnostics` (score 0.782072)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Operations and diagnostics Use `sidekick_status` for a compact system overview. Use `sidekick_health` for a scored health check. Use `sidekick_tail` for recent logs. Use `sidekick_ne
2. `service.md — Check Status` (score 0.719919)
   Document: service.md Section: Service Management > Check Status bash sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent
3. `overview.md — What Sidekick can do` (score 0.689251)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
4. `README.md — Runtime services` (score 0.677362)
   Document: README.md Section: Sidekick Documentation > Runtime services | Service | Default port | Entry point | Purpose |
5. `overview.md — Overview` (score 0.673002)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,

#### RRF fused top results

1. `tool-usage-guide.md — Operations and diagnostics` (RRF 0.03278689; E5 rank 1; Qwen rank 1)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Operations and diagnostics Use `sidekick_status` for a compact system overview. Use `sidekick_health` for a scored health check. Use `sidekick_tail` for recent logs. Use `sidekick_ne
2. `service.md — Check Status` (RRF 0.03225806; E5 rank 2; Qwen rank 2)
   Document: service.md Section: Service Management > Check Status bash sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent
3. `README.md — Documentation map` (RRF 0.03009050; E5 rank 5; Qwen rank 8)
   Document: README.md Section: Sidekick Documentation > Documentation map Day-to-day service commands, health checks, troubleshooting, backups, and maintenance. | | `development.md` | Source layout, testing, extension workflow, and implementa
4. `operations.md — Packaged operations workflows` (RRF 0.01587302; E5 rank 3; Qwen rank None)
   Document: operations.md Section: Operations > Packaged operations workflows `restart_and_smoke_test`: restarts `sidekick-dashboard` and `sidekick-agent`, checks MCP health, and optionally schedules an MCP restart with `restart_mcp: true`.
5. `overview.md — What Sidekick can do` (RRF 0.01587302; E5 rank None; Qwen rank 3)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### agent_safety_limits

**Query:** What prevents the Agent Bridge from looping forever?

**Labeled relevant IDs:** `docs:agent-bridge.md:agent-bridge-safety-limits:1`

**Best labeled rank:** E5 `2`; Qwen `30`

#### E5 top results

1. `architecture.md — Agent Bridge: `src/agent.js`` (score 0.868947)
   Document: architecture.md Section: Architecture > Service boundaries > Agent Bridge: `src/agent.js` The agent has a loop limit controlled by `SIDEKICK_MAX_ITERATIONS` and stores transcripts under `data/conversations/`. Before planning it bu
2. `agent-bridge.md — Safety limits` (score 0.860358) **[labeled relevant]**
   Document: agent-bridge.md Section: Agent Bridge > Safety limits The main safety control is `SIDEKICK_MAX_ITERATIONS`, which defaults to 15. Tool-level safety still applies: dangerous shell commands are blocked by pattern checks, output reda
3. `agent-bridge.md — Agent Bridge` (score 0.854192)
   Document: agent-bridge.md Section: Agent Bridge The Agent Bridge is implemented in `src/agent.js` and defaults to port 4099. It runs autonomous tasks outside the main opencode session.
4. `technical-paper.md — 10. Agent Bridge` (score 0.849456)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 10. Agent Bridge `src/agent.js` runs an autonomous goal loop. It is intentionally bound to `127.0.0.1` by default and is meant to be reached through the 
5. `technical-paper.md — 10. Agent Bridge` (score 0.845950)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 10. Agent Bridge Current LLM behavior in `agent.js` is code-truth specific: The agent tries local Ollama first. If Ollama fails and `GROQ_API_KEY` is set

#### Qwen top results

1. `agent-bridge.md — Agent Bridge` (score 0.777276)
   Document: agent-bridge.md Section: Agent Bridge The Agent Bridge is implemented in `src/agent.js` and defaults to port 4099. It runs autonomous tasks outside the main opencode session.
2. `technical-paper.md — 10. Agent Bridge` (score 0.702436)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 10. Agent Bridge `src/agent.js` runs an autonomous goal loop. It is intentionally bound to `127.0.0.1` by default and is meant to be reached through the 
3. `platform-architecture-assessment.md — Trust, Privilege, And Authentication Boundaries` (score 0.669935)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Trust, Privilege, And Authentication Boundaries Agent Bridge is a separate HTTP service and directly imports `callTool` plus allowed tool def
4. `architecture.md — Agent Bridge: `src/agent.js`` (score 0.661354)
   Document: architecture.md Section: Architecture > Service boundaries > Agent Bridge: `src/agent.js` The Agent Bridge accepts high-level task requests, builds a task transcript, repeatedly chooses tool calls, executes them through `callTool`
5. `platform-architecture-assessment.md — Current Process Boundaries` (score 0.661341)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Current Process Boundaries Agent Bridge: `src/agent.js` accepts task goals, runs a local planning loop, calls `callTool`, stores transcripts,

#### RRF fused top results

1. `agent-bridge.md — Agent Bridge` (RRF 0.03226646; E5 rank 3; Qwen rank 1)
   Document: agent-bridge.md Section: Agent Bridge The Agent Bridge is implemented in `src/agent.js` and defaults to port 4099. It runs autonomous tasks outside the main opencode session.
2. `technical-paper.md — 10. Agent Bridge` (RRF 0.03175403; E5 rank 4; Qwen rank 2)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 10. Agent Bridge `src/agent.js` runs an autonomous goal loop. It is intentionally bound to `127.0.0.1` by default and is meant to be reached through the 
3. `architecture.md — Agent Bridge: `src/agent.js`` (RRF 0.03154496; E5 rank 1; Qwen rank 6)
   Document: architecture.md Section: Architecture > Service boundaries > Agent Bridge: `src/agent.js` The agent has a loop limit controlled by `SIDEKICK_MAX_ITERATIONS` and stores transcripts under `data/conversations/`. Before planning it bu
4. `architecture.md — Agent Bridge: `src/agent.js`` (RRF 0.03077652; E5 rank 6; Qwen rank 4)
   Document: architecture.md Section: Architecture > Service boundaries > Agent Bridge: `src/agent.js` The Agent Bridge accepts high-level task requests, builds a task transcript, repeatedly chooses tool calls, executes them through `callTool`
5. `agent-bridge.md — Task lifecycle` (RRF 0.02941813; E5 rank 9; Qwen rank 7)
   Document: agent-bridge.md Section: Agent Bridge > Task lifecycle A client submits a task to `POST /api/agent/run`. The bridge creates a task ID and transcript file. The agent loops until the goal is complete, fails, or reaches `SIDEKICK_MAX

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### memory_conflicts

**Query:** How does Sidekick detect conflicting memories and supersede old facts?

**Labeled relevant IDs:** `docs:data-model.md:data-model-structured-memory-conflict-detection-and-supersession:1, docs:data-model.md:data-model-structured-memory-conflict-detection-and-supersession:2`

**Best labeled rank:** E5 `27`; Qwen `3`

#### E5 top results

1. `tool-usage-guide.md — Persistent memory` (score 0.866964)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Persistent memory It also extracts simple `fact`, `decision`, `preference`, and `open_thread` memories when task text is explicit enough. These automatic memories are stored primaril
2. `technical-paper.md — `memories`` (score 0.866481)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 6. Core Tables > `memories` The extraction pass can also emit `fact`, `decision`, `preference`, `open_thread`, and `observation` rows from agent task tex
3. `overview.md — What Sidekick can do` (score 0.865356)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
4. `structured-memory-plan.md — Structured Memory And Memory Intelligence Status` (score 0.865176)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status Sidekick's automatic memory stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON doc
5. `technical-paper.md — `memories`` (score 0.863714)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 6. Core Tables > `memories` High-value memories can require confirmation, memories can be soft-deleted, expired, restored, exported/imported, and synced 

#### Qwen top results

1. `structured-memory-plan.md — Structured Memory And Memory Intelligence Status` (score 0.656430)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status Sidekick's automatic memory stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON doc
2. `configuration.md — Automatic Memory` (score 0.610086)
   Document: configuration.md Section: Configuration > Automatic Memory `sidekick_context` writes compatibility context entries such as decisions, problems, patterns, and `sess_...` sessions into the `context` document. Exact IDs can be recall
3. `data-model.md — Conflict Detection and Supersession` (score 0.607957) **[labeled relevant]**
   Document: data-model.md Section: Data Model > Structured memory > Conflict Detection and Supersession When a new `fact`, `decision`, `preference`, `procedure`, `open_thread`, or `observation` memory is similar enough to an existing active r
4. `configuration.md — Automatic Memory` (score 0.606956)
   Document: configuration.md Section: Configuration > Automatic Memory Automatic memory is enabled by default. Sidekick stores bounded, redacted summaries of useful tool calls and completed Agent Bridge tasks in the `memories` table, with com
5. `technical-paper.md — `memories`` (score 0.597112)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 6. Core Tables > `memories` High-value memories can require confirmation, memories can be soft-deleted, expired, restored, exported/imported, and synced 

#### RRF fused top results

1. `structured-memory-plan.md — Structured Memory And Memory Intelligence Status` (RRF 0.03201844; E5 rank 4; Qwen rank 1)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status Sidekick's automatic memory stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON doc
2. `tool-usage-guide.md — Persistent memory` (RRF 0.03109932; E5 rank 1; Qwen rank 8)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Persistent memory It also extracts simple `fact`, `decision`, `preference`, and `open_thread` memories when task text is explicit enough. These automatic memories are stored primaril
3. `configuration.md — Automatic Memory` (RRF 0.03105441; E5 rank 7; Qwen rank 2)
   Document: configuration.md Section: Configuration > Automatic Memory `sidekick_context` writes compatibility context entries such as decisions, problems, patterns, and `sess_...` sessions into the `context` document. Exact IDs can be recall
4. `technical-paper.md — `memories`` (RRF 0.03076923; E5 rank 5; Qwen rank 5)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 6. Core Tables > `memories` High-value memories can require confirmation, memories can be soft-deleted, expired, restored, exported/imported, and synced 
5. `configuration.md — Automatic Memory` (RRF 0.03033088; E5 rank 8; Qwen rank 4)
   Document: configuration.md Section: Configuration > Automatic Memory Automatic memory is enabled by default. Sidekick stores bounded, redacted summaries of useful tool calls and completed Agent Bridge tasks in the `memories` table, with com

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### main_components

**Query:** What services and major components make up Sidekick?

**Labeled relevant IDs:** `docs:overview.md:overview-main-components:1, docs:overview.md:overview-main-components:2, docs:overview.md:overview-main-components:3`

**Best labeled rank:** E5 `23`; Qwen `9`

#### E5 top results

1. `overview.md — What Sidekick can do` (score 0.883121)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
2. `technical-paper.md — 2. Runtime Components` (score 0.880532)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 2. Runtime Components Sidekick runs as three primary Node.js services: | Service | Entry point | Default bind | Role |
3. `overview.md — Overview` (score 0.879517)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
4. `overview.md — What Sidekick can do` (score 0.876816)
   Document: overview.md Section: Overview > What Sidekick can do The current codebase includes tools for: shell, file, search, git, process, service, and archive operations; persistent key-value memory, explicit task sessions, handoffs, typed
5. `README.md — Sidekick Documentation` (score 0.873031)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr

#### Qwen top results

1. `overview.md — What Sidekick can do` (score 0.735211)
   Document: overview.md Section: Overview > What Sidekick can do Sidekick is broad by design.
2. `overview.md — Overview` (score 0.721845)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
3. `overview.md — Core idea` (score 0.683575)
   Document: overview.md Section: Overview > Core idea Sidekick does not replace the connected assistant or agent. It provides a persistent remote machine, governed MCP tools, durable context, and operational services. The companion `AGENTS.md
4. `security.md — Security` (score 0.676167)
   Document: security.md Section: Security Sidekick is powerful by design. It can execute commands, read and write files, manage services, store secrets, and call external APIs. Treat it like remote shell access to the host.
5. `README.md — Sidekick Documentation` (score 0.675713)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr

#### RRF fused top results

1. `overview.md — Overview` (RRF 0.03200205; E5 rank 3; Qwen rank 2)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
2. `technical-paper.md — 2. Runtime Components` (RRF 0.03105441; E5 rank 2; Qwen rank 7)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 2. Runtime Components Sidekick runs as three primary Node.js services: | Service | Entry point | Default bind | Role |
3. `README.md — Sidekick Documentation` (RRF 0.03076923; E5 rank 5; Qwen rank 5)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr
4. `overview.md — What Sidekick can do` (RRF 0.03067916; E5 rank 1; Qwen rank 10)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
5. `security.md — Security` (RRF 0.02991071; E5 rank 10; Qwen rank 4)
   Document: security.md Section: Security Sidekick is powerful by design. It can execute commands, read and write files, manage services, store secrets, and call external APIs. Treat it like remote shell access to the host.

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### agent_information_access

**Query:** Where should an agent look for authoritative Sidekick operational knowledge?

**Labeled relevant IDs:** `docs:README.md:sidekick-documentation-agent-information-access:1, docs:README.md:sidekick-documentation-agent-information-access:2, docs:README.md:sidekick-documentation-agent-information-access:3, docs:README.md:sidekick-documentation-agent-information-access:4, docs:README.md:sidekick-documentation-agent-information-access:5, docs:README.md:sidekick-documentation-agent-information-access:6`

**Best labeled rank:** E5 `2`; Qwen `15`

#### E5 top results

1. `data-model.md — Knowledge base` (score 0.874331)
   Document: data-model.md Section: Data Model > Knowledge base The `knowledge` table is the documentation store for Sidekick's agent-facing operational knowledge. `sidekick_knowledge` supports `search`, `get`, `list`, `add`, `update`, and `de
2. `README.md — Agent Information Access` (score 0.864358) **[labeled relevant]**
   Document: README.md Section: Sidekick Documentation > Agent Information Access The important runtime pattern is database-first access. `AGENTS.md` is the thin instruction layer that tells agents where to look; the authoritative operational 
3. `technical-paper.md — 15. Security Model` (score 0.861019)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Sidekick should be treated like remote shell access to the host. Its safety model is defense in depth, not a claim that powerful tools
4. `technical-paper.md — `knowledge`` (score 0.859589)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 6. Core Tables > `knowledge` `knowledge` stores documentation and operational knowledge. Each entry has category, title, content, tags, enabled status, v
5. `technical-paper.md — 18. Summary` (score 0.859570)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 18. Summary Sidekick's current architecture is best understood as a self-hosted agent platform with a centralized governed tool runtime, durable data and

#### Qwen top results

1. `overview.md — Overview` (score 0.701514)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
2. `tool-creation.md — Resources` (score 0.667555)
   Document: tool-creation.md Section: Tool Creation Guide > Resources For agent-facing procedures and documentation, prefer `sidekick_knowledge` entries over large markdown excerpts in prompts. See `docs/development.md` for project structure 
3. `overview.md — Core idea` (score 0.662949)
   Document: overview.md Section: Overview > Core idea Sidekick does not replace the connected assistant or agent. It provides a persistent remote machine, governed MCP tools, durable context, and operational services. The companion `AGENTS.md
4. `README.md — Documentation map` (score 0.662785)
   Document: README.md Section: Sidekick Documentation > Documentation map Day-to-day service commands, health checks, troubleshooting, backups, and maintenance. | | `development.md` | Source layout, testing, extension workflow, and implementa
5. `data-model.md — Knowledge base` (score 0.660440)
   Document: data-model.md Section: Data Model > Knowledge base The `knowledge` table is the documentation store for Sidekick's agent-facing operational knowledge. `sidekick_knowledge` supports `search`, `get`, `list`, `add`, `update`, and `de

#### RRF fused top results

1. `data-model.md — Knowledge base` (RRF 0.03177806; E5 rank 1; Qwen rank 5)
   Document: data-model.md Section: Data Model > Knowledge base The `knowledge` table is the documentation store for Sidekick's agent-facing operational knowledge. `sidekick_knowledge` supports `search`, `get`, `list`, `add`, `update`, and `de
2. `technical-paper.md — 18. Summary` (RRF 0.03030999; E5 rank 5; Qwen rank 7)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 18. Summary Sidekick's current architecture is best understood as a self-hosted agent platform with a centralized governed tool runtime, durable data and
3. `technical-paper.md — Abstract` (RRF 0.02877847; E5 rank 9; Qwen rank 10)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > Abstract Sidekick is a self-hosted remote agent platform built around the Model Context Protocol (MCP). It gives compatible MCP clients and automation ag
4. `overview.md — Overview` (RRF 0.01639344; E5 rank None; Qwen rank 1)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
5. `README.md — Agent Information Access` (RRF 0.01612903; E5 rank 2; Qwen rank None) **[labeled relevant]**
   Document: README.md Section: Sidekick Documentation > Agent Information Access The important runtime pattern is database-first access. `AGENTS.md` is the thin instruction layer that tells agents where to look; the authoritative operational 

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### firewall_exposure

**Query:** Which Sidekick ports should be exposed through the firewall?

**Labeled relevant IDs:** `docs:installation.md:installation-and-deployment-firewall-and-exposure:1`

**Best labeled rank:** E5 `15`; Qwen `2`

#### E5 top results

1. `security.md — Exposure recommendations` (score 0.879743)
   Document: security.md Section: Security > Exposure recommendations Recommended safest setup: Bind services to a private interface or firewall them to VPN-only access. Use a strong `SIDEKICK_API_KEY`. Enable dashboard auth if dashboard is re
2. `overview.md — Recommended operating model` (score 0.873101)
   Document: overview.md Section: Overview > Recommended operating model Run Sidekick on a machine that is reliably available to its connected clients: a VPS, home server, mini PC, VM, or Raspberry Pi. Keep the MCP server protected with a stro
3. `overview.md — Core idea` (score 0.873097)
   Document: overview.md Section: Overview > Core idea A normal workflow looks like this: A compatible client connects to the MCP server on port 4097. The client authenticates and discovers the allowed Sidekick tool catalog. Sidekick exposes i
4. `security.md — IP allowlists` (score 0.872104)
   Document: security.md Section: Security > IP allowlists `SIDEKICK_ALLOWED_IPS` restricts MCP access by IPv4 address or CIDR range. Localhost is always allowed. `SIDEKICK_DASHBOARD_ALLOWED_IPS` provides similar filtering for the dashboard. I
5. `project-review.md — Tool recommendations` (score 0.869087)
   Document: project-review.md Section: Project Review > Tool recommendations `sidekick_fs_guard` or a shared path guard used by file-capable tools. `sidekick_approval_queue` for queued high-risk actions that require dashboard approval. `sidek

#### Qwen top results

1. `README.md — Runtime services` (score 0.656731)
   Document: README.md Section: Sidekick Documentation > Runtime services | Service | Default port | Entry point | Purpose |
2. `installation.md — Firewall and exposure` (score 0.625127) **[labeled relevant]**
   Document: installation.md Section: Installation and Deployment > Firewall and exposure At minimum, expose port 4097 only to systems that need MCP access. The dashboard and agent ports should usually be private, VPN-only, or reverse-proxied 
3. `security.md — Security` (score 0.599601)
   Document: security.md Section: Security Sidekick is powerful by design. It can execute commands, read and write files, manage services, store secrets, and call external APIs. Treat it like remote shell access to the host.
4. `overview.md — Recommended operating model` (score 0.588399)
   Document: overview.md Section: Overview > Recommended operating model Run Sidekick on a machine that is reliably available to its connected clients: a VPS, home server, mini PC, VM, or Raspberry Pi. Keep the MCP server protected with a stro
5. `README.md — Runtime services` (score 0.565280)
   Document: README.md Section: Sidekick Documentation > Runtime services | MCP server | 4097 | `src/index.js` | Exposes Sidekick tools over MCP Streamable HTTP and legacy SSE. | | Dashboard | 4098 | `src/dashboard.js` | Browser UI and managem

#### RRF fused top results

1. `overview.md — Recommended operating model` (RRF 0.03175403; E5 rank 2; Qwen rank 4)
   Document: overview.md Section: Overview > Recommended operating model Run Sidekick on a machine that is reliably available to its connected clients: a VPS, home server, mini PC, VM, or Raspberry Pi. Keep the MCP server protected with a stro
2. `security.md — Exposure recommendations` (RRF 0.03088620; E5 rank 1; Qwen rank 9)
   Document: security.md Section: Security > Exposure recommendations Recommended safest setup: Bind services to a private interface or firewall them to VPN-only access. Use a strong `SIDEKICK_API_KEY`. Enable dashboard auth if dashboard is re
3. `README.md — Runtime services` (RRF 0.02967033; E5 rank 10; Qwen rank 5)
   Document: README.md Section: Sidekick Documentation > Runtime services | MCP server | 4097 | `src/index.js` | Exposes Sidekick tools over MCP Streamable HTTP and legacy SSE. | | Dashboard | 4098 | `src/dashboard.js` | Browser UI and managem
4. `README.md — Runtime services` (RRF 0.01639344; E5 rank None; Qwen rank 1)
   Document: README.md Section: Sidekick Documentation > Runtime services | Service | Default port | Entry point | Purpose |
5. `installation.md — Firewall and exposure` (RRF 0.01612903; E5 rank None; Qwen rank 2) **[labeled relevant]**
   Document: installation.md Section: Installation and Deployment > Firewall and exposure At minimum, expose port 4097 only to systems that need MCP access. The dashboard and agent ports should usually be private, VPN-only, or reverse-proxied 

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### deployment_scripts

**Query:** How do the supplied deployment scripts install Sidekick?

**Labeled relevant IDs:** `docs:installation.md:installation-and-deployment-deployment-scripts:1, docs:installation.md:installation-and-deployment-deployment-scripts:2`

**Best labeled rank:** E5 `4`; Qwen `12`

#### E5 top results

1. `install.md — What the Deploy Scripts Should Handle` (score 0.937495)
   Document: install.md Section: Installation and Deployment > What the Deploy Scripts Should Handle The deployment scripts are intended to handle the normal server setup flow: Connect to the remote machine over SSH Prepare the `/home/sidekick
2. `install.md — Installation and Deployment` (score 0.935258)
   Document: install.md Section: Installation and Deployment Sidekick should be installed and deployed using the included deployment scripts. The deploy scripts are the primary install path. Manual `npm install` commands are for local developm
3. `installation.md — Manual systemd installation` (score 0.903593)
   Document: installation.md Section: Installation and Deployment > Manual systemd installation sudo -u sidekick git clone https://github.com/geoffmcc/sidekick.git /home/sidekick/sidekick cd /home/sidekick/sidekick sudo -u sidekick cp .env.exa
4. `installation.md — Deployment scripts` (score 0.902757) **[labeled relevant]**
   Document: installation.md Section: Installation and Deployment > Deployment scripts The repo includes `deploy.sh` for Linux/macOS and `deploy.ps1` for Windows. The scripts are designed to bootstrap a fresh remote host, create or use a `side
5. `install.md — After Deployment` (score 0.900491)
   Document: install.md Section: Installation and Deployment > After Deployment Open the dashboard: text http://YOUR_REMOTE_IP:4098/ Check the service: bash sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent View logs: bash s

#### Qwen top results

1. `install.md — Installation and Deployment` (score 0.833465)
   Document: install.md Section: Installation and Deployment Sidekick should be installed and deployed using the included deployment scripts. The deploy scripts are the primary install path. Manual `npm install` commands are for local developm
2. `installation.md — Manual systemd installation` (score 0.757557)
   Document: installation.md Section: Installation and Deployment > Manual systemd installation sudo -u sidekick git clone https://github.com/geoffmcc/sidekick.git /home/sidekick/sidekick cd /home/sidekick/sidekick sudo -u sidekick cp .env.exa
3. `install.md — What the Deploy Scripts Should Handle` (score 0.732291)
   Document: install.md Section: Installation and Deployment > What the Deploy Scripts Should Handle The deployment scripts are intended to handle the normal server setup flow: Connect to the remote machine over SSH Prepare the `/home/sidekick
4. `README.md — Fast path` (score 0.728780)
   Document: README.md Section: Sidekick Documentation > Fast path bash git clone https://github.com/geoffmcc/sidekick.git cd sidekick cp .env.example .env npm install node src/index.js Node.js 22 or newer is required. For a persistent deploym
5. `overview.md — Main components` (score 0.704951)
   Document: overview.md Section: Overview > Main components knowledge entries, and named JSON documents, plus file artifacts for transcripts, secrets, snapshots, queues, and exports. | | Deployment scripts | Bootstrap a remote host, create th

#### RRF fused top results

1. `install.md — Installation and Deployment` (RRF 0.03252247; E5 rank 2; Qwen rank 1)
   Document: install.md Section: Installation and Deployment Sidekick should be installed and deployed using the included deployment scripts. The deploy scripts are the primary install path. Manual `npm install` commands are for local developm
2. `install.md — What the Deploy Scripts Should Handle` (RRF 0.03226646; E5 rank 1; Qwen rank 3)
   Document: install.md Section: Installation and Deployment > What the Deploy Scripts Should Handle The deployment scripts are intended to handle the normal server setup flow: Connect to the remote machine over SSH Prepare the `/home/sidekick
3. `installation.md — Manual systemd installation` (RRF 0.03200205; E5 rank 3; Qwen rank 2)
   Document: installation.md Section: Installation and Deployment > Manual systemd installation sudo -u sidekick git clone https://github.com/geoffmcc/sidekick.git /home/sidekick/sidekick cd /home/sidekick/sidekick sudo -u sidekick cp .env.exa
4. `README.md — Fast path` (RRF 0.03011775; E5 rank 9; Qwen rank 4)
   Document: README.md Section: Sidekick Documentation > Fast path bash git clone https://github.com/geoffmcc/sidekick.git cd sidekick cp .env.example .env npm install node src/index.js Node.js 22 or newer is required. For a persistent deploym
5. `install.md — Server Path` (RRF 0.02921109; E5 rank 10; Qwen rank 7)
   Document: install.md Section: Installation and Deployment > Server Path The expected install path on the remote server is: bash /home/sidekick/sidekick Use this path consistently in documentation, scripts, troubleshooting notes, and example

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### knowledge_base

**Query:** What is the Sidekick knowledge base used for?

**Labeled relevant IDs:** `docs:data-model.md:data-model-knowledge-base:1`

**Best labeled rank:** E5 `1`; Qwen `6`

#### E5 top results

1. `data-model.md — Knowledge base` (score 0.894710) **[labeled relevant]**
   Document: data-model.md Section: Data Model > Knowledge base The `knowledge` table is the documentation store for Sidekick's agent-facing operational knowledge. `sidekick_knowledge` supports `search`, `get`, `list`, `add`, `update`, and `de
2. `README.md — Sidekick Documentation` (score 0.882922)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr
3. `overview.md — What Sidekick can do` (score 0.875638)
   Document: overview.md Section: Overview > What Sidekick can do The current codebase includes tools for: shell, file, search, git, process, service, and archive operations; persistent key-value memory, explicit task sessions, handoffs, typed
4. `overview.md — What Sidekick can do` (score 0.872094)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
5. `technical-paper.md — `knowledge`` (score 0.863184)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 6. Core Tables > `knowledge` `knowledge` stores documentation and operational knowledge. Each entry has category, title, content, tags, enabled status, v

#### Qwen top results

1. `README.md — Sidekick Documentation` (score 0.757746)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr
2. `overview.md — Overview` (score 0.742811)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
3. `overview.md — What Sidekick can do` (score 0.714166)
   Document: overview.md Section: Overview > What Sidekick can do Sidekick is broad by design.
4. `README.md — Documentation map` (score 0.711413)
   Document: README.md Section: Sidekick Documentation > Documentation map Day-to-day service commands, health checks, troubleshooting, backups, and maintenance. | | `development.md` | Source layout, testing, extension workflow, and implementa
5. `overview.md — Core idea` (score 0.698371)
   Document: overview.md Section: Overview > Core idea Sidekick does not replace the connected assistant or agent. It provides a persistent remote machine, governed MCP tools, durable context, and operational services. The companion `AGENTS.md

#### RRF fused top results

1. `README.md — Sidekick Documentation` (RRF 0.03252247; E5 rank 2; Qwen rank 1)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr
2. `data-model.md — Knowledge base` (RRF 0.03154496; E5 rank 1; Qwen rank 6) **[labeled relevant]**
   Document: data-model.md Section: Data Model > Knowledge base The `knowledge` table is the documentation store for Sidekick's agent-facing operational knowledge. `sidekick_knowledge` supports `search`, `get`, `list`, `add`, `update`, and `de
3. `overview.md — What Sidekick can do` (RRF 0.03055037; E5 rank 4; Qwen rank 7)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
4. `README.md — Documentation map` (RRF 0.02991071; E5 rank 10; Qwen rank 4)
   Document: README.md Section: Sidekick Documentation > Documentation map Day-to-day service commands, health checks, troubleshooting, backups, and maintenance. | | `development.md` | Source layout, testing, extension workflow, and implementa
5. `technical-paper.md — 18. Summary` (RRF 0.02941813; E5 rank 7; Qwen rank 9)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 18. Summary Sidekick's current architecture is best understood as a self-hosted agent platform with a centralized governed tool runtime, durable data and

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### mcp_server_boundary

**Query:** What endpoints and responsibilities belong to the MCP server?

**Labeled relevant IDs:** `docs:architecture.md:architecture-service-boundaries-mcp-server-src-index-js:1, docs:architecture.md:architecture-service-boundaries-mcp-server-src-index-js:2`

**Best labeled rank:** E5 `6`; Qwen `1`

#### E5 top results

1. `overview.md — Main components` (score 0.886691)
   Document: overview.md Section: Overview > Main components | Component | Role | | MCP server | The public tool endpoint used by compatible MCP clients and agents. | | Tool runtime | `src/tools/` owns descriptors, registry, dispatcher, reques
2. `api-reference.md — `POST /mcp`` (score 0.861427)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `POST /mcp` Primary Streamable HTTP MCP endpoint. Requires a valid bearer token or `api_key` query parameter. Handles session creation, tool invocation, and sta
3. `api-reference.md — `GET /health`` (score 0.858204)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `GET /health` Returns JSON health information including uptime, current session count, stale session mappings, version, timestamp, and session details.
4. `api-reference.md — `GET /mcp`` (score 0.856557)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `GET /mcp` Streamable HTTP GET path. Requires a valid `mcp-session-id` header.
5. `technical-paper.md — 8. MCP Server` (score 0.855325)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 8. MCP Server The server maintains in-memory sessions. Each session includes: MCP server instance; transport; creation timestamp; last access timestamp; 

#### Qwen top results

1. `architecture.md — MCP server: `src/index.js`` (score 0.739450) **[labeled relevant]**
   Document: architecture.md Section: Architecture > Service boundaries > MCP server: `src/index.js` The MCP server creates an `McpServer` from `@modelcontextprotocol/sdk`, registers built-in and approved generated tool definitions, and serves
2. `overview.md — Main components` (score 0.732313)
   Document: overview.md Section: Overview > Main components | Component | Role | | MCP server | The public tool endpoint used by compatible MCP clients and agents. | | Tool runtime | `src/tools/` owns descriptors, registry, dispatcher, reques
3. `technical-paper.md — 8. MCP Server` (score 0.695638)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 8. MCP Server `src/index.js` builds MCP server instances with `@modelcontextprotocol/sdk`. It supports: Streamable HTTP at `/mcp`; legacy SSE at `/sse` a
4. `api-reference.md — `GET /mcp`` (score 0.687752)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `GET /mcp` Streamable HTTP GET path. Requires a valid `mcp-session-id` header.
5. `installation.md — MCP client configuration` (score 0.653272)
   Document: installation.md Section: Installation and Deployment > MCP client configuration Use Streamable HTTP with the MCP server URL and bearer token. A typical config shape is: jsonc { "mcp": { "sidekick": { "enabled": true, "type": "remo

#### RRF fused top results

1. `overview.md — Main components` (RRF 0.03252247; E5 rank 1; Qwen rank 2)
   Document: overview.md Section: Overview > Main components | Component | Role | | MCP server | The public tool endpoint used by compatible MCP clients and agents. | | Tool runtime | `src/tools/` owns descriptors, registry, dispatcher, reques
2. `architecture.md — MCP server: `src/index.js`` (RRF 0.03154496; E5 rank 6; Qwen rank 1) **[labeled relevant]**
   Document: architecture.md Section: Architecture > Service boundaries > MCP server: `src/index.js` The MCP server creates an `McpServer` from `@modelcontextprotocol/sdk`, registers built-in and approved generated tool definitions, and serves
3. `api-reference.md — `POST /mcp`` (RRF 0.03128055; E5 rank 2; Qwen rank 6)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `POST /mcp` Primary Streamable HTTP MCP endpoint. Requires a valid bearer token or `api_key` query parameter. Handles session creation, tool invocation, and sta
4. `api-reference.md — `GET /mcp`` (RRF 0.03125000; E5 rank 4; Qwen rank 4)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `GET /mcp` Streamable HTTP GET path. Requires a valid `mcp-session-id` header.
5. `api-reference.md — `GET /health`` (RRF 0.01587302; E5 rank 3; Qwen rank None)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `GET /health` Returns JSON health information including uptime, current session count, stale session mappings, version, timestamp, and session details.

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### tool_risk

**Query:** How do tool risk levels interact with policy and approval requirements?

**Labeled relevant IDs:** `docs:tool-architecture.md:tool-architecture-risk-behavior:1`

**Best labeled rank:** E5 `2`; Qwen `6`

#### E5 top results

1. `tools-reference.md — Tools Reference` (score 0.887497)
   Document: tools-reference.md Section: Tools Reference Tool definitions exposed by the dashboard API include policy metadata: `risk`: `low`, `medium`, `high`, or `critical` `enabled`: whether the active source policy allows the tool `policy`
2. `tool-architecture.md — Risk Behavior` (score 0.867672) **[labeled relevant]**
   Document: tool-architecture.md Section: Tool Architecture > Risk Behavior Built-in descriptors must have explicit risk metadata. Missing built-in risk metadata fails registry construction. Generated tools are untrusted runtime data. Missing
3. `tool-architecture.md — Policy And Approval Boundary` (score 0.867660)
   Document: tool-architecture.md Section: Tool Architecture > Policy And Approval Boundary Policy and approval decisions are evaluated in the dispatcher for all tool execution surfaces. Approval behavior remains compatible with the existing d
4. `configuration.md — Security and tool policy` (score 0.865898)
   Document: configuration.md Section: Configuration > Security and tool policy Policy lists accept exact tool names and risk selectors such as `risk:high` or `risk:critical`. Source-specific variables are available for `MCP`, `DASHBOARD`, and
5. `configuration.md — Security and tool policy` (score 0.861411)
   Document: configuration.md Section: Configuration > Security and tool policy Approval mode defaults to `off`, so allowed tools execute immediately. Use it when you want allowed high-risk actions to wait in the dashboard Approvals tab:

#### Qwen top results

1. `tools-reference.md — Tools Reference` (score 0.700720)
   Document: tools-reference.md Section: Tools Reference Tool definitions exposed by the dashboard API include policy metadata: `risk`: `low`, `medium`, `high`, or `critical` `enabled`: whether the active source policy allows the tool `policy`
2. `tools-reference.md — Risk classification` (score 0.698474)
   Document: tools-reference.md Section: Tools Reference > Risk classification Use `SIDEKICK_TOOL_POLICY=restricted` to block high and critical tools by default. Use `SIDEKICK_ALLOWED_TOOLS`, `SIDEKICK_BLOCKED_TOOLS`, and source-specific varia
3. `configuration.md — Security and tool policy` (score 0.689892)
   Document: configuration.md Section: Configuration > Security and tool policy Policy lists accept exact tool names and risk selectors such as `risk:high` or `risk:critical`. Source-specific variables are available for `MCP`, `DASHBOARD`, and
4. `security.md — Approval queue` (score 0.684598)
   Document: security.md Section: Security > Approval queue The approval queue is an optional dashboard review layer for allowed tools. It does not enable tools that policy blocks. The default `SIDEKICK_APPROVAL_MODE=off` preserves existing be
5. `configuration.md — Security and tool policy` (score 0.679383)
   Document: configuration.md Section: Configuration > Security and tool policy Approval mode defaults to `off`, so allowed tools execute immediately. Use it when you want allowed high-risk actions to wait in the dashboard Approvals tab:

#### RRF fused top results

1. `tools-reference.md — Tools Reference` (RRF 0.03278689; E5 rank 1; Qwen rank 1)
   Document: tools-reference.md Section: Tools Reference Tool definitions exposed by the dashboard API include policy metadata: `risk`: `low`, `medium`, `high`, or `critical` `enabled`: whether the active source policy allows the tool `policy`
2. `configuration.md — Security and tool policy` (RRF 0.03149802; E5 rank 4; Qwen rank 3)
   Document: configuration.md Section: Configuration > Security and tool policy Policy lists accept exact tool names and risk selectors such as `risk:high` or `risk:critical`. Source-specific variables are available for `MCP`, `DASHBOARD`, and
3. `tool-architecture.md — Risk Behavior` (RRF 0.03128055; E5 rank 2; Qwen rank 6) **[labeled relevant]**
   Document: tool-architecture.md Section: Tool Architecture > Risk Behavior Built-in descriptors must have explicit risk metadata. Missing built-in risk metadata fails registry construction. Generated tools are untrusted runtime data. Missing
4. `tools-reference.md — Risk classification` (RRF 0.03128055; E5 rank 6; Qwen rank 2)
   Document: tools-reference.md Section: Tools Reference > Risk classification Use `SIDEKICK_TOOL_POLICY=restricted` to block high and critical tools by default. Use `SIDEKICK_ALLOWED_TOOLS`, `SIDEKICK_BLOCKED_TOOLS`, and source-specific varia
5. `configuration.md — Security and tool policy` (RRF 0.03076923; E5 rank 5; Qwen rank 5)
   Document: configuration.md Section: Configuration > Security and tool policy Approval mode defaults to `off`, so allowed tools execute immediately. Use it when you want allowed high-risk actions to wait in the dashboard Approvals tab:

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### dashboard_data_editing

**Query:** What persistent data can be inspected or edited from the dashboard?

**Labeled relevant IDs:** `docs:dashboard.md:dashboard-data-editing:1`

**Best labeled rank:** E5 `7`; Qwen `10`

#### E5 top results

1. `architecture.md — Dashboard: `src/dashboard.js`` (score 0.856396)
   Document: architecture.md Section: Architecture > Service boundaries > Dashboard: `src/dashboard.js` The dashboard serves a browser UI and JSON API. The server code lives in `src/dashboard.js`, the authenticated HTML shell lives in `src/das
2. `architecture.md — Dashboard: `src/dashboard.js`` (score 0.850793)
   Document: architecture.md Section: Architecture > Service boundaries > Dashboard: `src/dashboard.js` Memory shows what Sidekick learned from `memories`. The dashboard categorizes rows as durable, sessions, unresolved, or operational; existi
3. `technical-paper.md — 9. Dashboard` (score 0.850268)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 9. Dashboard `src/dashboard.js` serves: `src/dashboard.html`; static CSS/JS/assets; status APIs; database APIs; KV APIs; tool and category APIs; knowledg
4. `blackbox.md — Dashboard` (score 0.849933)
   Document: blackbox.md Section: Black Box Incident Explorer > Dashboard The dashboard has a Black Box tab with: incident list with search and lifecycle filtering; storage summary; capture action with profile selection; incident overview with
5. `architecture.md — Dashboard: `src/dashboard.js`` (score 0.847898)
   Document: architecture.md Section: Architecture > Service boundaries > Dashboard: `src/dashboard.js` Sessions use real session/task identifiers when present; otherwise a deterministic source-plus-time-window fallback keeps legacy records gr

#### Qwen top results

1. `dashboard.md — Main UI areas` (score 0.650678)
   Document: dashboard.md Section: Dashboard > Main UI areas Typical dashboard functions: use Mission Control as the default LAN portal for service health, attention items, quick actions, tool traffic, and recent activity; view recent tool cal
2. `architecture.md — Dashboard: `src/dashboard.js`` (score 0.629266)
   Document: architecture.md Section: Architecture > Service boundaries > Dashboard: `src/dashboard.js` Memory shows what Sidekick learned from `memories`. The dashboard categorizes rows as durable, sessions, unresolved, or operational; existi
3. `architecture.md — Evolve and dynamic tools` (score 0.624647)
   Document: architecture.md Section: Architecture > Service boundaries > Evolve and dynamic tools Dashboard quick actions mirror user-triggered dashboard operations into `platform_executions` with `operation_type='dashboard_action'`. Existing
4. `api-reference.md — Dashboard API summary` (score 0.613032)
   Document: api-reference.md Section: HTTP API Reference > Dashboard API summary The dashboard API includes read endpoints for logs, KV data, structured memories, sync metadata, system status, dashboard summary, LLM status, services, config, 
5. `technical-paper.md — 9. Dashboard` (score 0.612290)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 9. Dashboard `src/dashboard.js` serves: `src/dashboard.html`; static CSS/JS/assets; status APIs; database APIs; KV APIs; tool and category APIs; knowledg

#### RRF fused top results

1. `architecture.md — Dashboard: `src/dashboard.js`` (RRF 0.03225806; E5 rank 2; Qwen rank 2)
   Document: architecture.md Section: Architecture > Service boundaries > Dashboard: `src/dashboard.js` Memory shows what Sidekick learned from `memories`. The dashboard categorizes rows as durable, sessions, unresolved, or operational; existi
2. `technical-paper.md — 9. Dashboard` (RRF 0.03125763; E5 rank 3; Qwen rank 5)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 9. Dashboard `src/dashboard.js` serves: `src/dashboard.html`; static CSS/JS/assets; status APIs; database APIs; KV APIs; tool and category APIs; knowledg
3. `dashboard.md — Main UI areas` (RRF 0.03088620; E5 rank 9; Qwen rank 1)
   Document: dashboard.md Section: Dashboard > Main UI areas Typical dashboard functions: use Mission Control as the default LAN portal for service health, attention items, quick actions, tool traffic, and recent activity; view recent tool cal
4. `dashboard.md — Data editing` (RRF 0.02921109; E5 rank 7; Qwen rank 10) **[labeled relevant]**
   Document: dashboard.md Section: Dashboard > Data editing `GET /api/kv` returns the KV store. `PUT /api/kv/:key` writes or updates one KV entry. `DELETE /api/kv/:key` removes one key. KV entries may be stored as simple legacy strings or as m
5. `architecture.md — Dashboard: `src/dashboard.js`` (RRF 0.01639344; E5 rank 1; Qwen rank None)
   Document: architecture.md Section: Architecture > Service boundaries > Dashboard: `src/dashboard.js` The dashboard serves a browser UI and JSON API. The server code lives in `src/dashboard.js`, the authenticated HTML shell lives in `src/das

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### mcp_authentication

**Query:** How is the MCP endpoint authenticated?

**Labeled relevant IDs:** `docs:security.md:security-mcp-authentication:1`

**Best labeled rank:** E5 `4`; Qwen `1`

#### E5 top results

1. `api-reference.md — `POST /mcp`` (score 0.878035)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `POST /mcp` Primary Streamable HTTP MCP endpoint. Requires a valid bearer token or `api_key` query parameter. Handles session creation, tool invocation, and sta
2. `api-reference.md — `GET /mcp`` (score 0.870104)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `GET /mcp` Streamable HTTP GET path. Requires a valid `mcp-session-id` header.
3. `overview.md — Main components` (score 0.866677)
   Document: overview.md Section: Overview > Main components | Component | Role | | MCP server | The public tool endpoint used by compatible MCP clients and agents. | | Tool runtime | `src/tools/` owns descriptors, registry, dispatcher, reques
4. `security.md — MCP authentication` (score 0.861671) **[labeled relevant]**
   Document: security.md Section: Security > MCP authentication The MCP server requires an API key. Clients can send it as: http Authorization: Bearer YOUR_SIDEKICK_API_KEY or as an `api_key` query parameter. Use the header form whenever possi
5. `api-reference.md — `DELETE /mcp`` (score 0.859248)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `DELETE /mcp` Streamable HTTP session teardown. Requires a valid `mcp-session-id` header.

#### Qwen top results

1. `security.md — MCP authentication` (score 0.710150) **[labeled relevant]**
   Document: security.md Section: Security > MCP authentication The MCP server requires an API key. Clients can send it as: http Authorization: Bearer YOUR_SIDEKICK_API_KEY or as an `api_key` query parameter. Use the header form whenever possi
2. `installation.md — MCP client configuration` (score 0.669774)
   Document: installation.md Section: Installation and Deployment > MCP client configuration Use Streamable HTTP with the MCP server URL and bearer token. A typical config shape is: jsonc { "mcp": { "sidekick": { "enabled": true, "type": "remo
3. `api-reference.md — `GET /mcp`` (score 0.649637)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `GET /mcp` Streamable HTTP GET path. Requires a valid `mcp-session-id` header.
4. `technical-paper.md — 8. MCP Server` (score 0.643675)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 8. MCP Server `src/index.js` builds MCP server instances with `@modelcontextprotocol/sdk`. It supports: Streamable HTTP at `/mcp`; legacy SSE at `/sse` a
5. `api-reference.md — `POST /mcp`` (score 0.627336)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `POST /mcp` Primary Streamable HTTP MCP endpoint. Requires a valid bearer token or `api_key` query parameter. Handles session creation, tool invocation, and sta

#### RRF fused top results

1. `security.md — MCP authentication` (RRF 0.03201844; E5 rank 4; Qwen rank 1) **[labeled relevant]**
   Document: security.md Section: Security > MCP authentication The MCP server requires an API key. Clients can send it as: http Authorization: Bearer YOUR_SIDEKICK_API_KEY or as an `api_key` query parameter. Use the header form whenever possi
2. `api-reference.md — `GET /mcp`` (RRF 0.03200205; E5 rank 2; Qwen rank 3)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `GET /mcp` Streamable HTTP GET path. Requires a valid `mcp-session-id` header.
3. `api-reference.md — `POST /mcp`` (RRF 0.03177806; E5 rank 1; Qwen rank 5)
   Document: api-reference.md Section: HTTP API Reference > MCP server endpoints > `POST /mcp` Primary Streamable HTTP MCP endpoint. Requires a valid bearer token or `api_key` query parameter. Handles session creation, tool invocation, and sta
4. `overview.md — Main components` (RRF 0.03057890; E5 rank 3; Qwen rank 8)
   Document: overview.md Section: Overview > Main components | Component | Role | | MCP server | The public tool endpoint used by compatible MCP clients and agents. | | Tool runtime | `src/tools/` owns descriptors, registry, dispatcher, reques
5. `platform-architecture-assessment.md — Trust, Privilege, And Authentication Boundaries` (RRF 0.02921109; E5 rank 7; Qwen rank 10)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Trust, Privilege, And Authentication Boundaries MCP requires a non-placeholder `SIDEKICK_API_KEY` and optionally enforces allowed IP ranges (

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### service_commands

**Query:** What commands restart Sidekick and inspect service status or logs?

**Labeled relevant IDs:** `docs:operations.md:operations-service-commands:1, docs:operations.md:operations-service-commands:2`

**Best labeled rank:** E5 `5`; Qwen `2`

#### E5 top results

1. `tool-usage-guide.md — Operations and diagnostics` (score 0.900783)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Operations and diagnostics Use `sidekick_status` for a compact system overview. Use `sidekick_health` for a scored health check. Use `sidekick_tail` for recent logs. Use `sidekick_ne
2. `service.md — Restart Sidekick` (score 0.896853)
   Document: service.md Section: Service Management > Restart Sidekick bash sudo systemctl restart sidekick-mcp sidekick-dashboard sidekick-agent
3. `service.md — Check Status` (score 0.893851)
   Document: service.md Section: Service Management > Check Status bash sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent
4. `service.md — Follow Logs` (score 0.888046)
   Document: service.md Section: Service Management > Follow Logs bash sudo journalctl -u sidekick-mcp -f
5. `operations.md — Service commands` (score 0.887809) **[labeled relevant]**
   Document: operations.md Section: Operations > Service commands bash sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent sudo systemctl restart sidekick-mcp sudo systemctl restart sidekick-dashboard sudo systemctl restart si

#### Qwen top results

1. `service.md — Restart Sidekick` (score 0.777273)
   Document: service.md Section: Service Management > Restart Sidekick bash sudo systemctl restart sidekick-mcp sidekick-dashboard sidekick-agent
2. `operations.md — Service commands` (score 0.761234) **[labeled relevant]**
   Document: operations.md Section: Operations > Service commands bash sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent sudo systemctl restart sidekick-mcp sudo systemctl restart sidekick-dashboard sudo systemctl restart si
3. `tool-usage-guide.md — Operations and diagnostics` (score 0.749778)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Operations and diagnostics Use `sidekick_status` for a compact system overview. Use `sidekick_health` for a scored health check. Use `sidekick_tail` for recent logs. Use `sidekick_ne
4. `operations.md — Service commands` (score 0.716970) **[labeled relevant]**
   Document: operations.md Section: Operations > Service commands bash sudo journalctl -u sidekick-mcp -f
5. `service.md — Check Status` (score 0.710447)
   Document: service.md Section: Service Management > Check Status bash sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent

#### RRF fused top results

1. `service.md — Restart Sidekick` (RRF 0.03252247; E5 rank 2; Qwen rank 1)
   Document: service.md Section: Service Management > Restart Sidekick bash sudo systemctl restart sidekick-mcp sidekick-dashboard sidekick-agent
2. `tool-usage-guide.md — Operations and diagnostics` (RRF 0.03226646; E5 rank 1; Qwen rank 3)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Operations and diagnostics Use `sidekick_status` for a compact system overview. Use `sidekick_health` for a scored health check. Use `sidekick_tail` for recent logs. Use `sidekick_ne
3. `operations.md — Service commands` (RRF 0.03151365; E5 rank 5; Qwen rank 2) **[labeled relevant]**
   Document: operations.md Section: Operations > Service commands bash sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent sudo systemctl restart sidekick-mcp sudo systemctl restart sidekick-dashboard sudo systemctl restart si
4. `service.md — Check Status` (RRF 0.03125763; E5 rank 3; Qwen rank 5)
   Document: service.md Section: Service Management > Check Status bash sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent
5. `service.md — Follow Logs` (RRF 0.02991071; E5 rank 4; Qwen rank 10)
   Document: service.md Section: Service Management > Follow Logs bash sudo journalctl -u sidekick-mcp -f

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### sidekick_core_idea

**Query:** What does Sidekick provide to a connected MCP client or assistant?

**Labeled relevant IDs:** `docs:overview.md:overview-core-idea:1, docs:overview.md:overview-core-idea:2`

**Best labeled rank:** E5 `4`; Qwen `1`

#### E5 top results

1. `overview.md — Overview` (score 0.918603)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
2. `project-review.md — Product direction` (score 0.911871)
   Document: project-review.md Section: Project Review > Product direction The project description should be sharpened from "MCP server, dashboard, and local AI agent" to something closer to: Sidekick is a self-hosted remote operations agent. 
3. `technical-paper.md — Abstract` (score 0.909678)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > Abstract Sidekick is a self-hosted remote agent platform built around the Model Context Protocol (MCP). It gives compatible MCP clients and automation ag
4. `overview.md — Core idea` (score 0.907520) **[labeled relevant]**
   Document: overview.md Section: Overview > Core idea A normal workflow looks like this: A compatible client connects to the MCP server on port 4097. The client authenticates and discovers the allowed Sidekick tool catalog. Sidekick exposes i
5. `overview.md — Recommended operating model` (score 0.897961)
   Document: overview.md Section: Overview > Recommended operating model Run Sidekick on a machine that is reliably available to its connected clients: a VPS, home server, mini PC, VM, or Raspberry Pi. Keep the MCP server protected with a stro

#### Qwen top results

1. `overview.md — Core idea` (score 0.796461) **[labeled relevant]**
   Document: overview.md Section: Overview > Core idea Sidekick does not replace the connected assistant or agent. It provides a persistent remote machine, governed MCP tools, durable context, and operational services. The companion `AGENTS.md
2. `overview.md — Overview` (score 0.769232)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
3. `overview.md — Core idea` (score 0.755865) **[labeled relevant]**
   Document: overview.md Section: Overview > Core idea A normal workflow looks like this: A compatible client connects to the MCP server on port 4097. The client authenticates and discovers the allowed Sidekick tool catalog. Sidekick exposes i
4. `technical-paper.md — Abstract` (score 0.717053)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > Abstract Sidekick is a self-hosted remote agent platform built around the Model Context Protocol (MCP). It gives compatible MCP clients and automation ag
5. `README.md — Runtime services` (score 0.695825)
   Document: README.md Section: Sidekick Documentation > Runtime services | MCP server | 4097 | `src/index.js` | Exposes Sidekick tools over MCP Streamable HTTP and legacy SSE. | | Dashboard | 4098 | `src/dashboard.js` | Browser UI and managem

#### RRF fused top results

1. `overview.md — Overview` (RRF 0.03252247; E5 rank 1; Qwen rank 2)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
2. `overview.md — Core idea` (RRF 0.03154496; E5 rank 6; Qwen rank 1) **[labeled relevant]**
   Document: overview.md Section: Overview > Core idea Sidekick does not replace the connected assistant or agent. It provides a persistent remote machine, governed MCP tools, durable context, and operational services. The companion `AGENTS.md
3. `technical-paper.md — Abstract` (RRF 0.03149802; E5 rank 3; Qwen rank 4)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > Abstract Sidekick is a self-hosted remote agent platform built around the Model Context Protocol (MCP). It gives compatible MCP clients and automation ag
4. `overview.md — Core idea` (RRF 0.03149802; E5 rank 4; Qwen rank 3) **[labeled relevant]**
   Document: overview.md Section: Overview > Core idea A normal workflow looks like this: A compatible client connects to the MCP server on port 4097. The client authenticates and discovers the allowed Sidekick tool catalog. Sidekick exposes i
5. `project-review.md — Product direction` (RRF 0.03128055; E5 rank 2; Qwen rank 6)
   Document: project-review.md Section: Project Review > Product direction The project description should be sharpened from "MCP server, dashboard, and local AI agent" to something closer to: Sidekick is a self-hosted remote operations agent. 

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### blackbox_retention

**Query:** How are Black Box incident captures retained and cleaned up?

**Labeled relevant IDs:** `docs:blackbox.md:black-box-incident-explorer-retention:1, docs:blackbox.md:black-box-incident-explorer-retention:2, docs:blackbox.md:black-box-incident-explorer-retention:3`

**Best labeled rank:** E5 `5`; Qwen `3`

#### E5 top results

1. `blackbox.md — Concepts` (score 0.881242)
   Document: blackbox.md Section: Black Box Incident Explorer > Concepts Incident: durable troubleshooting record with lifecycle, severity, tags, retention, summaries, and links. Capture: one collection event for an incident. Incidents can hav
2. `blackbox.md — Black Box Incident Explorer` (score 0.875280)
   Document: blackbox.md Section: Black Box Incident Explorer Black Box captures configured incident context and stores it as structured evidence. It is no longer only a raw text time capsule.
3. `blackbox.md — MCP Actions` (score 0.870222)
   Document: blackbox.md Section: Black Box Incident Explorer > MCP Actions Legacy actions remain available: `capture` `list` `get` `delete` `analyze`
4. `architecture.md — Evolve and dynamic tools` (score 0.867504)
   Document: architecture.md Section: Architecture > Service boundaries > Evolve and dynamic tools Black Box captures also mirror capture lifecycle, source progress, and redacted source artifacts into the platform kernel. The Black Box inciden
5. `blackbox.md — Retention` (score 0.867426) **[labeled relevant]**
   Document: blackbox.md Section: Black Box Incident Explorer > Retention Retention classes are `transient`, `standard`, `important`, `archive`, and `pinned`. Pinned incidents never expire automatically. Open, investigating, and mitigating inc

#### Qwen top results

1. `blackbox.md — Black Box Incident Explorer` (score 0.757755)
   Document: blackbox.md Section: Black Box Incident Explorer Black Box captures configured incident context and stores it as structured evidence. It is no longer only a raw text time capsule.
2. `blackbox.md — Concepts` (score 0.726924)
   Document: blackbox.md Section: Black Box Incident Explorer > Concepts Incident: durable troubleshooting record with lifecycle, severity, tags, retention, summaries, and links. Capture: one collection event for an incident. Incidents can hav
3. `blackbox.md — Retention` (score 0.713077) **[labeled relevant]**
   Document: blackbox.md Section: Black Box Incident Explorer > Retention Environment settings include: `SIDEKICK_BLACKBOX_TTL_TRANSIENT_DAYS` `SIDEKICK_BLACKBOX_TTL_STANDARD_DAYS` `SIDEKICK_BLACKBOX_TTL_IMPORTANT_DAYS` `SIDEKICK_BLACKBOX_TTL_
4. `blackbox.md — Troubleshooting` (score 0.689102)
   Document: blackbox.md Section: Black Box Incident Explorer > Troubleshooting Use `storage_status` to inspect counts, active captures, and artifact size. Use `purge_preview` before retention cleanup. Use `get_source` for explicit source fail
5. `blackbox.md — Storage` (score 0.671807)
   Document: blackbox.md Section: Black Box Incident Explorer > Storage Migration `010_blackbox_incidents.sql` adds: `blackbox_incidents` `blackbox_captures` `blackbox_sources` `blackbox_observations` `blackbox_analyses` `blackbox_notes` `blac

#### RRF fused top results

1. `blackbox.md — Concepts` (RRF 0.03252247; E5 rank 1; Qwen rank 2)
   Document: blackbox.md Section: Black Box Incident Explorer > Concepts Incident: durable troubleshooting record with lifecycle, severity, tags, retention, summaries, and links. Capture: one collection event for an incident. Incidents can hav
2. `blackbox.md — Black Box Incident Explorer` (RRF 0.03252247; E5 rank 2; Qwen rank 1)
   Document: blackbox.md Section: Black Box Incident Explorer Black Box captures configured incident context and stores it as structured evidence. It is no longer only a raw text time capsule.
3. `blackbox.md — MCP Actions` (RRF 0.03057890; E5 rank 3; Qwen rank 8)
   Document: blackbox.md Section: Black Box Incident Explorer > MCP Actions Legacy actions remain available: `capture` `list` `get` `delete` `analyze`
4. `architecture.md — Evolve and dynamic tools` (RRF 0.02991071; E5 rank 4; Qwen rank 10)
   Document: architecture.md Section: Architecture > Service boundaries > Evolve and dynamic tools Black Box captures also mirror capture lifecycle, source progress, and redacted source artifacts into the platform kernel. The Black Box inciden
5. `blackbox.md — Troubleshooting` (RRF 0.02991071; E5 rank 10; Qwen rank 4)
   Document: blackbox.md Section: Black Box Incident Explorer > Troubleshooting Use `storage_status` to inspect counts, active captures, and artifact size. Use `purge_preview` before retention cleanup. Use `get_source` for explicit source fail

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### blackbox_security

**Query:** What is the security model for Black Box incident data?

**Labeled relevant IDs:** `docs:blackbox.md:black-box-incident-explorer-security-model:1`

**Best labeled rank:** E5 `4`; Qwen `2`

#### E5 top results

1. `blackbox.md — Black Box Incident Explorer` (score 0.866660)
   Document: blackbox.md Section: Black Box Incident Explorer Black Box captures configured incident context and stores it as structured evidence. It is no longer only a raw text time capsule.
2. `blackbox.md — Dashboard` (score 0.865387)
   Document: blackbox.md Section: Black Box Incident Explorer > Dashboard The dashboard has a Black Box tab with: incident list with search and lifecycle filtering; storage summary; capture action with profile selection; incident overview with
3. `tools-reference.md — `black_box`` (score 0.865205)
   Document: tools-reference.md Section: Tools Reference > Monitoring, diagnostics, and operations > `black_box` Incident time capsule: captures full system context (services, processes, logs, disk, network) in one call for debugging. Rate lim
4. `blackbox.md — Security Model` (score 0.863582) **[labeled relevant]**
   Document: blackbox.md Section: Black Box Incident Explorer > Security Model Captured logs and command output are untrusted data. Black Box strips terminal control characters, redacts sensitive values before writing artifacts, caps source ou
5. `blackbox.md — Integrations` (score 0.859661)
   Document: blackbox.md Section: Black Box Incident Explorer > Integrations Activity correlation is represented by incident/capture/source timeline events and tool log correlation IDs where available. Task/session IDs are stored on incidents 

#### Qwen top results

1. `blackbox.md — Black Box Incident Explorer` (score 0.734967)
   Document: blackbox.md Section: Black Box Incident Explorer Black Box captures configured incident context and stores it as structured evidence. It is no longer only a raw text time capsule.
2. `blackbox.md — Security Model` (score 0.706795) **[labeled relevant]**
   Document: blackbox.md Section: Black Box Incident Explorer > Security Model Captured logs and command output are untrusted data. Black Box strips terminal control characters, redacts sensitive values before writing artifacts, caps source ou
3. `blackbox.md — Dashboard` (score 0.673404)
   Document: blackbox.md Section: Black Box Incident Explorer > Dashboard The dashboard has a Black Box tab with: incident list with search and lifecycle filtering; storage summary; capture action with profile selection; incident overview with
4. `blackbox.md — Retention` (score 0.672700)
   Document: blackbox.md Section: Black Box Incident Explorer > Retention Environment settings include: `SIDEKICK_BLACKBOX_TTL_TRANSIENT_DAYS` `SIDEKICK_BLACKBOX_TTL_STANDARD_DAYS` `SIDEKICK_BLACKBOX_TTL_IMPORTANT_DAYS` `SIDEKICK_BLACKBOX_TTL_
5. `blackbox.md — Concepts` (score 0.656157)
   Document: blackbox.md Section: Black Box Incident Explorer > Concepts Observation: a direct structured fact extracted from a source, such as disk usage, failed service, listener, or log signature. Analysis: deterministic or LLM-assisted int

#### RRF fused top results

1. `blackbox.md — Black Box Incident Explorer` (RRF 0.03278689; E5 rank 1; Qwen rank 1)
   Document: blackbox.md Section: Black Box Incident Explorer Black Box captures configured incident context and stores it as structured evidence. It is no longer only a raw text time capsule.
2. `blackbox.md — Dashboard` (RRF 0.03200205; E5 rank 2; Qwen rank 3)
   Document: blackbox.md Section: Black Box Incident Explorer > Dashboard The dashboard has a Black Box tab with: incident list with search and lifecycle filtering; storage summary; capture action with profile selection; incident overview with
3. `blackbox.md — Security Model` (RRF 0.03175403; E5 rank 4; Qwen rank 2) **[labeled relevant]**
   Document: blackbox.md Section: Black Box Incident Explorer > Security Model Captured logs and command output are untrusted data. Black Box strips terminal control characters, redacts sensitive values before writing artifacts, caps source ou
4. `tools-reference.md — `black_box`` (RRF 0.03057890; E5 rank 3; Qwen rank 8)
   Document: tools-reference.md Section: Tools Reference > Monitoring, diagnostics, and operations > `black_box` Incident time capsule: captures full system context (services, processes, logs, disk, network) in one call for debugging. Rate lim
5. `blackbox.md — Storage` (RRF 0.03030303; E5 rank 6; Qwen rank 6)
   Document: blackbox.md Section: Black Box Incident Explorer > Storage Migration `010_blackbox_incidents.sql` adds: `blackbox_incidents` `blackbox_captures` `blackbox_sources` `blackbox_observations` `blackbox_analyses` `blackbox_notes` `blac

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### compute_results

**Query:** How does Sidekick Compute handle results and artifacts?

**Labeled relevant IDs:** `docs:compute.md:sidekick-compute-results-and-artifacts:1, docs:compute.md:sidekick-compute-results-and-artifacts:2`

**Best labeled rank:** E5 `1`; Qwen `3`

#### E5 top results

1. `compute.md — Results And Artifacts` (score 0.898352) **[labeled relevant]**
   Document: compute.md Section: Sidekick Compute > Results And Artifacts Workers upload artifacts with: text POST /compute/worker/jobs/:jobId/artifacts/upload Workers finalize artifacts with: text POST /compute/worker/jobs/:jobId/artifacts/:a
2. `compute.md — Dashboard And APIs` (score 0.889534)
   Document: compute.md Section: Sidekick Compute > Dashboard And APIs Job detail includes attempts and artifacts. Job stats include status counts, type counts, active lease count, attempt count, and artifact counts by state.
3. `compute.md — Testing` (score 0.885911)
   Document: compute.md Section: Sidekick Compute > Testing bash SIDEKICK_COMPUTE_LIVE=1 SIDEKICK_COMPUTE_LIVE_URL=http://127.0.0.1:4097 SIDEKICK_COMPUTE_LIVE_API_KEY=<admin api key> Then run: bash node test/compute-live-worker.test.js The liv
4. `compute.md — Results And Artifacts` (score 0.885569) **[labeled relevant]**
   Document: compute.md Section: Sidekick Compute > Results And Artifacts Artifact metadata records job, attempt, worker, lease, type, name, content type, hash, size, state, created time, and finalization time. Upload validates lease ownership
5. `overview.md — What Sidekick can do` (score 0.884494)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel

#### Qwen top results

1. `compute.md — Sidekick Compute` (score 0.739164)
   Document: compute.md Section: Sidekick Compute Sidekick Compute runs allowlisted model-oriented jobs through enrolled workers. It is not a remote shell, arbitrary command runner, or general GPU batch service.
2. `compute.md — Non-Goals` (score 0.679711)
   Document: compute.md Section: Sidekick Compute > Non-Goals Sidekick Compute does not provide arbitrary shell execution, raw process spawning, custom executable selection, unrestricted file transfer, or generalized GPU job scheduling. Add ne
3. `compute.md — Results And Artifacts` (score 0.647112) **[labeled relevant]**
   Document: compute.md Section: Sidekick Compute > Results And Artifacts Artifact metadata records job, attempt, worker, lease, type, name, content type, hash, size, state, created time, and finalization time. Upload validates lease ownership
4. `overview.md — What Sidekick can do` (score 0.640049)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
5. `README.md — Documentation map` (score 0.631597)
   Document: README.md Section: Sidekick Documentation > Documentation map | `overview.md` | What Sidekick is, how the pieces fit together, and common use cases. | | `architecture.md` | Service boundaries, request flow, storage layout, session

#### RRF fused top results

1. `compute.md — Results And Artifacts` (RRF 0.03149802; E5 rank 4; Qwen rank 3) **[labeled relevant]**
   Document: compute.md Section: Sidekick Compute > Results And Artifacts Artifact metadata records job, attempt, worker, lease, type, name, content type, hash, size, state, created time, and finalization time. Upload validates lease ownership
2. `compute.md — Results And Artifacts` (RRF 0.03109932; E5 rank 1; Qwen rank 8) **[labeled relevant]**
   Document: compute.md Section: Sidekick Compute > Results And Artifacts Workers upload artifacts with: text POST /compute/worker/jobs/:jobId/artifacts/upload Workers finalize artifacts with: text POST /compute/worker/jobs/:jobId/artifacts/:a
3. `overview.md — What Sidekick can do` (RRF 0.03100962; E5 rank 5; Qwen rank 4)
   Document: overview.md Section: Overview > What Sidekick can do parsing, validation, templating, hashing, diffs, changelog generation, anonymization, extraction, analytics, and evidence-backed insight reports; system health, snapshots, timel
4. `compute.md — Non-Goals` (RRF 0.03083491; E5 rank 8; Qwen rank 2)
   Document: compute.md Section: Sidekick Compute > Non-Goals Sidekick Compute does not provide arbitrary shell execution, raw process spawning, custom executable selection, unrestricted file transfer, or generalized GPU job scheduling. Add ne
5. `compute.md — Sidekick Compute` (RRF 0.03067916; E5 rank 10; Qwen rank 1)
   Document: compute.md Section: Sidekick Compute Sidekick Compute runs allowlisted model-oriented jobs through enrolled workers. It is not a remote shell, arbitrary command runner, or general GPU batch service.

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### compute_trust

**Query:** What are the trust boundaries for Sidekick Compute workers?

**Labeled relevant IDs:** `docs:compute.md:sidekick-compute-trust-boundaries:1, docs:compute.md:sidekick-compute-trust-boundaries:2`

**Best labeled rank:** E5 `1`; Qwen `3`

#### E5 top results

1. `compute.md — Trust Boundaries` (score 0.903422) **[labeled relevant]**
   Document: compute.md Section: Sidekick Compute > Trust Boundaries Compute HTTP routes are split into three groups: `/compute/enrollment/*`: enrollment exchange uses one-time enrollment tokens. `/compute/worker/*`: worker protocol routes req
2. `compute.md — Trust Boundaries` (score 0.903137) **[labeled relevant]**
   Document: compute.md Section: Sidekick Compute > Trust Boundaries Worker credentials are issued only during enrollment or rotation. The server stores credential hashes. Worker detail APIs expose `hasCredential`, not the credential value.
3. `compute.md — Hardware, Backends, And Models` (score 0.886068)
   Document: compute.md Section: Sidekick Compute > Hardware, Backends, And Models `SIDEKICK_WORKER_BACKENDS_JSON`: explicit backend metadata. `OLLAMA_URL`: optional Ollama backend, with credentials stripped before reporting. `SIDEKICK_WORKER_
4. `architecture.md — MCP server: `src/index.js`` (score 0.884074)
   Document: architecture.md Section: Architecture > Service boundaries > MCP server: `src/index.js` `/compute/admin/*` routes for Sidekick Compute. The server requires `Authorization: Bearer <SIDEKICK_API_KEY>` or `?api_key=<key>` for MCP and
5. `compute.md — Enrollment And Workers` (score 0.883489)
   Document: compute.md Section: Sidekick Compute > Enrollment And Workers The worker agent in `src/compute/worker-agent.js` can be configured with: `SIDEKICK_URL` or `SIDEKICK_SERVER_URL` `SIDEKICK_ENROLL_TOKEN` for first enrollment `SIDEKICK

#### Qwen top results

1. `compute.md — Sidekick Compute` (score 0.739118)
   Document: compute.md Section: Sidekick Compute Sidekick Compute runs allowlisted model-oriented jobs through enrolled workers. It is not a remote shell, arbitrary command runner, or general GPU batch service.
2. `compute.md — Non-Goals` (score 0.667199)
   Document: compute.md Section: Sidekick Compute > Non-Goals Sidekick Compute does not provide arbitrary shell execution, raw process spawning, custom executable selection, unrestricted file transfer, or generalized GPU job scheduling. Add ne
3. `compute.md — Trust Boundaries` (score 0.664980) **[labeled relevant]**
   Document: compute.md Section: Sidekick Compute > Trust Boundaries Compute HTTP routes are split into three groups: `/compute/enrollment/*`: enrollment exchange uses one-time enrollment tokens. `/compute/worker/*`: worker protocol routes req
4. `compute.md — Enrollment And Workers` (score 0.650335)
   Document: compute.md Section: Sidekick Compute > Enrollment And Workers `SIDEKICK_WORKER_SHUTDOWN_GRACE_MS` The worker entry point in this repository is: bash node src/compute/worker-agent.js enroll --server http://<sidekick-host>:4097 --to
5. `compute.md — Trust Boundaries` (score 0.649647) **[labeled relevant]**
   Document: compute.md Section: Sidekick Compute > Trust Boundaries Worker credentials are issued only during enrollment or rotation. The server stores credential hashes. Worker detail APIs expose `hasCredential`, not the credential value.

#### RRF fused top results

1. `compute.md — Trust Boundaries` (RRF 0.03226646; E5 rank 1; Qwen rank 3) **[labeled relevant]**
   Document: compute.md Section: Sidekick Compute > Trust Boundaries Compute HTTP routes are split into three groups: `/compute/enrollment/*`: enrollment exchange uses one-time enrollment tokens. `/compute/worker/*`: worker protocol routes req
2. `compute.md — Sidekick Compute` (RRF 0.03154496; E5 rank 6; Qwen rank 1)
   Document: compute.md Section: Sidekick Compute Sidekick Compute runs allowlisted model-oriented jobs through enrolled workers. It is not a remote shell, arbitrary command runner, or general GPU batch service.
3. `compute.md — Trust Boundaries` (RRF 0.03151365; E5 rank 2; Qwen rank 5) **[labeled relevant]**
   Document: compute.md Section: Sidekick Compute > Trust Boundaries Worker credentials are issued only during enrollment or rotation. The server stores credential hashes. Worker detail APIs expose `hasCredential`, not the credential value.
4. `compute.md — Non-Goals` (RRF 0.03105441; E5 rank 7; Qwen rank 2)
   Document: compute.md Section: Sidekick Compute > Non-Goals Sidekick Compute does not provide arbitrary shell execution, raw process spawning, custom executable selection, unrestricted file transfer, or generalized GPU job scheduling. Add ne
5. `architecture.md — MCP server: `src/index.js`` (RRF 0.03033088; E5 rank 4; Qwen rank 8)
   Document: architecture.md Section: Architecture > Service boundaries > MCP server: `src/index.js` `/compute/admin/*` routes for Sidekick Compute. The server requires `Authorization: Bearer <SIDEKICK_API_KEY>` or `?api_key=<key>` for MCP and

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### memory_sync

**Query:** How are structured memories synchronized between Sidekick machines?

**Labeled relevant IDs:** `docs:data-model.md:data-model-structured-memory-cross-machine-sync:1, docs:data-model.md:data-model-structured-memory-cross-machine-sync:2`

**Best labeled rank:** E5 `2`; Qwen `4`

#### E5 top results

1. `configuration.md — Automatic Memory` (score 0.886727)
   Document: configuration.md Section: Configuration > Automatic Memory `sidekick_context` writes compatibility context entries such as decisions, problems, patterns, and `sess_...` sessions into the `context` document. Exact IDs can be recall
2. `data-model.md — Cross-Machine Sync` (score 0.882323) **[labeled relevant]**
   Document: data-model.md Section: Data Model > Structured memory > Cross-Machine Sync Automatic memory is enabled by default, can be disabled with `SIDEKICK_AUTO_MEMORY=0`, and is capped by `SIDEKICK_AUTO_MEMORY_MAX` active automatic rows. I
3. `structured-memory-plan.md — Implemented Scope` (score 0.879853)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status > Implemented Scope Add `sidekick_memory_export`, `sidekick_memory_import`, `sidekick_memory_manage`, `sidekick_sync_identity`, `sidekick_sync_exp
4. `configuration.md — Automatic Memory` (score 0.878231)
   Document: configuration.md Section: Configuration > Automatic Memory Automatic memory is enabled by default. Sidekick stores bounded, redacted summaries of useful tool calls and completed Agent Bridge tasks in the `memories` table, with com
5. `structured-memory-plan.md — Structured Memory And Memory Intelligence Status` (score 0.876322)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status Sidekick's automatic memory stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON doc

#### Qwen top results

1. `structured-memory-plan.md — Implemented Scope` (score 0.708231)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status > Implemented Scope Add `sidekick_memory_export`, `sidekick_memory_import`, `sidekick_memory_manage`, `sidekick_sync_identity`, `sidekick_sync_exp
2. `structured-memory-plan.md — Structured Memory And Memory Intelligence Status` (score 0.705115)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status Sidekick's automatic memory stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON doc
3. `configuration.md — Automatic Memory` (score 0.700682)
   Document: configuration.md Section: Configuration > Automatic Memory `sidekick_context` writes compatibility context entries such as decisions, problems, patterns, and `sess_...` sessions into the `context` document. Exact IDs can be recall
4. `data-model.md — Cross-Machine Sync` (score 0.652122) **[labeled relevant]**
   Document: data-model.md Section: Data Model > Structured memory > Cross-Machine Sync Automatic memory is enabled by default, can be disabled with `SIDEKICK_AUTO_MEMORY=0`, and is capped by `SIDEKICK_AUTO_MEMORY_MAX` active automatic rows. I
5. `configuration.md — Automatic Memory` (score 0.650239)
   Document: configuration.md Section: Configuration > Automatic Memory Automatic memory is enabled by default. Sidekick stores bounded, redacted summaries of useful tool calls and completed Agent Bridge tasks in the `memories` table, with com

#### RRF fused top results

1. `configuration.md — Automatic Memory` (RRF 0.03226646; E5 rank 1; Qwen rank 3)
   Document: configuration.md Section: Configuration > Automatic Memory `sidekick_context` writes compatibility context entries such as decisions, problems, patterns, and `sess_...` sessions into the `context` document. Exact IDs can be recall
2. `structured-memory-plan.md — Implemented Scope` (RRF 0.03226646; E5 rank 3; Qwen rank 1)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status > Implemented Scope Add `sidekick_memory_export`, `sidekick_memory_import`, `sidekick_memory_manage`, `sidekick_sync_identity`, `sidekick_sync_exp
3. `data-model.md — Cross-Machine Sync` (RRF 0.03175403; E5 rank 2; Qwen rank 4) **[labeled relevant]**
   Document: data-model.md Section: Data Model > Structured memory > Cross-Machine Sync Automatic memory is enabled by default, can be disabled with `SIDEKICK_AUTO_MEMORY=0`, and is capped by `SIDEKICK_AUTO_MEMORY_MAX` active automatic rows. I
4. `structured-memory-plan.md — Structured Memory And Memory Intelligence Status` (RRF 0.03151365; E5 rank 5; Qwen rank 2)
   Document: structured-memory-plan.md Section: Structured Memory And Memory Intelligence Status Sidekick's automatic memory stores bounded, redacted summaries in the `memories` SQLite table, with compatibility copies in the `context` JSON doc
5. `configuration.md — Automatic Memory` (RRF 0.03100962; E5 rank 4; Qwen rank 5)
   Document: configuration.md Section: Configuration > Automatic Memory Automatic memory is enabled by default. Sidekick stores bounded, redacted summaries of useful tool calls and completed Agent Bridge tasks in the `memories` table, with com

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### recommended_exposure

**Query:** How should a Sidekick server be exposed safely to remote clients?

**Labeled relevant IDs:** `docs:overview.md:overview-recommended-operating-model:1`

**Best labeled rank:** E5 `3`; Qwen `1`

#### E5 top results

1. `security.md — Exposure recommendations` (score 0.908666)
   Document: security.md Section: Security > Exposure recommendations Recommended safest setup: Bind services to a private interface or firewall them to VPN-only access. Use a strong `SIDEKICK_API_KEY`. Enable dashboard auth if dashboard is re
2. `technical-paper.md — 15. Security Model` (score 0.907371)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Sidekick should be treated like remote shell access to the host. Its safety model is defense in depth, not a claim that powerful tools
3. `overview.md — Recommended operating model` (score 0.895616) **[labeled relevant]**
   Document: overview.md Section: Overview > Recommended operating model Run Sidekick on a machine that is reliably available to its connected clients: a VPS, home server, mini PC, VM, or Raspberry Pi. Keep the MCP server protected with a stro
4. `technical-paper.md — 8. MCP Server` (score 0.891651)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 8. MCP Server `src/index.js` builds MCP server instances with `@modelcontextprotocol/sdk`. It supports: Streamable HTTP at `/mcp`; legacy SSE at `/sse` a
5. `dashboard.md — Authentication and protections` (score 0.884522)
   Document: dashboard.md Section: Dashboard > Authentication and protections If the dashboard is exposed outside a private network, put it behind a reverse proxy, VPN, or additional authentication. For shared deployments, also set `SIDEKICK_T

#### Qwen top results

1. `overview.md — Recommended operating model` (score 0.712425) **[labeled relevant]**
   Document: overview.md Section: Overview > Recommended operating model Run Sidekick on a machine that is reliably available to its connected clients: a VPS, home server, mini PC, VM, or Raspberry Pi. Keep the MCP server protected with a stro
2. `security.md — Security` (score 0.700864)
   Document: security.md Section: Security Sidekick is powerful by design. It can execute commands, read and write files, manage services, store secrets, and call external APIs. Treat it like remote shell access to the host.
3. `technical-paper.md — 15. Security Model` (score 0.666098)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Sidekick should be treated like remote shell access to the host. Its safety model is defense in depth, not a claim that powerful tools
4. `README.md — Runtime services` (score 0.646987)
   Document: README.md Section: Sidekick Documentation > Runtime services | Service | Default port | Entry point | Purpose |
5. `README.md — Sidekick Documentation` (score 0.646444)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr

#### RRF fused top results

1. `overview.md — Recommended operating model` (RRF 0.03226646; E5 rank 3; Qwen rank 1) **[labeled relevant]**
   Document: overview.md Section: Overview > Recommended operating model Run Sidekick on a machine that is reliably available to its connected clients: a VPS, home server, mini PC, VM, or Raspberry Pi. Keep the MCP server protected with a stro
2. `technical-paper.md — 15. Security Model` (RRF 0.03200205; E5 rank 2; Qwen rank 3)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Sidekick should be treated like remote shell access to the host. Its safety model is defense in depth, not a claim that powerful tools
3. `overview.md — Core idea` (RRF 0.03007689; E5 rank 6; Qwen rank 7)
   Document: overview.md Section: Overview > Core idea A normal workflow looks like this: A compatible client connects to the MCP server on port 4097. The client authenticates and discovers the allowed Sidekick tool catalog. Sidekick exposes i
4. `service.md — Service Management` (RRF 0.02963126; E5 rank 7; Qwen rank 8)
   Document: service.md Section: Service Management Sidekick uses systemd on the remote server.
5. `security.md — Exposure recommendations` (RRF 0.01639344; E5 rank 1; Qwen rank None)
   Document: security.md Section: Security > Exposure recommendations Recommended safest setup: Bind services to a private interface or firewall them to VPN-only access. Use a strong `SIDEKICK_API_KEY`. Enable dashboard auth if dashboard is re

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### shared_storage

**Query:** Where do Sidekick services store shared durable state?

**Labeled relevant IDs:** `docs:architecture.md:architecture-shared-storage:1, docs:architecture.md:architecture-shared-storage:2`

**Best labeled rank:** E5 `1`; Qwen `3`

#### E5 top results

1. `architecture.md — Shared storage` (score 0.856805) **[labeled relevant]**
   Document: architecture.md Section: Architecture > Shared storage All services use the same `SIDEKICK_DATA_DIR`. By default, this is `data/` relative to the project during local development, and `/home/sidekick/sidekick/data` in the example 
2. `data-model.md — Data Model` (score 0.853174)
   Document: data-model.md Section: Data Model Sidekick stores core persistent state in SQLite (`sidekick.db`) under `SIDEKICK_DATA_DIR`. Some feature-specific state still uses JSON/JSONL files where file artifacts are simpler or intentionally
3. `README.md — Sidekick Documentation` (score 0.850999)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr
4. `overview.md — Core idea` (score 0.844035)
   Document: overview.md Section: Overview > Core idea A normal workflow looks like this: A compatible client connects to the MCP server on port 4097. The client authenticates and discovers the allowed Sidekick tool catalog. Sidekick exposes i
5. `overview.md — Overview` (score 0.843311)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,

#### Qwen top results

1. `data-model.md — Data Model` (score 0.724149)
   Document: data-model.md Section: Data Model Sidekick stores core persistent state in SQLite (`sidekick.db`) under `SIDEKICK_DATA_DIR`. Some feature-specific state still uses JSON/JSONL files where file artifacts are simpler or intentionally
2. `tool-usage-guide.md — Persistent memory` (score 0.661056)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Persistent memory Use `sidekick_store` for durable facts that should survive sessions. Use project names that match `^[a-z][a-z0-9_]*$`. Good project names are lowercase and specific
3. `architecture.md — Shared storage` (score 0.656089) **[labeled relevant]**
   Document: architecture.md Section: Architecture > Shared storage All services use the same `SIDEKICK_DATA_DIR`. By default, this is `data/` relative to the project during local development, and `/home/sidekick/sidekick/data` in the example 
4. `overview.md — Core idea` (score 0.650145)
   Document: overview.md Section: Overview > Core idea Sidekick does not replace the connected assistant or agent. It provides a persistent remote machine, governed MCP tools, durable context, and operational services. The companion `AGENTS.md
5. `README.md — Sidekick Documentation` (score 0.645502)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr

#### RRF fused top results

1. `data-model.md — Data Model` (RRF 0.03252247; E5 rank 2; Qwen rank 1)
   Document: data-model.md Section: Data Model Sidekick stores core persistent state in SQLite (`sidekick.db`) under `SIDEKICK_DATA_DIR`. Some feature-specific state still uses JSON/JSONL files where file artifacts are simpler or intentionally
2. `architecture.md — Shared storage` (RRF 0.03226646; E5 rank 1; Qwen rank 3) **[labeled relevant]**
   Document: architecture.md Section: Architecture > Shared storage All services use the same `SIDEKICK_DATA_DIR`. By default, this is `data/` relative to the project during local development, and `/home/sidekick/sidekick/data` in the example 
3. `README.md — Sidekick Documentation` (RRF 0.03125763; E5 rank 3; Qwen rank 5)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr
4. `architecture.md — Shared storage` (RRF 0.02877847; E5 rank 10; Qwen rank 9) **[labeled relevant]**
   Document: architecture.md Section: Architecture > Shared storage Some feature-specific artifacts still use files: agent transcripts, audit/error logs, secrets, snapshots, queues, runbooks, baselines, and similar operational bundles. Back up
5. `tool-usage-guide.md — Persistent memory` (RRF 0.01612903; E5 rank None; Qwen rank 2)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Persistent memory Use `sidekick_store` for durable facts that should survive sessions. Use project names that match `^[a-z][a-z0-9_]*$`. Good project names are lowercase and specific

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### agent_task_lifecycle

**Query:** How does an Agent Bridge task move from request through tool calls to completion?

**Labeled relevant IDs:** `docs:agent-bridge.md:agent-bridge-task-lifecycle:1`

**Best labeled rank:** E5 `2`; Qwen `3`

#### E5 top results

1. `architecture.md — Agent Bridge: `src/agent.js`` (score 0.904817)
   Document: architecture.md Section: Architecture > Service boundaries > Agent Bridge: `src/agent.js` The Agent Bridge accepts high-level task requests, builds a task transcript, repeatedly chooses tool calls, executes them through `callTool`
2. `agent-bridge.md — Task lifecycle` (score 0.899249) **[labeled relevant]**
   Document: agent-bridge.md Section: Agent Bridge > Task lifecycle A client submits a task to `POST /api/agent/run`. The bridge creates a task ID and transcript file. The agent loops until the goal is complete, fails, or reaches `SIDEKICK_MAX
3. `architecture.md — Evolve and dynamic tools` (score 0.886285)
   Document: architecture.md Section: Architecture > Service boundaries > Evolve and dynamic tools Agent Bridge tasks mirror task lifecycle, tool-call progress, and transcript artifacts into the platform kernel with `operation_type='agent_task
4. `api-reference.md — Agent API summary` (score 0.881832)
   Document: api-reference.md Section: HTTP API Reference > Agent API summary The Agent Bridge exposes endpoints for task submission, task event streaming, task history, individual task retrieval, status, health, delay reload, and watch reload
5. `technical-paper.md — 10. Agent Bridge` (score 0.874432)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 10. Agent Bridge `src/agent.js` runs an autonomous goal loop. It is intentionally bound to `127.0.0.1` by default and is meant to be reached through the 

#### Qwen top results

1. `architecture.md — Agent Bridge: `src/agent.js`` (score 0.841297)
   Document: architecture.md Section: Architecture > Service boundaries > Agent Bridge: `src/agent.js` The Agent Bridge accepts high-level task requests, builds a task transcript, repeatedly chooses tool calls, executes them through `callTool`
2. `architecture.md — Evolve and dynamic tools` (score 0.806950)
   Document: architecture.md Section: Architecture > Service boundaries > Evolve and dynamic tools Agent Bridge tasks mirror task lifecycle, tool-call progress, and transcript artifacts into the platform kernel with `operation_type='agent_task
3. `agent-bridge.md — Task lifecycle` (score 0.802819) **[labeled relevant]**
   Document: agent-bridge.md Section: Agent Bridge > Task lifecycle A client submits a task to `POST /api/agent/run`. The bridge creates a task ID and transcript file. The agent loops until the goal is complete, fails, or reaches `SIDEKICK_MAX
4. `platform-architecture-assessment.md — Trust, Privilege, And Authentication Boundaries` (score 0.742332)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Trust, Privilege, And Authentication Boundaries Agent Bridge is a separate HTTP service and directly imports `callTool` plus allowed tool def
5. `platform-architecture-assessment.md — Current Process Boundaries` (score 0.739780)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Current Process Boundaries Agent Bridge: `src/agent.js` accepts task goals, runs a local planning loop, calls `callTool`, stores transcripts,

#### RRF fused top results

1. `architecture.md — Agent Bridge: `src/agent.js`` (RRF 0.03278689; E5 rank 1; Qwen rank 1)
   Document: architecture.md Section: Architecture > Service boundaries > Agent Bridge: `src/agent.js` The Agent Bridge accepts high-level task requests, builds a task transcript, repeatedly chooses tool calls, executes them through `callTool`
2. `agent-bridge.md — Task lifecycle` (RRF 0.03200205; E5 rank 2; Qwen rank 3) **[labeled relevant]**
   Document: agent-bridge.md Section: Agent Bridge > Task lifecycle A client submits a task to `POST /api/agent/run`. The bridge creates a task ID and transcript file. The agent loops until the goal is complete, fails, or reaches `SIDEKICK_MAX
3. `architecture.md — Evolve and dynamic tools` (RRF 0.03200205; E5 rank 3; Qwen rank 2)
   Document: architecture.md Section: Architecture > Service boundaries > Evolve and dynamic tools Agent Bridge tasks mirror task lifecycle, tool-call progress, and transcript artifacts into the platform kernel with `operation_type='agent_task
4. `technical-paper.md — 10. Agent Bridge` (RRF 0.03053613; E5 rank 5; Qwen rank 6)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 10. Agent Bridge `src/agent.js` runs an autonomous goal loop. It is intentionally bound to `127.0.0.1` by default and is meant to be reached through the 
5. `api-reference.md — Agent API summary` (RRF 0.03033088; E5 rank 4; Qwen rank 8)
   Document: api-reference.md Section: HTTP API Reference > Agent API summary The Agent Bridge exposes endpoints for task submission, task event streaming, task history, individual task retrieval, status, health, delay reload, and watch reload

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### backup_guidance

**Query:** What files and directories must be included in a Sidekick backup?

**Labeled relevant IDs:** `docs:data-model.md:data-model-backup-guidance:1`

**Best labeled rank:** E5 `1`; Qwen `2`

#### E5 top results

1. `data-model.md — Backup guidance` (score 0.891477) **[labeled relevant]**
   Document: data-model.md Section: Data Model > Backup guidance Back up the entire data directory. The highest-value file is `sidekick.db` because it contains KV data, structured memories, tool logs, the knowledge base, tool registry metadata
2. `operations.md — Backups` (score 0.888854)
   Document: operations.md Section: Operations > Backups Back up `SIDEKICK_DATA_DIR`. A simple backup: bash tar -czf sidekick-data-$(date +%F).tar.gz -C /home/sidekick/sidekick data For systemd deployments, also back up `.env`, but store it se
3. `project-review.md — Highest-priority follow-ups` (score 0.879662)
   Document: project-review.md Section: Project Review > Highest-priority follow-ups Add filesystem scope controls. `sidekick_read`, `sidekick_write`, archive, backup/export, sandbox, and diff tools currently operate on arbitrary paths. Keep t
4. `architecture.md — Shared storage` (score 0.875195)
   Document: architecture.md Section: Architecture > Shared storage Some feature-specific artifacts still use files: agent transcripts, audit/error logs, secrets, snapshots, queues, runbooks, baselines, and similar operational bundles. Back up
5. `tool-usage-guide.md — Safe experimentation` (score 0.873435)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Safe experimentation Use `sidekick_sandbox` when a command may change files and you want automatic backup and rollback support. Use `sidekick_snapshot` before and after operational c

#### Qwen top results

1. `operations.md — Backups` (score 0.703475)
   Document: operations.md Section: Operations > Backups Back up `SIDEKICK_DATA_DIR`. A simple backup: bash tar -czf sidekick-data-$(date +%F).tar.gz -C /home/sidekick/sidekick data For systemd deployments, also back up `.env`, but store it se
2. `data-model.md — Backup guidance` (score 0.681232) **[labeled relevant]**
   Document: data-model.md Section: Data Model > Backup guidance Back up the entire data directory. The highest-value file is `sidekick.db` because it contains KV data, structured memories, tool logs, the knowledge base, tool registry metadata
3. `tool-usage-guide.md — Safe experimentation` (score 0.629936)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Safe experimentation Use `sidekick_sandbox` when a command may change files and you want automatic backup and rollback support. Use `sidekick_snapshot` before and after operational c
4. `README.md — Sidekick Documentation` (score 0.611531)
   Document: README.md Section: Sidekick Documentation Sidekick is a self-hosted Model Context Protocol server and autonomous assistant platform that gives compatible clients and agents a persistent remote working environment. These docs descr
5. `security.md — Security` (score 0.592368)
   Document: security.md Section: Security Sidekick is powerful by design. It can execute commands, read and write files, manage services, store secrets, and call external APIs. Treat it like remote shell access to the host.

#### RRF fused top results

1. `data-model.md — Backup guidance` (RRF 0.03252247; E5 rank 1; Qwen rank 2) **[labeled relevant]**
   Document: data-model.md Section: Data Model > Backup guidance Back up the entire data directory. The highest-value file is `sidekick.db` because it contains KV data, structured memories, tool logs, the knowledge base, tool registry metadata
2. `operations.md — Backups` (RRF 0.03252247; E5 rank 2; Qwen rank 1)
   Document: operations.md Section: Operations > Backups Back up `SIDEKICK_DATA_DIR`. A simple backup: bash tar -czf sidekick-data-$(date +%F).tar.gz -C /home/sidekick/sidekick data For systemd deployments, also back up `.env`, but store it se
3. `tool-usage-guide.md — Safe experimentation` (RRF 0.03125763; E5 rank 5; Qwen rank 3)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Safe experimentation Use `sidekick_sandbox` when a command may change files and you want automatic backup and rollback support. Use `sidekick_snapshot` before and after operational c
4. `architecture.md — Shared storage` (RRF 0.03077652; E5 rank 4; Qwen rank 6)
   Document: architecture.md Section: Architecture > Shared storage Some feature-specific artifacts still use files: agent transcripts, audit/error logs, secrets, snapshots, queues, runbooks, baselines, and similar operational bundles. Back up
5. `project-review.md — Highest-priority follow-ups` (RRF 0.01587302; E5 rank 3; Qwen rank None)
   Document: project-review.md Section: Project Review > Highest-priority follow-ups Add filesystem scope controls. `sidekick_read`, `sidekick_write`, archive, backup/export, sandbox, and diff tools currently operate on arbitrary paths. Keep t

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### dashboard_auth

**Query:** How is the Sidekick dashboard authenticated and protected?

**Labeled relevant IDs:** `docs:dashboard.md:dashboard-authentication-and-protections:1, docs:dashboard.md:dashboard-authentication-and-protections:2`

**Best labeled rank:** E5 `1`; Qwen `2`

#### E5 top results

1. `dashboard.md — Authentication and protections` (score 0.926639) **[labeled relevant]**
   Document: dashboard.md Section: Dashboard > Authentication and protections Dashboard Basic Auth is enabled only when both `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS` are set. When enabled, it protects the dashboard HTML, JSON AP
2. `security.md — Dashboard authentication` (score 0.912963)
   Document: security.md Section: Security > Dashboard authentication Set both `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS` to enable Basic Auth for the dashboard HTML, API routes, and agent event streams. Static assets remain publi
3. `dashboard.md — Authentication and protections` (score 0.905767) **[labeled relevant]**
   Document: dashboard.md Section: Dashboard > Authentication and protections If the dashboard is exposed outside a private network, put it behind a reverse proxy, VPN, or additional authentication. For shared deployments, also set `SIDEKICK_T
4. `technical-paper.md — 9. Dashboard` (score 0.905400)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 9. Dashboard Dashboard protections include: optional Basic Auth; optional IP allowlist; in-memory rate limiting; JSON body size limit; same-origin checks
5. `technical-paper.md — 15. Security Model` (score 0.892269)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Core protections: MCP bearer token authentication. Optional MCP IP allowlist. Dashboard Basic Auth. Optional dashboard IP allowlist. C

#### Qwen top results

1. `security.md — Dashboard authentication` (score 0.719394)
   Document: security.md Section: Security > Dashboard authentication Set both `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS` to enable Basic Auth for the dashboard HTML, API routes, and agent event streams. Static assets remain publi
2. `dashboard.md — Authentication and protections` (score 0.718769) **[labeled relevant]**
   Document: dashboard.md Section: Dashboard > Authentication and protections If the dashboard is exposed outside a private network, put it behind a reverse proxy, VPN, or additional authentication. For shared deployments, also set `SIDEKICK_T
3. `technical-paper.md — 15. Security Model` (score 0.717085)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Core protections: MCP bearer token authentication. Optional MCP IP allowlist. Dashboard Basic Auth. Optional dashboard IP allowlist. C
4. `dashboard.md — Authentication and protections` (score 0.709543) **[labeled relevant]**
   Document: dashboard.md Section: Dashboard > Authentication and protections Dashboard Basic Auth is enabled only when both `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS` are set. When enabled, it protects the dashboard HTML, JSON AP
5. `platform-architecture-assessment.md — Trust, Privilege, And Authentication Boundaries` (score 0.695879)
   Document: platform-architecture-assessment.md Section: Sidekick Platform Architecture Assessment > Trust, Privilege, And Authentication Boundaries Dashboard requires non-placeholder MCP key, can require dashboard Basic Auth/session cookie, 

#### RRF fused top results

1. `security.md — Dashboard authentication` (RRF 0.03252247; E5 rank 2; Qwen rank 1)
   Document: security.md Section: Security > Dashboard authentication Set both `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS` to enable Basic Auth for the dashboard HTML, API routes, and agent event streams. Static assets remain publi
2. `dashboard.md — Authentication and protections` (RRF 0.03201844; E5 rank 1; Qwen rank 4) **[labeled relevant]**
   Document: dashboard.md Section: Dashboard > Authentication and protections Dashboard Basic Auth is enabled only when both `SIDEKICK_DASHBOARD_USER` and `SIDEKICK_DASHBOARD_PASS` are set. When enabled, it protects the dashboard HTML, JSON AP
3. `dashboard.md — Authentication and protections` (RRF 0.03200205; E5 rank 3; Qwen rank 2) **[labeled relevant]**
   Document: dashboard.md Section: Dashboard > Authentication and protections If the dashboard is exposed outside a private network, put it behind a reverse proxy, VPN, or additional authentication. For shared deployments, also set `SIDEKICK_T
4. `technical-paper.md — 15. Security Model` (RRF 0.03125763; E5 rank 5; Qwen rank 3)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Core protections: MCP bearer token authentication. Optional MCP IP allowlist. Dashboard Basic Auth. Optional dashboard IP allowlist. C
5. `architecture.md — Dashboard: `src/dashboard.js`` (RRF 0.02963126; E5 rank 7; Qwen rank 8)
   Document: architecture.md Section: Architecture > Service boundaries > Dashboard: `src/dashboard.js` It includes dashboard-specific protections: optional Basic Auth, IP allowlist, rate limiting, exact-host CSRF origin checks, audit logging,

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### evolve_architecture

**Query:** How does Evolve analyze workflows and create generated tools?

**Labeled relevant IDs:** `docs:architecture.md:architecture-service-boundaries-evolve-and-dynamic-tools:1, docs:architecture.md:architecture-service-boundaries-evolve-and-dynamic-tools:10, docs:architecture.md:architecture-service-boundaries-evolve-and-dynamic-tools:11, docs:architecture.md:architecture-service-boundaries-evolve-and-dynamic-tools:12, docs:architecture.md:architecture-service-boundaries-evolve-and-dynamic-tools:13, docs:architecture.md:architecture-service-boundaries-evolve-and-dynamic-tools:2, docs:architecture.md:architecture-service-boundaries-evolve-and-dynamic-tools:3, docs:architecture.md:architecture-service-boundaries-evolve-and-dynamic-tools:4, docs:architecture.md:architecture-service-boundaries-evolve-and-dynamic-tools:5, docs:architecture.md:architecture-service-boundaries-evolve-and-dynamic-tools:6, docs:architecture.md:architecture-service-boundaries-evolve-and-dynamic-tools:7, docs:architecture.md:architecture-service-boundaries-evolve-and-dynamic-tools:8, docs:architecture.md:architecture-service-boundaries-evolve-and-dynamic-tools:9`

**Best labeled rank:** E5 `1`; Qwen `2`

#### E5 top results

1. `architecture.md — Evolve and dynamic tools` (score 0.876687) **[labeled relevant]**
   Document: architecture.md Section: Architecture > Service boundaries > Evolve and dynamic tools The Evolve implementation is intentionally split out of the large tool module: `src/evolve/analyzer.js` restores chronological log order, segmen
2. `tools-reference.md — `evolve`` (score 0.876423)
   Document: tools-reference.md Section: Tools Reference > AI, learning, and self-extension > `evolve` Evidence-driven workflow learning and generated-tool lifecycle management. Mines repeated successful bounded workflows, infers parameters, v
3. `configuration.md — Evolve Workflow Learning` (score 0.872253)
   Document: configuration.md Section: Configuration > Evolve Workflow Learning Trial and active generated tools are discoverable as `sidekick_generated_<name>` after registry sync and MCP server startup. Deprecated or rejected generated tools
4. `architecture.md — Evolve and dynamic tools` (score 0.871763) **[labeled relevant]**
   Document: architecture.md Section: Architecture > Service boundaries > Evolve and dynamic tools Verified problems in the previous Evolve implementation: Tool logs were read newest-first while adjacent entries were interpreted as forward chr
5. `architecture.md — Evolve and dynamic tools` (score 0.863698) **[labeled relevant]**
   Document: architecture.md Section: Architecture > Service boundaries > Evolve and dynamic tools `src/evolve/lifecycle.js` owns generated capability state transitions: `observed`, `candidate`, `validated`, `awaiting_approval`, `trial`, `acti

#### Qwen top results

1. `tools-reference.md — `evolve`` (score 0.787447)
   Document: tools-reference.md Section: Tools Reference > AI, learning, and self-extension > `evolve` Evidence-driven workflow learning and generated-tool lifecycle management. Mines repeated successful bounded workflows, infers parameters, v
2. `architecture.md — Evolve and dynamic tools` (score 0.717880) **[labeled relevant]**
   Document: architecture.md Section: Architecture > Service boundaries > Evolve and dynamic tools The Evolve implementation is intentionally split out of the large tool module: `src/evolve/analyzer.js` restores chronological log order, segmen
3. `configuration.md — Evolve Workflow Learning` (score 0.662498)
   Document: configuration.md Section: Configuration > Evolve Workflow Learning Trial and active generated tools are discoverable as `sidekick_generated_<name>` after registry sync and MCP server startup. Deprecated or rejected generated tools
4. `configuration.md — Evolve Workflow Learning` (score 0.659870)
   Document: configuration.md Section: Configuration > Evolve Workflow Learning javascript sidekick_evolve({ action: "analyze" }) sidekick_evolve({ action: "validate", id: "cand_..." }) sidekick_evolve({ action: "approve", id: "cand_...", appr
5. `tool-usage-guide.md — Self-extension` (score 0.614619)
   Document: tool-usage-guide.md Section: Tool Usage Guide > Self-extension Use `sidekick_teach` to define reusable procedures composed from existing tools. Use `sidekick_evolve` only with care: it mines repeated successful workflows, validate

#### RRF fused top results

1. `architecture.md — Evolve and dynamic tools` (RRF 0.03252247; E5 rank 1; Qwen rank 2) **[labeled relevant]**
   Document: architecture.md Section: Architecture > Service boundaries > Evolve and dynamic tools The Evolve implementation is intentionally split out of the large tool module: `src/evolve/analyzer.js` restores chronological log order, segmen
2. `tools-reference.md — `evolve`` (RRF 0.03252247; E5 rank 2; Qwen rank 1)
   Document: tools-reference.md Section: Tools Reference > AI, learning, and self-extension > `evolve` Evidence-driven workflow learning and generated-tool lifecycle management. Mines repeated successful bounded workflows, infers parameters, v
3. `configuration.md — Evolve Workflow Learning` (RRF 0.03174603; E5 rank 3; Qwen rank 3)
   Document: configuration.md Section: Configuration > Evolve Workflow Learning Trial and active generated tools are discoverable as `sidekick_generated_<name>` after registry sync and MCP server startup. Deprecated or rejected generated tools
4. `tools-reference.md — Full inventory` (RRF 0.02941813; E5 rank 9; Qwen rank 7)
   Document: tools-reference.md Section: Tools Reference > Full inventory 3)", backoff: "string (optional, exponential|linear|fixed, default exponential)", initial_delay: "number (optional, ms, default 1000)" }` | | `evolve` | Meta | Evidence-
5. `architecture.md — Evolve and dynamic tools` (RRF 0.02899160; E5 rank 8; Qwen rank 10) **[labeled relevant]**
   Document: architecture.md Section: Architecture > Service boundaries > Evolve and dynamic tools Generated tool invocations also mirror parent and per-step execution state into the additive platform kernel tables (`platform_executions` and `

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### runtime_ports

**Query:** Which ports do the Sidekick MCP server, dashboard, and Agent Bridge use?

**Labeled relevant IDs:** `docs:README.md:sidekick-documentation-runtime-services:1, docs:README.md:sidekick-documentation-runtime-services:2, docs:README.md:sidekick-documentation-runtime-services:3`

**Best labeled rank:** E5 `2`; Qwen `1`

#### E5 top results

1. `overview.md — Overview` (score 0.892956)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
2. `README.md — Runtime services` (score 0.883704) **[labeled relevant]**
   Document: README.md Section: Sidekick Documentation > Runtime services | MCP server | 4097 | `src/index.js` | Exposes Sidekick tools over MCP Streamable HTTP and legacy SSE. | | Dashboard | 4098 | `src/dashboard.js` | Browser UI and managem
3. `agent-bridge.md — Purpose` (score 0.881020)
   Document: agent-bridge.md Section: Agent Bridge > Purpose The MCP server is reactive: a client calls a tool and receives a result. The Agent Bridge is task-oriented: the user submits a goal, Sidekick plans tool use, executes tools, records 
4. `project-review.md — Product direction` (score 0.878272)
   Document: project-review.md Section: Project Review > Product direction The project description should be sharpened from "MCP server, dashboard, and local AI agent" to something closer to: Sidekick is a self-hosted remote operations agent. 
5. `technical-paper.md — Abstract` (score 0.873556)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > Abstract Sidekick is a self-hosted remote agent platform built around the Model Context Protocol (MCP). It gives compatible MCP clients and automation ag

#### Qwen top results

1. `README.md — Runtime services` (score 0.747813) **[labeled relevant]**
   Document: README.md Section: Sidekick Documentation > Runtime services | MCP server | 4097 | `src/index.js` | Exposes Sidekick tools over MCP Streamable HTTP and legacy SSE. | | Dashboard | 4098 | `src/dashboard.js` | Browser UI and managem
2. `technical-paper.md — 2. Runtime Components` (score 0.740065)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 2. Runtime Components | MCP Server | `src/index.js` | `0.0.0.0:4097` | Public MCP endpoint for tool discovery and tool calls. | | Dashboard | `src/dashbo
3. `overview.md — Overview` (score 0.700098)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
4. `installation.md — Local development install` (score 0.695958)
   Document: installation.md Section: Installation and Deployment > Local development install Defaults: MCP server: `http://127.0.0.1:4097` Dashboard: `http://127.0.0.1:4098` Agent Bridge: `http://127.0.0.1:4099`
5. `agent-bridge.md — Purpose` (score 0.688979)
   Document: agent-bridge.md Section: Agent Bridge > Purpose The MCP server is reactive: a client calls a tool and receives a result. The Agent Bridge is task-oriented: the user submits a goal, Sidekick plans tool use, executes tools, records 

#### RRF fused top results

1. `README.md — Runtime services` (RRF 0.03252247; E5 rank 2; Qwen rank 1) **[labeled relevant]**
   Document: README.md Section: Sidekick Documentation > Runtime services | MCP server | 4097 | `src/index.js` | Exposes Sidekick tools over MCP Streamable HTTP and legacy SSE. | | Dashboard | 4098 | `src/dashboard.js` | Browser UI and managem
2. `overview.md — Overview` (RRF 0.03226646; E5 rank 1; Qwen rank 3)
   Document: overview.md Section: Overview Sidekick is a self-hosted agent platform for compatible MCP clients and automation agents. It provides a remote MCP server, browser dashboard, autonomous Agent Bridge, persistent memory and knowledge,
3. `technical-paper.md — 2. Runtime Components` (RRF 0.03128055; E5 rank 6; Qwen rank 2)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 2. Runtime Components | MCP Server | `src/index.js` | `0.0.0.0:4097` | Public MCP endpoint for tool discovery and tool calls. | | Dashboard | `src/dashbo
4. `agent-bridge.md — Purpose` (RRF 0.03125763; E5 rank 3; Qwen rank 5)
   Document: agent-bridge.md Section: Agent Bridge > Purpose The MCP server is reactive: a client calls a tool and receives a result. The Agent Bridge is task-oriented: the user submits a goal, Sidekick plans tool use, executes tools, records 
5. `technical-paper.md — Abstract` (RRF 0.03053613; E5 rank 5; Qwen rank 6)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > Abstract Sidekick is a self-hosted remote agent platform built around the Model Context Protocol (MCP). It gives compatible MCP clients and automation ag

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### tool_policy_config

**Query:** How are Sidekick tool allowlists, blocklists, and risk policies configured?

**Labeled relevant IDs:** `docs:configuration.md:configuration-security-and-tool-policy:1, docs:configuration.md:configuration-security-and-tool-policy:10, docs:configuration.md:configuration-security-and-tool-policy:11, docs:configuration.md:configuration-security-and-tool-policy:2, docs:configuration.md:configuration-security-and-tool-policy:3, docs:configuration.md:configuration-security-and-tool-policy:4, docs:configuration.md:configuration-security-and-tool-policy:5, docs:configuration.md:configuration-security-and-tool-policy:6, docs:configuration.md:configuration-security-and-tool-policy:7, docs:configuration.md:configuration-security-and-tool-policy:8, docs:configuration.md:configuration-security-and-tool-policy:9`

**Best labeled rank:** E5 `5`; Qwen `4`

#### E5 top results

1. `security.md — Tool permission policy` (score 0.921231)
   Document: security.md Section: Security > Tool permission policy Sidekick now supports a config-driven tool policy. The default `SIDEKICK_TOOL_POLICY=open` preserves existing behavior: tools are allowed unless explicitly blocked. Set `SIDEK
2. `security.md — Tool permission policy` (score 0.921082)
   Document: security.md Section: Security > Tool permission policy env SIDEKICK_AGENT_TOOL_POLICY=restricted SIDEKICK_AGENT_ALLOWED_TOOLS=sidekick_read,sidekick_search,sidekick_get,sidekick_respond SIDEKICK_BLOCKED_TOOLS=sidekick_db_restore,s
3. `tools-reference.md — Risk classification` (score 0.919969)
   Document: tools-reference.md Section: Tools Reference > Risk classification Use `SIDEKICK_TOOL_POLICY=restricted` to block high and critical tools by default. Use `SIDEKICK_ALLOWED_TOOLS`, `SIDEKICK_BLOCKED_TOOLS`, and source-specific varia
4. `technical-paper.md — 15. Security Model` (score 0.916449)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Tool policy is controlled with: `SIDEKICK_TOOL_POLICY` `SIDEKICK_BLOCKED_TOOLS` `SIDEKICK_ALLOWED_TOOLS` `SIDEKICK_MCP_TOOL_POLICY` `S
5. `configuration.md — Security and tool policy` (score 0.901057) **[labeled relevant]**
   Document: configuration.md Section: Configuration > Security and tool policy javascript sidekick_tools({ action: "policy", source: "mcp,dashboard,agent", name: "sidekick_bash", format: "json" }) The policy inspector reports whether each sou

#### Qwen top results

1. `security.md — Tool permission policy` (score 0.786801)
   Document: security.md Section: Security > Tool permission policy Sidekick now supports a config-driven tool policy. The default `SIDEKICK_TOOL_POLICY=open` preserves existing behavior: tools are allowed unless explicitly blocked. Set `SIDEK
2. `security.md — Tool permission policy` (score 0.774650)
   Document: security.md Section: Security > Tool permission policy env SIDEKICK_AGENT_TOOL_POLICY=restricted SIDEKICK_AGENT_ALLOWED_TOOLS=sidekick_read,sidekick_search,sidekick_get,sidekick_respond SIDEKICK_BLOCKED_TOOLS=sidekick_db_restore,s
3. `technical-paper.md — 15. Security Model` (score 0.712218)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Tool policy is controlled with: `SIDEKICK_TOOL_POLICY` `SIDEKICK_BLOCKED_TOOLS` `SIDEKICK_ALLOWED_TOOLS` `SIDEKICK_MCP_TOOL_POLICY` `S
4. `configuration.md — Security and tool policy` (score 0.711146) **[labeled relevant]**
   Document: configuration.md Section: Configuration > Security and tool policy env SIDEKICK_TOOL_POLICY=restricted SIDEKICK_AGENT_ALLOWED_TOOLS=sidekick_read,sidekick_search,sidekick_get,sidekick_respond SIDEKICK_BLOCKED_TOOLS=sidekick_db_res
5. `tools-reference.md — Risk classification` (score 0.693806)
   Document: tools-reference.md Section: Tools Reference > Risk classification Use `SIDEKICK_TOOL_POLICY=restricted` to block high and critical tools by default. Use `SIDEKICK_ALLOWED_TOOLS`, `SIDEKICK_BLOCKED_TOOLS`, and source-specific varia

#### RRF fused top results

1. `security.md — Tool permission policy` (RRF 0.03278689; E5 rank 1; Qwen rank 1)
   Document: security.md Section: Security > Tool permission policy Sidekick now supports a config-driven tool policy. The default `SIDEKICK_TOOL_POLICY=open` preserves existing behavior: tools are allowed unless explicitly blocked. Set `SIDEK
2. `security.md — Tool permission policy` (RRF 0.03225806; E5 rank 2; Qwen rank 2)
   Document: security.md Section: Security > Tool permission policy env SIDEKICK_AGENT_TOOL_POLICY=restricted SIDEKICK_AGENT_ALLOWED_TOOLS=sidekick_read,sidekick_search,sidekick_get,sidekick_respond SIDEKICK_BLOCKED_TOOLS=sidekick_db_restore,s
3. `technical-paper.md — 15. Security Model` (RRF 0.03149802; E5 rank 4; Qwen rank 3)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 15. Security Model Tool policy is controlled with: `SIDEKICK_TOOL_POLICY` `SIDEKICK_BLOCKED_TOOLS` `SIDEKICK_ALLOWED_TOOLS` `SIDEKICK_MCP_TOOL_POLICY` `S
4. `tools-reference.md — Risk classification` (RRF 0.03125763; E5 rank 3; Qwen rank 5)
   Document: tools-reference.md Section: Tools Reference > Risk classification Use `SIDEKICK_TOOL_POLICY=restricted` to block high and critical tools by default. Use `SIDEKICK_ALLOWED_TOOLS`, `SIDEKICK_BLOCKED_TOOLS`, and source-specific varia
5. `configuration.md — Security and tool policy` (RRF 0.03055037; E5 rank 7; Qwen rank 4) **[labeled relevant]**
   Document: configuration.md Section: Configuration > Security and tool policy env SIDEKICK_TOOL_POLICY=restricted SIDEKICK_AGENT_ALLOWED_TOOLS=sidekick_read,sidekick_search,sidekick_get,sidekick_respond SIDEKICK_BLOCKED_TOOLS=sidekick_db_res

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---

### tool_runtime

**Query:** Where is the authoritative tool registry and dispatcher implemented?

**Labeled relevant IDs:** `docs:architecture.md:architecture-service-boundaries-tool-runtime-src-tools:1, docs:architecture.md:architecture-service-boundaries-tool-runtime-src-tools:2, docs:architecture.md:architecture-service-boundaries-tool-runtime-src-tools:3, docs:architecture.md:architecture-service-boundaries-tool-runtime-src-tools:4`

**Best labeled rank:** E5 `7`; Qwen `6`

#### E5 top results

1. `technical-paper.md — 7. Tool System` (score 0.864603)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 7. Tool System The authoritative execution path is descriptor- and dispatcher-based: A tool descriptor supplies its canonical name, description, argument
2. `technical-paper.md — 7. Tool System` (score 0.862295)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 7. Tool System `src/tools/dispatcher.js` creates or inherits request context, validates arguments, applies source-aware policy and approvals, invokes the
3. `tool-architecture.md — Tool Architecture` (score 0.848872)
   Document: tool-architecture.md Section: Tool Architecture Sidekick's current built-in registry contains 107 tools across 20 categories. Tools execute through a descriptor registry and centralized dispatcher. `src/tools-legacy.js` still cont
4. `tool-architecture.md — Invocation Surfaces` (score 0.843772)
   Document: tool-architecture.md Section: Tool Architecture > Invocation Surfaces Legacy internal tool-to-tool calls in `src/tools-legacy.js`: local `callTool` delegates to the dispatcher. Generated/evolved tool steps in `src/dynamic-tools.js
5. `tool-architecture.md — Dispatcher Pipeline` (score 0.841975)
   Document: tool-architecture.md Section: Tool Architecture > Dispatcher Pipeline Apply timeout and cancellation boundaries where provided. Normalize and sanitize success, validation, policy, approval, timeout, cancellation, handler, and disp

#### Qwen top results

1. `tool-architecture.md — Tool Architecture` (score 0.726841)
   Document: tool-architecture.md Section: Tool Architecture Sidekick's current built-in registry contains 107 tools across 20 categories. Tools execute through a descriptor registry and centralized dispatcher. `src/tools-legacy.js` still cont
2. `tool-architecture.md — Registry Lifecycle` (score 0.662510)
   Document: tool-architecture.md Section: Tool Architecture > Registry Lifecycle Compatibility maps are derived from the registry: `TOOLS` `TOOL_DEFS` schema lookup MCP definitions risk and category metadata for catalog display New production
3. `technical-paper.md — 7. Tool System` (score 0.661890)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 7. Tool System `src/tools/dispatcher.js` creates or inherits request context, validates arguments, applies source-aware policy and approvals, invokes the
4. `tool-architecture.md — Invocation Surfaces` (score 0.654829)
   Document: tool-architecture.md Section: Tool Architecture > Invocation Surfaces Legacy internal tool-to-tool calls in `src/tools-legacy.js`: local `callTool` delegates to the dispatcher. Generated/evolved tool steps in `src/dynamic-tools.js
5. `technical-paper.md — 7. Tool System` (score 0.654101)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 7. Tool System The authoritative execution path is descriptor- and dispatcher-based: A tool descriptor supplies its canonical name, description, argument

#### RRF fused top results

1. `tool-architecture.md — Tool Architecture` (RRF 0.03226646; E5 rank 3; Qwen rank 1)
   Document: tool-architecture.md Section: Tool Architecture Sidekick's current built-in registry contains 107 tools across 20 categories. Tools execute through a descriptor registry and centralized dispatcher. `src/tools-legacy.js` still cont
2. `technical-paper.md — 7. Tool System` (RRF 0.03200205; E5 rank 2; Qwen rank 3)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 7. Tool System `src/tools/dispatcher.js` creates or inherits request context, validates arguments, applies source-aware policy and approvals, invokes the
3. `technical-paper.md — 7. Tool System` (RRF 0.03177806; E5 rank 1; Qwen rank 5)
   Document: technical-paper.md Section: Sidekick: Database-First Remote Agent Platform > 7. Tool System The authoritative execution path is descriptor- and dispatcher-based: A tool descriptor supplies its canonical name, description, argument
4. `tool-architecture.md — Invocation Surfaces` (RRF 0.03125000; E5 rank 4; Qwen rank 4)
   Document: tool-architecture.md Section: Tool Architecture > Invocation Surfaces Legacy internal tool-to-tool calls in `src/tools-legacy.js`: local `callTool` delegates to the dispatcher. Generated/evolved tool steps in `src/dynamic-tools.js
5. `architecture.md — Tool runtime: `src/tools/`` (RRF 0.02985075; E5 rank 7; Qwen rank 7) **[labeled relevant]**
   Document: architecture.md Section: Architecture > Service boundaries > Tool runtime: `src/tools/` responsibilities; `schemas/`, `metadata.js`, and `families/` for schemas, explicit risk/category metadata, and extracted descriptor-owned tool

**Human judgment:** [ ] E5 better  [ ] Qwen better  [ ] Both useful  [ ] Label/chunk issue

---
