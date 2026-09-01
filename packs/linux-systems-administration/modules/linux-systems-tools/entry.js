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
      schema: z.object({ include: z.string().min(1).max(200).regex(/^[a-z,]+$/).or(z.literal("")).optional(), services: optionalServices }).strict(),
      args: { include: "string", services: "string" }, risk: "medium", category: "Linux Systems",
      handler: args => services.dispatch("status", { include: args.include || "services,disk,memory,load,uptime,processes,modules", services: args.services || services.config?.default_services }),
    },
    {
      name: "linux_system_health",
      description: "Run the governed bounded host health check. This adapter does not infer health when a check is unavailable.",
      schema: z.object({ check: z.enum(["all", "services", "processes", "disk", "network", "modules"]).optional(), services: optionalServices, threshold: z.string().min(1).max(500).regex(/^[A-Za-z]+>[0-9]+(?:,[A-Za-z]+>[0-9]+)*$/).or(z.literal("")).optional() }).strict(),
      args: { check: "string", services: "string", threshold: "string" }, risk: "high", category: "Linux Systems",
      handler: args => services.dispatch("health", { check: args.check || "all", services: args.services || services.config?.default_services, threshold: args.threshold }),
    },
    {
      name: "linux_service_operation",
      description: "Inspect or operate one explicitly named systemd service through the governed service tool; mutations remain policy and approval controlled.",
      schema: z.object({ action: z.enum(serviceActions), service: z.string().regex(SERVICE_NAME), lines: z.number().int().min(1).max(1000).optional() }).strict(),
      args: { action: "string (start|stop|restart|status|enable|disable|logs)", service: "string", lines: "number" }, risk: "high", category: "Linux Systems",
      handler: args => validService(args.service) ? services.dispatch("service", args) : failure("invalid_input", "service must be one systemd unit name"),
    },
  ];
}

function healthCheck({ config }) {
  const services = config && config.default_services;
  const valid = typeof services === "string" && services.split(",").every(validService);
  return { ok: valid, details: { configured_service_scope: Boolean(services), invalid_configuration: valid ? null : "default_services must contain comma-separated systemd unit names", detection: "delegated to status/health/service providers" } };
}

module.exports = { buildDescriptors, healthCheck };
