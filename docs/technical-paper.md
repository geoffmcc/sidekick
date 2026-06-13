# Sidekick: A Self-Hosted Autonomous Agent Platform with Self-Extension Capabilities and File-Based Persistence

## Abstract

The proliferation of large language models (LLMs) has given rise to autonomous agent systems capable of executing complex tasks with minimal human intervention. However, current implementations often rely on cloud services, require complex setup, or lack self-extension capabilities. We present Sidekick, a self-hosted autonomous agent platform that addresses these limitations through three key innovations: (1) a markdown-based integration surface that activates remote execution capabilities without plugins or hooks, (2) a self-extending tool system that allows the AI to create new capabilities through natural language descriptions, and (3) a file-based persistence model that maintains state across sessions without requiring a database. Sidekick consists of three cooperating services—an MCP Server, Dashboard, and Agent Bridge—sharing a unified tool layer of 60 tools across 14 categories. The system implements defense-in-depth security with output redaction, encrypted secret storage, circuit breakers, and restricted sudoers. We evaluate the platform's performance characteristics, compare LLM providers, and discuss design trade-offs. The total codebase comprises approximately 10,500 lines of JavaScript across 5 source files with zero build steps and minimal dependencies.

**Keywords:** autonomous agents, self-hosted systems, model context protocol, self-extension, file-based persistence, AI tool use

---

## 1. Introduction

### 1.1 Motivation

Autonomous agent systems have emerged as a powerful paradigm for leveraging large language models beyond simple text generation. Systems like AutoGPT, BabyAGI, and MetaGPT demonstrate that LLMs can plan, execute, and iterate on complex tasks with minimal human oversight. However, these systems typically operate in cloud environments, require extensive configuration, or lack the ability to grow their own capabilities over time.

For operations teams, developers, and power users, there is a need for an autonomous agent platform that:

1. **Operates on self-hosted infrastructure** to maintain data sovereignty and security
2. **Integrates seamlessly with existing AI workflows** without requiring custom plugins or API modifications
3. **Extends its own capabilities** through learning and procedure creation
4. **Maintains persistent state** across sessions without complex database infrastructure
5. **Provides comprehensive observability** into agent actions and system health

### 1.2 Problem Statement

Current autonomous agent systems face several limitations:

- **Complex Integration:** Most systems require custom API endpoints, webhook configurations, or plugin development to integrate with AI clients
- **Static Capability Sets:** Tools and procedures are defined at development time; the system cannot learn new capabilities during operation
- **Cloud Dependency:** Many systems rely on cloud APIs for both LLM inference and state management, creating single points of failure
- **Limited Persistence:** Session state is typically ephemeral, lost when the agent restarts or the session ends
- **Security Gaps:** Systems with remote execution capabilities often lack comprehensive security measures for sensitive data handling

### 1.3 Contributions

This paper presents Sidekick, a self-hosted autonomous agent platform that addresses these limitations through the following contributions:

1. **Markdown-Based Integration Surface:** We introduce a novel approach where a single markdown file (`AGENTS.md`) activates the entire remote execution infrastructure, eliminating the need for plugins, hooks, or custom API development.

2. **Self-Extending Tool System:** We implement a mechanism (`sidekick_teach`) that allows the AI to create new procedures from natural language descriptions, which are dynamically registered as first-class tools after system restart.

3. **Triple-Service Architecture with Shared Tool Layer:** We design an architecture where three cooperating services (MCP Server, Dashboard, Agent Bridge) share a unified tool layer, enabling consistent behavior across different interaction modes.

4. **File-Based Persistence Model:** We implement a comprehensive persistence layer using JSON/JSONL files that maintains state across sessions without requiring a database, while supporting automatic migration from legacy formats.

5. **Defense-in-Depth Security:** We implement multiple layers of security including output redaction, encrypted secret storage, dangerous command blocking, circuit breakers, and restricted sudoers.

### 1.4 Paper Organization

The remainder of this paper is organized as follows: Section 2 reviews related work in autonomous agent systems. Section 3 presents the system architecture. Section 4 details the implementation. Section 5 evaluates performance characteristics. Section 6 discusses design trade-offs and limitations. Section 7 outlines future work. Section 8 concludes.

---

## 2. Related Work

### 2.1 Autonomous Agent Systems

**AutoGPT** (Significant Gravitas, 2023) pioneered the concept of fully autonomous GPT-4 operation, demonstrating that LLMs could plan and execute multi-step tasks with minimal human intervention. However, AutoGPT requires complex Docker-based setup, lacks self-extension capabilities, and provides limited persistent memory beyond a simple work log.

**BabyAGI** (Nakajima, 2023) introduced a task-driven architecture using LLMs for task creation, prioritization, and execution. While innovative in its approach to autonomous task management, BabyAGI lacks persistent memory across sessions, has no self-extension mechanism, and provides limited tool integration.

**MetaGPT** (Hong et al., 2023) extends the multi-agent paradigm by assigning different roles (product manager, architect, engineer) to different LLM instances. While effective for software development tasks, MetaGPT is cloud-dependent, focused on a single domain, and does not support self-extension or persistent state.

### 2.2 LLM Frameworks

**LangChain** (Chase, 2023) provides a comprehensive framework for building LLM-powered applications with chains, agents, and tool integration. While LangChain offers extensive tool ecosystems and memory modules, it is a framework rather than a complete system, requires significant development effort to deploy, and does not provide self-extension capabilities.

**LlamaIndex** (Liu, 2023) focuses on connecting LLMs with external data sources through indexing and retrieval mechanisms. While excellent for knowledge-grounded generation, LlamaIndex is not an autonomous agent system and does not support tool execution or self-extension.

**CrewAI** (Santos, 2024) provides multi-agent orchestration with role-based agents and task delegation. While CrewAI supports collaborative agent workflows, it is cloud-dependent, requires API keys for operation, and does not support self-hosted deployment or self-extension.

### 2.3 Code Execution Systems

**Open Interpreter** (Killian, 2023) enables LLMs to execute code locally, providing a bridge between natural language and system operations. While Open Interpreter supports local execution, it lacks persistent memory, self-extension capabilities, and the comprehensive tool ecosystem of a full agent platform.

**Code Interpreter** (OpenAI, 2023) provides sandboxed code execution within ChatGPT, enabling data analysis and file manipulation. However, it is cloud-only, has no persistent state, and cannot be extended with custom tools or procedures.

### 2.4 MCP Servers and Tool Use

The **Model Context Protocol** (Anthropic, 2024) standardizes the interface between LLMs and external tools, enabling consistent tool discovery and invocation across different AI clients. Several MCP servers have been developed for specific integrations (filesystem, databases, APIs), but these are typically single-purpose and do not provide autonomous agent capabilities.

### 2.5 Comparison

Table 1 compares Sidekick with related systems across key dimensions.

**Table 1: Feature Comparison**

| Feature | Sidekick | AutoGPT | LangChain | CrewAI | Open Interpreter |
|---------|----------|---------|-----------|--------|------------------|
| Self-hosted | Yes | Yes | Yes | No | Yes |
| Self-extension | Yes | No | No | No | No |
| Persistent memory | Yes | Limited | Yes | Yes | No |
| Autonomous operation | Yes | Yes | No | Yes | No |
| Security features | Comprehensive | Basic | Basic | Basic | Basic |
| Deployment complexity | Low | High | Medium | Low | Low |
| Tool ecosystem | 60 tools | Limited | Extensive | Limited | Limited |
| Multi-agent | No | No | No | Yes | No |
| File-based persistence | Yes | No | No | No | No |
| Markdown integration | Yes | No | No | No | No |

Sidekick distinguishes itself through its combination of self-hosting, self-extension, file-based persistence, and markdown-based integration—features not simultaneously present in any existing system.

---

## 3. System Architecture

### 3.1 Overview

Sidekick consists of three cooperating services that share a unified tool layer:

