"use strict";

const assert = require("assert");
const operations = require("../packs/container-operations/modules/container-operations-tools/lib/operations");
const profiles = require("../packs/container-operations/modules/container-operations-tools/lib/profiles");
const compose = require("../packs/container-operations/modules/container-operations-tools/lib/compose");

function fakeClient() {
  const calls = [];
  const containers = [{ Id: "abc", Name: "/web", Image: "sha256:abc", Config: { Image: "example/web:1", Labels: { "com.docker.compose.project": "demo", "com.docker.compose.service": "web" } }, State: { Status: "running", Running: true, Health: { Status: "healthy", Log: [] } }, NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] }, Networks: { demo: {} } }, Mounts: [] }];
  return { calls, get: async path => { calls.push(["GET", path]); if (path === "/containers/json?all=1") return containers; if (path === "/containers/abc/json") return containers[0]; if (path === "/images/json?all=1") return [{ Id: "sha256:abc", RepoTags: ["example/web:1"], RepoDigests: ["example/web@sha256:old"], Created: 1, Size: 10, Containers: 1 }]; if (path === "/networks") return [{ Id: "n", Name: "demo", Containers: { abc: {} } }]; if (path === "/volumes") return { Volumes: [] }; if (path === "/info") return { ID: "engine", Name: "test", ServerVersion: "test", SecurityOptions: ["name=rootless"] }; if (path === "/version") return { Version: "1", ApiVersion: "1" }; if (path.startsWith("/containers/web/stats")) return { id: "abc", name: "web", cpu_stats: {}, precpu_stats: {}, memory_stats: { usage: 2, limit: 10 }, networks: {} }; throw new Error(`unexpected GET ${path}`); }, post: async (path, body) => { calls.push(["POST", path, body]); return { Id: "new" }; }, delete: async path => { calls.push(["DELETE", path]); }, getText: async path => { calls.push(["TEXT", path]); return { text: "2025-01-01T00:00:00Z secret=value\nline2\n", truncated: false }; }, postText: async path => { calls.push(["POSTTEXT", path]); return { text: "{\"status\":\"Downloaded\"}\n", truncated: false }; } };
}

function test(name, fn) { try { fn(); console.log(`Passed: ${name}`); } catch (error) { console.error(`Failed: ${name}: ${error.stack}`); process.exitCode = 1; } }

test("CO.1: Docker and Podman profiles require safe named transports", () => {
  assert.equal(profiles.parseProfile("docker-local", { provider: "docker", socket: "/var/run/docker.sock" }).ok, true);
  assert.equal(profiles.parseProfile("podman-rootless", { provider: "podman", socket: "/run/user/1000/podman/podman.sock" }).ok, true);
  assert.equal(profiles.parseProfile("bad", { provider: "docker", endpoint: "http://127.0.0.1:2375" }).ok, false);
  assert.equal(profiles.parseProfile("bad", { provider: "docker", endpoint: "https://127.0.0.1:2376" }).ok, false);
});

test("CO.2: normalized discovery retains health, security, networks and ports", async () => {
  const client = fakeClient();
  const listed = await operations.list(client);
  assert.equal(listed[0].name, "web"); assert.equal(listed[0].health, "healthy"); assert.deepEqual(listed[0].networks, ["demo"]);
  const summary = await operations.summary(client); assert.equal(summary.counts.running, 1); assert.equal(summary.health, "healthy");
});

test("CO.3: logs and stats are bounded and use structured provider calls", async () => {
  const client = fakeClient(); const logs = await operations.logs(client, "web", { tail: 10, max_bytes: 1024, max_lines: 2 });
  assert.equal(logs.lines.length <= 2, true); assert.equal(client.calls.some(c => c[0] === "TEXT" && c[1].includes("tail=10")), true);
  const stats = await operations.stats(client, "web"); assert.equal(stats.memory.limit, 10);
});

test("CO.4: image pulls reject shell metacharacters and use POST", async () => {
  const client = fakeClient(); await operations.pull(client, "example/web:1"); assert.equal(client.calls.some(c => c[0] === "POSTTEXT"), true);
  await assert.rejects(() => operations.pull(client, "example/web:1;touch /tmp/pwned"), /invalid/);
});

test("CO.5: Compose roots and binaries are allowlisted", () => {
  assert.throws(() => compose.resolveFile({ compose: { project_roots: ["/srv/compose"] } }, [], "/tmp/compose.yml"), /outside/);
  assert.equal(profiles.parseProfile("x", { provider: "docker", socket: "/var/run/docker.sock", compose: { binary: "sh" } }).ok, false);
});

test("CO.6: provider failures remain explicit rather than healthy", async () => {
  const client = fakeClient(); client.get = async () => { const error = new Error("down"); error.code = "ECONNREFUSED"; throw error; };
  await assert.rejects(() => operations.info(client));
});

if (!process.exitCode) console.log("All container-operations provider tests passed.");
