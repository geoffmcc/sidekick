const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);
const CONTENT_IGNORED_ROOTS = new Set(["data", "docs", "test"]);
const CONFIG_EXTENSIONS = new Set([
  "", ".conf", ".env", ".ini", ".js", ".json", ".mjs", ".properties",
  ".key", ".pem", ".ps1", ".service", ".sh", ".toml", ".ts", ".yaml", ".yml"
]);
const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };

function relativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/") || ".";
}

function isIgnoredDirectory(relative) {
  const parts = relative.split("/");
  if (parts.some(part => IGNORED_DIRECTORIES.has(part))) return true;
  return relative === "data" || relative.startsWith("data/") ||
    relative === "docker/data" || relative.startsWith("docker/data/");
}

function isContentIgnored(relative) {
  const first = relative.split("/")[0];
  return CONTENT_IGNORED_ROOTS.has(first);
}

function sensitiveFileKind(fileName) {
  const lower = fileName.toLowerCase();
  if (lower === ".env" || (lower.startsWith(".env.") && !/(example|sample|template)$/.test(lower))) {
    return "environment";
  }
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(lower)) return "private_key";
  if (/\.(key|pem|p12|pfx)$/.test(lower)) return "key_material";
  if (!lower.startsWith("git-credential-") &&
      /(credentials?|password|passwd|secret|service[-_.]?account)/.test(lower) &&
      /\.(conf|env|ini|json|properties|txt|ya?ml)$/.test(lower) &&
      !/(example|sample|template|\.enc$)/.test(lower)) {
    return "credential_file";
  }
  return null;
}

function modeString(stat) {
  return (stat.mode & 0o777).toString(8).padStart(3, "0");
}

function isWindowsMountedPath(filePath) {
  return /^\/mnt\/[a-z]\//i.test(String(filePath).replace(/\\/g, "/"));
}

function parseEnvFile(content) {
  const values = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7) : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    const value = normalized.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    values.set(key, value);
  }
  return values;
}

