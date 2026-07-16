const legacy = require("../tools-legacy");

module.exports = {
  enforceToolPolicy: legacy.enforceToolPolicy,
  getToolRisk: legacy.getToolRisk,
  getToolPolicyDecision: legacy.getToolPolicyDecision,
  buildPolicyInspection: legacy.buildPolicyInspection,
  summarizePolicyInspection: legacy.summarizePolicyInspection,
  isDangerous: legacy.isDangerous,
};
