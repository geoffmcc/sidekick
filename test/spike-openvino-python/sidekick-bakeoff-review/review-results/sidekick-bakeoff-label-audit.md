# Sidekick retrieval bake-off label audit

## Executive finding

The first bake-off is useful for proving that E5 and Qwen are complementary, but it is not yet reliable enough to choose a permanent retrieval-quality winner.

The largest issue is relevance labeling: the benchmark generally labels one exact documentation section while the corpus contains duplicate or equivalent authoritative answers in other documents. Many apparently poor ranks are therefore false negatives.

The hardware/runtime conclusions remain valid:

- E5-small-v2 qINT8 on CPU is the fast, stable bulk/default embedding path.
- Qwen3-Embedding-0.6B INT8 on the Intel NPU is a stable semantic/deep-search path.
- Python OpenVINO is the production helper runtime.
- `openvino-node` remains rejected because of linear resident-memory growth.
- E5 and Qwen vectors must remain in separate vector spaces.

The quality benchmark should be corrected and rerun before declaring either model the permanent default on relevance alone.

## Benchmark defects to correct

### 1. Relevance labels are too narrow

Queries frequently have several valid answers across canonical documentation, technical documentation, and operational guides. The benchmark usually labels only the originally selected section.

Examples:

- `health_checks` labels only `operations.md > Health checks`, although `tool-usage-guide.md > Operations and diagnostics` and `service.md > Check Status` directly answer the query and rank first and second for both models.
- `sqlite_schema` labels only `data-model.md > SQLite schema`, although `data-model.md > Storage backends` and `platform-architecture-assessment.md > Current Storage Systems` enumerate the stored data.
- `deployment_scripts` labels only `installation.md > Deployment scripts`, while `install.md` contains duplicate deployment-script documentation.
- `service_commands` ignores the directly relevant `service.md` restart/status sections.
- `tool_policy_config` ignores `security.md > Tool permission policy`, which directly explains policy behavior.

These should not count as failures.

### 2. Some query/label pairs do not ask for the content in the labeled chunk

`blackbox_capture` asks how to capture a *time-limited incident bundle*, but the labeled `MCP Actions` chunk mainly lists action names. The query spans capture actions, profiles, and retention behavior. Either:

- rewrite it to “Which Black Box MCP action starts a capture?”, or
- label the relevant `MCP Actions`, `Concepts`, dashboard capture/profile, and retention chunks.

### 3. Duplicate and historical sources compete with canonical documentation

The corpus includes canonical manuals alongside duplicated or potentially historical material such as:

- `technical-paper.md`
- `platform-architecture-assessment.md`
- `project-review.md`
- `install.md`

Production retrieval should attach authority/status metadata to every source. The benchmark should either:

- test canonical operational retrieval using only current canonical documents, or
- label equivalent answers across every retained source.

Do not silently treat an unlabeled historical duplicate as irrelevant.

### 4. Pure semantic retrieval is the wrong only baseline

Many test questions contain exact operational terms: ports, endpoint names, environment variables, table names, section names, and commands. These favor lexical retrieval.

The corrected bake-off should compare:

1. SQLite FTS5/BM25 or equivalent lexical search.
2. E5 CPU vector search.
3. Qwen NPU vector search.
4. Lexical + E5 RRF.
5. Lexical + E5 + Qwen RRF for deep search.

The current dual-embedding RRF result demonstrates complementarity, but it does not test the most obvious exact-match retrieval path.

### 5. The “perfect-router” nDCG value is invalid

The review reports a perfect-router nDCG@10 below the real models. That cannot be interpreted as an upper bound.

The synthetic oracle inserts one relevant ID at the best observed rank, while some queries have multiple relevant IDs and nDCG's ideal denominator expects all of them. Remove oracle nDCG or construct a complete oracle ranking containing every relevant ID.

## Per-query audit

### Correct the labels or query definition