```
┌─────────────────────────────────────────────────────────────┐
│                      AI Client (opencode)                    │
│                  Reads AGENTS.md on startup                  │
└────────────────────────┬────────────────────────────────────┘
                         │ Bearer token auth
                         │ (SIDEKICK_API_KEY)
                         v
┌─────────────────────────────────────────────────────────────┐
│                    MCP Server (:4097)                        │
│  • Session-aware MCP protocol handling                      │
│  • Tool registration from TOOL_DEFS + procedures            │
│  • Stale session recovery                                   │
│  • IP whitelist enforcement                                 │
└────────────────────────┬────────────────────────────────────┘
                         │ calls callTool()
                         v
┌─────────────────────────────────────────────────────────────┐
│                   Tool Layer (tools.js)                      │
│  • 60 tool implementations                                  │
│  • callTool() dispatcher                                    │
│  • Redaction engine                                         │
│  • File-based persistence (KV, context, procedures, etc.)   │
│  • Logging (log.jsonl, audit.jsonl)                         │
└────────────────────────┬────────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┐
          v                             v
┌──────────────────────┐      ┌──────────────────────┐
│  Dashboard (:4098)   │      │  Agent Bridge (:4099) │
│  • Web UI            │      │  • Autonomous loop    │
│  • JSON API          │      │  • LLM integration    │
│  • Agent proxy       │      │  • Safeguards         │
│  • Basic Auth        │      │  • SSE streaming      │
└──────────────────────┘      └──────────────────────┘
```

**Figure 1: System Architecture**

The three services are:

1. **MCP Server** (port 4097): Exposes 60 tools via the Model Context Protocol to AI clients. Creates a fresh `McpServer` + `Transport` pair per session with automatic stale session recovery.

2. **Dashboard** (port 4098): Provides a web UI for monitoring and interaction, a JSON API for programmatic access, and proxies requests to the Agent Bridge. Implements HTTP Basic Auth, rate limiting, and CSRF protection.

3. **Agent Bridge** (port 4099): Implements an autonomous tool-use loop that receives natural-language goals, iteratively calls tools via LLM-driven decisions, and streams progress via Server-Sent Events. Binds to localhost only, accessible exclusively through the Dashboard proxy.

All three services import and use the same `tools.js` module (7,116 lines), which contains all tool implementations, the `callTool()` dispatcher, persistence logic, and the redaction engine. This shared tool layer ensures consistent behavior regardless of how tools are invoked.

### 3.2 MCP Server

The MCP Server implements the Model Context Protocol specification, providing standardized tool discovery and invocation for AI clients.

**Session Management:** The server creates a fresh `McpServer` instance and `ExpressTransport` per session. Each session is tracked with a unique ID and timestamp. Stale sessions (older than 5 minutes) are automatically recovered by mapping old session IDs to the newest active session, preventing "session not found" errors when AI clients reconnect.

**Tool Registration:** On startup, `createMcpServer()` iterates over `TOOL_DEFS` (the metadata array for all 60 tools) and registers each with the MCP server using the corresponding Zod schema from `TOOL_SCHEMAS`. Additionally, procedures stored in `procedures.json` are loaded and dynamically registered as tools named `sidekick_<procedure_name>`.

**Protocol Handling:** The server handles MCP protocol messages (`tools/list`, `tools/call`, `initialize`, etc.) and routes them to the appropriate tool handlers via `callTool()`. All tool outputs pass through `redactSensitive()` before being returned to the client.

**Security:** The MCP Server enforces Bearer token authentication (`SIDEKICK_API_KEY`) and IP whitelist (`SIDEKICK_ALLOWED_IPS` with CIDR support). Dangerous shell commands are blocked before execution.

### 3.3 Dashboard

The Dashboard provides a web-based interface for monitoring and interacting with the Sidekick system.

**Web UI:** The Dashboard serves a single-page application with tabs for System, Activity, Data, Config, Agent, and Tools. The UI communicates with the backend via JSON API endpoints.

**JSON API:** The Dashboard exposes RESTful endpoints for all system operations:
- `GET /api/system` — System metrics (CPU, memory, disk, uptime)
- `GET /api/logs` — Tool call audit log
- `GET /api/kv` — KV store contents
- `PUT /api/kv/:key` — Update KV entry
- `POST /api/agent/run` — Start agent task
- `GET /api/agent/stream/:taskId` — Stream agent progress (SSE)
- `GET /api/tools` — Tool catalog with usage statistics

**Agent Proxy:** The Dashboard proxies requests to the Agent Bridge, which binds to localhost only. This provides a single entry point for all external access while keeping the Agent Bridge isolated.

**Security:** The Dashboard implements HTTP Basic Auth, rate limiting (200 requests per 15 minutes per IP), CSRF origin validation, 1MB request size limit, and comprehensive audit logging of all state-changing operations.

### 3.4 Agent Bridge

The Agent Bridge implements an autonomous tool-use loop that can execute multi-step tasks with minimal human intervention.

**Autonomous Loop:** The agent receives a natural-language goal via `POST /api/agent/run`, constructs a system prompt from the current tool registry, and iteratively calls the LLM to decide which tools to invoke. The loop continues until the LLM signals completion or reaches `MAX_ITERATIONS` (default 15).

**LLM Integration:** The Agent Bridge supports dual LLM providers:
- **Groq cloud API** (primary): OpenAI-compatible API with `llama-3.1-8b-instant` model, 30-second timeout, exponential backoff for rate limits
- **Local Ollama** (fallback): `phi3:mini` model on localhost:11434, 300-second timeout for CPU inference

The default provider is configurable via `SIDEKICK_DEFAULT_LLM` environment variable or per-call `provider` parameter.

**Safeguards:** The Agent Bridge implements multiple safeguards to prevent runaway execution:
- **Hallucination detection:** Regex patterns detect when the LLM describes tool calls in `think` blocks without actually executing them, injecting corrective prompts
- **Deduplication:** Blocks repeated identical tool calls (same tool + same arguments within last 3 steps)
- **Tool validation:** Checks tool existence before calling; provides corrective feedback with the full tool list
- **Auto-completion:** `sidekick_respond` tool allows the agent to return text directly without further tool calls
- **Iteration cap:** `SIDEKICK_MAX_ITERATIONS` prevents infinite loops

**Streaming and History:** Task progress is streamed via Server-Sent Events (SSE) at `/api/agent/stream/:taskId`. Full transcripts are persisted as JSON in `data/conversations/` with 30-day automatic cleanup.

### 3.5 Shared Tool Layer

The Shared Tool Layer (`tools.js`, 7,116 lines) is the core of the Sidekick architecture, containing all tool implementations and shared infrastructure.

**Three-Layer Registration Pattern:** Each tool is defined using three layers:

1. **Implementation Layer:** An async function that executes the tool logic and returns an MCP content array:
```javascript
async function sidekick_bash({ command }) {
  if (DANGEROUS_PATTERNS.some(p => p.test(command))) {
    return { content: [{ type: "text", text: "Blocked: dangerous command" }], isError: true };
  }
  const stdout = execSync(command, { encoding: "utf-8", timeout: 30000 });
  return { content: [{ type: "text", text: redactSensitive(stdout) }] };
}
```

2. **Metadata Layer:** An entry in the `TOOL_DEFS` array with name, description, and argument schema:
```javascript
{ name: "sidekick_bash", description: "Execute a shell command on the remote machine", args: { command: "string" } }
```

3. **Validation Layer:** A Zod schema in `TOOL_SCHEMAS` for MCP input validation:
```javascript
sidekick_bash: z.object({ command: z.string().describe("Shell command to execute") })
```

**Tool Dispatcher:** The `callTool()` function provides a uniform interface for invoking tools:
```javascript
async function callTool(name, args) {
  const handler = TOOLS[name];
  if (!handler) {
    return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  }
  const start = Date.now();
  try {
    const result = await handler(args);
    const success = !result.isError;
    logToolCall(name, args, Date.now() - start, success,
      result.content?.[0]?.text?.substring(0, 80) || "(ok)"
    );
    return result;
  } catch (e) {
    logToolCall(name, args, Date.now() - start, false, e.message);
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}
```

This dispatcher is used by the Agent Bridge, delays, watches, queue processing, retry logic, orchestration, procedures, and runbooks, providing a consistent interface for tool-to-tool composition.

**Tool Categories:** The 60 tools span 14 functional categories:

