"use strict";

// The Brain planner uses Compute chat jobs. Keep the worker's Ollama transport
// honest by asserting that chat requests reach /api/chat with their messages,
// JSON format, and visible (non-thinking) output settings.

const assert = require("assert");
const http = require("http");

let received = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    received = { method: req.method, url: req.url, body: JSON.parse(body) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: { content: '{"version":1,"goal":"test","steps":[]}' }, done_reason: "stop" }));
  });
});

server.listen(0, "127.0.0.1", async () => {
  try {
    process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.NODE_ENV = "test";
    const { executeJob } = require("../src/compute/worker-agent");
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
    console.log("Ollama chat worker transport test passed.");
  } finally {
    server.close();
  }
});
