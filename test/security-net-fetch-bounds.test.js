"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateRequestPayload,
  MAX_REQUEST_BODY_BYTES,
  MAX_REQUEST_HEADER_BYTES,
  MAX_REQUEST_HEADER_COUNT,
  MAX_REQUEST_HEADER_VALUE_LENGTH,
} = require("../src/tools/families/net-fetch");

test("web_fetch accepts bounded request bodies and ordinary headers", () => {
  const result = validateRequestPayload(JSON.stringify({ Accept: "application/json", "X-Trace": "trace-1" }), "hello");
  assert.deepEqual(Object.keys(result.headers), ["Accept", "X-Trace"]);
  assert.equal(result.error, undefined);
});

test("web_fetch enforces UTF-8 request-body and serialized-header limits", () => {
  const tooLargeBody = "😀".repeat(Math.floor(MAX_REQUEST_BODY_BYTES / 4) + 1);
  const bodyResult = validateRequestPayload(undefined, tooLargeBody);
  assert.equal(bodyResult.error.code, "request_body_too_large");

  const headersResult = validateRequestPayload(" ".repeat(MAX_REQUEST_HEADER_BYTES + 1));
  assert.equal(headersResult.error.code, "request_headers_too_large");
});

test("web_fetch bounds header count and individual values", () => {
  const manyHeaders = Object.fromEntries(Array.from({ length: MAX_REQUEST_HEADER_COUNT + 1 }, (_, index) => [`X-${index}`, "v"]));
  assert.equal(validateRequestPayload(JSON.stringify(manyHeaders)).error.code, "too_many_request_headers");

  const longValue = JSON.stringify({ "X-Long": "v".repeat(MAX_REQUEST_HEADER_VALUE_LENGTH + 1) });
  assert.equal(validateRequestPayload(longValue).error.code, "request_header_value_too_large");
});

test("web_fetch refuses caller-controlled credentials and hop-by-hop framing headers", () => {
  for (const name of ["Authorization", "Cookie", "Host", "Content-Length", "Transfer-Encoding", "Connection", "Upgrade"]) {
    const result = validateRequestPayload(JSON.stringify({ [name]: "caller-value" }));
    assert.ok(result.error, `${name} must not be caller-controlled`);
  }
});

test("web_fetch rejects non-scalar header values without changing object prototypes", () => {
  const result = validateRequestPayload(JSON.stringify({ "X-Bad": { nested: true } }));
  assert.equal(result.error.code, "invalid_request_header");
});
