"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  readOllamaResponseText,
  readOllamaResponseJson,
  MAX_OLLAMA_RESPONSE_BYTES,
  MAX_OLLAMA_ERROR_BYTES,
} = require("../src/tools/families/inference");

test("Ollama JSON response reader accepts bounded UTF-8 JSON", async () => {
  const response = new Response(JSON.stringify({ value: "😀" }));
  assert.deepEqual(await readOllamaResponseJson(response), { value: "😀" });
});

test("Ollama response reader enforces the configured limit in bytes", async () => {
  const response = new Response("😀😀😀");
  await assert.rejects(readOllamaResponseText(response, 8), /exceeded 8 bytes/);
  assert.equal(MAX_OLLAMA_RESPONSE_BYTES, 8 * 1024 * 1024);
  assert.equal(MAX_OLLAMA_ERROR_BYTES, 16 * 1024);
});

test("Ollama error response reader truncates to a byte bound", async () => {
  const response = new Response("😀😀😀");
  const result = await readOllamaResponseText(response, 8, { truncate: true });
  assert.deepEqual(result, { text: "😀😀", truncated: true });
});
