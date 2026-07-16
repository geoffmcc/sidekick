const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-git-deploy-'));
const appDir = path.join(tempHome, 'sidekick');
process.env.SIDEKICK_DEPLOY_HOME_DIR = tempHome;
process.env.SIDEKICK_DEPLOY_APP_DIR = appDir;

delete require.cache[require.resolve('../scripts/git-deploy')];
const gitDeploy = require('../scripts/git-deploy');

function resetApp() {
  for (const entry of fs.readdirSync(tempHome)) {
    if (entry.startsWith('sidekick.rollback-') || entry.startsWith('sidekick.failed-') || entry === 'backups' || entry === 'deploy-work' || entry === '.sidekick-deploy.lock') {
      fs.rmSync(path.join(tempHome, entry), { recursive: true, force: true });
    }
  }
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(appDir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(appDir, '.env'), 'SECRET=redacted\n');
  fs.writeFileSync(path.join(appDir, 'data', 'sidekick.db'), 'db');
  fs.writeFileSync(path.join(appDir, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(appDir, 'scripts', 'seed-knowledge.js'), '');
}

function makeMock(overrides = {}) {
  const state = {
    branch: 'main',
    head: 'aaa111',
    origin: 'bbb222',
    fetchUrl: 'https://github.com/geoffmcc/sidekick.git',
    pushUrl: 'DISABLED',
    status: '',
    ahead: '0',
    behind: '1',
    services: 'active',
    installCalls: 0,
    calls: [],
    ...overrides
  };

  function fail(message) {
    const error = new Error(message);
    error.stderr = message;
    error.status = 1;
    throw error;
  }

  function execFileSyncMock(cmd, args, options = {}) {
    state.calls.push([cmd, ...args].join(' '));
    const cwd = options.cwd || '';
    if (cmd === 'df' && state.lowDisk) return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 9999999 9999998 1 99% /\n';
    if (cmd === 'df') return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 9999999 1 9999999 1% /\n';
    if (cmd === 'chown') return '';
    if (cmd === 'npm') {
      state.installCalls += 1;
      if (state.failInstall && args[0] === 'ci' && state.installCalls === 1) fail('npm token ghp_secret leaked');
      if (state.failSeed && args.join(' ') === 'run seed:knowledge') fail('seed failed');
      return 'ok\n';
    }
    if (cmd === 'sudo') {
      if (state.failStop && args[1] === 'stop') fail('stop failed');
      if (state.failRestart && args[1] === 'restart') fail('restart failed');
      if (args[1] === 'stop') state.services = 'inactive';
      if (args[1] === 'restart' && !state.keepServiceFailure) state.services = 'active';
      return 'ok\n';
    }
    if (cmd === 'systemctl') return `${state.services}\n`;
    if (cmd === 'git') {
      const joined = args.join(' ');
      if (args[0] === 'clone') {
        if (state.failClone) fail('clone failed');
        const target = args[args.length - 1];
        fs.mkdirSync(path.join(target, '.git'), { recursive: true });
        fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(target, 'package-lock.json'), '{}');
        fs.writeFileSync(path.join(target, 'scripts', 'seed-knowledge.js'), '');
        return 'cloned\n';
      }
      if (joined === 'branch --show-current') return `${state.branch}\n`;
      if (joined === 'rev-parse HEAD') return `${state.head}\n`;
      if (joined === 'rev-parse origin/main') return `${state.origin}\n`;
      if (joined === 'remote get-url origin') return `${state.fetchUrl}\n`;
      if (joined === 'remote get-url --push origin') return `${state.pushUrl}\n`;
      if (joined === 'status --porcelain') return `${state.status}\n`;
      if (joined === 'rev-list --count origin/main..HEAD') return `${state.ahead}\n`;
      if (joined === 'rev-list --count HEAD..origin/main') return `${state.behind}\n`;
      if (joined === 'fetch --prune origin main') {
        if (state.failFetch) fail('fetch failed');
        return 'fetched\n';
      }
      if (joined === 'merge --ff-only origin/main') {
        if (state.failMerge) fail('merge failed');
        state.head = state.origin;
        state.behind = '0';
        return 'merged\n';
      }
      if (joined.startsWith('reset --hard ')) {
        state.head = args[2];
        return 'reset\n';
      }
      if (joined === 'remote set-url --push origin DISABLED') {
        state.pushUrl = 'DISABLED';
        return '';
      }
    }
    fail(`unexpected command: ${cmd} ${args.join(' ')} cwd=${cwd}`);
  }

  gitDeploy.setExecFileSyncForTest(execFileSyncMock);
  return state;
}

