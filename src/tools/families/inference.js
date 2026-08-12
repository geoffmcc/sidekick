"use strict";

// Inference tool family: text embeddings and Ollama model management.
//
// Extracted from src/tools-legacy.js. Depends only on the Compute inference
// service (optional) and the global fetch — never on tools-legacy.js — so it
// carries no legacy import at module load. Risk classifications (both low) are
// preserved from src/tools/metadata.js; policy, redaction and audit are applied
// by the dispatcher.

const { z } = require("zod");

let inferenceService = null;
try { inferenceService = require("../../compute/inference-service"); } catch {}

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

const descriptors = Object.freeze([
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

module.exports = { descriptors, sidekick_embed, sidekick_ollama };
