"use strict";

const assert = require("assert");
const http = require("http");
const OllamaProvider = require("../src/providers/ollama-provider");

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    const request = JSON.parse(body);
    assert.strictEqual(request.options.num_predict, 65536);
    assert.strictEqual(request.options.num_ctx, 262144);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      model: "qwen3.5:latest",
      message: { role: "assistant", content: "complete" },
      done: true,
      done_reason: "stop",
    }));
  });
});

server.listen(0, "127.0.0.1", async () => {
  try {
    const address = server.address();
    const provider = new OllamaProvider({ endpoint: `http://127.0.0.1:${address.port}` });
    const result = await provider.chat([{ role: "user", content: "finish this" }], {
      model: "qwen3.5:latest",
      contextLimit: 262144,
    });
    assert.strictEqual(result.content, "complete");
    assert.strictEqual(result.finishReason, "stop");
    console.log("✓ Ollama receives the registered context limit and large finite generation default");
    server.close();
  } catch (error) {
    console.error(error.stack || error.message);
    server.close();
    process.exitCode = 1;
  }
});
