"use strict";

// Tool-catalog family: tools (catalog, discovery manifest, policy inspector).
//
// The final B-6 extraction — the registry/policy inspection surface. It reads
// the policy/approval/registry helpers that remain owned by tools-legacy
// (getToolDefsForSource, getToolPolicyDecision, getApprovalDecision,
// getToolRisk) lazily through the src/tools facade at call time, so this
// family carries no module-init dependency on tools-legacy and no require
// cycle. TOOL_CATEGORIES comes straight from the metadata module;
// getCurrentSource mirrors the legacy helper via toolContext. The policy
// inspection helpers (buildPolicyInspection, summarizePolicyInspection) move
// here and are re-exported through the facade for src/dashboard.js.
// `tools` is `low` risk, preserved from src/tools/metadata.js.

const { z } = require("zod");
const { TOOL_CATEGORIES } = require("../metadata");
const toolContext = require("../context");

function getCurrentSource() {
  return toolContext.getExecutionSource() || "unknown";
}
function getToolDefsForSource(...a) { return require("../index").getToolDefsForSource(...a); }
function getToolPolicyDecision(...a) { return require("../index").getToolPolicyDecision(...a); }
function getApprovalDecision(...a) { return require("../index").getApprovalDecision(...a); }
function getToolRisk(...a) { return require("../index").getToolRisk(...a); }

const RISK_ORDER = { low: 1, medium: 2, high: 3, critical: 4 };

function getToolRecordsForSource(source = getCurrentSource()) {
  const defs = getToolDefsForSource(source);
  return defs.map(def => ({
    name: def.name,
    description: def.description,
    args: def.args || {},
    category: def.category || TOOL_CATEGORIES[def.name] || "Uncategorized",
    risk: def.risk || getToolRisk(def.name),
    enabled: def.enabled !== false,
    approval_required: def.approval_required === true
  }));
}

function groupToolRecords(records) {
  const grouped = {};
  for (const tool of records) {
    const category = tool.category || "Uncategorized";
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(tool);
  }
  return Object.keys(grouped).sort().map(category => ({
    category,
    tools: grouped[category].sort((a, b) => a.name.localeCompare(b.name))
  }));
}

function formatToolOverview(records) {
  const grouped = groupToolRecords(records);
  const lines = [`Sidekick tools (${records.length} total)`];
  for (const group of grouped) {
    lines.push("", `${group.category} (${group.tools.length})`);
    for (const tool of group.tools) {
      const state = tool.enabled ? "" : " disabled";
      const approval = tool.approval_required ? ", approval required" : "";
      lines.push(`- ${tool.name} [${tool.risk}${approval}${state}]: ${tool.description}`);
    }
  }
  return lines.join("\n");
}