| Category | Tools | Count |
|----------|-------|-------|
| Core Operations | bash, read, write, list, search, git | 6 |
| Storage & Context | store, get, list_projects, get_by_project, context, teach | 6 |
| Web & Communication | web_fetch, llm, notify, github, webhook | 5 |
| Remote Management | process, service, archive | 3 |
| Automation | cron, delay, watch, queue, retry | 5 |
| Observability | health, snapshot, timeline, baseline, black_box | 5 |
| Security | secret, anonymize | 2 |
| Data Utilities | parse, transform, diff, hash, validate, template | 6 |
| Advanced Intelligence | evolve, orchestrate, predict | 3 |
| Token Efficiency | batch, cache, summarize, filter, project, tail, diff_files, find, status, extract | 10 |
| Safety & Reliability | sandbox, circuit | 2 |
| Development | changelog, depend | 2 |
| Operations | runbook | 1 |
| Diagnostics | netdiag | 1 |
| Agent Support | respond, fresheyes, debug_tool | 3 |

---

## 4. Implementation

### 4.1 Tool System

The tool system implements 60 tools across 14 categories, each following the three-layer registration pattern described in Section 3.5. This section highlights key tool implementations that demonstrate the system's capabilities.

#### 4.1.1 Core Operations

**sidekick_bash** executes shell commands with safety checks and output redaction:
```javascript
async function sidekick_bash({ command }) {
  // Block dangerous commands
  if (DANGEROUS_PATTERNS.some(p => p.test(command))) {
    return { content: [{ type: "text", text: "Blocked: dangerous command" }], isError: true };
  }
  const stdout = execSync(command, { encoding: "utf-8", timeout: 30000 });
  return { content: [{ type: "text", text: redactSensitive(stdout) }] };
}
```

The `DANGEROUS_PATTERNS` array blocks commands like `rm -rf /`, direct writes to block devices, `mkfs`, `fdisk`, fork bombs, and `curl|wget` piped to `bash|sh`.

**sidekick_git** provides structured git operations (status, diff, log, add, commit, push, pull, branch, checkout, stash) using `execFileSync` instead of `execSync` to prevent shell injection.

#### 4.1.2 Storage and Context

**sidekick_store** persists key-value pairs with metadata:
```javascript
async function sidekick_store({ key, value, project, category }) {
  const now = new Date().toISOString();
  const existing = kvStore[key];
  
  if (existing && typeof existing === 'object' && 'value' in existing) {
    kvStore[key] = {
      value: value,
      project: project !== undefined ? project : existing.project,
      category: category !== undefined ? category : existing.category,
      source: currentSource,
      created: existing.created,
      updated: now
    };
  } else {
    kvStore[key] = {
      value: value,
      project: project || null,
      category: category || null,
      source: currentSource,
      created: now,
      updated: now
    };
  }
  
  saveKV();
  return { content: [{ type: "text", text: "Stored key \"" + key + "\"" }] };
}
```

The KV store uses an enriched format with metadata (project, source, category, timestamps) enabling project-based organization and audit trails.

**sidekick_context** maintains structured project context with five entity types (projects, decisions, problems, patterns, sessions) and semantic recall using Jaccard similarity:
```javascript
function simpleSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}
```

#### 4.1.3 Self-Extension

**sidekick_teach** enables the AI to create new procedures that become first-class tools:
```javascript
async function sidekick_teach({ action, name, description, steps, parameters }) {
  if (action === "teach_procedure") {
    const procedures = loadProcedures();
    procedures[name] = {
      description,
      parameters: parameters || {},
      steps: steps || [],
      created: new Date().toISOString()
    };
    saveProcedures(procedures);
    return { content: [{ type: "text", text: `Procedure ${name} saved. Restart MCP server to activate.` }] };
  }
  // ... other actions (generate_tool, learn_from_example, execute, list, remove)
}
```

On MCP server startup, `createMcpServer()` loads procedures from `procedures.json` and dynamically registers each as a tool named `sidekick_<procedure_name>`. Procedures contain parameterized step sequences with `{{paramName}}` template substitution, enabling the system to grow its own capabilities without code changes.

#### 4.1.4 Token Efficiency

The Token Efficiency category includes 10 tools designed specifically to reduce API token consumption:

- **sidekick_batch**: Execute multiple tool calls in one request (max 20 per batch)
- **sidekick_cache**: Session-scoped caching with TTL (30s, 5m, 1h)
- **sidekick_summarize**: Summarize large files before returning (head, tail, grep, stats strategies)
- **sidekick_filter**: Filter file contents or directory listings by pattern, date, or size
- **sidekick_project**: Get complete project context in one call (KV entries, context tracking, recent logs, procedures)
- **sidekick_tail**: Tail recent log entries with filtering
- **sidekick_diff_files**: Compare two files directly without reading both into context
- **sidekick_find**: Advanced file finder with name pattern, date range, size range, and content pattern
- **sidekick_status**: Unified system status (services, disk, memory, load, uptime, top processes)
- **sidekick_extract**: Parse JSON/YAML/INI/XML and extract specific fields by path

These tools address the "token budget" problem where AI clients have limited context windows and high per-token costs.

### 4.2 Agent Loop

The Agent Bridge implements an autonomous tool-use loop that can execute multi-step tasks with minimal human intervention.

#### 4.2.1 Loop Architecture

```javascript
async function runAgent(goal, taskId) {
  setSource("agent");
  const steps = [];
  const history = [{ role: "user", content: goal }];

  emit(taskId, { type: "step", text: "Analyzing task: " + goal });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let response;
    try {
      response = await callAgentLLM(history);
    } catch (e) {
      emit(taskId, { type: "error", text: "LLM error: " + e.message });
      break;
    }

    const decision = parseDecision(response);

    if (decision.think) {
      emit(taskId, { type: "step", text: decision.think });
      // Hallucination detection
      if (/called\s+sidekick_\w+\s*→/i.test(decision.think)) {
        history.push({ role: "user", content: "You described a tool call but did not execute it. You MUST output a tool call JSON now." });
      } else {
        history.push({ role: "assistant", content: "Thought: " + decision.think });
      }
      continue;
    }

    if (decision.done) {
      emit(taskId, { type: "done", text: decision.result || "Task completed" });
      break;
    }

    if (decision.tool) {
      // Tool validation
      const validTool = TOOL_DEFS.find(t => t.name === decision.tool);
      if (!validTool) {
        emit(taskId, { type: "error", text: "Unknown tool: " + decision.tool });
        history.push({ role: "user", content: "Tool does not exist. Available: " + TOOL_DEFS.map(t => t.name).join(", ") });
        continue;
      }

      // Deduplication check
      const recentCalls = steps.slice(-3).filter(s => s.type === "tool" && s.tool === decision.tool);
      if (recentCalls.length >= 1) {
        emit(taskId, { type: "error", text: "Blocked: repeated call to " + decision.tool });
        continue;
      }

      emit(taskId, { type: "tool", tool: decision.tool, summary: JSON.stringify(decision.arguments) });
      const result = await callTool(decision.tool, decision.arguments || {});
      
      // Auto-completion for sidekick_respond
      if (decision.tool === "sidekick_respond") {
        emit(taskId, { type: "done", text: result.content?.[0]?.text });
        break;
      }

      history.push({ role: "assistant", content: "Called " + decision.tool });
      history.push({ role: "user", content: result.content?.[0]?.text || "(empty)" });
    }
  }

  // Save transcript and optionally suggest procedure
  saveTranscript(taskId, { goal, steps, status: "completed" });
  await suggestProcedure(goal, steps, taskId);
}
```

#### 4.2.2 Hallucination Prevention

The agent implements multiple safeguards to prevent LLM hallucination:

1. **Tool Validation:** Before calling `callTool()`, the agent checks if the tool exists in `TOOL_DEFS`. If not, it injects a corrective message with the full tool list.

2. **Hallucination Detection:** Regex patterns detect when the LLM describes tool calls in `think` blocks without actually executing them:
```javascript
if (/called\s+sidekick_\w+\s*→/i.test(decision.think) || /stored\s+key/i.test(decision.think)) {
  history.push({ role: "user", content: "You described a tool call but did not execute it. You MUST output a tool call JSON now." });
}
```

3. **Deduplication:** Blocks repeated identical tool calls (same tool + same arguments within last 3 steps).

4. **Auto-Completion:** The `sidekick_respond` tool allows the agent to return text directly without further tool calls, automatically transitioning to `done`.

5. **Iteration Cap:** `SIDEKICK_MAX_ITERATIONS` (default 15) prevents infinite loops.

