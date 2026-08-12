"use strict";

// Teach tool family: teach.
//
// Extracted from src/tools-legacy.js. Procedures are taught, generated (via
// the inference family's sidekick_llm), and executed through the nested
// dispatch seam — never by importing tools-legacy.js. The procedures store is
// the shared src/core/procedures-store.js. `teach` is `high` risk,
// preserved from src/tools/metadata.js.

const { z } = require("zod");
const { loadProcedures, saveProcedures } = require("../../core/procedures-store");
const { sidekick_llm } = require("./inference");
const { callTool } = require("../dispatch-seam");

function substituteParams(obj, params) {
  if (typeof obj === "string") {
    if (!params) return obj;
    return obj.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return params[key] !== undefined ? String(params[key]) : match;
    });
  }
  if (!params || typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => substituteParams(item, params));
  }
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = substituteParams(v, params);
  }
  return result;
}

async function sidekick_teach({ action, name, description, steps, example, trigger_phrases, implementation, parameters, args }) {
  const allowedActions = ["teach_procedure", "generate_tool", "learn_from_example", "execute", "list", "remove"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const procedures = loadProcedures();
  const now = new Date().toISOString();

  if (action === "teach_procedure") {
    if (!name || !description || !steps) {
      return { content: [{ type: "text", text: "name, description, and steps required" }], isError: true };
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      return { content: [{ type: "text", text: "steps must be a non-empty array" }], isError: true };
    }
    for (const step of steps) {
      if (!step.tool || !step.args) {
        return { content: [{ type: "text", text: "Each step must have 'tool' and 'args' properties" }], isError: true };
      }
    }
    procedures[name] = {
      name,
      description,
      parameters: parameters || {},
      steps,
      triggerPhrases: trigger_phrases || [],
      createdAt: now,
      lastUsed: null,
      useCount: 0
    };
    saveProcedures(procedures);
    const paramCount = Object.keys(parameters || {}).length;
    return { content: [{ type: "text", text: `Taught procedure: ${name} (${steps.length} steps, ${paramCount} parameters)` }] };
  }

  if (action === "generate_tool") {
    if (!name || !description) {
      return { content: [{ type: "text", text: "name and description required" }], isError: true };
    }
    const toolSchemas = `
Tool parameter schemas:
- sidekick_bash: { "command": "shell command to run" }
- sidekick_read: { "path": "absolute file path" }
- sidekick_write: { "path": "absolute file path", "content": "file content" }
- sidekick_list: { "path": "/home/sidekick" } (optional path)
- sidekick_search: { "pattern": "regex", "path": "optional dir", "include": "optional file pattern" }
- sidekick_git: { "action": "status|diff|log|add|commit|push|pull|branch|checkout|stash", "args": "optional string" }
- sidekick_notify: { "channel": "discord|slack|email", "message": "text", "webhook_url": "for discord/slack", "recipient": "for email" }
- sidekick_process: { "action": "list|top|kill|tree", "filter": "optional name", "pid": "optional number", "name": "optional name" }
- sidekick_service: { "action": "start|stop|restart|status|enable|disable|logs", "service": "service name" }
- sidekick_archive: { "action": "create|extract|list", "path": "source path", "output": "output path for create", "format": "tar.gz|zip" }
- sidekick_store: { "key": "storage key", "value": "value to store", "project": "optional project name" }
- sidekick_get: { "key": "storage key" }
- sidekick_web_fetch: { "url": "URL to fetch", "method": "GET|POST", "body": "optional", "headers": "optional JSON" }
- sidekick_llm: { "prompt": "question", "system": "optional system prompt", "temperature": "optional 0-2" }
`;
    const prompt = `Generate a procedure definition for "${name}" based on this description: "${description}".

Return a JSON object with two properties:
1. "parameters": an object defining input parameters, where each key is a param name and value has "type" (string|number|boolean), "description", and optional "required" (boolean, default false)
2. "steps": a JSON array of steps, where each step has "tool" and "args" properties. Use {{paramName}} in arg values to reference parameters.

${toolSchemas}
Example format:
{
  "parameters": { "path": { "type": "string", "description": "Directory to check", "required": true } },
  "steps": [
    {"tool": "sidekick_bash", "args": {"command": "df -h {{path}}"}},
    {"tool": "sidekick_bash", "args": {"command": "du -sh {{path}}"}}
  ]
}

If the procedure takes no parameters, return an empty "parameters" object.
IMPORTANT: Use ONLY the parameters shown in the schemas above. Do not invent tool parameters.
Return ONLY the JSON object, no other text.`;

    const llmResult = await sidekick_llm({ prompt, system: "You are a helpful assistant that generates tool procedures with parameters. Return only valid JSON." });
    if (llmResult.isError) {
      return { content: [{ type: "text", text: "Failed to generate tool: " + llmResult.content[0].text }], isError: true };
    }

    let generated;
    try {
      const text = llmResult.content[0].text.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        generated = JSON.parse(jsonMatch[0]);
      } else {
        generated = JSON.parse(text);
      }
    } catch (e) {
      return { content: [{ type: "text", text: "Failed to parse generated definition: " + e.message }], isError: true };
    }

    const generatedSteps = generated.steps;
    const generatedParams = generated.parameters || {};

    if (!Array.isArray(generatedSteps) || generatedSteps.length === 0) {
      return { content: [{ type: "text", text: "Generated steps are invalid" }], isError: true };
    }

    procedures[name] = {
      name,
      description,
      parameters: generatedParams,
      steps: generatedSteps,
      triggerPhrases: [],
      createdAt: now,
      lastUsed: null,
      useCount: 0,
      generated: true
    };
    saveProcedures(procedures);
    const paramNames = Object.keys(generatedParams);
    return { content: [{ type: "text", text: `Generated tool: ${name} (${generatedSteps.length} steps, parameters: ${paramNames.length > 0 ? paramNames.join(", ") : "none"})\nSteps:\n${JSON.stringify(generatedSteps, null, 2)}` }] };
  }

  if (action === "learn_from_example") {
    if (!name || !example) {
      return { content: [{ type: "text", text: "name and example required" }], isError: true };
    }
    const toolSchemas = `
Tool parameter schemas:
- sidekick_bash: { "command": "shell command to run" }
- sidekick_read: { "path": "absolute file path" }
- sidekick_write: { "path": "absolute file path", "content": "file content" }
- sidekick_list: { "path": "/home/sidekick" } (optional path)
- sidekick_search: { "pattern": "regex", "path": "optional dir", "include": "optional file pattern" }
- sidekick_git: { "action": "status|diff|log|add|commit|push|pull|branch|checkout|stash", "args": "optional string" }
- sidekick_notify: { "channel": "discord|slack|email", "message": "text", "webhook_url": "for discord/slack", "recipient": "for email" }
- sidekick_process: { "action": "list|top|kill|tree", "filter": "optional name", "pid": "optional number", "name": "optional name" }
- sidekick_service: { "action": "start|stop|restart|status|enable|disable|logs", "service": "service name" }
- sidekick_archive: { "action": "create|extract|list", "path": "source path", "output": "output path for create", "format": "tar.gz|zip" }
- sidekick_store: { "key": "storage key", "value": "value to store", "project": "optional project name" }
- sidekick_get: { "key": "storage key" }
- sidekick_web_fetch: { "url": "URL to fetch", "method": "GET|POST", "body": "optional", "headers": "optional JSON" }
- sidekick_llm: { "prompt": "question", "system": "optional system prompt", "temperature": "optional 0-2" }
`;
    const prompt = `Parse this example and extract a procedure definition:
"${example}"

Return a JSON object with two properties:
1. "parameters": an object defining input parameters (use {{paramName}} references in steps). If nothing varies, use empty {}.
2. "steps": a JSON array of steps, where each step has "tool" and "args" properties.

${toolSchemas}
IMPORTANT: Use ONLY the parameters shown in the schemas above. Do not invent tool parameters.
Return ONLY the JSON object, no other text.`;

    const llmResult = await sidekick_llm({ prompt, system: "You are a helpful assistant that extracts procedures from examples. Return only valid JSON." });
    if (llmResult.isError) {
      return { content: [{ type: "text", text: "Failed to parse example: " + llmResult.content[0].text }], isError: true };
    }

    let parsed;
    try {
      const text = llmResult.content[0].text.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = JSON.parse(text);
      }
    } catch (e) {
      return { content: [{ type: "text", text: "Failed to parse steps from example: " + e.message }], isError: true };
    }

    const parsedSteps = parsed.steps || parsed;
    const parsedParams = parsed.parameters || {};

    procedures[name] = {
      name,
      description: example,
      parameters: parsedParams,
      steps: Array.isArray(parsedSteps) ? parsedSteps : [],
      triggerPhrases: trigger_phrases || [],
      createdAt: now,
      lastUsed: null,
      useCount: 0,
      learned: true
    };
    saveProcedures(procedures);
    return { content: [{ type: "text", text: `Learned procedure: ${name} (${(Array.isArray(parsedSteps) ? parsedSteps.length : 0)} steps)` }] };
  }

  if (action === "execute") {
    if (!name) {
      return { content: [{ type: "text", text: "name required" }], isError: true };
    }
    const procedure = procedures[name];
    if (!procedure) {
      return { content: [{ type: "text", text: `Procedure not found: ${name}` }], isError: true };
    }

    const params = args || {};
    const requiredParams = Object.entries(procedure.parameters || {})
      .filter(([, def]) => def.required)
      .map(([k]) => k);
    const missing = requiredParams.filter(k => params[k] === undefined);
    if (missing.length > 0) {
      return { content: [{ type: "text", text: `Missing required parameters: ${missing.join(", ")}` }], isError: true };
    }

    procedure.lastUsed = now;
    procedure.useCount++;
    saveProcedures(procedures);

    const results = [];
    for (let i = 0; i < procedure.steps.length; i++) {
      const step = procedure.steps[i];
      const resolvedArgs = substituteParams(step.args, params);
      try {
        const result = await callTool(step.tool, resolvedArgs);
        results.push({
          step: i + 1,
          tool: step.tool,
          success: !result.isError,
          output: result.content[0].text.substring(0, 200)
        });
        if (result.isError) {
          return { content: [{ type: "text", text: `Procedure '${name}' failed at step ${i + 1} (${step.tool}):\n${result.content[0].text}` }], isError: true };
        }
      } catch (e) {
        return { content: [{ type: "text", text: `Procedure '${name}' failed at step ${i + 1} (${step.tool}): ${e.message}` }], isError: true };
      }
    }

    const summary = results.map(r => `Step ${r.step} (${r.tool}): ${r.success ? "✓" : "✗"} ${r.output}`).join("\n");
    return { content: [{ type: "text", text: `Executed procedure '${name}' (${procedure.steps.length} steps)\n\n${summary}` }] };
  }

  if (action === "list") {
    const procNames = Object.keys(procedures);
    if (procNames.length === 0) {
      return { content: [{ type: "text", text: "No procedures taught yet" }] };
    }
    const summary = procNames.map(name => {
      const proc = procedures[name];
      const tags = [];
      if (proc.generated) tags.push("generated");
      if (proc.learned) tags.push("learned");
      const paramNames = Object.keys(proc.parameters || {});
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      const paramStr = paramNames.length > 0 ? ` params: {${paramNames.join(", ")}}` : "";
      return `${name}${tagStr} - ${proc.description} (${proc.steps.length} steps, used ${proc.useCount} times${paramStr})`;
    }).join("\n");
    return { content: [{ type: "text", text: `Taught procedures (${procNames.length}):\n\n${summary}` }] };
  }

  if (action === "remove") {
    if (!name) {
      return { content: [{ type: "text", text: "name required" }], isError: true };
    }
    if (!procedures[name]) {
      return { content: [{ type: "text", text: `Procedure not found: ${name}` }], isError: true };
    }
    delete procedures[name];
    saveProcedures(procedures);
    return { content: [{ type: "text", text: `Removed procedure: ${name}` }] };
  }
}

