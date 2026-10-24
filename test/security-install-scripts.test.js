"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("bootstrap installs NodeSource only through its fingerprint-pinned HTTPS key", () => {
  const bootstrap = read("scripts/bootstrap.sh");
  const helper = read("scripts/lib/apt-repository.sh");
  assert.match(bootstrap, /install_verified_apt_key\s+\\\s*[\s\S]*6F71F525282841EEDAF851B42F59B5F99B1BE0B4/);
  assert.match(bootstrap, /Signed-By: \/usr\/share\/keyrings\/nodesource\.gpg/);
  assert.doesNotMatch(bootstrap, /deb\.nodesource\.com\/setup_[^\s|]*\s*\|\s*bash/);
  assert.match(helper, /actual_fingerprint.*expected_fingerprint/);
  assert.match(helper, /--proto '=https' --tlsv1\.2/);
});

test("setup-tools uses a fingerprint-pinned Docker APT source", () => {
  const setup = read("scripts/setup-tools.sh");
  assert.match(setup, /install_verified_apt_key\s+\\\s*[\s\S]*9DC858229FC7DD38854AE2D88D81803C0EBFCD88/);
  assert.match(setup, /Signed-By: \/etc\/apt\/keyrings\/docker\.gpg/);
  assert.doesNotMatch(setup, /get\.docker\.com\s*\|\s*sh/);
});

test("setup-tools runs third-party Python and npm package hooks as sidekick", () => {
  const setup = read("scripts/setup-tools.sh");
  assert.match(setup, /sudo -H -u "\$USERNAME" "\$TOOLS_PYTHON" -m pip install -q yt-dlp/);
  assert.match(setup, /sudo -H -u "\$USERNAME" "\$TOOLS_PYTHON" -m pip install -q openai-whisper/);
  assert.match(setup, /sudo -H -u "\$USERNAME" "\$TOOLS_PYTHON" -m pip install -q duckdb/);
  assert.match(setup, /sudo -H -u "\$USERNAME" env NPM_CONFIG_PREFIX="\$TOOLS_NPM_PREFIX" npm install --global @mermaid-js\/mermaid-cli/);
  assert.doesNotMatch(setup, /^\s*pip3?\s+install\b/m);
  assert.doesNotMatch(setup, /^\s*npm\s+install\s+-g\b/m);
  assert.match(setup, /find -P "\$TOOLS_VENV" -xdev[\s\S]*-exec chown "\$USERNAME:\$USERNAME"/);
  assert.match(setup, /\[ -L "\$TOOLS_VENV" \]/);
});

test("downloaded setup binaries are pinned, verified, and safely extracted", () => {
  const setup = read("scripts/setup-tools.sh");
  const ollama = read("scripts/lib/install-ollama.sh");
  assert.match(setup, /CLOUDFLARED_VERSION="\d+\.\d+\.\d+"/);
  assert.match(setup, /CLOUDFLARED_SHA256="[a-f0-9]{64}"/);
  assert.ok(setup.indexOf("sha256sum --check --status") < setup.indexOf("install -o root -g root -m 0755 -- \"$CLOUDFLARED_TMP\""));
  assert.doesNotMatch(setup, /releases\/latest\/download\/cloudflared/);
  assert.match(ollama, /local version="\d+\.\d+\.\d+"/);
  assert.match(ollama, /sha256sum --check --status/);
  assert.match(ollama, /\|\.\.\//);
  assert.ok(ollama.indexOf("sha256sum --check --status") < ollama.indexOf("--extract --file"));
  assert.doesNotMatch(setup, /ollama\.com\/install\.sh\s*\|\s*sh/);
});

test("metrics timer provisioning checks the protected Influx secret file", () => {
  const bootstrap = read("scripts/bootstrap.sh");
  const setup = read("scripts/setup-tools.sh");
  const unit = read("systemd/sidekick-metrics.service");
  const verifier = read("scripts/verify-runtime-secret.js");
  const deploy = read("deploy.ps1");
  for (const script of [bootstrap, setup]) {
    assert.match(script, /verify-runtime-secret\.js" SIDEKICK_INFLUX_TOKEN \/etc\/sidekick\/secrets/);
    assert.doesNotMatch(script, /grep -q '\^SIDEKICK_INFLUX_TOKEN=/,
      "installer must not enable metrics based on a raw dotenv credential");
  }
  assert.match(unit, /^Environment=SIDEKICK_SECRET_DIR=\/etc\/sidekick\/secrets$/m);
  assert.match(verifier, /readSecret\(name\)/);
  assert.doesNotMatch(verifier, /console\.(?:log|error).*value/);
  assert.match(deploy, /scripts\\verify-runtime-secret\.js/,
    "incremental deployment must upload the new installer helper");
});

test("runtime-secret verifier accepts only the protected file and never prints its value", t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-runtime-secret-verifier-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const secretDir = path.join(fixture, "secrets");
  fs.mkdirSync(secretDir);
  const secretFile = path.join(secretDir, "sidekick_influx_token");
  const verifier = path.join(root, "scripts/verify-runtime-secret.js");
  const env = { ...process.env, SIDEKICK_INFLUX_TOKEN: "synthetic-environment-only-token" };

  fs.writeFileSync(secretFile, "synthetic-file-backed-token\n", { mode: 0o600 });
  fs.chmodSync(secretFile, 0o600);
  let result = spawnSync(process.execPath, [verifier, "SIDEKICK_INFLUX_TOKEN", secretDir], { encoding: "utf8", env });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");

  fs.writeFileSync(secretFile, "sidekick-influx-token\n", { mode: 0o600 });
  fs.chmodSync(secretFile, 0o600);
  result = spawnSync(process.execPath, [verifier, "SIDEKICK_INFLUX_TOKEN", secretDir], { encoding: "utf8", env });
  assert.equal(result.status, 1, "placeholder file contents cannot enable the timer");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");

  result = spawnSync(process.execPath, [verifier, "SIDEKICK_INFLUX_TOKEN", path.join(fixture, "missing")], { encoding: "utf8", env });
  assert.equal(result.status, 1, "an environment-only token cannot enable the timer");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
