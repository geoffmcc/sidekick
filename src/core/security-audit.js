"use strict";

const identity = require("./identity");
const { buildProvenance, provenanceDetails } = require("./provenance");

function recordSecurityEvent(eventType, { context = {}, principalId = null, details = {}, overrides = {} } = {}) {
  const provenance = buildProvenance(context, overrides);
  const subject = principalId || provenance.requested_by || provenance.actor || null;
  identity.recordAuditEvent(eventType, subject, provenance.actor, provenanceDetails(context, details, overrides));
  return { eventType, principalId: subject, provenance };
}

module.exports = { recordSecurityEvent };
