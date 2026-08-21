const { McpServer } = require("@modelcontextprotocol/server");
const { z } = require("zod");
const packageJson = require("../../package.json");
const { callMcpTool, loadProcedures } = require("../tools");
const { getBuiltinRegistry } = require("../tools/index");
const dynamicTools = require("../dynamic-tools");
const { stripSidekickPrefix } = require("../core/tool-name");

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

function toolCallContext(args, extra) {
  const context = { requestId: extra?.requestInfo?.requestId };
  if (extra?.sessionId) context.sessionId = extra.sessionId;
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
      inputSchema: descriptor.schema,
      annotations: descriptor.annotations,
    }, async (args, extra) => {
      extra = extra || {};
      extra.authIdentity = authIdentityProvider();
      return callMcpTool(descriptor.name, args, toolCallContext(args, extra));
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
      inputSchema: paramSchema,
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
