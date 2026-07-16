const { z } = require("zod");
const { textResult } = require("../result");

async function sidekick_respond({ text }) {
  return textResult(text);
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "respond",
    description: "Return a text response directly without calling other tools. Use this for simple answers or when no tool action is needed.",
    schema: z.object({
      text: z.string().describe("The response text to return"),
    }),
    args: { text: "string (the response text to return)" },
    risk: "low",
    category: "Core",
    source: "builtin",
    family: "utility",
    handler: sidekick_respond,
  }),
]);

module.exports = { descriptors, sidekick_respond };
