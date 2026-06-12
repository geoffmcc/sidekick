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
