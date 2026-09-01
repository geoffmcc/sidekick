"use strict";
const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");

const safePath = value => typeof value === "string" && value.length <= 500 && !/[\u0000\r\n]/.test(value) && !/(^|[\\/])\.\.?([\\/]|$)/.test(value);
const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(value);
function failure(code, error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, code, error }) }], isError: true, code }; }

function buildDescriptors(services) {
  return [
    {
      name: "backup_database", description: "Create a timestamped governed database backup with optional compression.",
      schema: z.object({ path: z.string().max(500).regex(/^[^\u0000\r\n]+$/).refine(safePath, "path contains traversal").or(z.literal("")).optional(), compress: z.boolean().optional() }).strict(), args: { path: "string", compress: "boolean" }, risk: "medium", category: "Backup and DR",
      handler: args => args.path && !safePath(args.path) ? failure("invalid_path", "backup path contains traversal or control characters") : services.dispatch("db_backup", { path: args.path, compress: args.compress === true }),
    },
    {
      name: "restore_database", description: "Request a verified database restore through the critical governed restore tool; this adapter does not simulate restores.",
      schema: z.object({ path: z.string().min(1).max(500).regex(/^[^\u0000\r\n]+$/).refine(safePath, "path contains traversal"), verify: z.boolean().optional() }).strict(), args: { path: "string", verify: "boolean" }, risk: "critical", category: "Backup and DR",
      handler: args => !safePath(args.path) ? failure("invalid_path", "restore path contains traversal or control characters") : services.dispatch("db_restore", { path: args.path, verify: args.verify !== false }),
    },
    {
      name: "compare_backup_snapshots", description: "Compare two database snapshots using the governed deterministic database diff.",
      schema: z.object({ snapshot_a: z.string().min(1).max(500).regex(/^[^\u0000\r\n]+$/).refine(safePath, "path contains traversal"), snapshot_b: z.string().min(1).max(500).regex(/^[^\u0000\r\n]+$/).refine(safePath, "path contains traversal"), table: z.string().regex(identifier).optional() }).strict(), args: { snapshot_a: "string", snapshot_b: "string", table: "string" }, risk: "low", category: "Backup and DR",
      handler: args => !safePath(args.snapshot_a) || !safePath(args.snapshot_b) ? failure("invalid_path", "snapshot paths contain traversal or control characters") : services.dispatch("db_diff", args),
    },
    {
      name: "backup_dr_readiness", description: "Inspect Proxmox backup coverage, history, and verification evidence without changing the environment.",
      schema: z.object({ profile: z.string().regex(identifier).or(z.literal("")).optional() }).strict(), args: { profile: "string" }, risk: "low", category: "Backup and DR",
      handler: async args => { const read = async action => { try { return await services.dispatch("proxmox", { action, profile: args.profile }); } catch (error) { return { state: "unavailable", code: error.code || "provider_unavailable", error: String(error.message || error).slice(0, 300) }; } }; return { content: [{ type: "text", text: JSON.stringify({ coverage: await read("backup_coverage"), history: await read("backup_history"), verification: await read("backup_verification_audit") }, null, 2) }] }; },
    },
  ];
}
function healthCheck({ config }) { return { ok: Boolean(config && config.default_database), details: { default_database: config && config.default_database, restore: "delegated critical operation" } }; }
module.exports = { buildDescriptors, healthCheck };
