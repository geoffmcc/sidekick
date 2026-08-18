const fs = require("fs");
const path = require("path");
const { FILE_SECRET_NAMES } = require("./core/runtime-secrets");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
    line = line.trim();
    if (line && !line.startsWith("#")) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        const key = line.substring(0, idx).trim();
        const value = line.substring(idx + 1).trim();
        if (FILE_SECRET_NAMES.has(key) && value && process.env.NODE_ENV !== "test") {
          throw new Error(`${key} must be supplied through a protected secret file, not .env`);
        }
        if (!process.env[key]) process.env[key] = value;
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
