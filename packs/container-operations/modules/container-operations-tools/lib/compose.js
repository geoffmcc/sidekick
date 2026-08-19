"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const profiles = require("./profiles");
const { ContainerError } = require("./errors");

function resolveFile(profile, configuredRoots, requested) {
  if (typeof requested !== "string" || !requested) throw new ContainerError("invalid_input", "compose file is required");
  const file = path.resolve(requested);
  const roots = [...(profile.compose?.project_roots || []), ...(configuredRoots || [])].map(p => path.resolve(p));
  if (!roots.some(root => file === root || file.startsWith(`${root}${path.sep}`))) throw new ContainerError("path_denied", "compose file is outside administrator-configured project roots");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new ContainerError("resource_missing", "compose file does not exist");
  if (!/\.(ya?ml)$/i.test(file)) throw new ContainerError("invalid_input", "compose file must be YAML");
  return file;
}

function run(profile, file, action, timeoutMs) {
  const binary = profile.compose?.binary || (profile.provider === "podman" ? "podman" : "docker");
  const implementation = profile.compose?.implementation || (profile.provider === "podman" ? "podman compose" : "docker compose");
  const args = implementation === "docker compose" || implementation === "podman compose" ? ["compose"] : [];
  args.push("-f", file, action === "validate" ? "config" : action, ...(action === "validate" ? ["--quiet"] : ["--dry-run"]));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, cwd: path.dirname(file), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = []; const err = []; let bytes = 0; const max = 200000;
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { bytes += chunk.length; const target = stream === child.stdout ? out : err; if (Buffer.byteLength(target.join("")) < max) target.push(chunk.toString("utf8").slice(0, max)); });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new ContainerError("operation_timeout", "Compose operation timed out")); }, timeoutMs);
    child.on("error", error => { clearTimeout(timer); reject(new ContainerError(error.code === "ENOENT" ? "compose_unavailable" : "provider_failure", `Compose process failed: ${error.code || "spawn error"}`)); });
    child.on("close", code => { clearTimeout(timer); resolve({ ok: code === 0, exit_code: code, stdout: out.join("").slice(0, max), stderr: err.join("").slice(0, max), truncated: bytes > max }); });
  });
}

async function execute(profile, config, action, file) {
  const resolved = resolveFile(profile, config.repository_roots, file);
  if (!profile.compose) throw new ContainerError("compose_unavailable", `Compose is not configured for profile "${profile.name}"`);
  const result = await run(profile, resolved, action, profile.operation_timeout_ms);
  return { profile: profile.name, provider: profile.provider, file: resolved, action, ...result };
}

module.exports = { execute, resolveFile };