function normalizePolicySources(source) {
  if (!source) return ["mcp", "dashboard", "agent"];
  return String(source).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function inspectToolPolicy(toolInput, source) {
  const toolName = typeof toolInput === "string" ? toolInput : toolInput.name;
  const policy = getToolPolicyDecision(toolName, source);
  const approval = getApprovalDecision(toolName, source);
  return {
    source,
    tool: toolName,
    category: typeof toolInput === "string" ? null : toolInput.category || null,
    description: typeof toolInput === "string" ? null : toolInput.description || null,
    risk: policy.risk,
    allowed: policy.allowed,
    callable: policy.allowed,
    policy: {
      mode: policy.mode,
      allowed: policy.allowed,
      reason: policy.reason,
      matched: policy.matched || null,
      list: policy.list || null
    },
    approval_required: approval.required,
    approval: {
      mode: approval.mode,
      required: approval.required,
      reason: approval.reason,
      matched: approval.matched || null,
      list: approval.list || null
    }
  };
}

function buildPolicyInspection(records, sources) {
  const inspections = [];
  for (const source of sources) {
    for (const tool of records) {
      inspections.push(inspectToolPolicy(tool, source));
    }
  }
  return inspections;
}

function summarizePolicyInspection(inspections) {
  const summary = {
    total: inspections.length,
    sources: {},
    by_risk: {},
    blocked: 0,
    approval_required: 0
  };
  for (const item of inspections) {
    if (!summary.sources[item.source]) {
      summary.sources[item.source] = { total: 0, allowed: 0, blocked: 0, approval_required: 0, high_risk: 0 };
    }
    const sourceSummary = summary.sources[item.source];
    sourceSummary.total += 1;
    if (item.allowed) sourceSummary.allowed += 1;
    else {
      sourceSummary.blocked += 1;
      summary.blocked += 1;
    }
    if (item.approval_required) {
      sourceSummary.approval_required += 1;
      summary.approval_required += 1;
    }
    if (RISK_ORDER[item.risk] >= RISK_ORDER.high) sourceSummary.high_risk += 1;
    summary.by_risk[item.risk] = (summary.by_risk[item.risk] || 0) + 1;
  }
  return summary;
}

function formatPolicyInspection(inspections, summary = summarizePolicyInspection(inspections)) {
  const lines = [`Sidekick tool policy inspection (${inspections.length} decisions)`];
  for (const [source, counts] of Object.entries(summary.sources)) {
    lines.push(`Source ${source}: ${counts.allowed} allowed, ${counts.blocked} blocked, ${counts.approval_required} approval required, ${counts.high_risk} high/critical risk`);
  }
  for (const item of inspections) {
    const policyMatch = item.policy.matched ? `, matched ${item.policy.matched}` : "";
    const approvalMatch = item.approval.matched ? `, matched ${item.approval.matched}` : "";
    const category = item.category ? `${item.category}/` : "";
    lines.push(
      `- ${item.source}/${category}${item.tool} [${item.risk}]: ` +
      `policy ${item.allowed ? "allowed" : "blocked"} (${item.policy.mode}; ${item.policy.reason}${policyMatch}); ` +
      `approval ${item.approval_required ? "required" : "not required"} (${item.approval.mode}; ${item.approval.reason}${approvalMatch})`
    );
  }
  return lines.join("\n");
}

async function sidekick_tools({ action, query, name, category, format, include_disabled, limit, source }) {
  const selectedAction = action || "overview";
  const selectedFormat = format || "text";
  const maxResults = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 100;
  let records = getToolRecordsForSource(getCurrentSource());

  if (selectedAction !== "policy" && !include_disabled) {
    records = records.filter(tool => tool.enabled);
  }

  if (category) {
    const wantedCategory = String(category).toLowerCase();
    records = records.filter(tool => String(tool.category || "").toLowerCase() === wantedCategory);
  }

  if (selectedAction === "policy") {
    if (name) {
      records = records.filter(t => t.name === name);
      if (records.length === 0) {
        return { content: [{ type: "text", text: "Tool not found: " + name }], isError: true };
      }
    } else if (include_disabled === false) {
      records = records.filter(tool => tool.enabled);
    }
    records = records.slice(0, maxResults);
    const sources = normalizePolicySources(source);
    const inspections = buildPolicyInspection(records, sources);
    const summary = summarizePolicyInspection(inspections);
    const payload = { total: inspections.length, sources, summary, decisions: inspections };
    const text = selectedFormat === "json" ? JSON.stringify(payload, null, 2) : formatPolicyInspection(inspections, summary);
    return { content: [{ type: "text", text }] };
  }

  if (selectedAction === "get") {
    if (!name) {
      return { content: [{ type: "text", text: "name is required for action=get" }], isError: true };
    }
    const tool = records.find(t => t.name === name);
    if (!tool) {
      return { content: [{ type: "text", text: "Tool not found: " + name }], isError: true };
    }
    const text = selectedFormat === "json" ? JSON.stringify(tool, null, 2) : formatToolOverview([tool]);
    return { content: [{ type: "text", text }] };
  }

  if (selectedAction === "search") {
    if (!query) {
      return { content: [{ type: "text", text: "query is required for action=search" }], isError: true };
    }
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    records = records.filter(tool => {
      const haystack = [
        tool.name,
        tool.description,
        tool.category,
        tool.risk,
        Object.keys(tool.args || {}).join(" ")
      ].join(" ").toLowerCase();
      return terms.every(term => haystack.includes(term));
    }).slice(0, maxResults);
  } else if (selectedAction !== "overview") {
    return { content: [{ type: "text", text: "Invalid action. Allowed: overview, search, get, policy" }], isError: true };
  }

  const payload = selectedAction === "overview"
    ? { total: records.length, categories: groupToolRecords(records) }
    : { total: records.length, tools: records };
  const text = selectedFormat === "json" ? JSON.stringify(payload, null, 2) : formatToolOverview(records);
  return { content: [{ type: "text", text }] };
}

const SCHEMAS = {
  tools: z.object({
    action: z.enum(["overview", "search", "get", "policy"]).optional().default("overview").describe("Catalog action"),
    query: z.string().optional().describe("Search terms for action=search"),
    name: z.string().optional().describe("Tool name for action=get or action=policy"),
    category: z.string().optional().describe("Filter by category"),
    source: z.string().optional().describe("Comma-separated source list for action=policy, e.g. mcp,dashboard,agent"),
    format: z.enum(["text", "json"]).optional().default("text").describe("Output format"),
    include_disabled: z.boolean().optional().describe("Include policy-disabled tools"),
    limit: z.number().optional().describe("Max search results")
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "tools",
    description: "Tool catalog, discovery manifest, and policy inspector. Use for broad questions like 'what Sidekick tools are available?', 'list available tools', 'tool overview', 'tool manifest', or 'why is this tool blocked?'. Lists tools grouped by category, searches by capability, gets exact tool metadata, and inspects effective policy/approval decisions.",
    schema: SCHEMAS.tools,
    args: { action: "string (overview|search|get|policy - default overview)", query: "string (optional, search terms for action=search)", name: "string (optional, tool name for action=get or action=policy)", category: "string (optional, filter by category)", source: "string (optional, comma-separated sources for action=policy; default mcp,dashboard,agent)", format: "string (optional, text|json - default text)", include_disabled: "boolean (optional, include policy-disabled tools - default false; action=policy includes them by default)", limit: "number (optional, max search results - default 100)" },
    risk: "low",
    category: "Core",
    source: "builtin",
    family: "tool-catalog",
    handler: sidekick_tools,
  }),
]);

module.exports = { descriptors, sidekick_tools, buildPolicyInspection, summarizePolicyInspection };
