const assert = require("assert");
const {
  collectGpuTelemetry,
  isLocalTelemetryEndpoint,
  parseCsvLine,
  projectWorkerTelemetry,
  sanitizeTelemetry,
} = require("../src/compute/telemetry");

let passed = 0;
const pendingAsyncTests = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}: ${error.message}`); process.exitCode = 1; }
}

async function asyncTest(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}: ${error.message}`); process.exitCode = 1; }
}

test("CSV parser preserves quoted commas", () => {
  assert.deepStrictEqual(parseCsvLine('0, "GPU, Test", 535.1'), ["0", "GPU, Test", "535.1"]);
});

pendingAsyncTests.push(asyncTest("GPU collector uses fixed no-shell queries and strips process paths/PIDs", async () => {
  const calls = [];
  const result = await collectGpuTelemetry({
    platform: "linux",
    execFileImpl: (program, args, options, callback) => {
      calls.push({ program, args, options });
      const output = args[0].includes("query-gpu")
        ? '0, "GPU, Test", 535.1, 8192, 1024, 7168, 12, 55, 1500, 48\n'
        : '123, /home/user/.ollama/bin/ollama, 512\n';
      callback(null, output, "");
    },
  });
  assert.strictEqual(result.status, "available");
  assert.strictEqual(result.devices[0].name, "GPU, Test");
  assert.strictEqual(result.devices[0].memoryUsedBytes, 1024 * 1024 * 1024);
  assert.deepStrictEqual(result.processes[0], { name: "ollama", memoryBytes: 512 * 1024 * 1024, running: true });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].options.shell, false);
  assert.ok(calls[0].options.timeout >= 2000, "GPU probe timeout allows service-launched driver initialization");
  for (const key of ["TEMP", "TMP", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles", "CommonProgramFiles(x86)", "LOCALAPPDATA"]) {
    if (process.env[key]) assert.ok(Object.prototype.hasOwnProperty.call(calls[0].options.env, key), `GPU probe preserves benign runtime variable ${key}`);
  }
  assert.ok(!Object.keys(calls[0].options.env).some(key => /SECRET|TOKEN|PASSWORD|KEY/i.test(key)));
  assert.ok(calls[0].args.every(arg => !String(arg).includes("prompt") && !String(arg).includes("secret")));
  assert.ok(!("pid" in result.processes[0]));
}));

pendingAsyncTests.push(asyncTest("GPU collector degrades honestly when nvidia-smi is unavailable", async () => {
  const result = await collectGpuTelemetry({
    execFileImpl: (program, args, options, callback) => callback(new Error("missing")),
  });
  assert.deepStrictEqual(result, { status: "unavailable", reason: "nvidia_smi_unavailable" });
}));

test("telemetry sanitizer is explicit, bounded, and local-only", () => {
  const result = sanitizeTelemetry({
    privacy: "external-ok",
    prompt: "do not retain this",
    endpoint: "http://secret.example",
    collectedAt: "2026-08-22T19:00:00Z",
    system: { cpuLoad: 0.12, memoryUsedBytes: 100, memoryTotalBytes: 200, activeJobs: 1, processMemoryBytes: 999 },
    gpu: { status: "available", devices: [{ name: "GPU", utilizationPercent: 12, unexpected: "drop" }], processes: [{ name: "/secret/path/ollama", pid: 7 }] },
    inference: { status: "available", provider: "ollama", model: "local-model", tokensPerSecond: 14, prompt: "drop" },
    loadedModels: [{ name: "local-model", sizeBytes: 100, secret: "drop" }],
  });
  assert.strictEqual(result.privacy, "local-only");
  assert.ok(!("prompt" in result));
  assert.ok(!("endpoint" in result));
  assert.strictEqual(result.system.processMemoryBytes, 999);
  assert.ok(!("unexpected" in result.gpu.devices[0]));
  assert.strictEqual(result.gpu.processes[0].name, "ollama");
  assert.ok(!("pid" in result.gpu.processes[0]));
  assert.ok(!("secret" in result.loadedModels[0]));
  assert.ok(!("prompt" in result.inference));
  assert.strictEqual(sanitizeTelemetry({ inference: { status: "unavailable" } }).inference.status, "unavailable");
});

test("telemetry endpoint eligibility is local-only", () => {
  for (const endpoint of [
    "http://127.0.0.1:11434",
    "http://localhost:11434",
    "http://ollama:11434",
    "http://192.168.1.20:11434",
    "http://[fd00::20]:11434",
  ]) assert.strictEqual(isLocalTelemetryEndpoint(endpoint), true, endpoint);
  for (const endpoint of [
    "https://api.example.com",
    "http://8.8.8.8:11434",
    "http://user:pass@127.0.0.1:11434",
    "file:///tmp/ollama",
  ]) assert.strictEqual(isLocalTelemetryEndpoint(endpoint), false, endpoint);
});

test("worker projection allowlists identity and safe telemetry only", () => {
  const result = projectWorkerTelemetry({
    workerId: "wk_1",
    nodeId: "node_1",
    displayName: "GPU worker",
    platform: "win32",
    architecture: "x64",
    state: "online",
    connectionState: "online",
    healthState: "healthy",
    currentJobs: 1,
    lastHeartbeat: "2026-08-22T19:00:00Z",
    credentialHash: "must-not-appear",
    publicKey: "must-not-appear",
    metadata: { secret: "must-not-appear" },
    telemetry: { system: { activeJobs: 1 } },
  });
  assert.deepStrictEqual(Object.keys(result).sort(), [
    "architecture", "connectionState", "currentJobs", "displayName", "healthState",
    "lastHeartbeat", "nodeId", "platform", "state", "telemetry", "workerId",
  ].sort());
  assert.strictEqual(result.telemetry.privacy, "local-only");
  assert.ok(!JSON.stringify(result).includes("must-not-appear"));
});

Promise.all(pendingAsyncTests).then(() => {
  console.log(`\nCompute telemetry tests: ${passed} passed`);
  if (process.exitCode) process.exit(1);
});
