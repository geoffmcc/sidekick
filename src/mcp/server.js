const { McpServer } = require("@modelcontextprotocol/server");
const { z } = require("zod");
const packageJson = require("../../package.json");
const { callMcpTool, loadProcedures } = require("../tools");
const { getBuiltinRegistry } = require("../tools/index");
const dynamicTools = require("../dynamic-tools");
const { stripSidekickPrefix } = require("../core/tool-name");
const { CORRELATION_ID_PATTERN } = require("../tools/context");

const correlationInput = z.string().regex(CORRELATION_ID_PATTERN, "correlation_id must be 1-128 safe identifier characters").optional()
  .describe("Client-neutral correlation identifier propagated across related work");

function withCorrelationSchema(schema) {
  return schema && typeof schema.extend === "function"
    ? schema.extend({ correlation_id: correlationInput })
    : schema;
}

function buildProcedureSchema(parameters) {
  const shape = {};
  for (const [key, def] of Object.entries(parameters || {})) {
    let field;
    if (def.type === "number") {
      field = z.number().describe(def.description || key);
    } else if (def.type === "boolean") {
      field = z.boolean().describe(def.description || key);
    } else {
      field = z.string().describe(def.description || key);
    }
    if (!def.required) field = field.optional();
    shape[key] = field;
  }
  return z.object(shape);
}

/**
 * Builds the execution context for an MCP tool call.
 *
 * `extra.sessionId` is the transport's per-connection session identifier. Passing
 * it through is what gives tool_logs a real execution boundary: without it every
 * call is isolated, and correlation_id cannot substitute because it is unique per
 * call. Never substitute a constant (e.g. a static SIDEKICK_SESSION_ID) here — a
 * fixed value would group every call ever made into one sequence and let
 * downstream analysis infer adjacency between unrelated calls.
 *
 * `project` is recorded only when the call itself names one, so scope is observed
 * rather than guessed.
 */
function toolCallContext(args, extra, toolName) {
  const context = { requestId: extra?.requestInfo?.requestId };
  const correlationIsFilter = ["log_query", "timeline", "sidekick_log_query", "sidekick_timeline"].includes(toolName || "");
  const boundedTools = new Set(["dev_repo_profile", "semantic_repo", "dev_change_summary", "dev_verify", "search", "git"]);
  const canonicalToolName = String(toolName || "").replace(/^sidekick_/, "");
  if (boundedTools.has(canonicalToolName)) context.timeoutMs = 7500;
  if (extra?.sessionId) context.sessionId = extra.sessionId;
  // Session envelopes carry an explicit durable task/session id. Preserve it
  // as task metadata so log_query and timeline can correlate the same call
  // without confusing it with the transport's MCP session id.
  if (toolName === "session" && typeof args?.id === "string" && args.id.trim()) {
    context.taskId = args.id.trim();
    context.taskSessionId = args.id.trim();
    if (!args.correlation_id) context.correlationId = args.id.trim();
  }
  if (!correlationIsFilter && typeof args?.correlation_id === "string") context.correlationId = args.correlation_id;
  if (toolName === "session" && typeof args?.client_session_id === "string" && args.client_session_id.trim()) context.clientSessionId = args.client_session_id.trim();
  if (args && typeof args.project === "string" && args.project.trim()) {
    context.project = args.project.trim();
  }
  context.authIdentity = extra?.authIdentity || null;
  return context;
}

function createMcpServer(authIdentityProvider = () => null, options = {}) {
  const server = new McpServer({
    name: "sidekick-mcp-server",
    version: options.appVersion || packageJson.version || "0.0.0"
  }, {
    capabilities: { tools: {} }
  });

  const builtinRegistry = getBuiltinRegistry();
  for (const descriptor of builtinRegistry.listInDefinitionOrder()) {
    const mcpName = stripSidekickPrefix(descriptor.name);
    server.registerTool(mcpName, {
      description: descriptor.description,
      inputSchema: withCorrelationSchema(descriptor.schema),
      annotations: descriptor.annotations,
    }, async (args, extra) => {
      extra = extra || {};
      extra.authIdentity = authIdentityProvider();
      return callMcpTool(descriptor.name, args, toolCallContext(args, extra, descriptor.name));
    });
  }

  const procedures = loadProcedures();
  for (const [procName, proc] of Object.entries(procedures)) {
    const internalName = "sidekick_" + procName;
    if (builtinRegistry.has(internalName)) continue;
    const paramSchema = buildProcedureSchema(proc.parameters);
    const paramNames = Object.keys(proc.parameters || {});
    const paramDesc = paramNames.length > 0 ? ` Parameters: ${paramNames.join(", ")}.` : "";
    server.registerTool(procName, {
      description: `[procedure] ${proc.description}${paramDesc}`,
      inputSchema: withCorrelationSchema(paramSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (args, extra) => {
      extra = extra || {};
      extra.authIdentity = authIdentityProvider();
      return callMcpTool("teach", { action: "execute", name: procName, args },
        { ...toolCallContext(args, extra), generatedProcedure: internalName });
    });
  }

  const dynamicSchemas = dynamicTools.getDynamicToolSchemas();
  for (const def of dynamicTools.getDynamicToolDefs()) {
    if (builtinRegistry.has(def.name)) continue;
    const mcpName = stripSidekickPrefix(def.name);
    server.registerTool(mcpName, {
      description: def.description,
      inputSchema: dynamicSchemas[def.name],
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (args, extra) => {
      extra = extra || {};
      extra.authIdentity = authIdentityProvider();
      return callMcpTool(def.name, args,
        { ...toolCallContext(args, extra), generatedProcedure: def.name, correlationId: def.capabilityId });
    });
  }

  return server;
}

module.exports = { buildProcedureSchema, createMcpServer, toolCallContext };
