const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
    line = line.trim();
    if (line && !line.startsWith("#")) {
      const idx = line.indexOf("=");
      if (idx > 0 && !process.env[line.substring(0, idx).trim()]) {
        process.env[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
      }
    }
  });
}

const packageJson = require("../package.json");
const requiredNode = packageJson.engines?.node || ">=22.0.0";
const minMajor = Number(requiredNode.match(/>=\s*(\d+)/)?.[1] || 22);
const currentMajor = Number(process.versions.node.split(".")[0]);
if (Number.isFinite(minMajor) && currentMajor < minMajor) {
  throw new Error(`Unsupported Node.js runtime ${process.version}; Sidekick requires ${requiredNode}`);
}
