const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-health-"));
process.env.SIDEKICK_DATA_DIR = testDataDir;

delete require.cache[require.resolve("../src/tools")];
const { TOOLS, setSource, checkNetwork } = require("../src/tools");

(async () => {
  try {
    setSource("test");

    const all = await TOOLS.health({ check: "all" });
    assert.ok(!all.isError);
    assert.ok(all.content[0].text.includes("Health Check Report"));
    assert.ok(all.content[0].text.includes("## Services"));
    assert.ok(all.content[0].text.includes("## Processes"));
    assert.ok(all.content[0].text.includes("## Disk"));
    assert.ok(all.content[0].text.includes("## Network"));
    assert.ok(!all.content[0].text.includes("Cannot convert undefined or null to object"));

    const network = await checkNetwork({
      dnsProbe: async host => ({ ok: true, host, address: "192.0.2.1" }),
      httpsProbe: async url => ({ ok: true, url, statusCode: 200, latencyMs: 10 }),
      execFileSyncImpl: command => {
        if (command === "ping") throw new Error("ICMP blocked");
        if (command === "ss") {
          return [
            "LISTEN 0 511 0.0.0.0:4097 0.0.0.0:*",
            "LISTEN 0 511 0.0.0.0:4098 0.0.0.0:*",
            "LISTEN 0 511 0.0.0.0:4099 0.0.0.0:*"
          ].join("\n");
        }
        throw new Error(`Unexpected command: ${command}`);
      }
    });
    assert.strictEqual(network.score, 100);
    assert.strictEqual(network.results.internet, true);
    assert.strictEqual(network.results.icmp.ok, false);
    assert.deepStrictEqual(network.issues, []);

    const custom = await TOOLS.health({ check: "custom" });
    assert.ok(!custom.isError);
    assert.ok(custom.content[0].text.includes("## Custom"));

    const historyPath = path.join(testDataDir, "health_history.json");
    assert.ok(fs.existsSync(historyPath));
    const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    assert.strictEqual(history.length, 2);

    console.log("Health tests passed");
  } finally {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  fs.rmSync(testDataDir, { recursive: true, force: true });
  process.exit(1);
});
