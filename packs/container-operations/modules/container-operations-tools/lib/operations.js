"use strict";

const { ContainerError } = require("./errors");

const id = value => encodeURIComponent(String(value || ""));
const asArray = value => Array.isArray(value) ? value : [];

function safeContainerName(value) {
  const text = String(value || "");
  if (!text || text.length > 256 || /[\0\r\n]/.test(text)) throw new ContainerError("invalid_input", "container identifier is invalid");
  return text;
}

function normalizeContainer(raw) {
  // Docker's list endpoint returns State as a status string, while inspect
  // returns State as an object. Normalize both shapes before deriving runtime
  // state so discovery and health never report running containers as stopped.
  const rawState = raw.State;
  const state = rawState && typeof rawState === "object" ? rawState : {};
  const status = state.Status || (typeof rawState === "string" ? rawState : raw.Status) || "unknown";
  const health = state.Health?.Status || "unknown";
  const mounts = asArray(raw.Mounts).map(m => ({ type: m.Type, source: m.Source, destination: m.Destination, read_only: m.RW === false }));
  const security = { privileged: state?._privileged === true || raw.HostConfig?.Privileged === true, host_network: raw.HostConfig?.NetworkMode === "host", host_pid: raw.HostConfig?.PidMode === "host", socket_mount: mounts.some(m => /(?:^|\/)(?:var\/run\/)?(?:docker|podman)\.sock$/.test(String(m.source || ""))) };
  security.host_root_mount = mounts.some(m => m.source === "/" || m.destination === "/" || m.destination === "/host");
  return { id: raw.Id, name: String(raw.Name || "").replace(/^\//, ""), names: asArray(raw.Names).map(String).slice(0, 16), image: raw.Config?.Image || raw.Image, image_id: raw.Image, created: raw.Created, state: status, running: state.Running === true || status === "running", exit_code: state.ExitCode, restart_count: raw.RestartCount || 0, started_at: state.StartedAt, finished_at: state.FinishedAt, health, health_log: asArray(state.Health?.Log).slice(-5).map(x => ({ start: x.Start, end: x.End, exit_code: x.ExitCode, output: String(x.Output || "").slice(0, 1000) })), labels: Object.fromEntries(Object.entries(raw.Labels || {}).slice(0, 100)), mounts, networks: Object.keys(raw.NetworkSettings?.Networks || {}), ports: raw.NetworkSettings?.Ports || {}, host_config: { restart_policy: raw.HostConfig?.RestartPolicy?.Name || "none", memory_limit: raw.HostConfig?.Memory || 0, cpu_quota: raw.HostConfig?.CpuQuota || 0 }, security, compose: { project: raw.Labels?.["com.docker.compose.project"] || null, service: raw.Labels?.["com.docker.compose.service"] || null, config_files: raw.Labels?.["com.docker.compose.project.config_files"] || null } };
}

async function info(client) { return client.get("/info"); }
async function version(client) { return client.get("/version"); }
async function list(client, all = true) {
  const listed = (await client.get(`/containers/json?all=${all ? 1 : 0}`)).map(normalizeContainer);
  // The list endpoint can expose a stale or incomplete Running flag. Reconcile
  // each result with inspect so aggregate discovery matches authoritative state.
  return Promise.all(listed.map(async container => {
    try { return await inspect(client, container.id); } catch { return container; }
  }));
}
async function inspect(client, target) { const raw = await client.get(`/containers/${id(safeContainerName(target))}/json`); return normalizeContainer(raw); }
async function images(client) { return (await client.get("/images/json?all=1")).map(image => ({ id: image.Id, parent_id: image.ParentId, repo_tags: asArray(image.RepoTags).slice(0, 32), repo_digests: asArray(image.RepoDigests).slice(0, 32), created: image.Created, size: image.Size, containers: image.Containers, dangling: asArray(image.RepoTags).length === 0 })); }
async function networks(client) { return (await client.get("/networks")).map(n => ({ id: n.Id, name: n.Name, driver: n.Driver, scope: n.Scope, internal: n.Internal, labels: Object.fromEntries(Object.entries(n.Labels || {}).slice(0, 50)), containers: Object.keys(n.Containers || {}).slice(0, 200) })); }
async function volumes(client) { const data = await client.get("/volumes"); return asArray(data.Volumes).map(v => ({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint, scope: v.Scope, labels: Object.fromEntries(Object.entries(v.Labels || {}).slice(0, 50)), usage: v.UsageData || null })); }
async function stats(client, target) { const raw = await client.get(`/containers/${id(safeContainerName(target))}/stats?stream=false`); return { id: raw.id, name: raw.name, cpu: raw.cpu_stats && raw.precpu_stats ? { total_usage: raw.cpu_stats.cpu_usage?.total_usage, system_usage: raw.cpu_stats.system_cpu_usage, online_cpus: raw.cpu_stats.online_cpus, precpu_total_usage: raw.precpu_stats.cpu_usage?.total_usage } : null, memory: { usage: raw.memory_stats?.usage, limit: raw.memory_stats?.limit, cache: raw.memory_stats?.stats?.cache }, network: Object.fromEntries(Object.entries(raw.networks || {}).map(([name, v]) => [name, { rx_bytes: v.rx_bytes, tx_bytes: v.tx_bytes }])), block: raw.blkio_stats?.io_service_bytes_recursive || null, pids: raw.pids_stats?.current ?? null }; }
async function logs(client, target, options = {}) { const tail = Math.min(10000, Math.max(1, Number(options.tail || 100))); const since = options.since ? Math.max(0, Number(options.since)) : 0; if (!Number.isFinite(since)) throw new ContainerError("invalid_input", "since must be a timestamp or seconds value"); const result = await client.getText(`/containers/${id(safeContainerName(target))}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}&since=${Math.trunc(since)}`); const maxBytes = Math.min(1000000, Math.max(1024, Number(options.max_bytes || 200000))); const bytes = Buffer.byteLength(result.text); const text = result.text.slice(0, maxBytes); const lines = text.split(/\r?\n/).slice(-Math.min(10000, Math.max(1, Number(options.max_lines || 1000)))); return { target, lines, line_count: lines.length, truncated: result.truncated || bytes > maxBytes || lines.length < result.text.split(/\r?\n/).length, bytes_returned: Buffer.byteLength(lines.join("\n")) }; }
async function action(client, target, verb) { const current = await inspect(client, target); if (verb === "start" && current.running) return { outcome: "no_op", reason: "already_running", container: current }; if (verb === "stop" && !current.running) return { outcome: "no_op", reason: "already_stopped", container: current }; await client.post(`/containers/${id(current.id)}/${verb}`); const after = await inspect(client, current.id); return { outcome: after.running === (verb === "start" || verb === "restart") ? "success" : "unknown", container: after }; }
async function recreate(client, target) {
  const current = await client.get(`/containers/${id(safeContainerName(target))}/json`);
  const name = String(current.Name || "").replace(/^\//, "");
  if (!name || !current.Config) throw new ContainerError("provider_failure", "Engine returned an incomplete container configuration");
  const wasRunning = current.State?.Running === true;
  if (wasRunning) await client.post(`/containers/${id(current.Id)}/stop`);
  await client.delete(`/containers/${id(current.Id)}?v=false&force=false`);
  let created;
  try {
    created = await client.post(`/containers/create?name=${encodeURIComponent(name)}`, { Image: current.Config.Image, Cmd: current.Config.Cmd, Entrypoint: current.Config.Entrypoint, Env: current.Config.Env, WorkingDir: current.Config.WorkingDir, User: current.Config.User, Labels: current.Config.Labels, ExposedPorts: current.Config.ExposedPorts, HostConfig: current.HostConfig, NetworkingConfig: current.NetworkSettings ? { EndpointsConfig: Object.fromEntries(Object.entries(current.NetworkSettings.Networks || {}).map(([network, value]) => [network, { Aliases: value.Aliases, IPAMConfig: value.IPAMConfig, Links: value.Links }])) } : undefined });
    if (wasRunning) await client.post(`/containers/${id(created.Id)}/start`);
    const after = await inspect(client, created.Id);
    return { outcome: after.running === wasRunning ? "success" : "unknown", previous_id: current.Id, container: after, rollback_feasible: false };
  } catch (error) {
    // The old container has been removed; this is deliberately reported as
    // rollback unavailable instead of pretending a restore occurred.
    throw new ContainerError("verification_failed", `Container recreation failed after the previous container was removed; rollback is unavailable: ${error.message}`);
  }
}
async function pull(client, image) { if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/.test(String(image || "")) || /[;&|`$\\]/.test(String(image))) throw new ContainerError("invalid_input", "image reference is invalid"); const result = await client.postText(`/images/create?fromImage=${encodeURIComponent(image)}`); return { outcome: "success", image, output_bytes: Buffer.byteLength(result.text), truncated: result.truncated }; }
async function summary(client) { const [engine, containers, imageList, networkList, volumeList] = await Promise.all([info(client), list(client), images(client), networks(client), volumes(client)]); const unhealthy = containers.filter(c => c.health === "unhealthy"); const restarting = containers.filter(c => c.state === "restarting" || c.restart_count >= 5); const stopped = containers.filter(c => !c.running); const noHealth = containers.filter(c => c.health === "unknown"); return { engine: { id: engine.ID, name: engine.Name, server_version: engine.ServerVersion, operating_system: engine.OperatingSystem, rootless: engine.SecurityOptions?.some(x => /rootless/i.test(x)) || false }, counts: { containers: containers.length, running: containers.filter(c => c.running).length, stopped: stopped.length, unhealthy: unhealthy.length, restarting: restarting.length, without_healthcheck: noHealth.length, images: imageList.length, networks: networkList.length, volumes: volumeList.length }, health: unhealthy.length || restarting.length ? "degraded" : "healthy", unhealthy: unhealthy.slice(0, 50), restarting: restarting.slice(0, 50), stopped: stopped.slice(0, 50) }; }
async function capabilities(client, profile) { const checks = {}; for (const [name, fn] of [["info", () => info(client)], ["containers", () => list(client)], ["images", () => images(client)], ["networks", () => networks(client)], ["volumes", () => volumes(client)]]) { try { await fn(); checks[name] = "available"; } catch (error) { checks[name] = error.code === "permission_denied" ? "permission-limited" : error.code === "resource_missing" ? "unsupported" : "unavailable"; } } let engine = null; try { engine = await version(client); } catch {} return { provider: profile.provider, profile: profile.name, reachable: checks.info === "available", version: engine?.Version || engine?.Components?.[0]?.Version || null, api_version: engine?.ApiVersion || null, checks, lifecycle: profile.allow_mutations ? ["start", "stop", "restart"] : [], compose: profile.compose ? "configured" : "not_configured" }; }
async function updates(client) { const containers = await list(client); const imageList = await images(client); const names = [...new Set(containers.map(c => c.image).filter(Boolean))]; const items = []; for (const image of names) { const deployed = imageList.find(i => i.repo_tags.includes(image) || i.repo_digests.some(d => d.split("@")[0] === image.split("@")[0])); const currentDigests = deployed?.repo_digests || []; if (image.includes("@sha256:")) { items.push({ image, status: "pinned", deployed_digest: image.split("@")[1], containers: containers.filter(c => c.image === image).map(c => c.name) }); continue; } try { const remote = await client.get(`/distribution/${encodeURIComponent(image)}/json`); const candidate = remote.Descriptor?.digest || remote.descriptor?.digest || null; if (!candidate) items.push({ image, status: "unknown", reason: "registry returned no immutable digest" }); else items.push({ image, status: currentDigests.includes(candidate) ? "current" : "update_available", deployed_digests: currentDigests, candidate_digest: candidate, containers: containers.filter(c => c.image === image).map(c => c.name) }); } catch (error) { items.push({ image, status: error.code === "authentication_failed" ? "authentication_required" : error.code === "engine_unreachable" ? "registry_unavailable" : "unknown", reason: error.code }); } } return { items }; }

module.exports = { info, version, list, inspect, images, networks, volumes, stats, logs, action, recreate, pull, summary, capabilities, updates, normalizeContainer };
