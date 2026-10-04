"use strict";

const { resolveDeclaredActionEffects } = require("../tools/metadata");
const { getToolAnnotations } = require("../tools/annotations");

const EFFECT_ORDER = Object.freeze([
  "read_only", "target_read", "artifact", "application_state", "workspace_reversible",
  "build_test", "local_process", "external", "unknown",
]);

function actionValues(definition, step, suppliedInputs = {}) {
  const action = step?.args?.action;
  if (typeof action !== "string") return { values: [null], defaultValue: null, inputDependent: false };
  const reference = action.match(/^\$\{inputs\.([a-zA-Z0-9_-]+)\}$/);
  if (!reference) return { values: [action], defaultValue: action, inputDependent: false };
  const key = reference[1];
  const spec = definition?.inputs?.[key];
  if (!spec) return { values: [null], defaultValue: null, inputDependent: true };
  const hasProvided = Object.prototype.hasOwnProperty.call(suppliedInputs, key);
  if (hasProvided && typeof suppliedInputs[key] === "string") {
    return { values: [suppliedInputs[key]], defaultValue: suppliedInputs[key], inputDependent: true };
  }
  const defaultValue = hasProvided ? suppliedInputs[key] : spec.default;
  if (Array.isArray(spec.enum) && spec.enum.length) {
    return { values: spec.enum.filter(value => typeof value === "string"), defaultValue: typeof defaultValue === "string" ? defaultValue : null, inputDependent: true };
  }
  if (typeof defaultValue === "string") return { values: [defaultValue], defaultValue, inputDependent: true };
  return { values: [null], defaultValue: null, inputDependent: true };
}

function stepEnabledByDefault(definition, step, suppliedInputs = {}) {
  if (typeof step?.when !== "string") return true;
  const ref = step.when.match(/^\$\{inputs\.([a-zA-Z0-9_-]+)\}$/);
  if (!ref) return null;
  const key = ref[1];
  const value = Object.prototype.hasOwnProperty.call(suppliedInputs, key)
    ? suppliedInputs[key]
    : definition?.inputs?.[key]?.default;
  if (value === undefined) return null;
  if (value === false || value === null || value === 0 || value === "" || value === "false") return false;
  return true;
}

function resolveDefaultArgs(value, definition, inputs) {
  if (typeof value === "string") {
    const reference = value.match(/^\$\{inputs\.([a-zA-Z0-9_-]+)\}$/);
    if (!reference) return value;
    const key = reference[1];
    return Object.prototype.hasOwnProperty.call(inputs, key) ? inputs[key] : definition?.inputs?.[key]?.default;
  }
  if (Array.isArray(value)) return value.map(item => resolveDefaultArgs(item, definition, inputs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveDefaultArgs(item, definition, inputs)]));
  return value;
}

function effectForAction(tool, action, args = {}) {
  const canonical = String(tool || "").replace(/^sidekick_/i, "");
  const declared = resolveDeclaredActionEffects(canonical, action, args);
  if (declared) return declared;
  if (!action) {
    const annotations = getToolAnnotations(tool);
    if (annotations.readOnlyHint && !annotations.openWorldHint && !annotations.destructiveHint) return ["read_only"];
  }
  return ["unknown"];
}

function analyzeWorkflowEffects(definition, inputs = {}) {
  const possible = new Set();
  const defaults = new Set();
  const steps = [];
  for (const step of definition?.steps || []) {
    const actions = actionValues(definition, step, inputs);
    const enabledByDefault = stepEnabledByDefault(definition, step, inputs);
    const conditionRef = typeof step.when === "string" ? step.when.match(/^\$\{inputs\.([a-zA-Z0-9_-]+)\}$/) : null;
    const conditionSupplied = Boolean(conditionRef && Object.prototype.hasOwnProperty.call(inputs, conditionRef[1]));
    const effectArgs = resolveDefaultArgs(step.args || {}, definition, inputs);
    const possibleArgs = conditionSupplied && enabledByDefault === false ? [] : actions.values;
    const perAction = possibleArgs.map(action => ({ action, effects: effectForAction(step.tool, action, step.args || {}) }));
    const possibleEffects = [...new Set(perAction.flatMap(item => item.effects))];
    const defaultAction = actions.defaultValue;
    const defaultEffects = enabledByDefault === false
      ? []
      : defaultAction !== null
        ? effectForAction(step.tool, defaultAction, effectArgs)
        : perAction.length === 1
          ? effectForAction(step.tool, perAction[0].action, effectArgs)
          : [];
    for (const effect of possibleEffects) possible.add(effect);
    for (const effect of defaultEffects) defaults.add(effect);
    steps.push({
      step: step.name,
      tool: step.tool,
      actions: actions.values,
      default_action: defaultAction,
      input_dependent: actions.inputDependent || enabledByDefault === null,
      condition: step.when || null,
      enabled_by_default: enabledByDefault,
      effects: possibleEffects,
      default_effects: defaultEffects,
    });
  }
  const sorted = set => EFFECT_ORDER.filter(effect => set.has(effect));
  const effects = sorted(possible);
  const defaultEffects = sorted(defaults);
  const noTargetMutation = !effects.includes("external") && !effects.includes("unknown");
  const noPersistentStateWrites = !effects.includes("application_state") && !effects.includes("unknown");
  const strictNoWrite = effects.every(effect => ["read_only", "target_read"].includes(effect));
  return {
    effects,
    default_effects: defaultEffects,
    steps,
    strict_no_write: strictNoWrite,
    no_target_mutation: noTargetMutation,
    writes_application_state: effects.includes("application_state"),
    produces_artifacts: effects.includes("artifact"),
    runs_local_work: effects.some(effect => ["build_test", "local_process", "workspace_reversible"].includes(effect)),
    input_dependent: steps.some(step => step.input_dependent),
    unknown: effects.includes("unknown"),
  };
}

module.exports = { EFFECT_ORDER, actionValues, effectForAction, analyzeWorkflowEffects };
