const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-health-"));
process.env.SIDEKICK_DATA_DIR = testDataDir;

delete require.cache[require.resolve("../src/tools")];
const { TOOLS, setSource } = require("../src/tools");

(async () => {
  try {
    setSource("test");

    const all = await TOOLS.sidekick_health({ check: "all" });
    assert.ok(!all.isError);
    assert.ok(all.content[0].text.includes("Health Check Report"));
    assert.ok(all.content[0].text.includes("## Services"));
    assert.ok(all.content[0].text.includes("## Processes"));
    assert.ok(all.content[0].text.includes("## Disk"));
    assert.ok(all.content[0].text.includes("## Network"));
    assert.ok(!all.content[0].text.includes("Cannot convert undefined or null to object"));

    const custom = await TOOLS.sidekick_health({ check: "custom" });
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
