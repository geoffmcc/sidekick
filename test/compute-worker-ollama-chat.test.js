"use strict";

// The Brain planner uses Compute chat jobs. Keep the worker's Ollama transport
// honest by asserting that chat requests reach /api/chat with their messages,
// JSON format, and visible (non-thinking) output settings — and that the
// options the provider adapter forwards (num_ctx from contextLimit, format on
// generate) are not silently dropped on the worker path. Also covers
// mid-generation cancellation: the cancellation poll must abort the in-flight
// HTTP request, not wait politely for the model to finish.

const assert = require("assert");
const http = require("http");

// Fast cancellation poll for the abort test; must be set before the
// worker-agent module reads its config constants.
process.env.SIDEKICK_WORKER_CANCEL_POLL_MS = "250";
process.env.NODE_ENV = "test";

let received = null;
let hangUntilAbort = false;
let sawAbort = false;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    received = { method: req.method, url: req.url, body: JSON.parse(body) };
    if (hangUntilAbort) {
      // Simulate a long generation: never answer; only observe the abort.
      req.on("close", () => { sawAbort = true; });
      res.on("close", () => { sawAbort = true; });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/generate") {
      res.end(JSON.stringify({ response: "generated", done_reason: "stop" }));
    } else {
      res.end(JSON.stringify({ message: { content: '{"version":1,"goal":"test","steps":[]}' }, done_reason: "stop" }));
    }
  });
});

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.stack || e.message}`); }
}

server.listen(0, "127.0.0.1", async () => {
  process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;

  try {
    const { executeJob } = require("../src/compute/worker-agent");
    console.log("Worker Ollama transport:");

    await test("chat request carries messages, format, think:false, num_predict and num_ctx", async () => {
    const result = await executeJob({
      jobType: "chat",
      capability: "chat",
      requestPayload: {
        model: "qwen3.5:latest",
        messages: [
          { role: "system", content: "Return raw JSON only." },
          { role: "user", content: "Make a plan." },
        ],
        format: "json",
        maxTokens: 512,
        contextLimit: 32768,
      },
    });

    assert.strictEqual(result.content, '{"version":1,"goal":"test","steps":[]}');
    assert.strictEqual(received.method, "POST");
    assert.strictEqual(received.url, "/api/chat");
    assert.strictEqual(received.body.model, "qwen3.5:latest");
    assert.deepStrictEqual(received.body.messages, [
      { role: "system", content: "Return raw JSON only." },
      { role: "user", content: "Make a plan." },
    ]);
    assert.strictEqual(received.body.format, "json");
    assert.strictEqual(received.body.think, false);
    assert.strictEqual(received.body.options.num_predict, 512);
    // contextLimit was silently dropped on the worker path; parity with
    // ollama-provider.js means num_ctx reaches the model here too.
    assert.strictEqual(received.body.options.num_ctx, 32768);
    });

    await test("chat request without contextLimit omits num_ctx (never null)", async () => {
    await executeJob({
      jobType: "chat", capability: "chat",
      requestPayload: { model: "m", prompt: "hi", maxTokens: 256 },
    });
    assert.ok(!("num_ctx" in received.body.options), "num_ctx omitted when unset");
    });

    await test("generate request forwards format, think:false and num_ctx like chat", async () => {
    const result = await executeJob({
      jobType: "generate", capability: "generate",
      requestPayload: { model: "m", prompt: "make json", format: "json", maxTokens: 256, contextLimit: 8192 },
    });
    assert.strictEqual(result.content, "generated");
    assert.strictEqual(received.url, "/api/generate");
    assert.strictEqual(received.body.format, "json", "format no longer dropped on worker generate");
    assert.strictEqual(received.body.think, false);
    assert.strictEqual(received.body.options.num_ctx, 8192);
    assert.strictEqual(received.body.options.num_predict, 256);
    });

    await test("cancellation observed DURING generation aborts the in-flight request", async () => {
    hangUntilAbort = true;
    received = null;
    let polls = 0;
    const shouldCancel = async () => { polls++; return polls >= 2; };
    const started = Date.now();
    let error = null;
    try {
      await executeJob({
        jobType: "chat", capability: "chat",
        requestPayload: { model: "m", prompt: "slow generation" },
      }, shouldCancel);
    } catch (e) {
      error = e;
    }
    hangUntilAbort = false;
    assert.ok(error, "the aborted request rejects");
    assert.match(error.message, /cancellation requested/i,
      "canonical message so handleJob acknowledges instead of failing");
    assert.ok(received, "the request actually reached the model endpoint first");
    assert.ok(Date.now() - started < 10000, "aborted promptly, not after the request timeout");
    // Give the socket teardown a beat, then confirm the server saw the abort.
    await new Promise(r => setTimeout(r, 200));
    assert.ok(sawAbort, "server observed the aborted request");
    });

    await test("provider adapter generate() sends think:false like chat()", async () => {
    const OllamaProvider = require("../src/providers/ollama-provider");
    const provider = new OllamaProvider({ endpoint: process.env.OLLAMA_URL });
    const result = await provider.generate("hello", { model: "m", contextLimit: 4096, maxTokens: 128 });
    assert.strictEqual(result.content, "generated");
    assert.strictEqual(received.url, "/api/generate");
    assert.strictEqual(received.body.think, false, "generate no longer lets thinking consume the budget by default");
    assert.strictEqual(received.body.options.num_ctx, 4096);
    });

  } finally {
    await new Promise(resolve => server.close(resolve));
    console.log(`\nWorker Ollama transport tests: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
});
