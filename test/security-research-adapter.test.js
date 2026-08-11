"use strict";

const assert = require("assert");
const { createSecurityResearchAdapter, request } = require("../src/connectors/security-research");

console.log("Running Security Research Adapter Contract Tests...\n");

(async () => {
  try {
    console.log("Test SRA.1: absent integration is explicit and fail-closed");
    const unavailable = createSecurityResearchAdapter({ endpoint: "https://example.test/api", secret_ref: "secret:security-research/api" });
    assert.strictEqual(unavailable.state, "unavailable");
    assert.strictEqual(unavailable.secret_ref_present, true);
    await assert.rejects(() => request(unavailable, "findings.list"), /unavailable; no request was sent/);
    console.log("Passed\n");

    console.log("Test SRA.2: boundary validates transport configuration and delegates typed operations");
    assert.throws(() => createSecurityResearchAdapter({ endpoint: "http://user:pass@example.test" }), /without embedded credentials/);
    assert.throws(() => createSecurityResearchAdapter({ secret_ref: "raw-token" }), /opaque secret:name/);
    let received;
    const adapter = createSecurityResearchAdapter({
      endpoint: "https://example.test/api",
      secret_ref: "secret:security-research/api",
      capabilities: ["findings.read"],
      transport: { request: async input => { received = input; return { status: "analysis_only", items: [] }; } },
    });
    const result = await request(adapter, "findings.list", { project_id: "demo" });
    assert.strictEqual(adapter.state, "ready");
    assert.strictEqual(result.adapter, "security-research");
    assert.strictEqual(received.operation, "findings.list");
    assert.deepStrictEqual(received.payload, { project_id: "demo" });
    console.log("Passed\n");

    console.log("All Security Research Adapter Contract tests passed.");
  } catch (error) {
    console.error("Security Research Adapter Contract test failed:", error);
    process.exit(1);
  }
})();
