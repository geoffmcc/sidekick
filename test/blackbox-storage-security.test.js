const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createBlackboxStorage } = require("../src/blackbox/storage");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-blackbox-storage-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-blackbox-outside-"));
const storage = createBlackboxStorage({
  rootDir: root,
  safeId(value, label) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(String(value || ""))) throw new Error(`Invalid ${label}`);
  },
  redact: value => String(value || ""),
  hashText: value => crypto.createHash("sha256").update(String(value)).digest("hex"),
  nowIso: () => new Date().toISOString(),
  defaults: { dailyLimit: 20, maxBytes: 1024 * 1024, maxIncidents: 10 }
});

try {
  const artifact = storage.writeArtifact("incident", "capture", "source", "stdout", "safe output");
  assert.strictEqual(storage.readArtifactByPath(artifact.path), "safe output");

  const escaped = path.join(root, "escaped");
  fs.symlinkSync(outside, escaped, "dir");
  assert.throws(
    () => storage.readArtifactByPath(path.join(escaped, "secret.txt")),
    /symlink|escaped/i,
    "artifact reads must reject symlinked paths"
  );
  assert.throws(
    () => storage.writeArtifact("escaped", "capture", "source", "stdout", "must not write"),
    /symlink|escaped/i,
    "artifact writes must reject symlinked directories"
  );

  const victim = path.join(outside, "victim.txt");
  fs.writeFileSync(victim, "must survive");
  const incidentLink = path.join(root, "linked-incident");
  fs.symlinkSync(outside, incidentLink, "dir");
  assert.throws(
    () => storage.removeIncidentArtifacts("linked-incident"),
    /symlink|escaped/i,
    "incident deletion must reject symlinked directories"
  );
  assert.strictEqual(fs.readFileSync(victim, "utf8"), "must survive");

  console.log("Black Box storage security tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