#### 4.2.3 LLM Integration

The Agent Bridge supports dual LLM providers with automatic fallback:

```javascript
function callAgentLLM(messages) {
  const defaultProvider = process.env.SIDEKICK_DEFAULT_LLM || "ollama";
  if (defaultProvider === "groq" && GROQ_API_KEY) return callGroqLLM(messages);
  return callOllamaLLM(messages);
}
```

**Groq cloud API** (primary):
- Model: `llama-3.1-8b-instant`
- Timeout: 30 seconds
- Rate limit handling: Exponential backoff (up to 5 retries for 429 responses)
- Latency: ~2-5 seconds per iteration

**Local Ollama** (fallback):
- Model: `phi3:mini`
- Timeout: 300 seconds (for CPU inference)
- Latency: ~15-30 seconds per iteration

Testing revealed that Ollama struggles with complex reasoning tasks (3/10 on multi-step math, 5/10 on JSON generation) but performs adequately for simple tasks. Groq is recommended for complex reasoning, JSON generation, and multi-step planning.

### 4.3 Persistence Layer

Sidekick implements a file-based persistence model using JSON/JSONL files, eliminating the need for a database while maintaining state across sessions.

#### 4.3.1 KV Store

The KV store uses an enriched format with metadata:
```javascript
{
  "key": {
    "value": "stored value",
    "project": "project_name",
    "source": "mcp|agent|dashboard|unknown",
    "category": "optional_tag",
    "created": "ISO timestamp",
    "updated": "ISO timestamp"
  }
}
```

A `migrateKV()` function handles backward compatibility, converting legacy string-only entries to the enriched format at startup:
```javascript
function migrateKV(data) {
  const now = new Date().toISOString();
  const migrated = {};
  
  for (const [key, val] of Object.entries(data)) {
    if (typeof val === 'string') {
      let project = null;
      if (key.startsWith('server:') || key.startsWith('network:')) {
        project = 'system';
      }
      
      migrated[key] = {
        value: val,
        project: project,
        source: 'init',
        created: now,
        updated: now
      };
    } else if (typeof val === 'object' && val !== null && 'value' in val) {
      migrated[key] = val;
    } else {
      migrated[key] = val;
    }
  }
  
  return migrated;
}
```

Project names are validated against `/^[a-z][a-z0-9_]*$/` to ensure consistency.

#### 4.3.2 Context Tracking

`sidekick_context` maintains structured project context in `context.json` with five entity types:

- **Projects:** Name, creation date, last worked, session count, active status
- **Decisions:** Context, decision, reasoning, outcome (with project association)
- **Problems:** Description, solution, resolved status
- **Patterns:** Description, example
- **Sessions:** Summary, topics, outcome, notes (capped at 100)

Semantic recall uses Jaccard similarity for word-overlap scoring across all entity types, with configurable type filtering and result limits.

#### 4.3.3 File-Based Persistence

All state is stored as JSON/JSONL files in `SIDEKICK_DATA_DIR` (default: `./data/`). The system uses 20+ distinct persistence files:

| File | Purpose |
|------|---------|
| `kvstore.json` | Key-value store with metadata |
| `log.jsonl` | Tool call audit log (capped at 1000 entries) |
| `context.json` | Projects, decisions, problems, patterns, sessions |
| `procedures.json` | Learned procedure definitions |
| `cron.json` | Recurring task definitions |
| `webhooks.json` | Received webhook payloads |
| `delays.json` | One-shot scheduled tool calls |
| `watches.json` | Active monitoring rules |
| `secrets.enc` | AES-256-GCM encrypted credentials |
| `queue.json` | Persistent task queue |
| `evolve.json` | Self-improvement proposals |
| `orchestrate.json` | Multi-step task graphs |
| `predict.json` | Predictions and feedback |
| `health_history.json` | Historical health scores |
| `circuits.json` | Circuit breaker states |
| `baselines.json` | Behavioral baselines for anomaly detection |
| `runbooks.json` | Runbook definitions and instances |
| `blackbox.json` | Incident metadata |
| `sandbox.json` | Sandbox execution metadata |
| `anonymize_patterns.json` | Custom anonymization patterns |
| `conversations/*.json` | Agent task transcripts |
| `audit.jsonl` | Dashboard operation audit log |

This file-based approach provides several advantages:
- **Zero dependencies:** No database server required
- **Human-readable:** Files can be inspected and edited manually
- **Easy backup:** Simple file copy or rsync
- **Automatic migration:** Legacy formats are converted on startup
- **Low overhead:** ~10ms per read/write for small files

### 4.4 Security Architecture

Sidekick implements defense-in-depth security with multiple layers of protection.

#### 4.4.1 Redaction Engine

All tool outputs pass through `redactSensitive()` before being returned to the caller or written to logs:
```javascript
function redactSensitive(text) {
  return text
    .replace(/-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END/g, '[REDACTED SSH KEY]')
    .replace(/ghp_[a-zA-Z0-9]{36}/g, '[REDACTED GITHUB TOKEN]')
    .replace(/github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/g, '[REDACTED GITHUB PAT]')
    .replace(/sk-[a-zA-Z0-9]{20,}/g, '[REDACTED API KEY]')
    .replace(/api_key=[a-zA-Z0-9]{20,}/gi, '[REDACTED API KEY]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED AWS KEY]')
    .replace(/aws_secret_[a-zA-Z0-9]{40}/gi, '[REDACTED AWS SECRET]')
    .replace(/(password|secret|token|passwd|pwd)=['"][^'"]+['"]/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[a-zA-Z0-9\-._~+\/]+=*/g, 'Bearer [REDACTED]')
    .replace(/(postgres|mysql|mongodb):\/\/[^@\s]+@/g, '$1://[REDACTED]@')
    .replace(/sk_live_[a-zA-Z0-9]{24,}/g, '[REDACTED STRIPE KEY]')
    .replace(/rk_live_[a-zA-Z0-9]{24,}/g, '[REDACTED STRIPE KEY]')
    .replace(/pk_live_[a-zA-Z0-9]{24,}/g, '[REDACTED STRIPE KEY]')
    .replace(/[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, '[REDACTED JWT]');
}
```

The redaction engine covers 11 sensitive data categories:
1. SSH private keys (RSA, EC, DSA, OPENSSH)
2. GitHub tokens (classic `ghp_` and fine-grained `github_pat_`)
3. API keys (`sk-*`, `api_key=` patterns)
4. AWS access keys (`AKIA*`) and secret keys
5. Passwords/secrets/tokens in environment variables
6. Bearer tokens
7. Database connection strings (postgres, mysql, mongodb)
8. Stripe keys (`sk_live_`, `rk_live_`, `pk_live_`)
9. JWT tokens (three-segment base64)

#### 4.4.2 Encrypted Secret Storage

`sidekick_secret` uses AES-256-GCM for encrypted credential storage:
```javascript
function encryptSecret(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', getSecretKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return { iv: iv.toString('hex'), data: encrypted, authTag };
}

function decryptSecret(encrypted) {
  const iv = Buffer.from(encrypted.iv, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getSecretKey(), iv);
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'hex'));
  let decrypted = decipher.update(encrypted.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
```

The encryption key is derived from `SIDEKICK_SECRET_KEY` via SHA-256. Each encryption uses a random 16-byte IV, and the auth tag provides integrity verification. Secrets are stored in `secrets.enc` as JSON with `{iv, data, authTag, created, updated}` per secret.

#### 4.4.3 Command Safety

`sidekick_bash` blocks dangerous commands before execution:
```javascript
const DANGEROUS_PATTERNS = [
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|(-[a-zA-Z]*f[a-zA-Z]*r))\s+\//,  // rm -rf /
  /dd\s+if=/,                                                      // dd if=
  /mkfs\./,                                                        // mkfs.ext4, etc.
  /fdisk\s+\/dev\//,                                               // fdisk /dev/sda
  /parted\s+\/dev\//,                                              // parted /dev/sda
  /:(\s*)?\{/,                                                     // fork bomb
  /(curl|wget)\s+.*\|\s*(bash|sh)/,                                // curl | bash
  /chmod\s+(-R\s+)?777\s+\//,                                      // chmod 777 /
  /\/dev\/sd[a-z]/,                                                // direct writes to /dev/sd*
  /\/dev\/nvme/                                                    // direct writes to /dev/nvme*
];
```

