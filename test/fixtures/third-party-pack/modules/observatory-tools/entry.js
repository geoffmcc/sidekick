"use strict";

// Synthetic third-party PACK module fixture. Deliberately self-contained (no
// dispatch fan-out, empty permissions) so the capability-pack test exercising
// third_party provenance proves the LIFECYCLE — install/enable/dispatch/
// uninstall — without depending on any other tool or pack.

const { z } = require("zod");

module.exports = {
  buildDescriptors(services) {
    return [
      {
        name: "fixture_observation",
        description: "Return a synthetic observation proving the third-party fixture pack's tool dispatches",
        schema: z.object({ value: z.number().optional() }),
        args: { value: "number (optional input value)" },
        risk: "low",
        category: "Monitoring",
        handler: async ({ value = 1 }) => ({
          content: [{
            type: "text",
            text: JSON.stringify({
              module: services.moduleName,
              provenance_fixture: true,
              label: services.config.label || null,
              result: value,
            }),
          }],
        }),
      },
    ];
  },
  healthCheck({ config }) {
    return { ok: true, details: { label: config.label || null } };
  },
};
