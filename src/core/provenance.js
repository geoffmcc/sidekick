"use strict";

const { redactSensitiveKeysDeep } = require("../redact");

const FIELDS = Object.freeze(["requested_by", "actor", "acting_for", "approved_by", "executed_by"]);

function principalId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fromIdentity(identity) {
  if (!identity || typeof identity !== "object") return {};
  return {
    requested_by: principalId(identity.requested_by || identity.requestedBy || identity.principal_id),
    actor: principalId(identity.actor || identity.actor_principal_id || identity.actorPrincipalId || identity.principal_id),
    acting_for: principalId(identity.acting_for || identity.actingFor || identity.delegator_principal_id || identity.delegatorPrincipalId),
    approved_by: principalId(identity.approved_by || identity.approvedBy || identity.approver_principal_id || identity.approverPrincipalId),
    executed_by: principalId(identity.executed_by || identity.executedBy || identity.executor_principal_id || identity.executorPrincipalId),
  };
}

function buildProvenance(context = {}, overrides = {}) {
  const identity = fromIdentity(context.authIdentity);
  const values = {
    ...identity,
    requested_by: principalId(overrides.requested_by || overrides.requestedBy || context.requestedBy) || identity.requested_by,
    actor: principalId(overrides.actor || overrides.actorPrincipalId || context.actorPrincipalId) || identity.actor,
    acting_for: principalId(overrides.acting_for || overrides.actingFor || context.actingFor) || identity.acting_for,
    approved_by: principalId(overrides.approved_by || overrides.approvedBy || context.approvedBy) || identity.approved_by,
    executed_by: principalId(overrides.executed_by || overrides.executedBy || context.executedBy) || identity.executed_by,
  };
  return Object.freeze(Object.fromEntries(FIELDS.map(field => [field, values[field] || null])));
}

function safeDetails(details = {}) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  return redactSensitiveKeysDeep({ ...details });
}

function provenanceDetails(context, details = {}, overrides = {}) {
  return safeDetails({ ...details, provenance: buildProvenance(context, overrides) });
}

module.exports = { FIELDS, buildProvenance, provenanceDetails, safeDetails };