function isReferenceValue(value) {
  return /\$\{|\$env:|process\.env|secretKeyRef|valueFrom|<[^>]+>|\{\{|new RegExp|^z\./.test(value);
}

function isSensitiveConfigKey(key) {
  if (/(?:_PATH|_FILE|_FILENAME)$/i.test(key)) return false;
  return /(?:^|[_.-])(?:password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key)(?:$|[_.-])/i.test(key);
}

function isPlaceholderFile(relative) {
  const lower = relative.toLowerCase();
  return /(^|\/)\.env\.(example|sample|template)$/.test(lower) ||
    /\.(example|sample|template)\.[^.]+$/.test(lower);
}

function scanSecurityConfig({
  root,
  maxFiles = 2000,
  canAccess = () => true
}) {
  const scanRoot = path.resolve(root);
  const fileLimit = Math.min(Math.max(parseInt(maxFiles, 10) || 2000, 1), 10000);
  const findings = [];
  const files = [];
  let skippedByPolicy = 0;
  let truncated = false;

  function addFinding(severity, type, filePath, message, line) {
    findings.push({
      severity,
      type,
      path: relativePath(scanRoot, filePath),
      ...(line ? { line } : {}),
      message
    });
  }

  const stack = [{ directory: scanRoot, depth: 0 }];
  while (stack.length && files.length < fileLimit) {
    const { directory, depth } = stack.pop();
    if (!canAccess(directory)) {
      skippedByPolicy++;
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relative = relativePath(scanRoot, fullPath);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth < 12 && !isIgnoredDirectory(relative)) {
          stack.push({ directory: fullPath, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!canAccess(fullPath)) {
        skippedByPolicy++;
        continue;
      }
      files.push(fullPath);
      if (files.length >= fileLimit) {
        truncated = stack.length > 0 || entries.indexOf(entry) < entries.length - 1;
        break;
      }
    }
  }

  let trackedFiles = new Set();
  try {
    const output = execFileSync("git", ["-C", scanRoot, "ls-files", "-z"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 5 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    trackedFiles = new Set(output.split("\0").filter(Boolean).map(item => item.replace(/\\/g, "/")));
  } catch {
    // Non-repository directories can still be scanned.
  }

  for (const filePath of files) {
    const relative = relativePath(scanRoot, filePath);
    const fileName = path.basename(filePath);
    const kind = sensitiveFileKind(fileName);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }

    if (kind && trackedFiles.has(relative)) {
      addFinding("critical", "tracked_sensitive_file", filePath,
        `Git tracks a ${kind.replace(/_/g, " ")}; remove it from history and rotate exposed credentials.`);
    } else if (kind && kind !== "environment") {
      addFinding("medium", "sensitive_filename", filePath,
        `Sensitive-looking ${kind.replace(/_/g, " ")} is present; verify that it is encrypted, ignored, and still required.`);
    }

    if (kind &&
        process.platform !== "win32" &&
        !isWindowsMountedPath(filePath) &&
        (stat.mode & 0o077) !== 0) {
      addFinding("high", "sensitive_file_permissions", filePath,
        `Sensitive file permissions are ${modeString(stat)}; restrict group and other access.`);
    }

    if (stat.size > 1024 * 1024 || isContentIgnored(relative) || isPlaceholderFile(relative)) continue;
    if (!CONFIG_EXTENSIONS.has(path.extname(fileName).toLowerCase())) continue;

    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/.test(line)) {
        addFinding("critical", "private_key_material", filePath,
          "Private key material is present in a scanned configuration or source file.", index + 1);
      }

      const githubTokenPattern = new RegExp("(?:ghp_[A-Za-z0-9_]{36}|github_pat_[A-Za-z0-9_]{82})");
      const awsKeyPattern = new RegExp("AKIA[0-9A-Z]{16}");
      if (githubTokenPattern.test(line) || awsKeyPattern.test(line)) {
        addFinding("critical", "credential_signature", filePath,
          "A high-confidence credential signature is present.", index + 1);
      }

      if (path.basename(filePath) === ".env") continue;
      const assignment = line.match(
        /^\s*(?:(?:const|let|var)\s+)?["']?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*[:=]\s*(.+?)\s*[,;]?\s*$/
      );
      if (!assignment) continue;
      const key = assignment[1];
      const valueExpression = assignment[2];
      if (!isSensitiveConfigKey(key)) continue;
      if (/^sidekick_/i.test(key) && /^["'](?:low|medium|high|critical|security)["']$/i.test(valueExpression)) continue;
      const hasLiteralFallback = /(?:process\.env|env\.)[^;\n]*\|\|\s*["'][^"']+["']/i.test(valueExpression);
      const isCodeFile = [".js", ".mjs", ".ts"].includes(path.extname(fileName).toLowerCase()) ||
        path.extname(fileName) === "";
      const isLiteralAssignment = /^["'][^"']+["']$/.test(valueExpression);
      if (isCodeFile && !hasLiteralFallback && !isLiteralAssignment) continue;
      if (!isReferenceValue(valueExpression) || hasLiteralFallback) {
        addFinding("high", "hardcoded_sensitive_config", filePath,
          `Sensitive configuration key ${key} has a hardcoded value or fallback.`, index + 1);
      }
    }
  }

  const looksLikeSidekick = fs.existsSync(path.join(scanRoot, "package.json")) &&
    fs.existsSync(path.join(scanRoot, ".env.example"));
  const envPath = path.join(scanRoot, ".env");
  if (looksLikeSidekick) {
    if (!fs.existsSync(envPath)) {
      addFinding("medium", "missing_runtime_env", envPath,
        "Runtime .env is missing; verify how production secrets and security settings are injected.");
    } else if (canAccess(envPath)) {
      try {
        const env = parseEnvFile(fs.readFileSync(envPath, "utf8"));
        const apiKey = env.get("SIDEKICK_API_KEY") || "";
        const secretKey = env.get("SIDEKICK_SECRET_KEY") || "";
        const approvalMode = (env.get("SIDEKICK_APPROVAL_MODE") || "off").toLowerCase();
        if (!apiKey || apiKey === "sk-sidekick-local-dev" || apiKey === "sk-your-key-here") {
          addFinding("critical", "unsafe_api_key", envPath,
            "SIDEKICK_API_KEY is missing or uses a placeholder or local-development default.");
        }
        if (approvalMode !== "off" && !secretKey) {
          addFinding("critical", "approval_encryption_missing", envPath,
            "Approval mode is enabled without SIDEKICK_SECRET_KEY.");
        } else if (!secretKey) {
          addFinding("medium", "secret_encryption_key_missing", envPath,
            "SIDEKICK_SECRET_KEY is unset, so encrypted credential and approval storage is unavailable.");
        }
        const dashboardUser = env.get("SIDEKICK_DASHBOARD_USER") || "";
        const dashboardPass = env.get("SIDEKICK_DASHBOARD_PASS") || "";
        if (!dashboardUser || !dashboardPass) {
          addFinding("medium", "dashboard_auth_incomplete", envPath,
            "Dashboard Basic Auth is disabled or incomplete.");
        }
      } catch {
        addFinding("medium", "env_read_failed", envPath,
          "Runtime .env exists but could not be read for a key-only audit.");
      }
    } else {
      skippedByPolicy++;
    }
  }

  findings.sort((a, b) =>
    (SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]) ||
    a.path.localeCompare(b.path) ||
    ((a.line || 0) - (b.line || 0))
  );
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity]++;

  return {
    root: scanRoot,
    files_scanned: files.length,
    skipped_by_policy: skippedByPolicy,
    truncated,
    counts,
    findings
  };
}

module.exports = { scanSecurityConfig, isWindowsMountedPath };
