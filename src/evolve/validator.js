const Ajv = require("ajv");
const { SECRET_KEY_RE, stableStringify } = require("./common");

const PLACEHOLDER_RE = /^\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/;
const UNSAFE_COMMAND_RE = /(?:\{\{[^}]+\}\}.*[;&|`$()]|[;&|`$()].*\{\{[^}]+\}\})/;

function parameterSchema(parameters = {}) {
  const properties = {};
  const required = [];
  for (const [name, def] of Object.entries(parameters)) {
    const schema = { type: def.type || "string" };
    if (def.description) schema.description = def.description;
    if (def.default !== undefined) schema.default = def.default;
    if (def.enum) schema.enum = def.enum;
    if (def.maxLength) schema.maxLength = def.maxLength;
    if (schema.type === "string" && !schema.maxLength) schema.maxLength = 500;
    properties[name] = schema;
    if (def.required) required.push(name);
  }
  return { type: "object", additionalProperties: false, properties, required };
}

function substitute(value, params) {
  if (typeof value === "string") {
    const whole = value.match(PLACEHOLDER_RE);
    if (whole) return params[whole[1]];
    return value.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (m, key) => String(params[key] ?? m));
  }
  if (Array.isArray(value)) return value.map(v => substitute(v, params));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, params);
    return out;
  }
  return value;
}

function sampleValue(def, name) {
  if (def.default !== undefined) return def.default;
  if (Array.isArray(def.examples) && def.examples.length) return def.examples[0];
  if (def.enum && def.enum.length) return def.enum[0];
  if (def.type === "number") return /port/i.test(name) ? 443 : 1;
  if (def.type === "boolean") return true;
  if (/path/i.test(name)) return "/tmp/sidekick-evolve-test";
  if (/host|url|endpoint/i.test(name)) return "example.test";
  return "example";
}

function validateSchema(parameters) {
  const schema = parameterSchema(parameters);
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.compile(schema);
  return { passed: true, schema };
}

function validateSteps(steps, availableTools = new Map()) {
  const failures = [];
  if (!Array.isArray(steps) || steps.length < 2) failures.push("workflow must have at least two steps");
  for (const [index, step] of (steps || []).entries()) {
    if (!step || typeof step !== "object") {
      failures.push(`step ${index + 1} is not an object`);
      continue;
    }
    if (!step.tool || typeof step.tool !== "string") failures.push(`step ${index + 1} missing tool`);
    if (!availableTools.has(step.tool)) failures.push(`step ${index + 1} references missing tool ${step.tool}`);
    if (!step.args || typeof step.args !== "object" || Array.isArray(step.args)) failures.push(`step ${index + 1} args must be an object`);
  }
  return { passed: failures.length === 0, failures };
}

function securityReview(candidate) {
  const failures = [];
  const warnings = [];
  const text = stableStringify(candidate.steps || []);
  if (SECRET_KEY_RE.test(text)) failures.push("steps reference sensitive-looking argument names");
  if (UNSAFE_COMMAND_RE.test(text)) failures.push("parameter appears inside shell metacharacter context");
  for (const step of candidate.steps || []) {
    if (step.tool === "sidekick_bash" && /sudo|rm\s+-rf|mkfs|dd\s+.*of=|curl\s+.*\|\s*(?:bash|sh)/i.test(stableStringify(step.args))) {
      failures.push("destructive or privileged shell pattern detected");
    }
    if (/commit|push|deploy/i.test(stableStringify(step.args))) warnings.push("git/deploy-like action requires strict approval policy");
  }
  return { passed: failures.length === 0, failures, warnings };
}

function validateCandidate(candidate, availableToolDefs = []) {
  const available = new Map(availableToolDefs.map(t => [t.name, t]));
  const checks = {};
  checks.schema = validateSchema(candidate.parameters || {});
  checks.steps = validateSteps(candidate.steps || [], available);
  checks.security = securityReview(candidate);
  const sampleParams = Object.fromEntries(Object.entries(candidate.parameters || {}).map(([k, v]) => [k, sampleValue(v, k)]));
  const substituted = (candidate.steps || []).map(step => ({ tool: step.tool, args: substitute(step.args, sampleParams) }));
  const unresolved = stableStringify(substituted).match(/\{\{[^}]+\}\}/g) || [];
  checks.substitution = { passed: unresolved.length === 0, failures: unresolved };
  checks.mockExecution = {
    passed: checks.steps.passed && checks.substitution.passed,
    dryRun: substituted.map((step, index) => ({ index: index + 1, tool: step.tool, args: step.args })),
  };
  checks.policy = { passed: candidate.state !== "active", notes: "activation requires explicit approve/promote lifecycle action" };
  const passed = Object.values(checks).every(c => c.passed !== false);
  return {
    passed,
    checks,
    validatedAt: new Date().toISOString(),
    schema: checks.schema.schema,
  };
}

module.exports = {
  parameterSchema,
  substitute,
  validateCandidate,
};
