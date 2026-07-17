"use strict";

const fs = require("fs");

function logStderr(lvl, msg, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    lvl,
    msg,
    ...extra
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

logStderr("INFO", "Mock helper starting", {
  models_dir: process.env.SIDEKICK_OPENVINO_MODELS_DIR,
  node_version: process.version
});

// Immediately print the started event.
console.log(JSON.stringify({
  v: "1",
  event: "started",
  helper_version: "1.0.0",
  openvino_version: "2026.2.1-test",
  available_devices: ["CPU", "GPU", "NPU"],
  models_dir: process.env.SIDEKICK_OPENVINO_MODELS_DIR
}));

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let lineIdx;
  while ((lineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, lineIdx).trim();
    buffer = buffer.slice(lineIdx + 1);
    if (!line) continue;
    handleLine(line);
  }
});

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    console.log(JSON.stringify({ v: "1", event: "fatal", error: "malformed_json" }));
    process.exit(1);
  }

  const reqId = msg.id;
  const action = msg.action;

  if (action === "ping") {
    console.log(JSON.stringify({
      v: "1",
      id: reqId,
      ok: true,
      action: "ping",
      helper_version: "1.0.0",
      openvino_version: "2026.2.1-test",
      available_devices: ["CPU", "GPU", "NPU"]
    }));
    return;
  }

  if (action === "ready") {
    const modelId = msg.model_id;
    if (modelId === "unsupported") {
      console.log(JSON.stringify({
        v: "1",
        id: reqId,
        ok: false,
        error_code: "unsupported_model",
        error: "Model not supported"
      }));
      return;
    }
    console.log(JSON.stringify({
      v: "1",
      id: reqId,
      ok: true,
      action: "ready",
      model_id: modelId,
      device: modelId.includes("qwen") ? "NPU" : "CPU",
      available_devices: ["CPU", "GPU", "NPU"],
      openvino_version: "2026.2.1-test",
      helper_version: "1.0.0",
      certified_profiles: [128, 512],
      output_dimensions: modelId.includes("qwen") ? 1024 : 384,
      embedding_space_id: modelId
    }));
    return;
  }

  if (action === "embed") {
    const text = msg.text || "";
    const modelId = msg.model_id;

    if (text.includes("crash")) {
      logStderr("ERROR", "Simulating crash", { text });
      process.exit(1);
    }

    if (text.includes("hang")) {
      logStderr("INFO", "Simulating hang, sleeping forever", { text });
      // Keep process alive but do not respond.
      setInterval(() => {}, 10000);
      return;
    }

    if (text.includes("invalid-json")) {
      console.log("{invalid json response}");
      return;
    }

    if (text.includes("oversized")) {
      const huge = "A".repeat(5 * 1024 * 1024);
      console.log(JSON.stringify({ v: "1", id: reqId, ok: true, action: "embed", data: huge }));
      return;
    }

    if (text.includes("non-finite")) {
      const dims = modelId.includes("qwen") ? 1024 : 384;
      const arr = new Array(dims).fill(0.1);
      arr[0] = NaN;
      console.log(JSON.stringify({
        v: "1",
        id: reqId,
        ok: true,
        action: "embed",
        model_id: modelId,
        embedding: arr,
        device: "CPU",
        dimensions: dims,
        normalized: true
      }));
      return;
    }

    if (text.includes("bad-norm")) {
      const dims = modelId.includes("qwen") ? 1024 : 384;
      const arr = new Array(dims).fill(0.01);
      console.log(JSON.stringify({
        v: "1",
        id: reqId,
        ok: true,
        action: "embed",
        model_id: modelId,
        embedding: arr, // norm != 1.0
        device: "CPU",
        dimensions: dims,
        normalized: true
      }));
      return;
    }

    const dims = modelId.includes("qwen") ? 1024 : 384;
    // Generate a valid unit vector.
    const arr = new Array(dims).fill(0);
    arr[0] = 1.0; // simple L2 unit vector

    const fallbackOccurred = msg.fallback === "same_model_cpu" && modelId.includes("qwen");
    const device = fallbackOccurred ? "CPU" : (modelId.includes("qwen") ? "NPU" : "CPU");

    console.log(JSON.stringify({
      v: "1",
      id: reqId,
      ok: true,
      action: "embed",
      model_id: modelId,
      embedding_space_id: modelId,
      dimensions: dims,
      embedding: arr,
      device: device,
      requested_device: modelId.includes("qwen") ? "NPU" : "CPU",
      fallback_occurred: fallbackOccurred,
      fallback_reason: fallbackOccurred ? "device_not_found:NPU" : null,
      sequence_length: 512,
      token_count: 10,
      preprocess_ms: 1.5,
      infer_ms: 12.3,
      preprocessing_version: "1",
      openvino_version: "2026.2.1-test",
      helper_version: "1.0.0",
      normalized: true
    }));
    return;
  }
}
