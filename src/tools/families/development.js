"use strict";

// Development tool family: git, changelog, depend.
//
// Extracted from src/tools-legacy.js. Depends only on Node builtins, zod,
// shared non-legacy modules (redact, path-policy, core/command-validation),
// and the inference family's sidekick_llm (changelog's optional use_llm
// path) — never on tools-legacy.js. All handlers and helpers move verbatim;
// risk classifications (all medium) are preserved from src/tools/metadata.js
// and gated by the dispatcher.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { z } = require("zod");
const { redactSensitive } = require("../../redact");
const { enforcePathPolicy } = require("../path-policy");
const { validIdentifier } = require("../../core/command-validation");
const { sidekick_llm } = require("./inference");
const { childProcessEnv } = require("../../security/child-process");

const GIT_EXTERNAL_EXECUTION_OPTIONS = /^(?:-c(?:$|=)|--config(?:=|-env(?:=|$))|--(?:exec-path|upload-pack|receive-pack|git-dir|work-tree)(?:=|$)|--(?:ext-diff|paginate)(?:=|$))/;

function parseGitExtraArgs(extraArgs) {
  if (!extraArgs) return [];
  // Git pretty formats use ASCII unit separator (\x1f) as a field delimiter.
  // JavaScript classifies it as whitespace, so /\s+/ would silently split a
  // single --pretty argument and corrupt structured history parsing.
  const parsed = [];
  let current = ""; let quote = null; let escaped = false;
  for (const char of String(extraArgs)) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { parsed.push(current); current = ""; } continue; }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in Git arguments");
  if (current) parsed.push(current);
  if (parsed.some(arg => GIT_EXTERNAL_EXECUTION_OPTIONS.test(arg))) {
    throw new Error("Git arguments that alter configuration, helpers, execution paths, or pagers are not permitted");
  }
  return parsed;
}

function windowsPathToWslPath(value) {
  const text = String(value || "");
  const match = text.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return text;
  return "/mnt/" + match[1].toLowerCase() + "/" + match[2].replace(/\\/g, "/");
}

