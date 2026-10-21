"use strict";

const crypto = require("crypto");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function signature(payload, secret) {
  if (typeof secret !== "string" || secret.length < 16) throw new Error("scheduled authority key is unavailable");
  return crypto.createHmac("sha256", secret).update(`sidekick/scheduled-authority/v1\n${canonical(payload)}`).digest("hex");
}

function safeIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  const scopes = Array.isArray(identity.scopes)
    ? [...new Set(identity.scopes.filter(value => typeof value === "string" && value.length <= 160))].sort()
    : null;
  return {
    principal_id: typeof identity.principal_id === "string" ? identity.principal_id : null,
    principal_type: typeof identity.principal_type === "string" ? identity.principal_type : null,
    requested_by_principal_id: typeof identity.requested_by_principal_id === "string" ? identity.requested_by_principal_id : null,
    acting_for_principal_id: typeof identity.acting_for_principal_id === "string" ? identity.acting_for_principal_id : null,
    scopes,
    credential_id: typeof identity.credential_id === "string" ? identity.credential_id : null,
    delegation_id: typeof (identity.delegation_id || identity.delegationId) === "string" ? (identity.delegation_id || identity.delegationId) : null,
    authentication_method: typeof identity.authentication_method === "string" ? identity.authentication_method : null,
  };
}

function safeAgentAuthority(authority) {
  if (!authority || typeof authority !== "object" || !authority.envelope || typeof authority.envelope !== "object") return null;
  return {
    envelope: JSON.parse(JSON.stringify(authority.envelope)),
    principal_ref: typeof authority.principal_ref === "string" ? authority.principal_ref : null,
    project_ref: typeof authority.project_ref === "string" ? authority.project_ref : null,
    workspace_ref: typeof authority.workspace_ref === "string" ? authority.workspace_ref : null,
    repository_ref: typeof authority.repository_ref === "string" ? authority.repository_ref : null,
  };
}

function createScheduledAuthority({ delay, context, secret }) {
  const payload = {
    version: 1,
    delay_id: delay.id,
    execution_id: delay.platform_execution_id || null,
    when: delay.when,
    tool: delay.tool,
    args_digest: digest(delay.args || {}),
    project: context.project || null,
    task_id: context.taskId || null,
    source: context.source || null,
    auth_identity: safeIdentity(context.authIdentity),
    agent_authority: safeAgentAuthority(context.agentAuthorityContext),
  };
  return { payload, signature: signature(payload, secret) };
}

function verifyScheduledAuthority({ delay, secret }) {
  const signed = delay?.scheduled_authority;
  const payload = signed?.payload;
  if (!payload || payload.version !== 1 || typeof signed.signature !== "string") return null;
  let expected;
  try { expected = signature(payload, secret); } catch { return null; }
  const actualBytes = Buffer.from(signed.signature, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) return null;
  if (payload.delay_id !== delay.id || payload.execution_id !== (delay.platform_execution_id || null) || payload.when !== delay.when || payload.tool !== delay.tool || payload.args_digest !== digest(delay.args || {})) return null;
  return Object.freeze({
    source: "agent",
    taskId: payload.task_id,
    project: payload.project,
    authIdentity: payload.auth_identity,
    agentAuthorityContext: payload.agent_authority,
    initiatingSource: payload.source,
  });
}

module.exports = Object.freeze({ createScheduledAuthority, verifyScheduledAuthority, digest });
