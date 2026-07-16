const { normalizeDescriptor } = require("./descriptor");
const { TOOL_SCHEMAS } = require("./schemas");
const { getStaticToolCategory, getStaticToolRisk } = require("./metadata");

function buildBuiltinRegistry({ toolDefs, handlers, riskForTool, categoryForTool, schemas } = {}) {
  const defs = toolDefs || [];
  const toolHandlers = handlers || {};
  const schemaMap = schemas || TOOL_SCHEMAS;
  const descriptors = defs.map(def => normalizeDescriptor({
    name: def.name,
    description: def.description,
    args: def.args || {},
    schema: schemaMap[def.name],
    handler: toolHandlers[def.name],
    risk: riskForTool ? riskForTool(def.name) : getStaticToolRisk(def.name),
    category: categoryForTool ? categoryForTool(def.name) : getStaticToolCategory(def.name),
  }));
  return createRegistry(descriptors);
}

function createRegistry(descriptors) {
  const byName = new Map();
  for (const descriptor of descriptors) {
    if (byName.has(descriptor.name)) throw new Error(`Duplicate tool descriptor: ${descriptor.name}`);
    byName.set(descriptor.name, descriptor);
  }
  const ordered = Object.freeze([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
  const definitionOrder = Object.freeze([...descriptors]);
  return Object.freeze({
    list: () => ordered,
    listInDefinitionOrder: () => definitionOrder,
    get: name => byName.get(String(name || "").replace(/^sidekick_/, "")),
    has: name => byName.has(String(name || "").replace(/^sidekick_/, "")),
    toolsMap: () => Object.fromEntries(definitionOrder.map(d => [d.name, d.handler])),
    toolDefs: () => definitionOrder.map(d => ({ name: d.name, description: d.description, args: d.args, category: d.category, risk: d.risk })),
    schemas: () => Object.fromEntries(definitionOrder.map(d => [d.name, d.schema])),
  });
}

module.exports = { buildBuiltinRegistry, createRegistry };