async function sidekick_git({ action, path: repoPath, args: extraArgs }) {
  const repo = repoPath || ".";
  const allowedActions = ["status", "diff", "log", "show", "ls-tree", "ls-files", "add", "commit", "push", "pull", "branch", "checkout", "stash"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const writeActions = new Set(["add", "commit", "pull", "branch", "checkout", "stash"]);
  const policyError = enforcePathPolicy(repo, writeActions.has(action) ? "write" : "read");
  if (policyError) return policyError;
  if (!fs.existsSync(repo)) {
    return { content: [{ type: "text", text: "Repository path not found: " + repo }], isError: true };
  }

  const gitFile = path.join(repo, ".git");
  let gitEnv = childProcessEnv();
  let cmdArgs = ["-C", repo, action];
  if (fs.existsSync(gitFile) && fs.statSync(gitFile).isFile()) {
    const content = fs.readFileSync(gitFile, "utf-8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/i);
    if (match) {
      const gitDir = windowsPathToWslPath(match[1].trim());
      gitEnv = childProcessEnv({ GIT_DIR: gitDir, GIT_WORK_TREE: repo });
      cmdArgs = [action];
    }
  }
  if (extraArgs) {
    try {
      cmdArgs.push(...parseGitExtraArgs(extraArgs));
    } catch (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
  }

  try {
    const stdout = execFileSync("git", cmdArgs, { cwd: repo, env: gitEnv, timeout: 60000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    return { content: [{ type: "text", text: redactSensitive(stdout || "(empty output)") }] };
  } catch (e) {
    return { content: [{ type: "text", text: redactSensitive("Exit code: " + e.status + "\n" + (e.stderr || e.stdout || "")) }], isError: true };
  }
}

const COMMIT_TYPE_MAP = {
  feat: "Features",
  fix: "Bug Fixes",
  docs: "Documentation",
  style: "Styles",
  refactor: "Code Refactoring",
  perf: "Performance Improvements",
  test: "Tests",
  build: "Build System",
  ci: "Continuous Integration",
  chore: "Chores",
  revert: "Reverts",
  deps: "Dependencies"
};

function parseConventionalCommit(message) {
  const match = message.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (!match) {
    return { type: "other", scope: null, breaking: false, description: message };
  }
  return {
    type: match[1].toLowerCase(),
    scope: match[2] || null,
    breaking: !!match[3] || message.includes("BREAKING CHANGE:"),
    description: match[4]
  };
}

async function sidekick_changelog({ action, from, to, format, group_by, use_llm, include, path: repoPath }) {
  if (!from) {
    return { content: [{ type: "text", text: "from parameter required (starting ref: tag, commit, or branch)" }], isError: true };
  }

  const toRef = to || "HEAD";
  const fmt = format || "markdown";
  const groupBy = group_by || "type";
  const includeType = include || "all";
  const cwd = repoPath || process.cwd();
  const pathPolicyError = enforcePathPolicy(cwd, action === "save" ? "write" : "read");
  if (pathPolicyError) return pathPolicyError;

  let logOutput = "";
  try {
    logOutput = execFileSync("git", ["log", `${from}..${toRef}`, "--pretty=format:%H|%s|%an|%ad", "--date=short"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], cwd, env: childProcessEnv() });
  } catch (e) {
    return { content: [{ type: "text", text: `Git log failed: ${e.message}\n\nMake sure you're in a git repository and the refs exist.` }], isError: true };
  }

  if (!logOutput.trim()) {
    return { content: [{ type: "text", text: `No commits found between ${from} and ${toRef}` }] };
  }

  const commits = logOutput.trim().split("\n").map(line => {
    const [hash, message, author, date] = line.split("|");
    const parsed = parseConventionalCommit(message);
    return { hash, message, author, date, ...parsed };
  });

  let filtered = commits;
  if (includeType !== "all") {
    const typeFilter = {
      features: ["feat"],
      fixes: ["fix"],
      breaking: commits.filter(c => c.breaking).map(c => c.type),
      refactor: ["refactor"],
      deps: ["deps", "chore"]
    };
    const allowedTypes = typeFilter[includeType] || [];
    filtered = commits.filter(c => allowedTypes.includes(c.type) || (includeType === "breaking" && c.breaking));
  }

  if (filtered.length === 0) {
    return { content: [{ type: "text", text: `No commits matching filter "${includeType}" between ${from} and ${toRef}` }] };
  }

  const grouped = {};
  for (const commit of filtered) {
    let key;
    if (groupBy === "type") {
      key = COMMIT_TYPE_MAP[commit.type] || commit.type;
    } else if (groupBy === "scope") {
      key = commit.scope || "general";
    } else if (groupBy === "author") {
      key = commit.author;
    } else {
      key = "other";
    }
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(commit);
  }

  let changelog = "";

  if (fmt === "markdown") {
    const breaking = filtered.filter(c => c.breaking);
    if (breaking.length > 0) {
      changelog += "## ⚠ BREAKING CHANGES\n\n";
      for (const c of breaking) {
        changelog += `- ${c.description} (${c.hash.substring(0, 7)})\n`;
      }
      changelog += "\n";
    }

    for (const [group, commits] of Object.entries(grouped)) {
      if (groupBy === "type" && group === "other") continue;
      changelog += `## ${group}\n\n`;
      for (const c of commits) {
        const scope = c.scope ? `**${c.scope}:** ` : "";
        changelog += `- ${scope}${c.description} (${c.hash.substring(0, 7)})\n`;
      }
      changelog += "\n";
    }

    changelog += `---\n**${filtered.length} commits** from ${from} to ${toRef}\n`;
  } else if (fmt === "plain") {
    for (const [group, commits] of Object.entries(grouped)) {
      changelog += `${group}:\n`;
      for (const c of commits) {
        changelog += `  - ${c.description}\n`;
      }
      changelog += "\n";
    }
  } else if (fmt === "conventional") {
    for (const c of filtered) {
      changelog += `${c.message}\n`;
    }
  }

  if (use_llm && fmt === "markdown") {
    try {
      const summaryPrompt = `Summarize these ${filtered.length} git commits in 2-3 sentences for release notes. Focus on what changed and why it matters:\n\n${filtered.map(c => `- ${c.message}`).join("\n")}`;
      const llmResult = await sidekick_llm({
        prompt: summaryPrompt,
        system: "You are a technical writer creating release notes. Be concise and focus on user-facing changes.",
        temperature: 0.3
      });
      if (llmResult.content && llmResult.content[0]) {
        changelog = `## Summary\n\n${llmResult.content[0].text}\n\n${changelog}`;
      }
    } catch (e) {
      changelog += `\n*LLM summary failed: ${e.message}*\n`;
    }
  }

  if (action === "preview" || action === "generate") {
    return { content: [{ type: "text", text: changelog }] };
  }

  if (action === "save") {
    const changelogPath = path.join(cwd, "CHANGELOG.md");
    let existingContent = "";
    try {
      existingContent = fs.readFileSync(changelogPath, "utf8");
    } catch {}

    const date = new Date().toISOString().split("T")[0];
    const header = `## ${date}\n\n`;
    const newEntry = header + changelog;

    const lines = existingContent.split("\n");
    let insertIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("# ")) {
        insertIndex = i + 1;
        while (insertIndex < lines.length && lines[insertIndex].trim() === "") insertIndex++;
        break;
      }
    }

    lines.splice(insertIndex, 0, newEntry);
    fs.writeFileSync(changelogPath, lines.join("\n"));

    return { content: [{ type: "text", text: `Changelog saved to ${changelogPath}\n\n${newEntry}` }] };
  }

  return { content: [{ type: "text", text: changelog }] };
}

const MAX_DEPEND_DEPTH = 10;
const MAX_DEPEND_RESULTS = 100;

async function sidekick_depend({ action, type, target, depth, format }) {
  const maxDepth = Math.min(depth || 5, MAX_DEPEND_DEPTH);
  const fmt = format || "tree";

  if (action === "tree") {
    if (!type) {
      return { content: [{ type: "text", text: "type required (npm, service, process)" }], isError: true };
    }

    if (type === "npm") {
      const cwd = target || process.cwd();
      try {
        const result = execFileSync("npm", ["ls", `--depth=${maxDepth}`, "--json"], {
          encoding: "utf8",
          cwd,
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const tree = JSON.parse(result);

        if (fmt === "json") {
          return { content: [{ type: "text", text: JSON.stringify(tree, null, 2) }] };
        }

        const formatNpmTree = (node, indent = 0) => {
          let output = "";
          const prefix = "  ".repeat(indent);
          if (node.name) {
            output += `${prefix}${node.name}@${node.version || "?"}\n`;
          }
          if (node.dependencies) {
            for (const [name, dep] of Object.entries(node.dependencies)) {
              output += formatNpmTree(dep, indent + 1);
            }
          }
          return output;
        };

        return { content: [{ type: "text", text: formatNpmTree(tree) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `npm ls failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "service") {
      if (!target) {
        return { content: [{ type: "text", text: "target required for service tree" }], isError: true };
      }
      try {
        const result = execFileSync("systemctl", ["list-dependencies", validIdentifier(target, "service name", 128), "--no-pager"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `systemctl failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "process") {
      const pid = target || "1";
      try {
        if (!/^\d+$/.test(String(pid))) throw new Error("Invalid PID");
        const result = execFileSync("pstree", ["-p", String(pid)], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result }] };
      } catch (e) {
        return { content: [{ type: "text", text: `pstree failed: ${e.message}` }], isError: true };
      }
    }

    return { content: [{ type: "text", text: "Unknown type. Use: npm, service, process" }], isError: true };
  }

  if (action === "reverse") {
    if (!type || !target) {
      return { content: [{ type: "text", text: "type and target required" }], isError: true };
    }

    if (type === "npm") {
      const cwd = process.cwd();
      try {
        const result = execFileSync("npm", ["ls", "--all", "--json"], {
          encoding: "utf8",
          cwd,
          timeout: 15000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const tree = JSON.parse(result);

        const findDependents = (node, targetName, path = []) => {
          const results = [];
          if (node.dependencies) {
            for (const [name, dep] of Object.entries(node.dependencies)) {
              if (name === targetName) {
                results.push([...path, node.name || "root"]);
              }
              results.push(...findDependents(dep, targetName, [...path, node.name || "root"]));
            }
          }
          return results;
        };

        const dependents = findDependents(tree, target);
        if (dependents.length === 0) {
          return { content: [{ type: "text", text: `No packages depend on ${target}` }] };
        }

        const unique = [...new Set(dependents.map(d => d.join(" → ")))];
        return { content: [{ type: "text", text: `Packages depending on ${target}:\n\n${unique.slice(0, MAX_DEPEND_RESULTS).join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `npm ls failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "service") {
      try {
        const result = execFileSync("systemctl", ["list-dependencies", "--reverse", validIdentifier(target, "service name", 128), "--no-pager"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result || `No services depend on ${target}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `systemctl failed: ${e.message}` }], isError: true };
      }
    }

    if (type === "process") {
      try {
        if (!/^\d+$/.test(String(target))) throw new Error("Invalid PID");
        const result = execFileSync("ps", ["-o", "pid,ppid,comm", "--ppid", String(target)], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        return { content: [{ type: "text", text: result || `No child processes for PID ${target}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `ps failed: ${e.message}` }], isError: true };
      }
    }

    return { content: [{ type: "text", text: "Unknown type. Use: npm, service, process" }], isError: true };
  }

  if (action === "outdated") {
    if (type !== "npm") {
      return { content: [{ type: "text", text: "outdated only supported for npm" }], isError: true };
    }
    const cwd = target || process.cwd();
    try {
      const result = execFileSync("npm", ["outdated", "--json"], {
        encoding: "utf8",
        cwd,
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const outdated = JSON.parse(result);
      if (Object.keys(outdated).length === 0) {
        return { content: [{ type: "text", text: "All packages are up to date" }] };
      }
      const list = Object.entries(outdated).map(([name, info]) =>
        `${name}: ${info.current || "?"} → ${info.latest} (wanted: ${info.wanted || "?"})`
      ).join("\n");
      return { content: [{ type: "text", text: `Outdated packages:\n\n${list}` }] };
    } catch (e) {
      if (e.stdout) {
        try {
          const outdated = JSON.parse(e.stdout);
          const list = Object.entries(outdated).map(([name, info]) =>
            `${name}: ${info.current || "?"} → ${info.latest} (wanted: ${info.wanted || "?"})`
          ).join("\n");
          return { content: [{ type: "text", text: `Outdated packages:\n\n${list}` }] };
        } catch {}
      }
      return { content: [{ type: "text", text: `npm outdated failed: ${e.message}` }], isError: true };
    }
  }

  if (action === "impact") {
    if (!type || !target) {
      return { content: [{ type: "text", text: "type and target required" }], isError: true };
    }

    let impact = `Impact analysis for removing ${target}:\n\n`;

    if (type === "npm") {
      try {
        const result = execFileSync("npm", ["ls", "--all", "--json"], {
          encoding: "utf8",
          cwd: process.cwd(),
          timeout: 15000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        const tree = JSON.parse(result);

        const findDependents = (node, targetName) => {
          const results = [];
          if (node.dependencies) {
            for (const [name, dep] of Object.entries(node.dependencies)) {
              if (name === targetName) {
                results.push(node.name || "root");
              }
              results.push(...findDependents(dep, targetName));
            }
          }
          return results;
        };

        const dependents = findDependents(tree, target);
        if (dependents.length === 0) {
          impact += "No packages depend on this. Safe to remove.";
        } else {
          const unique = [...new Set(dependents)];
          impact += `WARNING: ${unique.length} package(s) depend on this:\n`;
          impact += unique.slice(0, 20).map(d => `  - ${d}`).join("\n");
          if (unique.length > 20) impact += `\n  ... and ${unique.length - 20} more`;
        }
      } catch (e) {
        impact += `Analysis failed: ${e.message}`;
      }
    } else if (type === "service") {
      try {
        const result = execFileSync("systemctl", ["list-dependencies", "--reverse", validIdentifier(target, "service name", 128), "--no-pager"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });
        if (result.trim()) {
          impact += `WARNING: The following services depend on ${target}:\n${result}`;
        } else {
          impact += "No services depend on this. Safe to remove.";
        }
      } catch (e) {
        impact += `Analysis failed: ${e.message}`;
      }
    } else {
      impact += "Impact analysis not supported for this type";
    }

    return { content: [{ type: "text", text: impact }] };
  }

  if (action === "orphans") {
    if (type !== "npm") {
      return { content: [{ type: "text", text: "orphans only supported for npm" }], isError: true };
    }
    const cwd = target || process.cwd();
    try {
      const pkgPath = path.join(cwd, "package.json");
      if (!fs.existsSync(pkgPath)) {
        return { content: [{ type: "text", text: "No package.json found" }], isError: true };
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const declared = Object.keys(pkg.dependencies || {});

      const result = execFileSync("npm", ["ls", "--depth=0", "--json"], {
        encoding: "utf8",
        cwd,
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const tree = JSON.parse(result);
      const installed = Object.keys(tree.dependencies || {});

      const orphans = installed.filter(dep => !declared.includes(dep));
      if (orphans.length === 0) {
        return { content: [{ type: "text", text: "No orphaned dependencies found" }] };
      }
      return { content: [{ type: "text", text: `Orphaned dependencies (installed but not in package.json):\n\n${orphans.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Analysis failed: ${e.message}` }], isError: true };
    }
  }

  return { content: [{ type: "text", text: "Unknown action. Use: tree, reverse, outdated, impact, orphans" }], isError: true };
}

const SCHEMAS = {
  git: z.object({
    action: z.enum(["status", "diff", "log", "show", "ls-tree", "ls-files", "add", "commit", "push", "pull", "branch", "checkout", "stash"]).describe("Git action to perform"),
    path: z.string().optional().describe("Repository path (defaults to current directory)"),
    args: z.string().optional().describe("Additional arguments for the git command")
  }),
  changelog: z.object({
    action: z.enum(["generate", "preview", "save"]),
    from: z.string().describe("Starting ref (tag, commit, branch)"),
    to: z.string().optional().default("HEAD"),
    format: z.enum(["markdown", "plain", "conventional"]).optional().default("markdown"),
    group_by: z.enum(["type", "scope", "author"]).optional().default("type"),
    use_llm: z.boolean().optional().default(false),
    include: z.enum(["all", "features", "fixes", "breaking", "refactor", "deps"]).optional().default("all"),
    path: z.string().optional().describe("Git repository path (default: current directory)")
  }),
  depend: z.object({
    action: z.enum(["tree", "reverse", "outdated", "impact", "orphans"]),
    type: z.enum(["npm", "service", "process"]),
    target: z.string().optional().describe("Package, service, or PID to analyze"),
    depth: z.number().optional().default(5),
    format: z.enum(["tree", "flat", "json"]).optional().default("tree")
  }),
};

const descriptors = Object.freeze([
  Object.freeze({
    name: "git",
    description: "Structured git operations (status, diff, log, read-only show/ls-tree, add, commit, push, pull, branch, checkout, stash)",
    schema: SCHEMAS.git,
    args: { action: "string", path: "string (optional)", args: "string (optional)" },
    risk: "medium",
    category: "Git & GitHub",
    source: "builtin",
    family: "development",
    handler: sidekick_git,
  }),
  Object.freeze({
    name: "changelog",
    description: "Generate human-readable changelogs from git history. Groups commits semantically and optionally uses LLM for summaries.",
    schema: SCHEMAS.changelog,
    args: { action: "string (generate|preview|save)", from: "string (starting ref: tag, commit, branch)", to: "string (optional, ending ref - default HEAD)", format: "string (optional, markdown|plain|conventional - default markdown)", group_by: "string (optional, type|scope|author - default type)", use_llm: "boolean (optional, generate LLM summary - default false)", include: "string (optional, all|features|fixes|breaking|refactor|deps - default all)", path: "string (optional, git repository path - default current directory)" },
    risk: "medium",
    category: "Development",
    source: "builtin",
    family: "development",
    handler: sidekick_changelog,
  }),
  Object.freeze({
    name: "depend",
    description: "Dependency analyzer for npm packages, systemd services, and processes. Shows dependency trees, reverse dependencies, and impact analysis.",
    schema: SCHEMAS.depend,
    args: { action: "string (tree|reverse|outdated|impact|orphans)", type: "string (npm|service|process)", target: "string (optional, package, service, or PID)", depth: "number (optional, tree depth - default 5)", format: "string (optional, tree|flat|json - default tree)" },
    risk: "medium",
    category: "Development",
    source: "builtin",
    family: "development",
    handler: sidekick_depend,
  }),
]);

module.exports = { descriptors, sidekick_git, sidekick_changelog, sidekick_depend, parseGitExtraArgs };
