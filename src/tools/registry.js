const { normalizeDescriptor } = require("./descriptor");
const { TOOL_SCHEMAS } = require("./schemas");
const { getStaticToolCategory, getStaticToolRisk } = require("./metadata");
const utilityFamily = require("./families/utility");

function canonicalName(name) {
  return String(name || "").replace(/^sidekick_/, "");
}

function buildBuiltinRegistry({ toolDefs, handlers, riskForTool, categoryForTool, schemas, extraDescriptors } = {}) {
  const defs = toolDefs || [];
  const toolHandlers = handlers || {};
  const schemaMap = schemas || TOOL_SCHEMAS;
  const extras = extraDescriptors || utilityFamily.descriptors;
  const extraByName = new Map(extras.map(descriptor => [canonicalName(descriptor.name), descriptor]));
  const descriptors = defs.map(def => {
    const extracted = extraByName.get(canonicalName(def.name));
    if (extracted) return normalizeDescriptor(extracted);
    return normalizeDescriptor({
      name: def.name,
      description: def.description,
      args: def.args || {},
      schema: schemaMap[def.name],
      handler: toolHandlers[def.name],
      risk: riskForTool ? riskForTool(def.name) : getStaticToolRisk(def.name),
      category: categoryForTool ? categoryForTool(def.name) : getStaticToolCategory(def.name),
      source: "builtin-legacy",
    });
  });
  for (const descriptor of extras) {
    if (!defs.some(def => canonicalName(def.name) === canonicalName(descriptor.name))) {
      descriptors.push(normalizeDescriptor(descriptor));
    }
  }
  return createRegistry(descriptors);
}

function createRegistry(descriptors) {
  const byName = new Map();
  const aliases = new Map();
  const normalized = descriptors.map(normalizeDescriptor);
  for (const descriptor of normalized) {
    const canonical = canonicalName(descriptor.name);
    if (byName.has(canonical)) throw new Error(`Duplicate tool descriptor: ${canonical}`);
    byName.set(canonical, descriptor);
    for (const alias of descriptor.aliases || []) {
      const normalizedAlias = canonicalName(alias);
      if (byName.has(normalizedAlias) || aliases.has(normalizedAlias)) throw new Error(`Duplicate tool alias: ${normalizedAlias}`);
      aliases.set(normalizedAlias, descriptor.name);
    }
  }
  const ordered = Object.freeze([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
  const definitionOrder = Object.freeze([...normalized]);
  const resolve = name => {
    const canonical = canonicalName(name);
    return byName.get(canonical) || byName.get(aliases.get(canonical));
  };
  return Object.freeze({
    list: () => ordered,
    listInDefinitionOrder: () => definitionOrder,
    get: resolve,
    has: name => Boolean(resolve(name)),
    toolsMap: () => Object.fromEntries(definitionOrder.map(d => [d.name, d.handler])),
    toolDefs: () => definitionOrder.map(d => ({ name: d.name, description: d.description, args: d.args, category: d.category, risk: d.risk, source: d.source, family: d.family })),
    schemas: () => Object.fromEntries(definitionOrder.map(d => [d.name, d.schema])),
  });
}

module.exports = { buildBuiltinRegistry, createRegistry };
