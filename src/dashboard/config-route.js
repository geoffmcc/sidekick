const REDACTED = "***redacted***";

function isSensitiveConfigName(name) {
  return /(?:^|_)(?:KEY|PASS(?:WORD)?|SECRET|TOKEN|CREDENTIALS?|PRIVATE_KEY|AUTH|COOKIE|CERT(?:IFICATE)?|SIGNATURE|(?:POSTGRES|DATABASE|REDIS|INFLUX|QDRANT|CONNECTION)(?:_URL|_URI|_DSN)?|URL|URI|DSN)(?:_|$)/i.test(name);
}

function collectDashboardConfig(env = process.env) {
  const config = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("SIDEKICK_") && !key.startsWith("GROQ_") && !key.startsWith("OLLAMA_")) continue;
    config[key] = isSensitiveConfigName(key) ? REDACTED : (value || "");
  }
  return config;
}

function registerDashboardConfigRoute({ app, requireIdentityPermission, env = process.env }) {
  app.get("/api/config", (req, res) => {
    if (!requireIdentityPermission(req, res, "dashboard.config.read")) return;
    res.json({ config: collectDashboardConfig(env) });
  });
}

module.exports = { registerDashboardConfigRoute, collectDashboardConfig, isSensitiveConfigName };
