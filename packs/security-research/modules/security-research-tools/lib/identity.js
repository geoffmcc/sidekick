"use strict";

/**
 * Caller identity for durable research records.
 *
 * Every kernel record requires a non-empty actor. We prefer, in order: an
 * explicit actor argument, the dispatch runtime's resolved actor, then a stable
 * pack default. Identity is recorded, never inferred as authorization — policy
 * and scope decide what an actor may do; this only decides how the action is
 * attributed in the audit trail.
 */

const { ResearchError } = require("./errors");

const DEFAULT_ACTOR = "security-research";

function resolveActor(args, runtime) {
  const explicit = args && (args.actor || args.created_by);
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  const fromRuntime = runtime && runtime.context && runtime.context.actor;
  if (fromRuntime && String(fromRuntime).trim()) return String(fromRuntime).trim();
  return DEFAULT_ACTOR;
}

function requireText(value, name) {
  const text = String(value == null ? "" : value).trim();
  if (!text) throw new ResearchError("invalid_input", `${name} is required`);
  return text;
}

function runtimeExecutionId(runtime) {
  return (runtime && runtime.context && runtime.context.executionId) || null;
}

module.exports = { resolveActor, requireText, runtimeExecutionId, DEFAULT_ACTOR };
