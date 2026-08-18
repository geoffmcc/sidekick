"use strict";

const assert = require("assert");
const dns = require("dns");
const http = require("http");
const { requestJson } = require("../src/compute/provider-http");

async function main() {
  const previous = dns.promises.lookup;
  let server;
  try {
    server = http.createServer((req, res) => {
      assert.strictEqual(req.headers.host, `provider.example:${server.address().port}`, "provider request must preserve the configured Host");
      assert.strictEqual(req.url, "/v1/chat?probe=1", "provider request must preserve the full path and query");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    dns.promises.lookup = async () => [{ address: "127.0.0.1", family: 4 }];
    const result = await requestJson({
      endpoint: `http://provider.example:${port}`,
      path: "/v1/chat?probe=1",
      body: { prompt: "test" },
      label: "provider endpoint",
      errorPrefix: "Provider",
    });
    assert.deepStrictEqual(result, { ok: true }, "pinned provider request should preserve legitimate private-provider use");

    dns.promises.lookup = async () => [{ address: "169.254.169.254", family: 4 }];
    await assert.rejects(
      () => requestJson({ endpoint: `http://metadata.example:${port}/v1`, path: "/chat", body: {} }),
      /protected|metadata|link-local/i,
      "provider requests must reject metadata-range DNS answers"
    );
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    dns.promises.lookup = previous;
  }
  console.log("provider outbound security tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
