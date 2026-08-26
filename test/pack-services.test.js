const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = path.join(os.tmpdir(), `sidekick-test-data-pack-services-${Date.now()}-${process.pid}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.SIDEKICK_DATA_DIR = dataDir;
const secretDir = path.join(dataDir, "secrets");
fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(secretDir, "sidekick_secret_key"), "pack-services-test-key\n", { mode: 0o600 });
process.env.SIDEKICK_SECRET_DIR = secretDir;
delete process.env.SIDEKICK_SECRET_KEY;
delete require.cache[require.resolve("../src/db")];
delete require.cache[require.resolve("../src/core/secrets-store")];
const db = require("../src/db");
const { createPackServices } = require("../src/modules/pack-services");

try {
  db.runPendingMigrations();
  const alpha = createPackServices("alpha", [
    { capability: "pack.secrets.metadata" },
    { capability: "pack.secrets.use" },
    { capability: "pack.secrets.write" },
    { capability: "pack.storage.read" },
    { capability: "pack.storage.write" },
    { capability: "pack.storage.delete" },
  ]);
  const beta = createPackServices("beta", [{ capability: "pack.storage.read" }]);

  assert.strictEqual(alpha.secrets.set("token", "alpha-secret").stored, true);
  assert.deepStrictEqual(alpha.secrets.list(), ["token"]);
  assert.strictEqual(alpha.secrets.get("token"), "alpha-secret");
  assert.throws(() => beta.secrets.get("token"), /requires an installed capability-pack owner|pack\.secrets/);

  alpha.storage.set("cursor", { offset: 4 });
  assert.deepStrictEqual(alpha.storage.get("cursor"), { offset: 4 });
  assert.strictEqual(beta.storage.get("cursor"), null);
  assert.throws(() => beta.storage.set("cursor", 5), /pack\.storage\.write/);
  assert.throws(() => alpha.storage.get("../other"), /safe name/);
  assert.strictEqual(alpha.secrets.delete("token").removed, true);
  assert.strictEqual(alpha.secrets.get("token"), null);
  console.log("Pack services: 10 passed");
} finally {
  try { db.close(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
