// Developer / Software Engineering pack: the pack's actual behaviour against
// REAL git repositories.
//
// Two targets are used deliberately:
//   - the Sidekick repository itself, for profiling a large real project;
//   - a purpose-built temporary repository with a known change set, so the
//     change analysis can be asserted exactly rather than approximately.
//
// Nothing about the Developer pack is mocked here. The tools run through the
// real dispatcher, the git reads go through the real git tool, and dev_verify
// executes a real command through the real bash tool.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-developer-pack');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_DB_FILE = path.join(TEST_DATA_DIR, 'sidekick.db');
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'developer-pack-test-secret-key';

require('../src/db').runPendingMigrations();

const bundled = require('../src/packs/bundled');
const packLifecycle = require('../src/packs/lifecycle');
const { callInternalTool } = require('../src/tools/dispatcher');
const { callAgentTool, getBuiltinRegistry } = require('../src/tools');
const { discoverCapabilities, resolveContextProviderArgs } = require('../src/agent/capability-broker');
const platformKernel = require('../src/platform/kernel');

const SIDEKICK_ROOT = path.resolve(__dirname, '..');
const FIXTURE_REPO = path.join(TEST_DATA_DIR, 'fixture-repo');

let failures = 0;
async function test(label, fn) {
  try {
    await fn();
    console.log(`Passed: ${label}`);
  } catch (error) {
    failures++;
    console.error(`FAILED: ${label}\n  ${error && error.stack ? error.stack : error}`);
  }
}

function json(result) {
  return JSON.parse(result.content[0].text);
}

function git(args, cwd = FIXTURE_REPO) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * A small but realistic Node repository with a committed baseline and an
 * uncommitted change set that exercises every classification the change
 * analysis makes: source, tests, docs, config, migration and dependency.
 */
function buildFixtureRepository() {
  fs.mkdirSync(path.join(FIXTURE_REPO, 'src'), { recursive: true });
  fs.mkdirSync(path.join(FIXTURE_REPO, 'test'), { recursive: true });
  fs.mkdirSync(path.join(FIXTURE_REPO, 'migrations'), { recursive: true });
  fs.mkdirSync(path.join(FIXTURE_REPO, '.github', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(FIXTURE_REPO, 'scripts'), { recursive: true });

  fs.writeFileSync(path.join(FIXTURE_REPO, 'package.json'), JSON.stringify({
    name: 'fixture-project',
    version: '1.0.0',
    scripts: {
      test: 'node test/run.js',
      lint: 'node scripts/lint.js',
      typecheck: 'node scripts/typecheck.js',
      build: 'node scripts/build.js',
    },
    dependencies: { 'left-pad': '1.2.0' },
  }, null, 2));
  fs.writeFileSync(path.join(FIXTURE_REPO, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }, null, 2));
  fs.writeFileSync(path.join(FIXTURE_REPO, 'README.md'), '# Fixture project\n');
  fs.writeFileSync(path.join(FIXTURE_REPO, 'AGENTS.md'), '# Fixture agent instructions\n');
  for (const script of ['lint', 'typecheck', 'build']) {
    fs.writeFileSync(path.join(FIXTURE_REPO, 'scripts', `${script}.js`), 'process.exit(0);\n');
  }
  fs.writeFileSync(path.join(FIXTURE_REPO, '.github', 'workflows', 'ci.yml'), 'name: ci\non: [push]\n');
  fs.writeFileSync(path.join(FIXTURE_REPO, 'src', 'auth.js'), 'function login(user) { return Boolean(user); }\nmodule.exports = { login };\n');
  fs.writeFileSync(path.join(FIXTURE_REPO, 'test', 'run.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(FIXTURE_REPO, 'migrations', '001_init.sql'), 'CREATE TABLE thing (id INTEGER);\n');

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'Fixture Author']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'chore: fixture baseline']);

  // The change set under analysis: an added export, a removed export, a new
  // test, a doc change, a new migration and a dependency bump.
  fs.writeFileSync(
    path.join(FIXTURE_REPO, 'src', 'auth.js'),
    'function login(user) { return Boolean(user && user.id); }\nfunction logout() { return true; }\nmodule.exports = { login, logout };\nexport function verifyToken(token) { return token.length > 0; }\n'
  );
  fs.writeFileSync(path.join(FIXTURE_REPO, 'test', 'auth.test.js'), "require('../src/auth');\n");
  fs.appendFileSync(path.join(FIXTURE_REPO, 'README.md'), '\nUpdated docs.\n');
  fs.writeFileSync(path.join(FIXTURE_REPO, 'migrations', '002_add_column.sql'), 'INSERT INTO thing (id) VALUES (1);\n');
  const pkg = JSON.parse(fs.readFileSync(path.join(FIXTURE_REPO, 'package.json'), 'utf-8'));
  pkg.dependencies['left-pad'] = '1.3.0';
  fs.writeFileSync(path.join(FIXTURE_REPO, 'package.json'), JSON.stringify(pkg, null, 2));
  // Staged so `git diff` sees the new files too.
  git(['add', '-A']);
}

