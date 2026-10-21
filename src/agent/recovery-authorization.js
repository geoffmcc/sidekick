"use strict";

function certificationEnvelopeIsReadOnly(envelope) {
  const effects = Array.isArray(envelope?.allowed_effects) ? envelope.allowed_effects : [];
  return effects.length === 1
    && effects[0] === "read_only"
    && envelope.changes_allowed === false
    && envelope.external_effects_allowed === false
    && envelope.production_allowed === false
    && Number(envelope.child_task_count) === 0;
}

function authorizeRecoveredTask(task, {
  resolvePrincipalIdentity,
  isPrincipalEnabled,
  hasProjectTaskAccess,
} = {}) {
  if (!task) return { ok: false, reason: "missing_task" };
  const principalId = task.actor_principal_id || task.requested_by_principal_id || null;
  if (principalId) {
    const authIdentity = typeof resolvePrincipalIdentity === "function" ? resolvePrincipalIdentity(task) : null;
    if (!authIdentity || authIdentity.principal_id !== principalId) return { ok: false, reason: "principal_authority_unavailable" };
    if (typeof isPrincipalEnabled !== "function" || !isPrincipalEnabled(principalId)) return { ok: false, reason: "principal_disabled" };
    if (task.project_id && (typeof hasProjectTaskAccess !== "function" || !hasProjectTaskAccess(authIdentity, task.project_id))) {
      return { ok: false, reason: "project_access_revoked" };
    }
    return { ok: true, authIdentity };
  }

  const serviceIdentity = task.principal_context?.service_identity || null;
  if (serviceIdentity === "certification" && certificationEnvelopeIsReadOnly(task.authority_envelope)) {
    return { ok: true, serviceIdentity };
  }
  return { ok: false, reason: "service_authority_unavailable" };
}

module.exports = { authorizeRecoveredTask, certificationEnvelopeIsReadOnly };
