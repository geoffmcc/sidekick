"use strict";

/**
 * Deterministic software-project detection.
 *
 * Everything here is MECHANICAL: it reads manifests, lockfiles, scripts and
 * config files and reports what it actually found. Nothing is inferred by a
 * language model, and nothing is guessed — a fact that cannot be established
 * from files on disk is reported as absent rather than invented. That is what
 * makes the profile usable as evidence.
 */

const path = require("path");
const { exists, isDirectory, readJsonFile, readTextFile, presentFiles, listUnder } = require("./fsutil");

const EXTENSION_LANGUAGES = Object.freeze({
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript",
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".py": "Python", ".pyi": "Python",
  ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".php": "PHP",
  ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin", ".scala": "Scala",
  ".cs": "C#", ".fs": "F#",
  ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".hpp": "C++", ".cxx": "C++",
  ".swift": "Swift", ".m": "Objective-C",
  ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell", ".ps1": "PowerShell",
  ".sql": "SQL", ".tf": "Terraform", ".lua": "Lua", ".dart": "Dart", ".ex": "Elixir", ".exs": "Elixir",
  ".vue": "Vue", ".svelte": "Svelte",
});

const ECOSYSTEM_MANIFESTS = Object.freeze([
  { file: "package.json", ecosystem: "node", language: "JavaScript/TypeScript" },
  { file: "pyproject.toml", ecosystem: "python", language: "Python" },
  { file: "setup.py", ecosystem: "python", language: "Python" },
  { file: "requirements.txt", ecosystem: "python", language: "Python" },
  { file: "go.mod", ecosystem: "go", language: "Go" },
  { file: "Cargo.toml", ecosystem: "rust", language: "Rust" },
  { file: "Gemfile", ecosystem: "ruby", language: "Ruby" },
  { file: "composer.json", ecosystem: "php", language: "PHP" },
  { file: "pom.xml", ecosystem: "maven", language: "Java" },
  { file: "build.gradle", ecosystem: "gradle", language: "Java/Kotlin" },
  { file: "build.gradle.kts", ecosystem: "gradle", language: "Kotlin" },
  { file: "mix.exs", ecosystem: "elixir", language: "Elixir" },
  { file: "pubspec.yaml", ecosystem: "dart", language: "Dart" },
  { file: "CMakeLists.txt", ecosystem: "cmake", language: "C/C++" },
]);

const PACKAGE_MANAGER_LOCKFILES = Object.freeze([
  { file: "package-lock.json", manager: "npm", install: "npm ci" },
  { file: "pnpm-lock.yaml", manager: "pnpm", install: "pnpm install --frozen-lockfile" },
  { file: "yarn.lock", manager: "yarn", install: "yarn install --frozen-lockfile" },
  { file: "bun.lockb", manager: "bun", install: "bun install" },
  { file: "poetry.lock", manager: "poetry", install: "poetry install" },
  { file: "uv.lock", manager: "uv", install: "uv sync" },
  { file: "Pipfile.lock", manager: "pipenv", install: "pipenv install --deploy" },
  { file: "Cargo.lock", manager: "cargo", install: "cargo fetch" },
  { file: "go.sum", manager: "go modules", install: "go mod download" },
  { file: "Gemfile.lock", manager: "bundler", install: "bundle install" },
  { file: "composer.lock", manager: "composer", install: "composer install" },
]);

const INSTRUCTION_FILES = Object.freeze([
  "AGENTS.md", "CLAUDE.md", "CONVENTIONS.md", ".cursorrules", ".windsurfrules",
  ".github/copilot-instructions.md", "CONTRIBUTING.md", "CODEOWNERS", ".github/CODEOWNERS",
]);

const DOC_FILES = Object.freeze([
  "README.md", "README.rst", "README.txt", "CHANGELOG.md", "ROADMAP.md",
  "ARCHITECTURE.md", "SECURITY.md", "MIGRATION.md", "CONTEXT.md",
]);

const CONTAINER_FILES = Object.freeze([
  "Dockerfile", "Containerfile", "docker-compose.yml", "docker-compose.yaml",
  "compose.yml", "compose.yaml", ".dockerignore",
]);

const MIGRATION_DIRECTORIES = Object.freeze([
  "migrations", "db/migrate", "prisma/migrations", "alembic/versions",
  "src/migrations", "database/migrations", "priv/repo/migrations",
]);