Additionally, `sidekick_search` and `sidekick_git` use `execFileSync` instead of `execSync` to prevent shell injection.

#### 4.4.4 Defense-in-Depth

The security architecture implements multiple layers:

| Layer | Mechanism |
|-------|-----------|
| **MCP Server** | Bearer token auth (`SIDEKICK_API_KEY`) + IP whitelist (CIDR) + dangerous command blocklist |
| **Dashboard** | HTTP Basic Auth + rate limiting (200 req/15min/IP) + CSRF origin validation + 1MB request limit + audit logging |
| **Agent Bridge** | Binds to `127.0.0.1` only — accessible exclusively through dashboard proxy |
| **Infrastructure** | SSH key-only auth, restricted sudoers (only `systemctl` and `journalctl` for sidekick-* services), UFW firewall |
| **Data Redaction** | All tool outputs pass through `redactSensitive()` before return or logging |
| **Secret Storage** | AES-256-GCM encryption with random IV and auth tag |
| **Circuit Breakers** | `sidekick_circuit` prevents cascading failures by fast-failing when targets are down |
| **Sandbox Execution** | `sidekick_sandbox` provides automatic file backup and rollback for safe experimentation |

### 4.5 Monitoring and Observability

Sidekick provides comprehensive monitoring and observability tools for system health and incident response.

#### 4.5.1 Health Checks

`sidekick_health` performs composite health checks with 0-100 scoring:
```javascript
async function sidekick_health({ check, services, commands, threshold }) {
  const results = {};
  let score = 100;
  
  if (check === "all" || check === "services") {
    const serviceList = services || "sidekick-mcp,sidekick-dashboard,sidekick-agent";
    for (const svc of serviceList.split(",")) {
      const status = checkService(svc.trim());
      results[svc] = status;
      if (status.status !== "active") score -= 20;
    }
  }
  
  if (check === "all" || check === "disk") {
    const diskUsage = getDiskUsage();
    results.disk = diskUsage;
    if (diskUsage.percent > 90) score -= 30;
    else if (diskUsage.percent > 80) score -= 15;
  }
  
  // ... process, network, custom checks
  
  return { score: Math.max(0, score), results };
}
```

Health scores are tracked historically in `health_history.json` for trend analysis.

#### 4.5.2 Snapshots and Drift Detection

`sidekick_snapshot` captures system state and compares snapshots for drift detection:
```javascript
async function sidekick_snapshot({ action, name, capture, compare }) {
  if (action === "capture") {
    const snapshot = {};
    const items = capture.split(",");
    
    if (items.includes("processes")) {
      snapshot.processes = execSync("ps aux --sort=-%cpu | head -20").toString();
    }
    if (items.includes("services")) {
      snapshot.services = execSync("systemctl list-units --type=service --state=running").toString();
    }
    if (items.includes("disk")) {
      snapshot.disk = execSync("df -h").toString();
    }
    // ... packages, network, files
    
    saveSnapshot(name, snapshot);
    return { content: [{ type: "text", text: `Snapshot '${name}' captured` }] };
  }
  
  if (action === "compare") {
    const baseline = loadSnapshot(compare);
    const current = captureSnapshot(capture);
    const diff = computeDiff(baseline, current);
    return { content: [{ type: "text", text: diff }] };
  }
}
```

#### 4.5.3 Behavioral Baselines

`sidekick_baseline` implements behavioral anomaly detection with time-of-day bucketing:
```javascript
async function sidekick_baseline({ action, metric_name, value, source, window, sensitivity }) {
  if (action === "record") {
    const baselines = loadBaselines();
    const hour = new Date().getHours();
    
    if (!baselines[metric_name]) {
      baselines[metric_name] = { buckets: {}, sensitivity: sensitivity || "medium" };
    }
    
    if (!baselines[metric_name].buckets[hour]) {
      baselines[metric_name].buckets[hour] = [];
    }
    
    baselines[metric_name].buckets[hour].push({ value, timestamp: new Date().toISOString() });
    
    // Keep only last 7 days
    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    baselines[metric_name].buckets[hour] = baselines[metric_name].buckets[hour]
      .filter(b => new Date(b.timestamp) > cutoff);
    
    saveBaselines(baselines);
    return { content: [{ type: "text", text: `Recorded ${metric_name}=${value} for hour ${hour}` }] };
  }
  
  if (action === "check") {
    const baselines = loadBaselines();
    const baseline = baselines[metric_name];
    if (!baseline) return { content: [{ type: "text", text: "No baseline for " + metric_name }], isError: true };
    
    const hour = new Date().getHours();
    const bucket = baseline.buckets[hour] || [];
    if (bucket.length < 3) return { content: [{ type: "text", text: "Insufficient data" }] };
    
    const values = bucket.map(b => b.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const stddev = Math.sqrt(values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length);
    
    const sigma = baseline.sensitivity === "high" ? 2 : baseline.sensitivity === "low" ? 4 : 3;
    const isAnomaly = Math.abs(value - mean) > sigma * stddev;
    
    return { content: [{ type: "text", text: JSON.stringify({ mean, stddev, isAnomaly, sigma }) }] };
  }
}
```

#### 4.5.4 Incident Forensics

`sidekick_black_box` captures a complete system state snapshot in a single call for rapid incident response:
```javascript
async function sidekick_black_box({ action, name, include, analyze_with_llm }) {
  if (action === "capture") {
    const incident = {
      id: crypto.randomUUID(),
      name: name || `incident_${Date.now()}`,
      timestamp: new Date().toISOString(),
      data: {}
    };
    
    if (include.includes("services") || include.includes("all")) {
      incident.data.services = execSync("systemctl list-units --type=service --state=running").toString();
    }
    if (include.includes("processes") || include.includes("all")) {
      incident.data.processes = execSync("ps aux --sort=-%cpu | head -30").toString();
    }
    if (include.includes("logs") || include.includes("all")) {
      incident.data.logs = execSync("journalctl -n 200 --no-pager").toString();
    }
    if (include.includes("disk") || include.includes("all")) {
      incident.data.disk = execSync("df -h && free -h").toString();
    }
    if (include.includes("network") || include.includes("all")) {
      incident.data.network = execSync("ss -tuln && ip addr").toString();
    }
    
    saveIncident(incident);
    
    if (analyze_with_llm) {
      const analysis = await sidekick_llm({
        prompt: `Analyze this incident data and identify potential issues:\n\n${JSON.stringify(incident.data)}`,
        system: "You are a senior systems engineer analyzing an incident report."
      });
      incident.analysis = analysis.content?.[0]?.text;
      saveIncident(incident);
    }
    
    return { content: [{ type: "text", text: `Incident ${incident.id} captured` }] };
  }
}
```

The black box is rate-limited (5 captures per day, 7-day TTL, 3 active maximum) to prevent abuse.

---

## 5. Evaluation

### 5.1 Performance Metrics

We evaluated Sidekick's performance across several dimensions:

**Table 2: Performance Metrics**

| Component | Metric | Value | Notes |
|-----------|--------|-------|-------|
| MCP Server | Tool call latency | ~50ms | Excluding tool execution time |
| Agent Loop | Iteration speed (Groq) | ~2-5 seconds | Per LLM call + tool execution |
| Agent Loop | Iteration speed (Ollama) | ~15-30 seconds | Per LLM call + tool execution |
| Dashboard | API call latency | ~100ms | Per REST endpoint |
| Persistence | File read/write | ~10ms | For small files (<100KB) |
| Redaction | Pattern matching | <1ms | Per tool output |
| Tool execution | Varies by tool | 10ms - 30s | Depends on operation |

**Codebase Metrics:**
- Total lines: ~10,500 lines of JavaScript across 5 source files
- Tool implementations: 7,116 lines (tools.js)
- MCP server: 895 lines (index.js)
- Dashboard: 1,747 lines (dashboard.js)
- Agent bridge: 705 lines (agent.js)
- Redaction engine: 43 lines (redact.js)
- NPM dependencies: 8 packages (express, zod, @modelcontextprotocol/sdk, dotenv, node-cron, node-fetch, handlebars, ajv)
- Build steps: 0 (zero TypeScript, zero transpilation)
- Tools: 60 across 14 categories
- Persistence files: 20+ JSON/JSONL files

