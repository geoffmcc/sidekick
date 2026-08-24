"use strict";

/**
 * Event vocabulary for the platform event ledger.
 *
 * Before this file there was no vocabulary at all: `appendEvent` accepted any
 * string, and a subscription could be created for an `event_type` that nothing
 * would ever publish. Fan-out is exact-match (or `*`), so a typo does not fail
 * loudly — it produces a subscription that silently never fires, which is the
 * worst possible failure mode for an audit trail.
 *
 * Two levels of strictness, deliberately different:
 *
 *   - SHAPE is enforced. `dotted.lower_snake` with at least one dot is the
 *     contract every publisher already follows, and anything else (whitespace,
 *     empty, uppercase, no namespace) can only be a mistake. Enforcing it costs
 *     nothing and catches the typo class that matters.
 *   - NAMESPACE is advisory. An unknown namespace is reported (and logged) but
 *     not rejected, because this list is a snapshot of what the code publishes
 *     today and a new subsystem must not be blocked from subscribing before
 *     someone remembers to edit this file. `test/platform-event-consumption`
 *     keeps the snapshot honest in the other direction: every literal
 *     `event_type` in `src/` must have its namespace registered here.
 *
 * KNOWN_EVENT_TYPES covers both the direct `event_type:` literals and the types
 * passed positionally through the publisher helpers (`appendScheduledPlatformEvent`,
 * `recordPlatformApprovalEvent`, `appendAgentExecutionEvent`,
 * `appendPlatformCaptureEvent`, `recordPackEvent`, `onEvent`). A few publishers
 * build the type from a runtime value (`auditComputeEvent`, the memory families),
 * so the NAMESPACE list — not the type list — is the authoritative surface, and
 * it is the namespace that the test enforces.
 */

// Namespaces in use by production publishers, grouped by owning subsystem.
const EVENT_NAMESPACES = Object.freeze([
  // Kernel primitives
  "execution",
  "artifact",
  "capability",
  "changeset",
  "workflow",
  "runner",
  "workspace",
  "project",
  "scope",
  "backup",
  "release",
  "model",
  "extension",
  // Subsystems
  "agent",
  "approval",
  "blackbox",
  "brain",
  "compute",
  "connector",
  "memory",
  "module",
  "pack",
  "proxmox",
  "runbook",
  "schedule",
  "research",
  "context",
  // Reserved for the delivery pipeline's own bookkeeping and for tests that
  // exercise the pipeline without impersonating a real subsystem.
  "delivery",
  "test",
]);

