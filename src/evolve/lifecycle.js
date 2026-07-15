const { validateCandidate } = require("./validator");

const STATES = new Set([
  "observed", "candidate", "validated", "awaiting_approval", "trial", "active",
  "deprecated", "rejected", "failed_validation"
]);

function allowedActions(capability) {
  const state = capability.state || "candidate";
  const validationPassed = Boolean(capability.validation && capability.validation.passed);
  return {
    validate: ["candidate", "failed_validation"].includes(state),
    approve: state === "awaiting_approval" && validationPassed,
    promote: state === "trial" && (capability.successCount || 0) >= 1,
    reject: !["rejected", "deprecated", "active"].includes(state),
    deprecate: ["trial", "active"].includes(state),
    feedback: true,
  };
}

function transition(capability, nextState, metadata = {}) {
  if (!STATES.has(nextState)) throw new Error(`Invalid Evolve lifecycle state: ${nextState}`);
  const now = new Date().toISOString();
  capability.state = nextState;
  capability.updatedAt = now;
  capability.history = capability.history || [];
  capability.history.push({ state: nextState, at: now, ...metadata });
  return capability;
}

function candidateToCapability(candidate) {
  const now = new Date().toISOString();
  return {
    id: candidate.id,
    name: candidate.proposedToolName,
    title: candidate.title,
    description: candidate.description,
    state: candidate.state || "candidate",
    evidence: candidate.evidence || [],
    evidenceCount: candidate.evidenceCount || 0,
    successRate: candidate.successRate || 0,
    usefulnessScore: candidate.score || 0,
    scoreBreakdown: candidate.scoreBreakdown || {},
    parameters: candidate.parameters || {},
    schema: null,
    steps: candidate.steps || [],
    risk: candidate.risk || "medium",
    validation: null,
    approver: null,
    version: 1,
    activationDate: null,
    useCount: 0,
    successCount: 0,
    failureCount: 0,
    estimatedCallsSaved: candidate.estimatedCallsSaved || 0,
    lastUsedAt: null,
    userFeedback: [],
    deprecationReason: null,
    duplicate: Boolean(candidate.duplicate),
    duplicateReasons: candidate.duplicateReasons || [],
    createdAt: now,
    updatedAt: now,
    history: [{ state: candidate.state || "candidate", at: now, reason: "mined from telemetry" }],
  };
}

function validateCapability(capability, availableTools) {
  const validation = validateCandidate(capability, availableTools);
  capability.validation = validation;
  capability.schema = validation.schema;
  transition(capability, validation.passed ? "validated" : "failed_validation", { validationPassed: validation.passed });
  if (validation.passed) transition(capability, "awaiting_approval", { reason: "validation complete" });
  return capability;
}

function recordInvocation(capability, success, callsSaved = 0) {
  capability.useCount = (capability.useCount || 0) + 1;
  if (success) capability.successCount = (capability.successCount || 0) + 1;
  else capability.failureCount = (capability.failureCount || 0) + 1;
  capability.estimatedCallsSaved = (capability.estimatedCallsSaved || 0) + callsSaved;
  capability.lastUsedAt = new Date().toISOString();
  return capability;
}

function usefulness(capability) {
  const uses = capability.useCount || 0;
  const successRate = uses ? (capability.successCount || 0) / uses : 0;
  const votes = capability.userFeedback || [];
  const voteScore = votes.length ? votes.filter(v => v.useful).length / votes.length : 0.5;
  return Math.round(((capability.usefulnessScore || 0) * 0.5) + (successRate * 30) + (voteScore * 20));
}

module.exports = {
  STATES,
  allowedActions,
  transition,
  candidateToCapability,
  validateCapability,
  recordInvocation,
  usefulness,
};
