"use strict";

// OpenVINO helper response-contract regression tests.
//
// CI runs the Node mock helper (test/helpers/mock-openvino-helper.js), not the
// real Python helper — which is exactly how helper.py:~801 shipped a false
// provenance echo ("requested_device": primary_device) that the mock did not
// share: a successful explicit-NPU embed was recorded as accelerator null /
// verification "rejected_claim" by deriveAttemptProvenance while every test
// stayed green. These checks are deliberately static and deterministic: they
// parse both helper sources and fail if either side of the contract regresses,
// with no Python runtime required.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const HELPER_PY = path.join(__dirname, "..", "src", "compute", "openvino", "helper.py");
const MOCK_HELPER = path.join(__dirname, "helpers", "mock-openvino-helper.js");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

const helperSource = fs.readFileSync(HELPER_PY, "utf8");
const mockSource = fs.readFileSync(MOCK_HELPER, "utf8");

// The embed success reply is the dict literal passed to _reply_ok inside
// handle_embed. Anchor on the unique '"action": "embed"' reply marker and
// capture through the closing of that call.
function embedReplyBlock(source) {
  const start = source.indexOf('"action": "embed"');
  assert.ok(start >= 0, "helper.py embed reply block not found");
  const block = source.slice(start, source.indexOf("})", start));
  assert.ok(block.length > 0, "helper.py embed reply block is empty");
  return block;
}

console.log("OpenVINO helper contract:");

test("helper.py embed reply echoes the request's requested_device (not primary_device)", () => {
  const block = embedReplyBlock(helperSource);
  assert.ok(
    /"requested_device":\s*requested_device\b/.test(block),
    'embed reply must contain "requested_device": requested_device'
  );
  assert.ok(
    !/"requested_device":\s*primary_device\b/.test(block),
    'embed reply must NOT echo primary_device as requested_device (false provenance: an explicit-NPU success is then recorded as rejected_claim)'
  );
});

test("helper.py reads requested_device from the request payload", () => {
  assert.ok(
    /requested_device\s*=\s*payload\.get\("requested_device",\s*primary_device\)/.test(helperSource),
    "requested_device must be sourced from the request payload with the primary device only as the default"
  );
});

test("helper.py fallback_reason names the requested device, not the primary device", () => {
  assert.ok(
    /fallback_reason\s*=\s*f"device_not_found:\{requested_device\}"/.test(helperSource),
    "fallback_reason must name the device the caller actually requested"
  );
  assert.ok(
    !/fallback_reason\s*=\s*f"device_not_found:\{primary_device\}"/.test(helperSource),
    "fallback_reason must not name the model's primary device"
  );
});

test("helper.py ready probe accepts a per-device requested_device (advertisement honesty)", () => {
  assert.ok(
    /def handle_ready\(\s*self,\s*request_id: str,\s*model_id: str,\s*requested_device/.test(helperSource),
    "handle_ready must accept a requested_device so each advertised device is individually probed"
  );
  assert.ok(
    /msg\.get\("requested_device"\)/.test(helperSource),
    "the dispatch loop must forward requested_device to handle_ready"
  );
});

console.log("\nMock/real helper contract agreement:");

test("mock helper echoes msg.requested_device the same way", () => {
  // The mock derives its echo from the request; if either side changes shape,
  // this pins the shared contract rather than letting the mock drift green.
  assert.ok(
    /requestedDevice\s*=\s*msg\.requested_device/.test(mockSource),
    "mock helper must derive requested_device from the request"
  );
  assert.ok(
    /requested_device:\s*requestedDevice\b/.test(mockSource),
    "mock helper embed reply must echo the request's requested_device"
  );
});

test("both helpers reply with the same embed provenance fields", () => {
  const helperBlock = embedReplyBlock(helperSource);
  for (const field of ["requested_device", "device", "fallback_occurred", "fallback_reason"]) {
    assert.ok(helperBlock.includes(`"${field}"`), `helper.py embed reply carries ${field}`);
    assert.ok(new RegExp(`${field}\\s*:`).test(mockSource), `mock helper embed reply carries ${field}`);
  }
});

console.log(`\nOpenVINO helper contract tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