// Literal event types published by `src/`. Dynamic (variable) types are covered
// by their namespace only — see the file header.
const KNOWN_EVENT_TYPES = Object.freeze([
  "agent.decision_rejected",
  "agent.evidence_classified",
  "agent.evidence_missing",
  "agent.followup_started",
  "agent.memory_brief_loaded",
  "agent.task_started",
  "agent.tool_approval_pending",
  "agent.tool_completed",
  "agent.tool_started",
  "approval.approved",
  "approval.completed",
  "approval.expired",
  "approval.failed",
  "approval.finalize_rejected",
  "approval.lease_recovered",
  "approval.lease_renewed",
  "approval.reconciliation_required",
  "approval.rejected",
  "approval.requested",
  "approval.superseded",
  "artifact.registered",
  "backup.completed",
  "backup.created",
  "backup.restored",
  "blackbox.capture_cancelled",
  "blackbox.capture_timeout",
  "blackbox.source_completed",
  "blackbox.source_started",
  "brain.attempt_limit_exceeded",
  "brain.checkpoint_corrupt",
  "brain.completion_discarded",
  "brain.enabled",
  "brain.evidence_missing",
  "brain.lease_lost",
  "brain.legacy_approval_not_superseded",
  "brain.memory_failed",
  "brain.park_failed",
  "brain.plan_validated",
  "brain.reconciliation_required",
  "brain.result_discarded",
  "brain.resume_claim_failed",
  "brain.resume_unrecoverable",
  "brain.resumed_completed",
  "brain.resumed_failed",
  "brain.state",
  "brain.step_already_recorded",
  "brain.step_completed",
  "brain.step_not_in_plan",
  "brain.step_redispatched",
  "brain.step_refused",
  "brain.step_started",
  "brain.waiting_for_approval",
  "capability.granted",
  "capability.revoked",
  "compute.artifact_custody_failed",
  "connector.configured",
  "connector.health.check",
  "connector.registered",
  "connector.state_changed",
  "execution.awaiting_approval",
  "execution.blocked",
  "execution.cancel_requested",
  "execution.cancelled",
  "execution.claims_recovered",
  "execution.completed",
  "execution.created",
  "execution.failed",
  "execution.orphaned",
  "execution.partial",
  "execution.planned",
  "execution.queued",
  "execution.ready",
  "execution.retrying",
  "execution.rollback_failed",
  "execution.rolled_back",
  "execution.rolling_back",
  "execution.running",
  "execution.scope_bound",
  "execution.timed_out",
  "execution.verifying",
  "execution.waiting",
  "extension.activated",
  "extension.deactivated",
  "extension.registered",
  "extension.uninstalled",
  "model.deprecated",
  "model.registered",
  "module.health.alert",
  "module.health.check",
  "module.provisioning",
  "module.transition",
  "pack.transition",
  "pack.uninstalled",
  "project.archived",
  "project.registered",
  "project.source_recorded",
  "project.sources_backfilled",
  "release.created",
  "release.published",
  "research.campaign.created",
  "research.campaign.state_changed",
  "research.disclosure.created",
  "research.disclosure.state_changed",
  "research.finding.created",
  "research.hypothesis.created",
  "research.hypothesis.state_changed",
  "research.report.created",
  "research.test_run.created",
  "research.test_run.state_changed",
  "runbook.step_completed",
  "runbook.step_started",
  "runbook.step_verified",
  "runner.completed",
  "runner.created",
  "runner.terminated",
  "schedule.cron.added",
  "schedule.cron.disabled",
  "schedule.cron.removed",
  "schedule.delay.added",
  "schedule.delay.cancelled",
  "schedule.delay.completed",
  "schedule.delay.failed",
  "schedule.watch.added",
  "schedule.watch.paused",
  "schedule.watch.removed",
  "schedule.watch.resumed",
  "schedule.watch.triggered",
  "scope.guard.decision",
  "scope.snapshot.created",
  "workflow.checkpointed",
  "workflow.completed",
  "workflow.created",
  "workflow.failed",
  "workflow.paused",
  "workflow.started",
  "workflow.step_completed",
  "workflow.step_dispatch",
  "workflow.step_failed",
  "workflow.step_started",
  "workspace.archived",
  "workspace.created",
  "workspace.secret_deleted",
  "workspace.secret_set",
  "workspace.secrets_backfilled",
]);

// `execution.<state>` and `changeset.<decision>` are built by interpolation in
// the kernel. The execution states are enumerated above because that state
// machine is closed; `changeset.<decision>` takes caller-supplied text, so it
// is covered by its namespace only.
const EVENT_TYPE_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

// The wildcard subscription. Not an event type — no publisher may use it.
const WILDCARD_EVENT_TYPE = "*";

function isValidEventTypeShape(eventType) {
  return typeof eventType === "string" && EVENT_TYPE_SHAPE.test(eventType);
}

function getEventNamespace(eventType) {
  if (typeof eventType !== "string") return null;
  const namespace = eventType.split(".")[0];
  return namespace || null;
}

function isKnownNamespace(eventType) {
  const namespace = getEventNamespace(eventType);
  return Boolean(namespace) && EVENT_NAMESPACES.includes(namespace);
}

function isKnownEventType(eventType) {
  return KNOWN_EVENT_TYPES.includes(eventType);
}

/**
 * Validates a subscription's `event_type`. Returns the advisory findings rather
 * than throwing for anything except a malformed shape, so callers decide how
 * loud to be. `*` is always valid: it is how an operator subscribes to the
 * whole ledger.
 */
