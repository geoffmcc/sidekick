"use strict";

const vm = require("node:vm");

const MAX_PATTERN_LENGTH = 512;
const DEFAULT_MATCH_TIMEOUT_MS = 20;
const DEFAULT_BUDGET_MS = 500;

class BoundedRegex {
  constructor(pattern, flags = "", options = {}) {
    if (typeof pattern !== "string" || pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(`Regex pattern must be a string no longer than ${MAX_PATTERN_LENGTH} characters`);
    }
    if (typeof flags !== "string" || /[^dgimsuvy]/.test(flags) || flags.includes("g") || flags.includes("y")) {
      throw new Error("Regex flags are invalid or stateful flags are not supported");
    }
    const regex = new RegExp(pattern, flags);
    this.context = vm.createContext({ regex, replaceRegex: new RegExp(pattern, `${flags}g`), value: "", replacement: "" });
    this.script = new vm.Script("regex.test(value)");
    this.replaceScript = new vm.Script("value.replace(replaceRegex, replacement)");
    this.deadline = Number.isFinite(options.deadline)
      ? options.deadline
      : Date.now() + (Number.isFinite(options.budgetMs) ? Math.max(1, options.budgetMs) : DEFAULT_BUDGET_MS);
    this.matchTimeoutMs = Number.isFinite(options.matchTimeoutMs)
      ? Math.max(1, options.matchTimeoutMs)
      : DEFAULT_MATCH_TIMEOUT_MS;
  }

  test(value) {
    return this.run(this.script, { value: String(value) });
  }

  replace(value, replacement) {
    return this.run(this.replaceScript, { value: String(value), replacement: String(replacement) });
  }

  run(script, values) {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new Error("Regex evaluation exceeded its time budget");
    Object.assign(this.context, values);
    try {
      return script.runInContext(this.context, { timeout: Math.max(1, Math.min(this.matchTimeoutMs, remaining)) });
    } catch (error) {
      if (error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        throw new Error("Regex evaluation exceeded its time budget");
      }
      throw error;
    }
  }
}

module.exports = { BoundedRegex, MAX_PATTERN_LENGTH };