(async () => {
  console.log('Running Developer pack tests...\n');

  bundled.installBundledPack('developer', { enable: true });
  const health = packLifecycle.health('developer');
  assert.strictEqual(health.status, 'healthy', 'Developer pack must be healthy before its tools are exercised');
  buildFixtureRepository();

  // --- DP.1 dev_repo_profile against the real Sidekick repository ----------
  await test('DP.1: dev_repo_profile returns meaningful information about the real Sidekick repository', async () => {
    const result = await callInternalTool('dev_repo_profile', { path: SIDEKICK_ROOT });
    assert.strictEqual(result.isError, undefined, result.content[0].text.slice(0, 500));
    const profile = json(result);

    assert.strictEqual(profile.repository.path, SIDEKICK_ROOT);
    assert.strictEqual(profile.repository.is_git_repository, true);
    assert.ok(profile.repository.branch, 'a branch is reported');
    assert.match(profile.repository.head.sha, /^[0-9a-f]{40}$/);
    assert.ok(profile.repository.head.subject, 'HEAD subject is reported');
    // Clone depth is environment-dependent: CI checks out with depth 1, so the
    // assertion is on the SHAPE and correctness of the history, not on how much
    // of it this particular checkout happens to have.
    assert.ok(Array.isArray(profile.repository.recent_commits) && profile.repository.recent_commits.length >= 1, 'recent history is collected');
    assert.strictEqual(profile.repository.recent_commits[0].sha, profile.repository.head.sha, 'history starts at HEAD');
    for (const commit of profile.repository.recent_commits) {
      assert.match(commit.sha, /^[0-9a-f]{40}$/, 'each commit has a full sha');
      assert.ok(commit.subject && commit.author && commit.date, `commit ${commit.sha} should be fully parsed`);
    }
    assert.strictEqual(typeof profile.repository.working_tree.clean, 'boolean');

    // Mechanically detected facts about THIS repository.
    assert.ok(profile.languages.some(entry => entry.language === 'JavaScript' && entry.file_count > 50), JSON.stringify(profile.languages));
    assert.deepStrictEqual(profile.ecosystems.map(e => e.ecosystem), ['node']);
    assert.deepStrictEqual(profile.package_managers.map(m => m.manager), ['npm']);
    assert.strictEqual(profile.package_managers[0].install_command, 'npm ci');
    assert.strictEqual(profile.ci.provider, 'github-actions');
    assert.ok(profile.ci.configs.includes('.github/workflows/ci.yml'));
    assert.ok(profile.migrations.directories.includes('migrations'));
    assert.ok(profile.migrations.count >= 36, `expected the migration set, got ${profile.migrations.count}`);
    assert.ok(profile.instruction_files.includes('AGENTS.md'), 'the repository instruction file is surfaced');
    assert.ok(profile.documentation.includes('README.md'));
    assert.ok(profile.structure.top_level_directories.includes('src'));
    assert.ok(profile.structure.top_level_directories.includes('packs'));
    assert.strictEqual(profile.structure.workspaces.monorepo, false);
    assert.strictEqual(profile.semantic.available, true);
    assert.match(profile.semantic.schema, /^sidekick\.semantic-ir\.v1$/);
    assert.match(profile.semantic.index_root_hash, /^[0-9a-f]{64}$/);
    assert.ok(profile.semantic.languages.includes('javascript'));
    assert.ok(profile.semantic.stats.symbols > 0);

    // The verification path is stated WITH its evidence, and nothing is invented.
    assert.strictEqual(profile.verification.likely_commands.test, 'npm run test');
    assert.strictEqual(profile.verification.likely_commands.lint, null, 'Sidekick defines no lint script, so none is claimed');
    assert.strictEqual(profile.verification.likely_commands.typecheck, null);
    const testCandidate = profile.verification.candidates.find(c => c.command === 'npm run test');
    assert.strictEqual(testCandidate.source, 'package.json scripts');
    assert.match(testCandidate.evidence, /scripts\.test = node test\/run-all\.js/);
  });

  await test('DP.1b: generic Agent semantic context propagates the requested repository scope', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-agent-scope-'));
    const repoA = path.join(root, 'repo-a');
    const repoB = path.join(root, 'repo-b');
    fs.mkdirSync(repoA); fs.mkdirSync(repoB);
    try {
      fs.writeFileSync(path.join(repoA, 'alpha.ts'), "export function AlphaOnlySymbol() { return 'a'; }\n");
      fs.writeFileSync(path.join(repoB, 'beta.ts'), "export function BetaOnlySymbol() { return 'b'; }\n");
      const request = `Profile this repository at "${repoB}"`;
      const liveSemantic = getBuiltinRegistry().get('semantic_repo');
      assert.ok(liveSemantic, 'semantic_repo must be present in the canonical live registry');
      const selected = discoverCapabilities(request, [{ ...liveSemantic, enabled: true }], { limit: 1 }).find(tool => tool.contextProvider);
      assert.ok(selected, 'generic capability discovery selects a context provider');
      const providerArgs = resolveContextProviderArgs(selected.contextProvider, request);
      assert.strictEqual(providerArgs.path, repoB, 'the explicit repository path is propagated by provider metadata');
      const result = await callAgentTool(selected.contextProvider.tool, { ...providerArgs, query: 'Profile this repository', level: 1, limit: 20, max_chars: 6000 }, { source: selected.contextProvider.source, timeoutMs: 30000 });
      assert.ok(!result.isError, result.content?.[0]?.text || 'semantic context dispatch failed');
      const text = result.content?.[0]?.text || '';
      assert.ok(text.includes('BetaOnlySymbol'), 'semantic context contains the requested repository symbol');
      assert.ok(!text.includes('AlphaOnlySymbol'), 'semantic context excludes the other repository symbol');
      const defaultArgs = resolveContextProviderArgs(selected.contextProvider, 'Profile this repository');
      assert.strictEqual(Object.prototype.hasOwnProperty.call(defaultArgs, 'path'), false, 'no explicit path preserves current-repository default behavior');
      const current = await callAgentTool(selected.contextProvider.tool, { ...defaultArgs, query: 'Profile this repository', limit: 2, max_chars: 2000 }, { source: selected.contextProvider.source, timeoutMs: 30000 });
      assert.ok(!current.isError, current.content?.[0]?.text || 'default current-repository profiling failed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // --- DP.2 dev_repo_profile against the fixture repository ----------------
  await test('DP.2: dev_repo_profile detects the fixture project structure', async () => {
    const profile = json(await callInternalTool('dev_repo_profile', { path: FIXTURE_REPO }));
    assert.strictEqual(profile.repository.branch, 'main');
    assert.deepStrictEqual(profile.scripts.test.map(s => s.script), ['test']);
    assert.deepStrictEqual(profile.scripts.lint.map(s => s.script), ['lint']);
    assert.deepStrictEqual(profile.scripts.build.map(s => s.script), ['build']);
    assert.strictEqual(profile.verification.likely_commands.lint, 'npm run lint');
    assert.strictEqual(profile.verification.likely_commands.build, 'npm run build');
    assert.strictEqual(profile.verification.likely_commands.typecheck, 'npm run typecheck');
    assert.ok(profile.instruction_files.includes('AGENTS.md'));
    assert.strictEqual(profile.ci.provider, 'github-actions');
    assert.strictEqual(profile.migrations.count, 2);
  });

  await test('DP.2b: a tsconfig.json with no typecheck script yields a non-installing ecosystem default', async () => {
    const tsProject = path.join(TEST_DATA_DIR, 'ts-project');
    fs.mkdirSync(tsProject, { recursive: true });
    fs.writeFileSync(path.join(tsProject, 'package.json'), JSON.stringify({ name: 'ts-project', version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(tsProject, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }, null, 2));
    const profile = json(await callInternalTool('dev_repo_profile', { path: tsProject }));
    assert.strictEqual(
      profile.verification.likely_commands.typecheck,
      'npx --no-install tsc --noEmit',
      'the ecosystem default must never be allowed to install a package from the network'
    );
  });

  // --- DP.3 dev_change_summary against a known change set ------------------
  await test('DP.3: dev_change_summary analyzes a real change set with exact classification', async () => {
    const result = await callInternalTool('dev_change_summary', { path: FIXTURE_REPO, staged: true });
    assert.strictEqual(result.isError, undefined, result.content[0].text.slice(0, 500));
    const summary = json(result);

    // src/auth.js, test/auth.test.js, README.md, migrations/002_add_column.sql, package.json
    assert.strictEqual(summary.totals.files, 5, JSON.stringify(summary.by_kind));
    assert.ok(summary.totals.insertions > 0 && summary.totals.deletions > 0);

    // The analysis pins WHAT was analyzed: commit, branch and tree state.
    assert.strictEqual(summary.git_state.head_sha, git(['rev-parse', 'HEAD']).trim());
    assert.strictEqual(summary.git_state.branch, 'main');
    assert.strictEqual(summary.git_state.worktree_clean, false, 'the fixture change set is pending');
    assert.ok(summary.git_state.changed_file_count >= 5, `changed files pinned, got ${summary.git_state.changed_file_count}`);
    assert.strictEqual(summary.scope.base_sha, null, 'no base was requested, so none is invented');

    assert.strictEqual(summary.by_kind.source.count, 1, 'src/auth.js');
    assert.strictEqual(summary.by_kind.test.count, 1, 'test/auth.test.js');
    assert.strictEqual(summary.by_kind.documentation.count, 1, 'README.md');
    assert.strictEqual(summary.by_kind.migration.count, 1, 'migrations/002_add_column.sql');
    assert.strictEqual(summary.by_kind.dependency.count, 1, 'package.json');
    assert.ok(summary.by_kind.source.files.includes('src/auth.js'));

    // API surface: an added export and a removed one, with the symbols named.
    assert.strictEqual(summary.api_surface.detected, true);
    assert.ok(summary.api_surface.added_symbols.includes('logout'), JSON.stringify(summary.api_surface));
    assert.ok(summary.api_surface.added_symbols.includes('verifyToken'));

    // Dependency movement is detected with both versions.
    assert.strictEqual(summary.dependencies.detected, true);
    const leftPad = summary.dependencies.entries.find(entry => entry.name === 'left-pad');
    assert.ok(leftPad, JSON.stringify(summary.dependencies.entries));
    assert.strictEqual(leftPad.from, '1.2.0');
    assert.strictEqual(leftPad.to, '1.3.0');
    assert.strictEqual(leftPad.change, 'updated');

    // Coverage signals and risks, each carrying evidence.
    assert.strictEqual(summary.verification.source_files_changed, 1);
    assert.strictEqual(summary.verification.test_files_changed, 1);
    assert.strictEqual(summary.verification.tests_accompany_source, true);
    assert.strictEqual(summary.verification.documentation_changed, true);

    const risks = Object.fromEntries(summary.risks.map(risk => [risk.risk, risk]));
    assert.ok(risks.schema_migration, 'a migration is flagged high risk');
    assert.strictEqual(risks.schema_migration.severity, 'high');
    assert.ok(risks.schema_migration.evidence.includes('migrations/002_add_column.sql'));
    assert.ok(risks.dependency_change, 'the dependency change is flagged');
    assert.ok(risks.security_sensitive_paths, 'src/auth.js is a security-sensitive path');
    assert.strictEqual(summary.risk_level, 'high');

    // The raw evidence the analysis was computed from stays available.
    assert.strictEqual(summary.evidence.files.length, 5);
    assert.ok(summary.evidence.diff_bytes_analyzed > 0);
    assert.ok(Array.isArray(summary.semantic_changes));
    assert.match(summary.semantic_index_root_hash, /^[0-9a-f]{64}$/);
    assert.strictEqual(summary.semantic_comparison.after.kind, 'staged_index', 'staged semantic comparison must index the staged state, not unstaged bytes');
  });

  await test('DP.4: dev_change_summary reports untracked files, which no diff can show', async () => {
    fs.writeFileSync(path.join(FIXTURE_REPO, 'src', 'brand-new.js'), 'module.exports = {};\n');
    const summary = json(await callInternalTool('dev_change_summary', { path: FIXTURE_REPO, staged: true }));
    assert.strictEqual(summary.untracked.count, 1);
    assert.ok(summary.untracked.files.includes('src/brand-new.js'));
    assert.match(summary.untracked.note, /NOT part of the analyzed diff/);
    fs.rmSync(path.join(FIXTURE_REPO, 'src', 'brand-new.js'));
  });

  await test('DP.4b: dev_change_summary resolves the base ref to its exact commit sha', async () => {
    // "diff against HEAD" is only reproducible as "diff against <sha>": the
    // scope must carry both the literal ref and the sha it resolved to.
    const summary = json(await callInternalTool('dev_change_summary', { path: FIXTURE_REPO, base: 'HEAD' }));
    assert.strictEqual(summary.scope.base, 'HEAD');
    assert.strictEqual(summary.scope.base_sha, git(['rev-parse', 'HEAD']).trim());
    assert.deepStrictEqual(summary.semantic_comparison.before, { kind: 'git_revision', sha: summary.scope.base_sha });
    assert.strictEqual(summary.semantic_comparison.after.kind, 'working_tree');
    const bogus = json(await callInternalTool('dev_change_summary', { path: FIXTURE_REPO, base: 'HEAD~0' }));
    assert.strictEqual(bogus.scope.base_sha, git(['rev-parse', 'HEAD']).trim(), 'any committish resolves');
  });

  // --- DP.5 dev_verify executes real commands ------------------------------
  await test('DP.5: dev_verify selects and executes real commands, reporting the evidence', async () => {
    const result = await callInternalTool('dev_verify', { path: FIXTURE_REPO, intents: ['test'] });
    const report = json(result);
    assert.strictEqual(report.verdict, 'passed', JSON.stringify(report.summary));
    const testCommand = report.commands.find(entry => entry.intent === 'test');
    assert.strictEqual(testCommand.status, 'passed');
    assert.strictEqual(testCommand.executed, true);
    assert.strictEqual(testCommand.command, 'npm run test');
    assert.match(testCommand.selected_because, /package\.json scripts/);
    assert.ok(testCommand.command_executed.includes(FIXTURE_REPO), 'the executed command is reported verbatim');
    assert.strictEqual(testCommand.exit_code, 0);
    assert.ok(typeof testCommand.duration_ms === 'number');

    // The verdict pins the exact code it verified.
    assert.strictEqual(report.git_state.head_sha, git(['rev-parse', 'HEAD']).trim());
    assert.strictEqual(report.git_state.branch, 'main');
    assert.strictEqual(typeof report.git_state.worktree_clean, 'boolean');
    assert.ok(Number.isInteger(report.git_state.changed_file_count));
  });

  await test('DP.6: dev_verify reports a real failure with its exit status and output', async () => {
    const pkgPath = path.join(FIXTURE_REPO, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    pkg.scripts.test = 'node -e "console.error(\'fixture failure marker\'); process.exit(3)"';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const result = await callInternalTool('dev_verify', { path: FIXTURE_REPO, intents: ['test'] });
    assert.strictEqual(result.isError, true, 'a failing verification is an error result');
    const report = json(result);
    assert.strictEqual(report.verdict, 'failed');
    assert.strictEqual(report.summary.failed_count, 1);
    const failure = report.summary.failures[0];
    assert.strictEqual(failure.intent, 'test');
    assert.ok(/fixture failure marker/.test(failure.output_tail), failure.output_tail);
    const testCommand = report.commands.find(entry => entry.intent === 'test');
    // The exact code npm propagates varies by npm major version; what must hold
    // is that a non-zero status is surfaced rather than swallowed.
    assert.ok(Number.isInteger(testCommand.exit_code) && testCommand.exit_code !== 0, `a non-zero exit status must be surfaced, got ${testCommand.exit_code}`);

    pkg.scripts.test = 'node test/run.js';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  });

  await test('DP.7: dev_verify never invents a command it could not detect', async () => {
    const bare = path.join(TEST_DATA_DIR, 'bare-repo');
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, 'notes.txt'), 'no project here\n');
    const report = json(await callInternalTool('dev_verify', { path: bare, intents: ['test', 'lint', 'build', 'syntax'] }));
    assert.strictEqual(report.verdict, 'nothing_to_verify');
    // git_state is always present. The bare directory sits INSIDE the Sidekick
    // checkout, so git honestly resolves the enclosing repository — the pin
    // reports what the commands actually ran against, it does not pretend the
    // path is repository-free when it is not.
    for (const key of ['head_sha', 'branch', 'worktree_clean', 'changed_file_count']) {
      assert.ok(Object.prototype.hasOwnProperty.call(report.git_state, key), `git_state.${key} present`);
    }
    assert.deepStrictEqual(report.summary.not_detected.sort(), ['build', 'lint', 'syntax', 'test']);
    for (const entry of report.commands) {
      assert.strictEqual(entry.executed, false);
      assert.strictEqual(entry.command, null);
    }
  });

  await test('DP.8: dev_verify honours an explicit configuration override', async () => {
    packLifecycle.configure('developer', { verification_mode: 'standard', test_command: 'echo override-marker' });
    const report = json(await callInternalTool('dev_verify', { path: FIXTURE_REPO, intents: ['test'] }));
    const testCommand = report.commands.find(entry => entry.intent === 'test');
    assert.strictEqual(testCommand.command, 'echo override-marker');
    assert.strictEqual(testCommand.selected_because, 'explicit test_command configuration override');
    assert.ok(report.overrides_applied.includes('test_command'));
    assert.ok(/override-marker/.test(testCommand.output));
    packLifecycle.configure('developer', { verification_mode: 'standard' });
  });

  await test('DP.9: the Developer tools refuse paths outside configured repository roots', async () => {
    packLifecycle.configure('developer', { repository_roots: [FIXTURE_REPO] });
    const denied = await callInternalTool('dev_repo_profile', { path: SIDEKICK_ROOT });
    assert.strictEqual(denied.isError, true);
    const payload = json(denied);
    assert.strictEqual(payload.code, 'repository_root_denied');
    const allowed = await callInternalTool('dev_repo_profile', { path: FIXTURE_REPO });
    assert.strictEqual(allowed.isError, undefined);
    packLifecycle.configure('developer', { verification_mode: 'standard' });
  });

  // --- DP.10 workflows -----------------------------------------------------
  await test('DP.10: the Repository Reconnaissance workflow completes against a real repository', async () => {
    const result = await callInternalTool('workflow', {
      action: 'run',
      name: 'developer/repository-recon',
      inputs: { path: SIDEKICK_ROOT, project: 'sidekick-developer-pack-test' },
      project: 'sidekick-developer-pack-test',
    });
    const run = json(result);
    assert.strictEqual(run.status, 'completed', JSON.stringify(run.steps));
    assert.strictEqual(run.ok, true);
    assert.strictEqual(run.owner, 'pack:developer');
    assert.strictEqual(run.steps.length, 8);
    for (const step of run.steps) {
      assert.ok(['ok', 'skipped'].includes(step.status), `${step.step} was ${step.status}: ${step.error || ''}`);
    }

    // Evidence-backed result, not a narrative.
    assert.strictEqual(run.result.repository.path, SIDEKICK_ROOT);
    assert.match(run.result.repository.head.sha, /^[0-9a-f]{40}$/);
    assert.ok(run.result.instruction_files.includes('AGENTS.md'));
    assert.strictEqual(run.result.verification.likely_commands.test, 'npm run test');
    assert.ok(String(run.result.recent_history).length > 0, 'git history was collected');
    assert.strictEqual(run.result.handoff_recorded, true, 'a durable handoff was left');

    // Durable execution state in the canonical subsystems.
    const workflow = platformKernel.getWorkflow(run.run_id);
    assert.strictEqual(workflow.state, 'completed');
    assert.strictEqual(workflow.total_steps, 8);
    assert.strictEqual(workflow.current_step, 8);
    assert.strictEqual(workflow.steps.filter(step => step.state === 'completed').length, 8);
    const execution = platformKernel.getExecution(run.execution_id);
    assert.strictEqual(execution.state, 'completed');
    assert.strictEqual(execution.operation_type, 'workflow_definition_run');
    assert.strictEqual(execution.project_id, 'sidekick_developer_pack_test', 'project identity is canonicalized and carried by the ledger');
  });

  await test('DP.11: the Pull Request Review workflow completes with evidence-backed findings', async () => {
    const result = await callInternalTool('workflow', {
      action: 'run',
      name: 'developer/pull-request-review',
      inputs: { path: FIXTURE_REPO, base: 'HEAD', run_verification: true },
    });
    const run = json(result);
    assert.strictEqual(run.status, 'completed', JSON.stringify(run.steps));
    assert.strictEqual(run.result.totals.files > 0, true, 'the review analyzed a real change set');
    assert.ok(run.result.risks.some(risk => risk.risk === 'schema_migration'), JSON.stringify(run.result.risks));
    assert.ok(run.result.api_surface.detected, 'API surface changes are reported');
    assert.strictEqual(run.result.verification_verdict, 'passed', JSON.stringify(run.result.verification));
    assert.ok(run.result.changed_by_kind.migration.count >= 1);
    // The GitHub-dependent steps were skipped because no repo was supplied,
    // and the workflow still produced a complete review.
    const skipped = run.steps.filter(step => step.status === 'skipped').map(step => step.step);
    assert.deepStrictEqual(skipped.sort(), ['ci', 'pull_request']);
  });

  await test('DP.12: a workflow validates its declared inputs', async () => {
    const missing = await callInternalTool('workflow', { action: 'run', name: 'developer/repository-recon', inputs: {} });
    const payload = json(missing);
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.code, 'invalid_inputs');
    assert.ok(payload.errors.some(error => /input "path" is required/.test(error)), JSON.stringify(payload.errors));

    const unknown = await callInternalTool('workflow', {
      action: 'run',
      name: 'developer/repository-recon',
      inputs: { path: FIXTURE_REPO, bogus: 1 },
    });
    assert.ok(/unknown input/.test(json(unknown).error), json(unknown).error);
  });

  await test('DP.13: workflow discovery lists the pack-owned workflows with their contracts', async () => {
    const list = json(await callInternalTool('workflow', { action: 'list', owner: 'developer' }));
    assert.strictEqual(list.workflows.length, 7);
    const recon = list.workflows.find(workflow => workflow.name === 'developer/repository-recon');
    assert.strictEqual(recon.mode, 'read_only');
    assert.strictEqual(recon.owner, 'pack:developer');
    assert.strictEqual(recon.inputs.path.required, true);
    const implement = list.workflows.find(workflow => workflow.name === 'developer/implement-change');
    assert.strictEqual(implement.mode, 'mutating');
  });

  console.log(`\n${failures === 0 ? 'All Developer pack tests passed.' : `${failures} Developer pack test(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
