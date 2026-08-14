"use strict";

// Inference tool family: LLM chat, text embeddings, and Ollama model management.
//
// Extracted from src/tools-legacy.js. `llm` and `embed` route through the
// Compute inference service — the single inference authority — which owns
// provider/model selection, credentials, trust/data-classification gating,
// health, and fallback; this family no longer reaches Ollama/Groq directly for
// inference (the `ollama` handler remains a direct model-management surface,
// which is administration, not inference). Risk classifications (llm medium,
// embed/ollama low) are preserved from src/tools/metadata.js; policy, redaction
// and audit are applied by the dispatcher. sidekick_llm is exported for the
// legacy handlers that call it (teach, fresheyes, changelog, black_box).

const { z } = require("zod");
const compute = require("../../compute");
const toolContext = require("../context");
const { resolveOutputTokenBudget } = require("../../compute/token-budget");

let inferenceService = null;
try { inferenceService = require("../../compute/inference-service"); } catch {}

async function sidekick_embed({ text, model }) {
  const m = model || "nomic-embed-text";
  // Embeddings route through Compute — the single inference authority — not a
  // direct Ollama call. Requests are classified private, so placement keeps them
  // on local/trusted providers.
  if (!inferenceService) {
    return { content: [{ type: "text", text: "Embedding error: Compute inference service unavailable" }], isError: true };
  }
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

async function sidekick_llm({ prompt, system, temperature, async: asyncMode, timeout_ms: timeoutMs, max_tokens: maxTokens, output_budget: outputBudget, context_limit: contextLimit }) {
  // Chat routes through Compute — the single inference authority. Provider/model
  // selection, credentials, health, and fallback belong to Placement; the tool
  // no longer reaches Ollama/Groq directly or accepts a provider pin. Requests
  // are classified private, so they stay on local/trusted providers.
  if (!inferenceService) {
    return { content: [{ type: "text", text: "LLM error: Compute inference service unavailable" }], isError: true };
  }
  try {
    if (asyncMode) {
      // The MCP gateway may impose a shorter response deadline than a real
      // model needs. Persist the request first, then let the compute runner
      // execute it outside the tool invocation and expose it through the
      // existing compute_jobs lifecycle.
      compute.initialize();
      const context = toolContext.getExecutionContext();
      const workerModel = process.env.OLLAMA_MODEL || "qwen3.5:latest";
      const job = compute.jobManager.createJob({
        jobType: "chat",
        capability: "chat",
        source: context.source,
        project: context.project,
        requestingActor: context.actor,
        rootExecutionId: context.rootExecutionId,
        parentExecutionId: context.executionId,
        taskId: context.taskId,
        sessionId: context.sessionId,
        dataClassification: "private",
        capabilityRequirements: { executor: "ollama.inference", model: workerModel },
        requestPayload: {
          async: true,
          prompt,
          system,
          temperature: temperature ?? 0.7,
          maxTokens: resolveOutputTokenBudget({ maxTokens, outputBudget }),
          contextLimit,
          model: workerModel,
        },
        timeoutMs: timeoutMs || 86400000,
        maxAttempts: 1,
        idempotencyKey: context.idempotencyKey || undefined,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({
          async: true,
          job_id: job.jobId,
          status: job.status,
          project: job.project,
          poll: { tool: "compute_jobs", action: "get", job_id: job.jobId },
        }, null, 2) }],
      };
    }
    const result = await inferenceService.chat({
      messages: [{ role: "user", content: prompt }],
      system,
      temperature: temperature || 0.7,
      dataClassification: "private",
      maxTokens: resolveOutputTokenBudget({ maxTokens, outputBudget }),
      preferences: { allowFallback: true },
    });
    return { content: [{ type: "text", text: result.content || JSON.stringify(result) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "LLM error: " + e.message }], isError: true };
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "llm",
    description: "Ask the LLM via Compute (provider and model are chosen by routing; private by default)",
    schema: z.object({
      prompt: z.string().describe("The prompt to send to the LLM"),
      system: z.string().optional().describe("System prompt override"),
      temperature: z.number().optional().default(0.7).describe("Sampling temperature (0-2)"),
      async: z.boolean().optional().default(false).describe("Queue the request durably and return a job ID instead of waiting for the model"),
      timeout_ms: z.number().int().min(1000).max(86400000).optional().describe("Maximum provider execution time for async requests"),
      max_tokens: z.number().int().min(256).max(262144).optional().describe("Optional maximum output tokens; overrides output_budget"),
      output_budget: z.enum(["normal", "complex", "large"]).optional().default("normal").describe("Output tier: normal=4096, complex=8192, large=16384; max_tokens overrides it"),
      context_limit: z.number().int().min(4096).max(262144).optional().describe("Optional model context window; omitted uses the registered model limit"),
    }),
    args: { prompt: "string", system: "string (optional)", temperature: "number (optional)", async: "boolean (optional)", timeout_ms: "integer (optional, async execution timeout)", max_tokens: "integer (optional, provider output limit; overrides output_budget)", output_budget: "string (optional: normal|complex|large; defaults normal)", context_limit: "integer (optional, model context limit)" },
    risk: "medium",
    category: "Core",
    source: "builtin",
    family: "inference",
    handler: sidekick_llm,
  }),
  Object.freeze({
    name: "embed",
    description: "Generate text embeddings via Compute (private by default)",
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