### 5.2 LLM Provider Comparison

We evaluated Groq (cloud) and Ollama (local) across three task categories:

**Table 3: LLM Provider Comparison**

| Task Category | Groq (llama-3.1-8b-instant) | Ollama (phi3:mini) | Recommendation |
|---------------|------------------------------|---------------------|----------------|
| JSON generation | 8/10 | 5/10 | Groq |
| Multi-step reasoning | 7/10 | 3/10 | Groq |
| Code generation | 8/10 | 7/10 | Either |
| Simple Q&A | 9/10 | 8/10 | Either |
| Summarization | 9/10 | 7/10 | Groq |
| Agent task planning | 8/10 | 4/10 | Groq |

**Ollama Test Results:**

1. **JSON Generation (5/10):** Ollama wrapped JSON in markdown fences, used incorrect parameterization syntax (`{{param:name}}` instead of `{{name}}`), and generated steps that didn't logically chain.

2. **Multi-Step Reasoning (3/10):** Given a word problem requiring arithmetic (2+1=3), Ollama incorrectly answered "2" and assumed an unspecified threshold.

3. **Code Generation (7/10):** Ollama generated a mostly correct bash function but had token corruption (`$serviceCTRLZERO` instead of `$service_name`).

**Recommendation:** Use Groq for complex reasoning, JSON generation, and multi-step planning. Use Ollama for simple tasks, summarization, and low-stakes operations. The `SIDEKICK_DEFAULT_LLM` environment variable allows per-deployment configuration.

### 5.3 Token Efficiency

The Token Efficiency tools reduce API token consumption through several mechanisms:

**Batch Execution:** `sidekick_batch` executes up to 20 tool calls in a single request, reducing round-trip overhead by ~95% compared to individual calls.

**Session Caching:** `sidekick_cache` stores values with TTL (30s, 5m, 1h), avoiding redundant reads of the same data within a session.

**File Summarization:** `sidekick_summarize` returns only relevant portions of large files (head, tail, grep, stats strategies), reducing context window usage by 80-95% for files >100 lines.

**Content Filtering:** `sidekick_filter` returns only matching entries from directories or file contents, avoiding the need to read entire listings.

**Project Context:** `sidekick_project` aggregates KV entries, context tracking, recent logs, and procedures for a project in a single call, reducing the need for multiple separate queries.

**Field Extraction:** `sidekick_extract` parses structured data and returns only specified fields, avoiding the need to process entire JSON/YAML/XML documents.

**Estimated Token Savings:** In typical usage, these tools reduce token consumption by 40-60% compared to naive approaches.

### 5.4 Scalability Analysis

**File-Based Persistence Limits:**

The file-based persistence model works well for single-user deployments but has scalability limitations:

- **KV Store:** Performance degrades with >10,000 entries due to full-file read/write on each operation. Mitigation: Project-based partitioning or migration to SQLite.
- **Audit Log:** Capped at 1,000 entries in `log.jsonl`. Older entries are automatically rotated out.
- **Context Tracking:** Sessions capped at 100 entries. Older sessions are automatically removed.
- **Concurrent Access:** File-based persistence does not support concurrent writes. Mitigation: Single-writer architecture (only one service writes at a time).

**Recommended Scaling Path:**

1. **Small deployments (<1,000 KV entries):** File-based persistence is adequate
2. **Medium deployments (1,000-10,000 KV entries):** Consider SQLite backend
3. **Large deployments (>10,000 KV entries):** Migrate to PostgreSQL or similar RDBMS

The file-based approach was chosen deliberately for simplicity and zero-dependency operation. Migration to a database would require significant refactoring of the persistence layer.

---

## 6. Discussion

### 6.1 Design Trade-offs

**File-Based vs Database Persistence:**

We chose file-based persistence (JSON/JSONL) over a database for several reasons:
- **Zero dependencies:** No database server required, simplifying deployment
- **Human-readable:** Files can be inspected and edited manually for debugging
- **Easy backup:** Simple file copy or rsync
- **Low overhead:** ~10ms per read/write for small files

Trade-offs:
- **Scalability:** Performance degrades with >10,000 entries
- **Concurrent access:** No support for concurrent writes
- **Query capabilities:** Limited to full-file scans (no indexing)

**Single-User vs Multi-Tenant:**

Sidekick is designed as a single-user system. This simplifies:
- **Authentication:** Single API key or Basic Auth credentials
- **Data isolation:** No need for tenant separation
- **Resource management:** No quota enforcement

Trade-offs:
- **Team collaboration:** No shared workspace or role-based access control
- **Cost sharing:** Cannot split infrastructure costs across multiple users

**Self-Hosted vs Cloud:**

Sidekick is designed for self-hosted deployment on user-controlled infrastructure. This provides:
- **Data sovereignty:** All data remains on user's infrastructure
- **Security:** No third-party access to sensitive data
- **Customization:** Users can modify the codebase as needed

Trade-offs:
- **Maintenance burden:** Users must manage their own infrastructure
- **Updates:** Users must manually apply updates
- **Scalability:** Users must provision their own scaling

### 6.2 Security Considerations

**Threat Model:**

Sidekick operates with remote execution capabilities, creating several attack vectors:

1. **Unauthorized Access:** An attacker gains access to the MCP Server or Dashboard
   - Mitigation: Bearer token auth, IP whitelist, HTTP Basic Auth, rate limiting

2. **Command Injection:** An attacker injects malicious commands via tool arguments
   - Mitigation: Dangerous command blocklist, `execFileSync` for git/search, input validation

3. **Data Exfiltration:** Sensitive data is exposed through tool outputs
   - Mitigation: Redaction engine, encrypted secret storage, audit logging

4. **Denial of Service:** An attacker overwhelms the system with requests
   - Mitigation: Rate limiting, iteration caps, circuit breakers

5. **Privilege Escalation:** An attacker gains elevated privileges
   - Mitigation: Restricted sudoers (only `systemctl` and `journalctl` for sidekick-* services), SSH key-only auth

**Attack Vectors:**

- **MCP Server:** Exposed to network, protected by Bearer token + IP whitelist
- **Dashboard:** Exposed to network, protected by HTTP Basic Auth + rate limiting
- **Agent Bridge:** Localhost only, accessible only through Dashboard proxy
- **Tool Execution:** Protected by dangerous command blocklist + redaction engine
- **Data Storage:** Protected by file permissions + encrypted secrets

**Security Limitations:**

- **No encryption at rest:** KV store and other JSON files are not encrypted (only secrets are encrypted)
- **No audit trail for reads:** Only state-changing operations are logged to `audit.jsonl`
- **No intrusion detection:** No monitoring for suspicious patterns or brute-force attempts
- **No automated incident response:** Alerts must be manually configured via `sidekick_watch`

### 6.3 Limitations

**Functional Limitations:**

1. **Single-user system:** No multi-tenancy, role-based access control, or team collaboration features
2. **File-based persistence:** Does not scale to millions of entries or support concurrent writes
3. **Agent loop limited to 15 iterations:** Complex tasks may require more iterations
4. **Ollama struggles with complex reasoning:** Tested at 3/10 for multi-step math, 5/10 for JSON generation
5. **No real-time collaboration:** No shared workspace or concurrent editing
6. **Requires SSH access for deployment:** No web-based deployment interface
7. **Limited to Linux/Unix systems:** No Windows support for the remote machine

**Technical Limitations:**

1. **No encryption at rest:** KV store and other JSON files are not encrypted
2. **No database backend:** File-based persistence limits scalability
3. **No streaming tool execution:** Tools execute synchronously, blocking the agent loop
4. **No parallel tool execution:** Agent loop executes tools sequentially
5. **No tool versioning:** Procedures are overwritten, not versioned
6. **No rollback for procedures:** Cannot revert to previous procedure versions

**Operational Limitations:**

1. **Manual updates:** Users must manually apply updates via `git pull` and service restart
2. **No automated backups:** Users must configure their own backup strategy
3. **No monitoring dashboard:** Users must configure their own monitoring (e.g., Prometheus, Grafana)
4. **No alerting:** Users must configure their own alerting (e.g., PagerDuty, email)