const SCHEMAS = {
  teach: z.object({
    action: z.enum(["teach_procedure", "generate_tool", "learn_from_example", "execute", "list", "remove"]).describe("Teach action to perform"),
    name: z.string().optional().describe("Procedure name (required for teach/generate/execute/remove)"),
    description: z.string().optional().describe("Procedure description (required for teach/generate)"),
    steps: z.array(z.object({ tool: z.string(), args: z.record(z.any()) })).optional().describe("Array of steps (required for teach_procedure)"),
    parameters: z.record(z.object({ type: z.enum(["string", "number", "boolean"]), description: z.string().optional(), required: z.boolean().optional() })).optional().describe("Parameter definitions for the procedure"),
    args: z.record(z.any()).optional().describe("Arguments to pass when executing a procedure"),
    example: z.string().optional().describe("Example to learn from (required for learn_from_example)"),
    trigger_phrases: z.array(z.string()).optional().describe("Trigger phrases for the procedure"),
    implementation: z.string().optional().describe("Implementation details (for generate_tool)")
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "teach",
    description: "Meta-learning and self-extension: teach procedures, generate tools, learn from examples, execute learned workflows",
    schema: SCHEMAS.teach,
    args: { action: "string", name: "string (optional)", description: "string (optional)", steps: "array (optional)", parameters: "object (optional)", args: "object (optional)", example: "string (optional)", trigger_phrases: "array (optional)", implementation: "string (optional)" },
    risk: "high",
    category: "Context & Learning",
    source: "builtin",
    family: "teach",
    handler: sidekick_teach,
  }),
]);

module.exports = { descriptors, sidekick_teach };