| Query ID | Recommended correction |
|---|---|
| `blackbox_capture` | Rewrite the query or label MCP Actions + Concepts/profile/capture + Retention. |
| `memory_types` | Also label `technical-paper.md > memories` and any canonical structured-memory section that enumerates types. |
| `sqlite_schema` | Label `Data Model`, `Storage backends`, `SQLite schema`, and equivalent current storage/schema summaries. |
| `health_checks` | Label `operations.md > Health checks`, `tool-usage-guide.md > Operations and diagnostics`, and `service.md > Check Status`. |
| `main_components` | Label `overview.md > Main components`, `overview.md > Overview`, and `technical-paper.md > Runtime Components` if retained. |
| `agent_information_access` | Label both README Agent Information Access and the Knowledge base section. |
| `firewall_exposure` | Label installation Firewall and exposure, security Exposure recommendations, and overview Recommended operating model. |
| `deployment_scripts` | Remove the duplicate `install.md` from the canonical corpus or label its equivalent deployment sections. |
| `mcp_server_boundary` | Label architecture MCP server, technical-paper MCP Server, and the component summary when it answers responsibilities. |
| `tool_risk` | Label Risk Behavior, Risk classification, and Policy/Approval Boundary. |
| `dashboard_data_editing` | Label Dashboard Data editing, Main UI areas, API summary, and technical-paper Dashboard where they enumerate editable data. |
| `mcp_authentication` | Also label installation MCP client configuration where bearer-token setup is explained. |
| `service_commands` | Label operations Service commands and service.md Restart/Status sections. |
| `sidekick_core_idea` | Label Core idea plus concise overview/abstract sections that state the same product role. |
| `memory_sync` | Label Cross-Machine Sync plus current implementation/status sections that explain export/import conflict strategies. |
| `recommended_exposure` | Label overview Recommended operating model and security Exposure recommendations. |
| `shared_storage` | Label architecture Shared storage and the data-model overview/storage backend sections. |
| `backup_guidance` | Label data-model Backup guidance and operations Backups. |
| `dashboard_auth` | Label dashboard Authentication and protections plus security Dashboard authentication/protections. |
| `tool_policy_config` | Label configuration Security and tool policy plus security Tool permission policy. |
| `tool_runtime` | Label architecture Tool runtime, tool-architecture registry/dispatcher sections, and technical-paper Tool System if retained. |

### Keep the labels; these are useful hard-query/model signals

| Query ID | Audit judgment |
|---|---|
| `database_query_safety` | Correct narrow target. Both miss top 10; Qwen is less poor at rank 14. |
| `memory_remaining_work` | Correct target. Both models fail badly on a natural paraphrase. |
| `workflow_engine` | Correct target. Both retrieve broad automation material instead of the durable workflow implementation. |
| `redaction` | Qwen shows a genuine advantage by finding the exact section at rank 3. |
| `development_safety` | E5 shows a genuine advantage; exact implementation notes are rank 5 versus Qwen rank 62. |
| `predict_confidence` | Qwen shows a genuine advantage; exact confidence section is rank 3. |
| `agent_safety_limits` | E5 shows a genuine advantage; exact loop-limit section is rank 2. |
| `memory_conflicts` | Qwen shows a genuine advantage; exact supersession section is rank 3. |
| `knowledge_base` | E5 shows a genuine advantage by placing the exact section first. |

### No urgent label correction; both paths are operationally acceptable

- `blackbox_retention`
- `blackbox_security`
- `compute_results`
- `compute_trust`
- `agent_task_lifecycle`
- `evolve_architecture`
- `runtime_ports`

Their exact labeled answers are already near the top for both models; the rank disagreement is not operationally significant.

## Revised architecture recommendation

### Default retrieval

Use lexical search plus E5 CPU:

- lexical search catches exact ports, endpoints, commands, table names, and environment variables;
- E5 supplies inexpensive semantic recall;
- combine by stable document/chunk ID using RRF;
- apply source-authority metadata so canonical current docs rank above historical assessments.

### Deep retrieval

Add Qwen NPU when:

- the user explicitly requests deep or comprehensive retrieval;
- lexical + E5 has weak evidence;
- the query is conceptual, architectural, security-sensitive, or ambiguous;
- an agent needs a second semantic search pass.

Fuse ranks, never cosine scores.

### Indexing metadata

Every chunk should include:

- stable document/chunk ID;
- source path;
- heading path;
- content hash and chunking version;
- authority: canonical, generated-reference, assessment, historical;
- freshness/version;
- E5 vector provenance;
- Qwen vector provenance;
- lexical index version.

## Next benchmark

Rerun after:

1. defining a canonical source allowlist or authority weights;
2. expanding valid relevant IDs;
3. correcting `blackbox_capture`;
4. fixing/removing the oracle nDCG metric;
5. adding a lexical/FTS baseline and lexical fusion;
6. manually reviewing only the remaining genuine misses.

The first run proves complementarity. The corrected run should decide retrieval policy.
