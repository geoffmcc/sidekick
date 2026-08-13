"use strict";

// Synthetic third-party module fixture (v2). Deliberately self-contained:
// no dispatch fan-out, so the manifest declares no permissions.

const { z } = require("zod");

module.exports = {
  buildDescriptors(services) {
    return [
      {
        name: "synthetic_metric",
        aliases: ["synthetic_metrics"],
        description: "Return a synthetic metric derived from the module configuration",
        schema: z.object({ value: z.number().optional() }),
        args: { value: "number (optional input value)" },
        risk: "low",
        category: "Monitoring",
        handler: async ({ value = 1 }) => ({
          content: [{
            type: "text",
            text: JSON.stringify({
              module: services.moduleName,
              api: "v2",
              label: services.config.label,
              result: value * (services.config.factor || 1) + 1000,
            }),
          }],
        }),
      },
    ];
  },
  healthCheck({ config }) {
    return { ok: true, details: { api: "v2", label: config.label } };
  },
};
