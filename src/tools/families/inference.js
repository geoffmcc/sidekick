"use strict";

// Inference tool family: LLM chat, text embeddings, and Ollama model management.
//
// Extracted from src/tools-legacy.js. Depends only on the Compute inference
// service (optional), Node http/https, and the global fetch — never on
// tools-legacy.js — so it carries no legacy import at module load. Risk
// classifications (llm medium, embed/ollama low) are preserved from
// src/tools/metadata.js; policy, redaction and audit are applied by the
// dispatcher. sidekick_llm is exported for the legacy handlers that call it
// directly (teach, fresheyes, changelog, black_box) until their own slices
// land; tools-legacy re-imports it (the sidekick_status precedent). GROQ_* and
// OLLAMA_URL stay exported from tools-legacy for the compatibility-export
// contract; the family reads the same environment variables itself.

const { z } = require("zod");

let inferenceService = null;
try { inferenceService = require("../../compute/inference-service"); } catch {}

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

async function sidekick_embed({ text, model }) {
  try {
    const m = model || "nomic-embed-text";
    if (inferenceService) {
      try {
        const result = await inferenceService.embed({
          input: text,
          model: m,
          dataClassification: "private",
          preferences: { allowFallback: true },
        });
        return { content: [{ type: "text", text: JSON.stringify({ embedding: result.embedding, dimensions: result.dimensions || result.embedding?.length, model: m }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: "Embedding error: " + e.message }], isError: true };
      }
    }
    const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
    const response = await fetch(`${ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m, prompt: text }),
    });
    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 404) {
        return { content: [{ type: "text", text: `Error: Model '${m}' not found. Pull it with: ollama pull ${m}` }], isError: true };
      }
      return { content: [{ type: "text", text: `Error: Ollama request failed (${response.status}): ${errText}` }], isError: true };
    }
    const data = await response.json();
    return { content: [{ type: "text", text: JSON.stringify({ embedding: data.embedding, dimensions: data.embedding?.length, model: m }, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_ollama({ action, model }) {
  try {
    const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

    if (action === "list") {
      const response = await fetch(`${ollamaUrl}/api/tags`);
      if (!response.ok) {
        return { content: [{ type: "text", text: `Error: Failed to list models (${response.status})` }], isError: true };
      }
      const data = await response.json();
      const models = (data.models || []).map(m => ({
        name: m.name,
        size: m.size,
        modified_at: m.modified_at,
        digest: m.digest?.substring(0, 12)
      }));
      return { content: [{ type: "text", text: JSON.stringify(models, null, 2) }] };
    }

    if (action === "ps") {
      const response = await fetch(`${ollamaUrl}/api/ps`);
      if (!response.ok) {
        return { content: [{ type: "text", text: `Error: Failed to list running models (${response.status})` }], isError: true };
      }
      const data = await response.json();
      const models = (data.models || []).map(m => ({
        name: m.name,
        size: m.size,
        digest: m.digest?.substring(0, 12),
        expires_at: m.expires_at
      }));
      return { content: [{ type: "text", text: JSON.stringify(models, null, 2) }] };
    }

    if (action === "pull") {
      if (!model) {
        return { content: [{ type: "text", text: "Error: model name required" }], isError: true };
      }
      const response = await fetch(`${ollamaUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model, stream: false }),
      });
      if (!response.ok) {
        const errText = await response.text();
        return { content: [{ type: "text", text: `Error: Failed to pull model (${response.status}): ${errText}` }], isError: true };
      }
      return { content: [{ type: "text", text: `Successfully pulled model: ${model}` }] };
    }

    if (action === "show") {
      if (!model) {
        return { content: [{ type: "text", text: "Error: model name required" }], isError: true };
      }
      const response = await fetch(`${ollamaUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model }),
      });
      if (!response.ok) {
        return { content: [{ type: "text", text: `Error: Failed to show model (${response.status})` }], isError: true };
      }
      const data = await response.json();
      return { content: [{ type: "text", text: JSON.stringify({
        name: data.details?.family,
        parameter_size: data.details?.parameter_size,
        quantization_level: data.details?.quantization_level,
        template: data.template,
        system: data.system
      }, null, 2) }] };
    }

    return { content: [{ type: "text", text: "Error: Invalid action. Use: list, ps, pull, show" }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
}

async function sidekick_llm({ prompt, system, temperature, provider }) {
  if (inferenceService) {
    try {
      const result = await inferenceService.chat({
        messages: [{ role: "user", content: prompt }],
        system,
        temperature: temperature || 0.7,
        dataClassification: "private",
        // Caller-supplied provider names are advisory only; placement ignores
        // provider pinning and applies its own gates.
        preferences: { allowFallback: true },
      });
      return { content: [{ type: "text", text: result.content || JSON.stringify(result) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "LLM error: " + e.message }], isError: true };
    }
  }
  const defaultProvider = process.env.SIDEKICK_DEFAULT_LLM || "ollama";
  const useGroq = (provider || defaultProvider) === "groq";
  if (useGroq && GROQ_API_KEY) {
    return callGroqLLM(prompt, system, temperature);
  }
  return callOllamaLLM(prompt, system, temperature);
}

function callOllamaLLM(prompt, system, temperature) {
  const http = require("http");
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: process.env.OLLAMA_MODEL || "qwen2.5-coder:7b",
      prompt: prompt,
      system: system || "You are a helpful assistant running on a remote machine.",
      options: { temperature: temperature || 0.7 },
      stream: false
    });
    const req = http.request({
      hostname: "127.0.0.1", port: 11434,
      path: "/api/generate",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ content: [{ type: "text", text: parsed.response || JSON.stringify(parsed) }] });
        } catch (e) {
          resolve({ content: [{ type: "text", text: "Error parsing response: " + data.substring(0, 200) }], isError: true });
        }
      });
    });
    req.on("error", (err) => resolve({ content: [{ type: "text", text: "LLM error: " + err.message }], isError: true }));
    req.write(body);
    req.end();
  });
}

function callGroqLLM(prompt, system, temperature) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: system || "You are a helpful assistant running on a remote machine." },
        { role: "user", content: prompt }
      ],
      temperature: temperature || 0.7
    });
    const req = https.request({
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + GROQ_API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content || JSON.stringify(parsed);
          resolve({ content: [{ type: "text", text: content }] });
        } catch (e) {
          resolve({ content: [{ type: "text", text: "Error parsing response: " + data.substring(0, 200) }], isError: true });
        }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); resolve({ content: [{ type: "text", text: "LLM timeout" }], isError: true }); });
    req.on("error", (err) => resolve({ content: [{ type: "text", text: "LLM error: " + err.message }], isError: true }));
    req.write(body);
    req.end();
  });
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "llm",
    description: "Ask the LLM (defaults to local Ollama, use provider='groq' for cloud Groq)",
    schema: z.object({
      prompt: z.string().describe("The prompt to send to the LLM"),
      system: z.string().optional().describe("System prompt override"),
      temperature: z.number().optional().default(0.7).describe("Sampling temperature (0-2)"),
      provider: z.string().optional().describe("LLM provider: 'ollama' (default) or 'groq' (cloud)"),
    }),
    args: { prompt: "string", system: "string (optional)", temperature: "number (optional)", provider: "string (optional, 'ollama' or 'groq' - default from SIDEKICK_DEFAULT_LLM env var or 'ollama')" },
    risk: "medium",
    category: "Core",
    source: "builtin",
    family: "inference",
    handler: sidekick_llm,
  }),
  Object.freeze({
    name: "embed",
    description: "Generate text embeddings using Ollama",
    schema: z.object({
      text: z.string().describe("Text to embed"),
      model: z.string().optional().default("nomic-embed-text").describe("Embedding model"),
    }),
    args: { text: "string (text to embed)", model: "string (optional, embedding model - default nomic-embed-text)" },
    risk: "low",
    category: "Context & Learning",
    source: "builtin",
    family: "inference",
    handler: sidekick_embed,
  }),
  Object.freeze({
    name: "ollama",
    description: "Manage Ollama models: list, ps, pull, show",
    schema: z.object({
      action: z.enum(["list", "ps", "pull", "show"]).describe("Ollama action"),
      model: z.string().optional().describe("Model name (required for pull/show)"),
    }),
    args: { action: "string (list|ps|pull|show)", model: "string (optional, model name for pull/show)" },
    risk: "low",
    category: "Context & Learning",
    source: "builtin",
    family: "inference",
    handler: sidekick_ollama,
  }),
]);

module.exports = { descriptors, sidekick_llm, sidekick_embed, sidekick_ollama };