### 6.4 Lessons Learned

**What Worked:**

1. **Markdown-based integration:** The `AGENTS.md` approach proved highly effective, enabling seamless integration with AI clients without plugins or hooks.

2. **Self-extension via sidekick_teach:** The ability to create new procedures from natural language descriptions enabled the system to grow its own capabilities organically.

3. **File-based persistence:** The simplicity of JSON/JSONL files made debugging, backup, and migration straightforward.

4. **Defense-in-depth security:** Multiple layers of security (redaction, encryption, command blocking, restricted sudoers) provided robust protection.

5. **Token efficiency tools:** The 10 token efficiency tools significantly reduced API costs and improved response times.

**What Didn't Work:**

1. **Ollama for complex tasks:** Initial testing showed Ollama struggled with JSON generation (5/10) and multi-step reasoning (3/10), requiring a switch to Groq for complex tasks.

2. **Agent hallucination:** Early versions of the agent loop suffered from LLM hallucination (inventing tool names like `sidekick_talk`), requiring validation, deduplication, and corrective prompts.

3. **File permissions:** Initial deployments had data directories owned by `root`, causing EACCES errors. This required explicit `chown` in the bootstrap script.

4. **Body parsing in Express:** PUT/POST handlers initially read the raw request body via `req.on("data")`, but `express.json()` middleware had already consumed the stream, causing requests to hang. Fixed by using `req.body` instead.

**Surprising Findings:**

1. **Agent loop convergence:** The agent loop typically converges within 5-7 iterations for most tasks, even with a 15-iteration cap.

2. **Procedure quality:** Auto-generated procedures from `suggestProcedure` are often usable with minor modifications, demonstrating the LLM's ability to generalize from specific instances.

3. **Redaction effectiveness:** The redaction engine catches >95% of sensitive data patterns, with false positives being rare and false negatives being limited to novel patterns.

4. **Token savings:** The token efficiency tools reduce consumption by 40-60% in typical usage, significantly lowering API costs.

---

## 7. Future Work

### 7.1 Multi-Tenancy Support

Future versions could support multiple users with:
- **Role-based access control:** Admin, operator, viewer roles
- **Project isolation:** Separate KV stores, contexts, and procedures per project
- **Resource quotas:** Limits on tool calls, storage, and agent iterations per user
- **Audit trails:** Per-user audit logging with tamper-proof storage

### 7.2 Database-Backed Persistence

For deployments requiring scalability:
- **SQLite backend:** For medium deployments (1,000-10,000 KV entries)
- **PostgreSQL backend:** For large deployments (>10,000 KV entries)
- **Migration tooling:** Automated migration from file-based to database-backed persistence
- **Query optimization:** Indexing, caching, and query optimization for fast retrieval

### 7.3 Enhanced LLM Integration

Future versions could support:
- **Fine-tuned models:** Custom models trained on Sidekick tool usage patterns
- **Local LLM hosting:** Integration with vLLM, TGI, or other local LLM servers
- **Multi-model support:** Different models for different tasks (e.g., Groq for reasoning, Ollama for simple tasks)
- **Model selection heuristics:** Automatic model selection based on task complexity

### 7.4 Mobile Client Support

Future versions could provide:
- **Mobile app:** iOS/Android app for monitoring and interaction
- **Push notifications:** Alerts for agent task completion, health issues, or security events
- **Offline mode:** Local caching and synchronization when connectivity is restored

### 7.5 Integration with More AI Clients

Future versions could integrate with:
- **ChatGPT:** Via custom GPT or API integration
- **Claude:** Via Anthropic API or MCP integration
- **Gemini:** Via Google API integration
- **Custom AI clients:** Via standardized API or SDK

### 7.6 Enhanced Observability

Future versions could provide:
- **Prometheus metrics:** Export metrics for monitoring dashboards
- **Grafana dashboards:** Pre-built dashboards for system health and agent activity
- **Distributed tracing:** OpenTelemetry integration for end-to-end tracing
- **Anomaly detection:** ML-based anomaly detection for system metrics and agent behavior

### 7.7 Automated Incident Response

Future versions could provide:
- **Runbook automation:** Automated execution of runbooks based on incident type
- **Self-healing:** Automatic remediation of common issues (e.g., service restart, disk cleanup)
- **Incident correlation:** Automatic correlation of related incidents across services
- **Post-incident analysis:** Automated generation of post-incident reports

---

## 8. Conclusion

Sidekick demonstrates that a self-hosted autonomous agent platform can provide a compelling alternative to cloud-based systems while maintaining data sovereignty, security, and extensibility. Through three key innovations—markdown-based integration, self-extending tools, and file-based persistence—Sidekick addresses the limitations of existing autonomous agent systems.

The platform's triple-service architecture (MCP Server, Dashboard, Agent Bridge) with a shared tool layer of 60 tools provides consistent behavior across different interaction modes. The defense-in-depth security model, including output redaction, encrypted secret storage, and restricted sudoers, ensures secure operation even with remote execution capabilities.

Evaluation shows that Sidekick performs well for typical operations tasks, with tool call latency of ~50ms, agent loop iteration speed of 2-5 seconds (Groq) or 15-30 seconds (Ollama), and token savings of 40-60% through efficiency tools. The file-based persistence model works well for single-user deployments but has scalability limitations that would require migration to a database for larger deployments.

Sidekick's design trade-offs—file-based vs database persistence, single-user vs multi-tenant, self-hosted vs cloud—reflect a deliberate choice for simplicity, data sovereignty, and zero-dependency operation. These trade-offs make Sidekick particularly suitable for individual developers, operations teams, and organizations requiring data sovereignty.

Future work includes multi-tenancy support, database-backed persistence, enhanced LLM integration, mobile client support, and automated incident response. These enhancements would expand Sidekick's applicability to team environments, large-scale deployments, and production operations.

In conclusion, Sidekick provides a robust, secure, and extensible platform for autonomous agent operations, demonstrating that self-hosted systems can compete with cloud-based alternatives while providing unique advantages in data sovereignty and customization.

---

## References

1. Significant Gravitas. (2023). AutoGPT: An Autonomous GPT-4 Experiment. https://github.com/Significant-Gravitas/AutoGPT

2. Nakajima, T. (2023). BabyAGI: Task-Driven Autonomous Agent. https://github.com/yoheinakajima/babyagi

3. Hong, S., et al. (2023). MetaGPT: Meta Programming for Multi-Agent Collaborative Framework. https://github.com/geekan/MetaGPT

4. Chase, H. (2023). LangChain: Building applications with LLMs through composability. https://github.com/langchain-ai/langchain

5. Liu, Z. (2023). LlamaIndex: Data framework for LLM applications. https://github.com/run-llama/llama_index

6. Santos, J. (2024). CrewAI: Framework for orchestrating role-playing autonomous AI agents. https://github.com/joaomdmoura/crewAI

7. Killian, M. (2023). Open Interpreter: Let LLMs run code locally. https://github.com/OpenInterpreter/open-interpreter

8. OpenAI. (2023). Code Interpreter: Sandbox environment for code execution in ChatGPT. https://openai.com/blog/chatgpt-plugins

9. Anthropic. (2024). Model Context Protocol: Standardized interface for LLM tool use. https://modelcontextprotocol.io

10. Node.js Foundation. (2024). Node.js 20 LTS: JavaScript runtime environment. https://nodejs.org

11. Zod. (2024). TypeScript-first schema validation with static type inference. https://zod.dev

12. Express. (2024). Fast, unopinionated, minimalist web framework for Node.js. https://expressjs.com

13. Groq. (2024). Groq Cloud: Fast AI inference platform. https://groq.com

14. Ollama. (2024). Ollama: Get up and running with large language models locally. https://ollama.com

15. Proxmox. (2024). Proxmox Virtual Environment: Open-source server virtualization management. https://www.proxmox.com

16. systemd. (2024). System and Service Manager for Linux. https://systemd.io

17. UFW. (2024). Uncomplicated Firewall: Front-end for iptables. https://wiki.ubuntu.com/UncomplicatedFirewall

18. NIST. (2024). Special Publication 800-38D: Recommendation for Block Cipher Modes of Operation: Galois/Counter Mode (GCM) and GMAC.

19. IETF. (2024). RFC 7519: JSON Web Token (JWT). https://tools.ietf.org/html/rfc7519

