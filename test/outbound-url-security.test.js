"use strict";

const assert = require("assert");
const dns = require("dns");
const http = require("http");

const outbound = require("../src/security/outbound-url");

async function main() {
  const previous = dns.promises.lookup;
  const previousPrivate = process.env.SIDEKICK_ALLOW_PRIVATE_FETCH;
  const { sidekick_web_fetch } = require("../src/tools/families/net-fetch");
  let server;
  try {
    delete process.env.SIDEKICK_ALLOW_PRIVATE_FETCH;
    dns.promises.lookup = async () => [
      { address: "127.0.0.1", family: 4 },
      { address: "93.184.216.34", family: 4 },
    ];

    const refused = await outbound.resolveOutboundUrl("https://attacker-controlled.example/", "url");
    assert.match(refused.refusal, /private|loopback/i, "DNS-resolved loopback must be refused");

    dns.promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const pinned = await outbound.resolveOutboundUrl("https://example.com/path", "url");
    assert.strictEqual(pinned.address, "93.184.216.34", "caller must receive the validated address to pin");
    assert.strictEqual(pinned.url.hostname, "example.com", "original hostname must remain available for Host/SNI");

    process.env.SIDEKICK_ALLOW_PRIVATE_FETCH = "true";
    dns.promises.lookup = async () => [{ address: "169.254.169.254", family: 4 }];
    const metadata = await outbound.resolveOutboundUrl("https://metadata.example/", "url");
    assert.match(metadata.refusal, /protected|metadata|link-local/i, "metadata-range DNS results remain forbidden");

    process.env.SIDEKICK_ALLOW_PRIVATE_FETCH = "true";
    server = http.createServer((req, res) => {
      assert.match(req.headers.host, /^public\.example:\d+$/, "pinned requests retain the original HTTP Host");
      res.end("pinned");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    dns.promises.lookup = async () => [{ address: "127.0.0.1", family: 4 }];
    const fetched = await sidekick_web_fetch({ url: `http://public.example:${port}/` });
    assert.ok(!fetched.isError, "DNS-pinned web_fetch should retain legitimate functionality");
    assert.match(fetched.content[0].text, /Status: 200[\s\S]*pinned/);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    dns.promises.lookup = previous;
    if (previousPrivate === undefined) delete process.env.SIDEKICK_ALLOW_PRIVATE_FETCH;
    else process.env.SIDEKICK_ALLOW_PRIVATE_FETCH = previousPrivate;
  }
  console.log("outbound URL security tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