console.log('Running Git deployment hardening tests...\n');

try {
  resetApp();
  let state = makeMock({ head: 'bbb222', origin: 'bbb222', behind: '0' });
  let result = gitDeploy.verify();
  assert.strictEqual(result.status, 'ok', 'valid checkout should verify');
  assert.ok(state.calls.includes('git fetch --prune origin main'), 'verify should fetch origin main');

  resetApp();
  state = makeMock({ head: 'bbb222', origin: 'bbb222', behind: '0' });
  result = gitDeploy.deploy();
  assert.strictEqual(result.status, 'ok', 'no-op deploy should succeed');
  assert.strictEqual(result.changed, false, 'no-op deploy should report unchanged');
  assert.ok(state.calls.includes('npm ci --omit=dev'), 'lockfile deploy should use npm ci');

  resetApp();
  state = makeMock();
  result = gitDeploy.deploy();
  assert.strictEqual(result.status, 'ok', 'fast-forward deploy should succeed');
  assert.strictEqual(result.changed, true, 'fast-forward deploy should report changed');
  assert.strictEqual(result.previous_commit, 'aaa111');
  assert.strictEqual(result.deployed_commit, 'bbb222');
  assert.strictEqual(gitDeploy.allowedFetchUrl('git://github.com/geoffmcc/sidekick.git'), false, 'git protocol should not be allowed for deploy origin');

  for (const [name, overrides, expected] of [
    ['dirty tracked tree', { status: ' M src/tools.js' }, 'tracked working tree is not clean'],
    ['staged tracked changes', { status: 'M  src/tools.js' }, 'tracked working tree is not clean'],
    ['wrong branch', { branch: 'feature' }, 'deployment checkout is not on main'],
    ['ahead branch', { ahead: '1', behind: '0' }, 'local main is ahead of origin/main'],
    ['diverged branch', { ahead: '1', behind: '1' }, 'local main has diverged from origin/main'],
    ['wrong origin', { fetchUrl: 'https://github.com/evil/repo.git' }, 'origin fetch URL is not the expected read-only repository'],
    ['credential origin', { fetchUrl: 'https://ghp_secret@github.com/geoffmcc/sidekick.git' }, 'origin fetch URL contains embedded credentials'],
    ['enabled push URL', { pushUrl: 'https://github.com/geoffmcc/sidekick.git' }, 'origin push URL is not disabled'],
    ['fetch failure', { failFetch: true }, 'git fetch failed'],
    ['install failure', { failInstall: true }, 'dependency installation failed'],
    ['seed failure', { failSeed: true }, 'knowledge seed failed'],
    ['restart failure', { failRestart: true }, 'service restart failed'],
    ['health failure', { services: 'failed', keepServiceFailure: true }, 'service health check failed']
  ]) {
    resetApp();
    makeMock(overrides);
    result = gitDeploy.deploy();
    assert.strictEqual(result.status, 'failed', `${name} should fail`);
    assert.ok(result.error.includes(expected), `${name} should explain failure`);
    assert.ok(!JSON.stringify(result).includes('ghp_secret'), `${name} should redact secrets`);
    if (['install failure', 'seed failure', 'restart failure', 'health failure'].includes(name)) {
      assert.strictEqual(result.rollback_status, 'completed', `${name} should roll back a changed deployment`);
    }
  }

  resetApp();
  fs.rmSync(path.join(appDir, '.git'), { recursive: true, force: true });
  makeMock();
  result = gitDeploy.convert();
  assert.strictEqual(result.status, 'ok', 'non-Git conversion should succeed');
  assert.ok(fs.existsSync(result.backup), 'conversion should create durable backup');
  assert.ok(fs.existsSync(result.rollback), 'conversion should retain rollback directory');
  assert.strictEqual(result.push_url, 'DISABLED', 'conversion should disable push URL');

  resetApp();
  fs.rmSync(path.join(appDir, '.git'), { recursive: true, force: true });
  makeMock({ failClone: true });
  result = gitDeploy.convert();
  assert.strictEqual(result.status, 'failed', 'clone failure should fail conversion');

  resetApp();
  fs.rmSync(path.join(appDir, '.git'), { recursive: true, force: true });
  makeMock({ lowDisk: true });
  result = gitDeploy.convert();
  assert.strictEqual(result.status, 'failed', 'insufficient disk space should fail conversion');
  assert.strictEqual(result.error, 'insufficient free disk space');

  resetApp();
  fs.rmSync(path.join(appDir, '.git'), { recursive: true, force: true });
  fs.rmSync(path.join(appDir, '.env'), { force: true });
  makeMock();
  result = gitDeploy.convert();
  assert.strictEqual(result.status, 'failed', 'inconsistent backup should fail conversion');
  assert.strictEqual(result.error, 'backup validation failed');

  resetApp();
  fs.rmSync(path.join(appDir, '.git'), { recursive: true, force: true });
  makeMock({ failStop: true });
  result = gitDeploy.convert();
  assert.strictEqual(result.status, 'failed', 'service stop failure should fail conversion');
  assert.strictEqual(result.error, 'service stop failed');

  resetApp();
  fs.rmSync(path.join(appDir, '.git'), { recursive: true, force: true });
  makeMock({ failRestart: true });
  result = gitDeploy.convert();
  assert.strictEqual(result.status, 'failed', 'restart failure should fail conversion');
  assert.strictEqual(result.rollback_status, 'completed', 'conversion should roll back after post-stop failure');

  resetApp();
  fs.mkdirSync(path.join(tempHome, '.sidekick-deploy.lock'), { recursive: true });
  makeMock();
  result = gitDeploy.deploy();
  assert.strictEqual(result.status, 'failed', 'existing lock should block concurrent deployment');
  fs.rmSync(path.join(tempHome, '.sidekick-deploy.lock'), { recursive: true, force: true });

  const deploySh = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8');
  const deployPs1 = fs.readFileSync(path.join(root, 'deploy.ps1'), 'utf8');
  const toolsJs = fs.readFileSync(path.join(root, 'src', 'tools-legacy.js'), 'utf8');
  const schemasJs = fs.readFileSync(path.join(root, 'src', 'tools', 'schemas', 'index.js'), 'utf8');
  assert.match(deploySh, /SCP\/offline mode/, 'deploy.sh should label explicit SCP/offline mode');
  assert.match(deployPs1, /SCP\/offline mode/, 'deploy.ps1 should label explicit SCP/offline mode');
  assert.match(deploySh, /verify_git_deploy_source/, 'deploy.sh should validate local helper provenance before Git deploy');
  assert.match(deployPs1, /Assert-GitDeploySource/, 'deploy.ps1 should validate local helper provenance before Git deploy');
  assert.doesNotMatch(deploySh, /node \/tmp\/sidekick-git-deploy\.js/, 'deploy.sh should not execute helper from world-writable tmp');
  assert.doesNotMatch(deployPs1, /node \/tmp\/sidekick-git-deploy\.js/, 'deploy.ps1 should not execute helper from world-writable tmp');
  assert.match(deploySh, /Syncing \.env before first Git conversion/, 'deploy.sh should copy first-deploy .env before conversion backup');
  assert.match(deployPs1, /Syncing \.env before first Git conversion/, 'deploy.ps1 should copy first-deploy .env before conversion backup');
  assert.doesNotMatch(deploySh, /rm -rf \$REMOTE_DIR/, 'deploy.sh should not destructively remove live directory');
  assert.doesNotMatch(deployPs1, /rm -rf \$REMOTE_DIR/, 'deploy.ps1 should not destructively remove live directory');
  assert.match(toolsJs, /SIDEKICK_DEPLOY_REPO_PATH = "\/home\/sidekick\/sidekick"/, 'sidekick_ops should use fixed deployment path');
  assert.match(toolsJs, /deployScriptPath\(repoPath\)/, 'sidekick_ops should delegate to git deployment helper');
  assert.match(schemasJs, /ops:\s*z\.object/, 'ops schema should remain registered');

  console.log('Git deployment hardening tests passed\n');
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}
