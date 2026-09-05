const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { childProcessEnv } = require("../security/child-process");

function runCommand(program, args = [], opts = {}) {
  try {
    return execFileSync(program, args, { encoding: "utf-8", timeout: 5000, ...opts, env: childProcessEnv(opts.env) }).trim();
  } catch { return "?"; }
}

function parseMemInfo() {
  try {
    return Object.fromEntries(fs.readFileSync("/proc/meminfo", "utf-8").split("\n").filter(Boolean).map(line => {
      const match = line.match(/^([^:]+):\s+(\d+)\s*(\w+)?/);
      return match ? [match[1], { value: Number(match[2]), unit: match[3] || "" }] : null;
    }).filter(Boolean));
  } catch { return {}; }
}

function formatKb(entry) {
  if (!entry || !Number.isFinite(entry.value)) return "?";
  if (entry.unit === "kB") return `${entry.value} kB`;
  return String(entry.value);
}

function parseDiskRoot() {
  const output = runCommand("df", ["-h", "/"]);
  const line = output.split("\n")[1] || "";
  const parts = line.trim().split(/\s+/);
  return { total: parts[1] || "?", used: parts[2] || "?", free: parts[3] || "?", pct: parts[4] || "?" };
}

function parseLoadAverage() {
  try {
    return fs.readFileSync("/proc/loadavg", "utf-8").trim().split(/\s+/).slice(0, 3).join(" ");
  } catch { return os.loadavg().map(n => n.toFixed(2)).join(" "); }
}

function systemctlStatus(unit, action = "is-active") {
  const status = runCommand("systemctl", [action, unit], { timeout: 3000 });
  return status === "?" ? "inactive" : status;
}

function systemSnapshot() {
  const memInfo = parseMemInfo();
  const totalKb = memInfo.MemTotal?.value || 0;
  const availableKb = memInfo.MemAvailable?.value || 0;
  const usedKb = totalKb && availableKb ? totalKb - availableKb : 0;
  const memPct = totalKb ? Math.round((usedKb / totalKb) * 100) : 0;
  const disk = parseDiskRoot();
  const load1m = Number((os.loadavg()[0] || 0).toFixed(2));
  const cpuCount = os.cpus().length || 1;
  return {
    uptime: runCommand("uptime", ["-p"]),
    memory: { total: formatKb(memInfo.MemTotal), used: usedKb ? `${usedKb} kB` : "?", free: formatKb(memInfo.MemAvailable), pct: `${memPct}%`, pctNumber: memPct },
    disk,
    load_1m: load1m,
    cpu_count: cpuCount,
    load: parseLoadAverage()
  };
}

module.exports = { formatKb, parseMemInfo, parseDiskRoot, parseLoadAverage, runCommand, systemSnapshot, systemctlStatus };