function validateSubscriptionEventType(eventType) {
  if (eventType === WILDCARD_EVENT_TYPE) {
    return { valid: true, wildcard: true, unknown_namespace: false, known_type: false };
  }
  if (!isValidEventTypeShape(eventType)) {
    return {
      valid: false,
      wildcard: false,
      unknown_namespace: true,
      known_type: false,
      reason: "event_type must be dotted lower_snake_case (for example execution.failed) or '*'",
    };
  }
  return {
    valid: true,
    wildcard: false,
    unknown_namespace: !isKnownNamespace(eventType),
    known_type: isKnownEventType(eventType),
  };
}

/**
 * Sensitivity levels, ordered least to most restricted. Before this was a
 * closed set the column accepted any string, and in practice every one of the
 * 21,267 events in the production ledger was `normal` — the field was inert,
 * so "delivery ignores sensitivity" described a gate with nothing to gate.
 * Enumerating the levels makes the column mean something the moment a publisher
 * uses one, and lets a subscription declare a ceiling.
 */
const SENSITIVITY_LEVELS = Object.freeze(["normal", "sensitive", "secret"]);

/**
 * Redaction states. `redacted` means the payload went through `redactSensitive`
 * before storage. `none` means it did NOT — module transitions and pack events
 * deliberately store arbitrary error text and label themselves honestly rather
 * than pretend. 44% of the production ledger is `none`, which is exactly why
 * the delivery path re-redacts before handing a payload to a handler.
 */
const REDACTION_STATES = Object.freeze(["redacted", "none", "unknown"]);

// Event sources observed in production. Advisory, like namespaces: the set has
// already drifted on its own (`approval` vs `approvals`, `workflow` vs
// `workflow-runner`), which is the argument for validating the shape — and
// against rejecting an unlisted one, since most publishers swallow errors from
// appendEvent and a rejection would silently drop the event instead.
const KNOWN_EVENT_SOURCES = Object.freeze([
  "agent",
  "approval",
  "approvals",
  "blackbox",
  "bootstrap",
  "browser",
  "capability-packs",
  "compute",
  "cron",
  "dashboard",
  "delay",
  "mcp",
  "memory",
  "network-scope",
  "modules",
  "ops-backfill",
  "platform",
  "proxmox-pack",
  "retry",
  "runbook",
  "security-research",
  "watch",
  "workflow",
  "workflow-runner",
  // Reserved for suites that exercise the pipeline without impersonating a real
  // producer, matching the `test` namespace above.
  "test",
]);

const EVENT_SOURCE_SHAPE = /^[a-z][a-z0-9]*([_-][a-z0-9]+)*$/;

function isValidSensitivity(value) {
  return SENSITIVITY_LEVELS.includes(value);
}

function sensitivityRank(value) {
  const index = SENSITIVITY_LEVELS.indexOf(value);
  return index === -1 ? 0 : index;
}

/**
 * True when an event at `eventSensitivity` may be delivered to a subscription
 * whose ceiling is `maxSensitivity`. Unknown values fail closed to `normal`.
 */
function sensitivityAllowed(eventSensitivity, maxSensitivity) {
  return sensitivityRank(eventSensitivity) <= sensitivityRank(maxSensitivity);
}

function isValidSourceShape(source) {
  return typeof source === "string" && source.length <= 32 && EVENT_SOURCE_SHAPE.test(source);
}

function isKnownSource(source) {
  return KNOWN_EVENT_SOURCES.includes(source);
}

module.exports = {
  EVENT_NAMESPACES,
  SENSITIVITY_LEVELS,
  REDACTION_STATES,
  KNOWN_EVENT_SOURCES,
  EVENT_SOURCE_SHAPE,
  isValidSensitivity,
  sensitivityRank,
  sensitivityAllowed,
  isValidSourceShape,
  isKnownSource,
  KNOWN_EVENT_TYPES,
  EVENT_TYPE_SHAPE,
  WILDCARD_EVENT_TYPE,
  isValidEventTypeShape,
  getEventNamespace,
  isKnownNamespace,
  isKnownEventType,
  validateSubscriptionEventType,
};
