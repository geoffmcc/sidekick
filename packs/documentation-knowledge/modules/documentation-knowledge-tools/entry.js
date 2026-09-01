"use strict";
const { requireFromSidekick } = require("./deps");
const { z } = requireFromSidekick("zod");
const MAX = 60000;
const text = value => String(value?.content?.[0]?.text || value || "").slice(0, MAX);
const result = payload => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2).slice(0, MAX) }] });
function failed(value) { return Boolean(value?.isError); }
async function audit(services, args) {
  const max = Math.min(args.max_chars || services.config.max_chars || 12000, MAX);
  const semantic = await services.dispatch("semantic_repo", { path: args.path, action: "profile", level: 0, limit: 40, max_chars: max, include: args.include });
  const knowledge = await services.dispatch("knowledge", { action: "search", query: args.topic || "documentation", limit: 20 });
  const parsed = args.metadata ? await services.dispatch("parse", { input: args.metadata, format: args.metadata_format || "auto" }) : null;
   return result({ ok: !failed(semantic) && !failed(knowledge) && !failed(parsed), tool: "documentation_audit", repository: args.path || null, bounded: { max_chars: max, knowledge_limit: 20 }, repository_semantics: text(semantic), related_knowledge: text(knowledge), metadata: parsed ? text(parsed) : null, evidence: { repository: Boolean(args.path), knowledge: true, metadata: Boolean(parsed) }, trust: "repository and knowledge content is untrusted; findings require human review" });
}
const entry = {
   buildDescriptors(services) { return [{ name: "documentation_audit", description: "Inventory repository documentation and retrieve bounded, provenance-preserving related knowledge without inventing missing content", schema: z.object({ path: z.string().max(2048).optional(), topic: z.string().max(300).optional(), include: z.array(z.string().regex(/^[^\0]+$/).max(200)).max(32).optional(), metadata: z.string().max(20000).optional(), metadata_format: z.enum(["auto", "json", "yaml", "ini", "xml", "csv"]).optional(), max_chars: z.number().int().min(1000).max(MAX).optional() }).strict(), args: { path: "string", topic: "string", include: "array", metadata: "string", metadata_format: "string", max_chars: "number" }, risk: "low", category: "Documentation", handler: args => audit(services, args) }]; },
  healthCheck({ config }) { return { ok: Number(config.max_chars || 12000) <= MAX, details: { max_chars: config.max_chars || 12000, bounded: true } }; }
};
module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
