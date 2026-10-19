"use strict";

const { requireFromSidekick } = require("./lib/deps");
const { z } = requireFromSidekick("zod");

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,254}$/;
function validService(value) { return typeof value === "string" && SERVICE_NAME.test(value); }
const optionalServices = z.string().regex(/^[A-Za-z0-9_.@:-]+(?:,[A-Za-z0-9_.@:-]+)*$/).or(z.literal("")).optional();
function failure(code, error) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, code, error }) }], isError: true, code }; }

function buildDescriptors(services) {
  const serviceActions = ["start", "stop", "restart", "status", "enable", "disable", "logs"];
  return [
    {
      name: "linux_system_status",
      description: "Return bounded Linux host status using the governed system status tool; unavailable sections remain provider-reported.",
      schema: z.object({ include: z.string().min(1).max(200).regex(/^[a-z,]+$/).or(z.literal("")).optional().describe("Comma-separated status sections such as services,disk,memory,load,uptime,processes,modules; omit for the standard set."), services: optionalServices.describe("Optional comma-separated systemd unit names to scope service status; defaults to the configured pack list.") }).strict(),
      args: { include: "string (comma-separated host status sections; omit for standard set)", services: "string (optional comma-separated configured systemd unit names)" }, risk: "medium", category: "Linux Systems",
      handler: args => services.dispatch("status", { include: args.include || "services,disk,memory,load,uptime,processes,modules", services: args.services || services.config?.default_services }),
    },
    {
      name: "linux_system_health",
      description: "Run the governed bounded host health check. This adapter does not infer health when a check is unavailable.",
      schema: z.object({ check: z.enum(["all", "services", "processes", "disk", "network", "modules"]).optional().describe("Health area to inspect; defaults to all."), services: optionalServices.describe("Optional comma-separated systemd unit names for service checks; defaults to the configured pack list."), threshold: z.string().min(1).max(500).regex(/^[A-Za-z]+>[0-9]+(?:,[A-Za-z]+>[0-9]+)*$/).or(z.literal("")).optional().describe("Optional comma-separated thresholds in metric>value form, for example disk>90.") }).strict(),
      args: { check: "string (all|services|processes|disk|network|modules; default all)", services: "string (optional configured systemd units)", threshold: "string (optional metric>value pairs)" }, risk: "high", category: "Linux Systems",
      handler: args => services.dispatch("health", { check: args.check || "all", services: args.services || services.config?.default_services, threshold: args.threshold }),
    },
    {
      name: "linux_service_operation",
      description: "Inspect or operate one explicitly named systemd service through the governed service tool; mutations remain policy and approval controlled.",
      schema: z.object({ action: z.enum(serviceActions).describe("Systemd operation; start, stop, restart, enable, and disable are mutations subject to policy and approval."), service: z.string().regex(SERVICE_NAME).describe("Exact systemd unit name, not a shell command or pattern."), lines: z.number().int().min(1).max(1000).optional().describe("Maximum recent log lines to return for logs.") }).strict(),
      args: { action: "string (status|logs are reads; start|stop|restart|enable|disable mutate service state)", service: "string (exact systemd unit name; no shell syntax)", lines: "number (maximum recent log lines)" }, risk: "high", category: "Linux Systems",
      handler: args => validService(args.service) ? services.dispatch("service", args) : failure("invalid_input", "service must be one systemd unit name"),
    },
    {
      name: "linux_process_inspection", description: "Inspect bounded host processes through the governed process provider.",
      schema: z.object({ action: z.enum(["list", "top", "tree"]).describe("Bounded read-only process view."), filter: z.string().max(200).regex(/^[^\0\r\n]*$/).optional().describe("Literal provider filter text; not interpreted as a command or regular expression.") }).strict(),
      args: { action: "string (list|top|tree; read-only)", filter: "string (literal bounded process filter; no command execution)" }, risk: "low", category: "Linux Systems", annotations: { readOnlyHint: true, idempotentHint: true },
      handler: args => services.dispatch("process", args),
    },
  ];
}

function healthCheck({ config }) {
  const services = config && config.default_services;
  const valid = typeof services === "string" && services.split(",").every(validService);
  return { ok: valid, details: { configured_service_scope: Boolean(services), invalid_configuration: valid ? null : "default_services must contain comma-separated systemd unit names", detection: "delegated to status/health/service providers" } };
}

module.exports = { buildDescriptors, healthCheck };
