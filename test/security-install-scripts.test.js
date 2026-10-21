"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