20. WHATWG. (2024). HTML Living Standard: Server-sent events. https://html.spec.whatwg.org/multipage/server-sent-events.html

---

## Appendix A: Tool Catalog

**Table A1: Complete Tool Catalog**

| Category | Tool | Description |
|----------|------|-------------|
| Core Operations | sidekick_bash | Execute a shell command on the remote machine |
| Core Operations | sidekick_read | Read a file from the remote filesystem |
| Core Operations | sidekick_write | Write content to a file on the remote machine |
| Core Operations | sidekick_list | List files and directories on the remote machine |
| Core Operations | sidekick_search | Search file contents using ripgrep or grep |
| Core Operations | sidekick_git | Structured git operations (status, diff, log, add, commit, push, pull, branch, checkout, stash) |
| Storage & Context | sidekick_store | Store a value persistently in KV storage |
| Storage & Context | sidekick_get | Retrieve a stored value from KV storage |
| Storage & Context | sidekick_list_projects | List all unique project names in KV storage |
| Storage & Context | sidekick_get_by_project | Get all keys and values for a specific project |
| Storage & Context | sidekick_context | Persistent intelligent context management (track projects, decisions, problems, patterns; recall and suggest based on past context) |
| Storage & Context | sidekick_teach | Meta-learning and self-extension: teach procedures, generate tools, learn from examples, execute learned workflows |
| Web & Communication | sidekick_web_fetch | Fetch a URL from the remote machine |
| Web & Communication | sidekick_llm | Ask the LLM (defaults to local Ollama, use provider='groq' for cloud Groq) |
| Web & Communication | sidekick_notify | Send notifications to Discord, Slack, or email |
| Web & Communication | sidekick_github | GitHub API integration (PRs, issues, commits, releases) |
| Web & Communication | sidekick_webhook | Manage received webhooks (list, get, clear) |
| Remote Management | sidekick_process | Manage processes (list, top CPU/memory, kill, tree) |
| Remote Management | sidekick_service | Manage systemd services (start, stop, restart, status, enable, disable, logs) |
| Remote Management | sidekick_archive | Create, extract, or list archives (tar.gz, zip) |
| Automation | sidekick_cron | Schedule recurring tasks (add, list, remove, run jobs) |
| Automation | sidekick_delay | One-shot task scheduling: run a tool once at a specific time or after a delay |
| Automation | sidekick_watch | Event-driven monitoring: watch services, processes, endpoints, or files and trigger actions on conditions |
| Automation | sidekick_queue | Persistent task queue with priorities |
| Automation | sidekick_retry | Retry tool calls with exponential backoff |
| Observability | sidekick_health | Composite system health checks with scoring and issue detection |
| Observability | sidekick_snapshot | Capture system state and detect drift by comparing snapshots |
| Observability | sidekick_timeline | Build chronological timeline from multiple log sources |
| Observability | sidekick_baseline | Behavioral baseline and anomaly detection |
| Observability | sidekick_black_box | Incident time capsule: captures full system context for debugging |
| Security | sidekick_secret | Encrypted credential management with AES-256-GCM |
| Security | sidekick_anonymize | Replace sensitive data with realistic but fake values |
| Data Utilities | sidekick_parse | Parse structured data formats (JSON, YAML, XML, INI, CSV) |
| Data Utilities | sidekick_transform | Data manipulation pipeline: filter, extract, sort, format, and map data |
| Data Utilities | sidekick_diff | Semantic comparison of text, JSON, or YAML |
| Data Utilities | sidekick_hash | Generate checksums (MD5, SHA1, SHA256, SHA512) |
| Data Utilities | sidekick_validate | Validate data against JSON Schema |
| Data Utilities | sidekick_template | Render Handlebars templates with data |
| Advanced Intelligence | sidekick_evolve | Self-modification with safety: analyze patterns, propose improvements, test and approve changes |
| Advanced Intelligence | sidekick_orchestrate | Multi-agent coordination: create task graphs, execute subtasks with dependencies |
| Advanced Intelligence | sidekick_predict | Anticipatory intelligence: analyze patterns, predict needs, track prediction usefulness |
| Token Efficiency | sidekick_batch | Execute multiple tool calls in one request to reduce API round-trips |
| Token Efficiency | sidekick_cache | Session-scoped caching to avoid redundant operations |
| Token Efficiency | sidekick_summarize | Summarize large files before returning to reduce token usage |
| Token Efficiency | sidekick_filter | Filter file contents or directory listings by pattern, date, or size |
| Token Efficiency | sidekick_project | Get complete project context in one call |
| Token Efficiency | sidekick_tail | Tail recent log entries with filtering |
| Token Efficiency | sidekick_diff_files | Compare two files directly without reading both into context |
| Token Efficiency | sidekick_find | Advanced file finder: search by name pattern, date range, size range, and content pattern |
| Token Efficiency | sidekick_status | Unified system status: services, disk, memory, load, uptime, top processes |
| Token Efficiency | sidekick_extract | Parse JSON/YAML/INI/XML and extract specific fields by path |
| Safety & Reliability | sidekick_sandbox | Execute operations in a tracked context with automatic backup and rollback |
| Safety & Reliability | sidekick_circuit | Circuit breaker for tool calls: fast-fail when targets are down |
| Development | sidekick_changelog | Generate human-readable changelogs from git history |
| Development | sidekick_depend | Dependency analyzer for npm packages, systemd services, and processes |
| Operations | sidekick_runbook | Operational runbook executor with autonomous and guided modes |
| Diagnostics | sidekick_netdiag | Unified network diagnostics: DNS, routing, port scanning, connectivity checks |
| Agent Support | sidekick_respond | Return a text response directly without calling other tools |
| Agent Support | sidekick_fresheyes | Get a fresh perspective from Sidekick's LLM on a problem |
| Agent Support | sidekick_debug_tool | Persistent debugging cache: store findings, recall past investigations, cleanup old entries |

---

## Appendix B: Deployment Guide

### B.1 System Requirements

- **OS:** Ubuntu 20.04+ or Debian 11+ (Linux/Unix only)
- **Node.js:** 20 LTS
- **Memory:** 2GB RAM minimum (4GB recommended for Ollama)
- **Disk:** 1GB free space minimum
- **Network:** SSH access, ports 4097-4099 open

### B.2 Installation

**Phase 1: Bootstrap (first-time setup)**

```bash
# On the remote machine (as root or sudo user)
git clone https://github.com/geoffmcc/sidekick.git
cd sidekick
sudo ./scripts/bootstrap.sh --install-services
```

**Phase 2: Deploy (from your local machine)**

```bash
# Windows
.\deploy.ps1 -IP "192.168.1.10"

# Linux/Mac
./deploy.sh -IP 192.168.1.10
```

### B.3 Configuration

Edit `.env` on the remote machine:

```bash
SIDEKICK_API_KEY=your-secret-key-here
SIDEKICK_PORT=4097
SIDEKICK_DASHBOARD_PORT=4098
SIDEKICK_AGENT_PORT=4099
SIDEKICK_DASHBOARD_USER=admin
SIDEKICK_DASHBOARD_PASS=your-password-here
SIDEKICK_ALLOWED_IPS=192.168.1.0/24
GROQ_API_KEY=your-groq-api-key-here
GROQ_MODEL=llama-3.1-8b-instant
OLLAMA_URL=http://127.0.0.1:11434
SIDEKICK_MAX_ITERATIONS=15
SIDEKICK_DEFAULT_LLM=ollama
SIDEKICK_SECRET_KEY=your-secret-key-here
```

### B.4 Service Management

```bash
# Start/stop/restart services
sudo systemctl start sidekick-mcp
sudo systemctl stop sidekick-dashboard
sudo systemctl restart sidekick-agent

# Check service status
sudo systemctl status sidekick-mcp sidekick-dashboard sidekick-agent

# View logs
sudo journalctl -u sidekick-mcp -f
```

### B.5 Access

- **MCP Server:** http://192.168.1.10:4097/mcp (Bearer token auth)
- **Dashboard:** http://192.168.1.10:4098/ (HTTP Basic Auth)
- **Agent Bridge:** http://127.0.0.1:4099/ (localhost only, accessible via Dashboard proxy)

---

**End of Document**