const SCRIPT_INTENTS = Object.freeze({
  test: [/^test$/, /^tests?$/, /^test:.*/, /^spec$/, /^jest$/, /^vitest$/, /^mocha$/],
  lint: [/^lint$/, /^lint:.*/, /^eslint$/, /^ruff$/, /^flake8$/, /^format:check$/],
  typecheck: [/^typecheck$/, /^type-check$/, /^tsc$/, /^types$/, /^check-types$/, /^mypy$/],
  build: [/^build$/, /^build:.*/, /^compile$/, /^bundle$/],
});

function classifyScripts(scripts = {}) {
  const classified = { test: [], lint: [], typecheck: [], build: [], other: [] };
  for (const [name, command] of Object.entries(scripts)) {
    let matched = false;
    for (const [intent, patterns] of Object.entries(SCRIPT_INTENTS)) {
      if (patterns.some(pattern => pattern.test(name))) {
        classified[intent].push({ script: name, command });
        matched = true;
        break;
      }
    }
    if (!matched) classified.other.push({ script: name, command });
  }
  return classified;
}

function detectLanguages(files) {
  const counts = new Map();
  for (const file of files) {
    const language = EXTENSION_LANGUAGES[path.extname(file).toLowerCase()];
    if (!language) continue;
    counts.set(language, (counts.get(language) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([language, file_count]) => ({ language, file_count }));
}

function detectEcosystems(root) {
  const found = [];
  for (const candidate of ECOSYSTEM_MANIFESTS) {
    if (exists(path.join(root, candidate.file))) {
      found.push({ ecosystem: candidate.ecosystem, manifest: candidate.file, language: candidate.language });
    }
  }
  return found;
}

function detectPackageManagers(root) {
  const found = [];
  for (const candidate of PACKAGE_MANAGER_LOCKFILES) {
    if (exists(path.join(root, candidate.file))) {
      found.push({ manager: candidate.manager, lockfile: candidate.file, install_command: candidate.install });
    }
  }
  return found;
}

function detectWorkspaces(root) {
  const workspaces = { monorepo: false, kind: null, packages: [] };
  const pkg = readJsonFile(path.join(root, "package.json"));
  if (pkg && pkg.workspaces) {
    workspaces.monorepo = true;
    workspaces.kind = "npm-workspaces";
    workspaces.packages = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [];
  }
  if (exists(path.join(root, "pnpm-workspace.yaml"))) {
    workspaces.monorepo = true;
    workspaces.kind = workspaces.kind || "pnpm-workspaces";
  }
  if (exists(path.join(root, "lerna.json"))) {
    workspaces.monorepo = true;
    workspaces.kind = workspaces.kind || "lerna";
  }
  if (exists(path.join(root, "turbo.json"))) {
    workspaces.monorepo = true;
    workspaces.kind = workspaces.kind || "turborepo";
  }
  if (exists(path.join(root, "nx.json"))) {
    workspaces.monorepo = true;
    workspaces.kind = workspaces.kind || "nx";
  }
  if (exists(path.join(root, "go.work"))) {
    workspaces.monorepo = true;
    workspaces.kind = workspaces.kind || "go-workspace";
  }
  const cargo = readTextFile(path.join(root, "Cargo.toml"));
  if (cargo && /^\s*\[workspace\]/m.test(cargo)) {
    workspaces.monorepo = true;
    workspaces.kind = workspaces.kind || "cargo-workspace";
  }
  return workspaces;
}

function detectCi(root) {
  const configs = [];
  configs.push(...listUnder(root, ".github/workflows", { filter: name => /\.(ya?ml)$/i.test(name), limit: 30 }));
  for (const candidate of [".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml", ".travis.yml", "cloudbuild.yaml", ".drone.yml"]) {
    if (exists(path.join(root, candidate))) configs.push(candidate);
  }
  if (isDirectory(path.join(root, ".circleci"))) configs.push(...listUnder(root, ".circleci", { limit: 5 }));
  const provider = configs.some(c => c.startsWith(".github/"))
    ? "github-actions"
    : configs.includes(".gitlab-ci.yml")
      ? "gitlab-ci"
      : configs.length ? "other" : null;
  return { provider, configs };
}

function detectMigrations(root) {
  const directories = MIGRATION_DIRECTORIES.filter(candidate => isDirectory(path.join(root, candidate)));
  const files = [];
  for (const directory of directories) {
    files.push(...listUnder(root, directory, { limit: 200 }));
  }
  return { directories, count: files.length, latest: files.slice(-5) };
}

/**
 * Candidate verification commands, derived from what is actually present.
 *
 * Each candidate carries the EVIDENCE that produced it, so a caller can see
 * why a command was proposed. Nothing is proposed for an ecosystem whose
 * marker files are absent.
 */
function verificationCandidates(root, { scripts, packageManagers, ecosystems }) {
  const candidates = [];
  const runner = packageManagers.find(manager => ["npm", "pnpm", "yarn", "bun"].includes(manager.manager));
  const runPrefix = runner ? ({ npm: "npm run", pnpm: "pnpm run", yarn: "yarn", bun: "bun run" })[runner.manager] : "npm run";

  for (const intent of ["lint", "typecheck", "test", "build"]) {
    for (const entry of scripts[intent] || []) {
      candidates.push({
        intent,
        command: `${runPrefix} ${entry.script}`,
        source: "package.json scripts",
        evidence: `scripts.${entry.script} = ${entry.command}`,
      });
    }
  }

  const has = ecosystem => ecosystems.some(entry => entry.ecosystem === ecosystem);
  if (has("go")) {
    candidates.push({ intent: "test", command: "go test ./...", source: "ecosystem", evidence: "go.mod present" });
    candidates.push({ intent: "build", command: "go build ./...", source: "ecosystem", evidence: "go.mod present" });
    candidates.push({ intent: "lint", command: "go vet ./...", source: "ecosystem", evidence: "go.mod present" });
  }
  if (has("rust")) {
    candidates.push({ intent: "test", command: "cargo test", source: "ecosystem", evidence: "Cargo.toml present" });
    candidates.push({ intent: "build", command: "cargo build", source: "ecosystem", evidence: "Cargo.toml present" });
    if (exists(path.join(root, "clippy.toml"))) {
      candidates.push({ intent: "lint", command: "cargo clippy", source: "ecosystem", evidence: "clippy.toml present" });
    }
  }
  if (has("python")) {
    if (exists(path.join(root, "pytest.ini")) || exists(path.join(root, "tests")) || /\[tool\.pytest/.test(readTextFile(path.join(root, "pyproject.toml")) || "")) {
      candidates.push({ intent: "test", command: "pytest", source: "ecosystem", evidence: "pytest configuration or tests/ present" });
    }
    if (exists(path.join(root, "ruff.toml")) || /\[tool\.ruff/.test(readTextFile(path.join(root, "pyproject.toml")) || "")) {
      candidates.push({ intent: "lint", command: "ruff check .", source: "ecosystem", evidence: "ruff configuration present" });
    }
    if (exists(path.join(root, "mypy.ini")) || /\[tool\.mypy/.test(readTextFile(path.join(root, "pyproject.toml")) || "")) {
      candidates.push({ intent: "typecheck", command: "mypy .", source: "ecosystem", evidence: "mypy configuration present" });
    }
  }
  if (exists(path.join(root, "tsconfig.json")) && !(scripts.typecheck || []).length) {
    // `--no-install` matters: without it npx will DOWNLOAD and run a package
    // that is not part of the project. A verification command must never
    // install anything, and must never reach the network to decide whether a
    // project typechecks.
    candidates.push({ intent: "typecheck", command: "npx --no-install tsc --noEmit", source: "ecosystem", evidence: "tsconfig.json present, no typecheck script" });
  }
  if (has("maven")) candidates.push({ intent: "test", command: "mvn -q test", source: "ecosystem", evidence: "pom.xml present" });
  if (has("gradle")) candidates.push({ intent: "test", command: "./gradlew test", source: "ecosystem", evidence: "gradle build file present" });
  if (has("ruby") && isDirectory(path.join(root, "spec"))) {
    candidates.push({ intent: "test", command: "bundle exec rspec", source: "ecosystem", evidence: "Gemfile and spec/ present" });
  }

  // Deduplicate on (intent, command), first evidence wins.
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = `${candidate.intent}::${candidate.command}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  EXTENSION_LANGUAGES,
  INSTRUCTION_FILES,
  DOC_FILES,
  CONTAINER_FILES,
  classifyScripts,
  detectLanguages,
  detectEcosystems,
  detectPackageManagers,
  detectWorkspaces,
  detectCi,
  detectMigrations,
  verificationCandidates,
  presentFiles,
};
