const { execFileSync } = require("child_process");
const { childProcessEnv } = require("../security/child-process");

function createWatchRuntime({ callAgentTool }) {
  function checkService(serviceName) {
    try {
      const output = execFileSync("systemctl", ["is-active", serviceName], { encoding: "utf-8", timeout: 5000, env: childProcessEnv() }).trim();
      return { status: output, active: output === "active" };
    } catch { return { status: "unknown", active: false }; }
  }

  function checkProcess(processName) {
    try {
      const output = execFileSync("pgrep", ["-f", processName], { encoding: "utf-8", timeout: 5000, env: childProcessEnv() }).trim();
      return { running: output.length > 0, pids: output.split("\n").filter(Boolean) };
    } catch { return { running: false, pids: [] }; }
  }

  function checkEndpoint(url) {
    try {
      const output = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", url], { encoding: "utf-8", timeout: 10000, env: childProcessEnv() }).trim();
      return { status: parseInt(output), ok: output.startsWith("2") };
    } catch { return { status: 0, ok: false }; }
  }

  function checkFile(filePath, pattern) {
    try {
      const fs = require("fs");
      const output = fs.readFileSync(filePath, "utf-8");
      return { exists: true, matches: pattern ? output.includes(pattern) : true, content: output.substring(0, 200) };
    } catch { return { exists: false, matches: false }; }
  }

  function evaluateWatchCondition(watch, checkResult) {
    const { source, condition } = watch;
    if (source === "service") return condition === "status!=active" ? !checkResult.active : condition === "status=active" ? checkResult.active : false;
    if (source === "process") return condition === "not_running" ? !checkResult.running : condition === "running" ? checkResult.running : false;
    if (source === "endpoint") {
      if (condition === "status!=200") return checkResult.status !== 200;
      if (condition === "status=200") return checkResult.status === 200;
      if (condition.startsWith("status>=")) return checkResult.status >= parseInt(condition.substring(8));
    }
    if (source === "file") {
      if (condition === "content_matches") return checkResult.exists && checkResult.matches;
      if (condition === "not_exists") return !checkResult.exists;
      if (condition === "exists") return checkResult.exists;
    }
    return false;
  }

  async function executeWatchAction(watch, checkResult, metadata = {}) {
    if (!watch.action_tool) return;
    const args = { ...watch.action_args };
    if (args.message) {
      args.message = args.message.replace(/\{\{source\}\}/g, watch.source)
        .replace(/\{\{target\}\}/g, watch.target)
        .replace(/\{\{status\}\}/g, JSON.stringify(checkResult))
        .replace(/\{\{time\}\}/g, new Date().toISOString());
    }
    try { return await callAgentTool(watch.action_tool, args, metadata); }
    catch (e) {
      console.error(`Watch ${watch.id} action failed: ${e.message}`);
      return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
    }
  }

  return { checkService, checkProcess, checkEndpoint, checkFile, evaluateWatchCondition, executeWatchAction };
}

module.exports = { createWatchRuntime };
