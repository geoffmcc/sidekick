const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isWindowsMountedPath } = require("../src/security-scan");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-security-scan-"));
const dataDir = path.join(testRoot, "runtime-data");
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;

delete require.cache[require.resolve("../src/tools")];
const { TOOLS, setSource } = require("../src/tools");

function write(relative, content, mode) {
  const target = path.join(testRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (mode !== undefined) fs.chmodSync(target, mode);
  return target;
}

(async () => {
  try {
    assert.strictEqual(isWindowsMountedPath("/mnt/c/Users/geoff/Projects/sidekick/.env"), true);
    assert.strictEqual(isWindowsMountedPath("/home/sidekick/.env"), false);

    setSource("test");
    write("config.yml", [
      "POSTGRES_PASSWORD: weak-default",
      "SAFE_TOKEN: ${SAFE_TOKEN}",
      "PRIVATE_KEY_PATH: /run/secrets/key"
    ].join("\n"));
    write("package.json", '{"name":"sidekick"}');
    write(".env.example", "SIDEKICK_API_KEY=\n");
    write(".env", [
      "SIDEKICK_API_KEY=replace-with-your-sidekick-api-key",
      "SIDEKICK_APPROVAL_MODE=strict",
      "SIDEKICK_SECRET_KEY=",
      "SIDEKICK_DASHBOARD_USER=admin",
      "SIDEKICK_DASHBOARD_PASS=fixture-dashboard-pass"
    ].join("\n"), 0o600);
    write("generated-admin-password.txt", "do-not-return-this-value", 0o644);
    const privateKeyHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const privateKeyFooter = ["-----END", "PRIVATE KEY-----"].join(" ");
    write("private.pem", [
      privateKeyHeader,
      "not-real-key-material",
      privateKeyFooter
    ].join("\n"), 0o600);

    const result = await TOOLS.security_scan({
      path: testRoot,
      format: "json",
      max_files: 100
    });
    assert.ok(!result.isError);
    const report = JSON.parse(result.content[0].text);
    assert.ok(report.findings.some(item =>
      item.type === "hardcoded_sensitive_config" &&
      item.path === "config.yml" &&
      item.message.includes("POSTGRES_PASSWORD")
    ));
    assert.ok(report.findings.some(item =>
      item.type === "sensitive_filename" &&
      item.path === "generated-admin-password.txt"
    ));
    assert.ok(report.findings.some(item =>
      item.type === "private_key_material" &&
      item.path === "private.pem"
    ));
    assert.ok(!report.findings.some(item => item.type === "unsafe_api_key"));
    assert.ok(report.findings.some(item => item.type === "approval_encryption_missing"));
    assert.ok(!result.content[0].text.includes("do-not-return-this-value"));
    assert.ok(!result.content[0].text.includes("fixture-dashboard-pass"));
    assert.ok(!report.findings.some(item =>
      item.type === "hardcoded_sensitive_config" &&
      item.message.includes("SAFE_TOKEN")
    ));

    write("denied/credentials.yml", "PASSWORD: must-not-appear");
    process.env.SIDEKICK_DENIED_PATHS = path.join(testRoot, "denied");
    const descendantFiltered = await TOOLS.security_scan({ path: testRoot, format: "json" });
    const filteredReport = JSON.parse(descendantFiltered.content[0].text);
    assert.ok(filteredReport.skipped_by_policy > 0);
    assert.ok(!filteredReport.findings.some(item => item.path.startsWith("denied/")));

    process.env.SIDEKICK_DENIED_PATHS = testRoot;
    const blocked = await TOOLS.security_scan({ path: testRoot });
    assert.ok(blocked.isError);
    assert.ok(blocked.content[0].text.includes("Path blocked by policy"));
    delete process.env.SIDEKICK_DENIED_PATHS;

    console.log("Security scan tests passed");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  fs.rmSync(testRoot, { recursive: true, force: true });
  process.exit(1);
});
