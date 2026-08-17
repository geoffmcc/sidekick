#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const APP_DIR = process.env.SIDEKICK_DEPLOY_APP_DIR || '/home/sidekick/sidekick';
const HOME_DIR = process.env.SIDEKICK_DEPLOY_HOME_DIR || '/home/sidekick';
const REPO_URL = 'https://github.com/geoffmcc/sidekick.git';
const PUSH_URL = 'DISABLED';
const SERVICES = ['sidekick-dashboard', 'sidekick-agent', 'sidekick-mcp'];
const LOCK_DIR = path.join(HOME_DIR, '.sidekick-deploy.lock');
const WORK_DIR = path.join(HOME_DIR, 'deploy-work');
const BACKUP_ROOT = path.join(HOME_DIR, 'backups');
const BACKUP_RETENTION = Math.max(1, Number(process.env.SIDEKICK_DEPLOY_BACKUP_RETENTION || 5));
let execFileSyncImpl = childProcess.execFileSync;

function setExecFileSyncForTest(fn) {
  execFileSyncImpl = fn;
}

function redact(text) {
  return String(text || '')
    .replace(/https:\/\/[^\s/@]+@github\.com/gi, 'https://[REDACTED]@github.com')
    .replace(/(gh[pousr]_[A-Za-z0-9_]+)/g, '[REDACTED]')
    .replace(/(github_pat_[A-Za-z0-9_]+)/g, '[REDACTED]')
    .replace(/(Authorization:\s*)(Bearer|token)\s+\S+/gi, '$1[REDACTED]');
}

function run(cmd, args, options = {}) {
  try {
    const stdout = execFileSyncImpl(cmd, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    return {
      ok: false,
      stdout: redact(error.stdout || ''),
      stderr: redact(error.stderr || error.message || ''),
      status: error.status
    };
  }
}

function fail(result, message, details = {}) {
  result.status = 'failed';
  result.error = message;
  result.details = { ...(result.details || {}), ...details };
  return result;
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function acquireLock(result) {
  try {
    fs.mkdirSync(LOCK_DIR, { mode: 0o700 });
    fs.writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid));
    result.lock = LOCK_DIR;
    return true;
  } catch (error) {
    const pidPath = path.join(LOCK_DIR, 'pid');
    let lockPid = null;
    try { lockPid = Number(fs.readFileSync(pidPath, 'utf8').trim()); } catch {}
    let alive = true;
    if (Number.isInteger(lockPid) && lockPid > 0) {
      try {
        process.kill(lockPid, 0);
      } catch (probeError) {
        alive = probeError.code !== 'ESRCH';
      }
    }
    if (Number.isInteger(lockPid) && lockPid > 0 && !alive) {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      fs.mkdirSync(LOCK_DIR, { mode: 0o700 });
      fs.writeFileSync(pidPath, String(process.pid));
      result.lock = LOCK_DIR;
      result.stale_lock_recovered = lockPid;
      return true;
    }
    fail(result, 'deployment lock is already held', { lock: LOCK_DIR, lock_pid: lockPid });
    return false;
  }
}

function releaseLock() {
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
}

function git(args, cwd = APP_DIR, options = {}) {
  return run('git', args, { cwd, timeout: options.timeout || 60000, maxBuffer: options.maxBuffer });
}

function npmInstall(cwd) {
  const lockfile = path.join(cwd, 'package-lock.json');
  if (fs.existsSync(lockfile)) return run('npm', ['ci', '--omit=dev'], { cwd, timeout: 180000, maxBuffer: 20 * 1024 * 1024 });
  return run('npm', ['install', '--omit=dev', '--no-package-lock'], { cwd, timeout: 180000, maxBuffer: 20 * 1024 * 1024 });
}

function runSeed(cwd) {
  if (!fs.existsSync(path.join(cwd, 'scripts', 'seed-knowledge.js'))) return { ok: true, stdout: 'seed unavailable', skipped: true };
  return run('npm', ['run', 'seed:knowledge'], { cwd, timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
}

function service(action, name) {
  return run('sudo', ['systemctl', action, name], { timeout: 30000, maxBuffer: 1024 * 1024 });
}

function deploymentServices() {
  return process.env.SIDEKICK_DEPLOY_SKIP_MCP_LIFECYCLE === '1'
    ? SERVICES.filter(serviceName => serviceName !== 'sidekick-mcp')
    : SERVICES;
}

function serviceStates() {
  const states = {};
  for (const svc of SERVICES) {
    const res = run('systemctl', ['is-active', svc], { timeout: 5000, maxBuffer: 1024 * 1024 });
    states[svc] = res.ok ? res.stdout : (res.stdout || 'unknown');
  }
  return states;
}

function servicesActive(states) {
  return Object.values(states).every(v => v === 'active');
}

function servicesStopped(states) {
  return Object.values(states).every(v => v !== 'active');
}

function allowedFetchUrl(url) {
  return url === REPO_URL;
}

function hasCredential(url) {
  return /https:\/\/[^/\s]+@/i.test(url || '') || /github_pat_|gh[pousr]_/i.test(url || '');
}

function verifyRepoPath(result) {
  if (path.resolve(APP_DIR) !== path.resolve(process.env.SIDEKICK_DEPLOY_APP_DIR || '/home/sidekick/sidekick')) return fail(result, 'unexpected repository path');
  if (!fs.existsSync(APP_DIR)) return fail(result, 'deployment path does not exist', { repo_path: APP_DIR });
  return null;
}

function repoInfo(cwd = APP_DIR) {
  return {
    branch: git(['branch', '--show-current'], cwd).stdout || null,
    head: git(['rev-parse', 'HEAD'], cwd).stdout || null,
    origin: git(['rev-parse', 'origin/main'], cwd).stdout || null,
    fetch_url: git(['remote', 'get-url', 'origin'], cwd).stdout || null,
    push_url: git(['remote', 'get-url', '--push', 'origin'], cwd).stdout || null,
    status: git(['status', '--porcelain'], cwd).stdout || ''
  };
}

function validateExistingCheckout(result) {
  const pathError = verifyRepoPath(result);
  if (pathError) return false;
  if (!fs.existsSync(path.join(APP_DIR, '.git'))) return fail(result, 'deployment path is not a Git checkout', { repo_path: APP_DIR }), false;

  const info = repoInfo(APP_DIR);
  result.branch = info.branch;
  result.previous_commit = info.head;
  result.deployed_commit = info.head;
  result.fetch_repository = redact(info.fetch_url);
  result.push_url = redact(info.push_url);

  if (hasCredential(info.fetch_url)) return fail(result, 'origin fetch URL contains embedded credentials'), false;
  if (!allowedFetchUrl(info.fetch_url)) return fail(result, 'origin fetch URL is not the expected read-only repository', { fetch_url: redact(info.fetch_url) }), false;
  if (info.push_url !== PUSH_URL) return fail(result, 'origin push URL is not disabled', { push_url: redact(info.push_url) }), false;
  if (info.branch !== 'main') return fail(result, 'deployment checkout is not on main', { branch: info.branch || '(detached)' }), false;
  if (info.status) return fail(result, 'tracked working tree is not clean', { git_status: info.status }), false;

  return true;
}

function compareWithOrigin(result) {
  const ahead = git(['rev-list', '--count', 'origin/main..HEAD']).stdout;
  const behind = git(['rev-list', '--count', 'HEAD..origin/main']).stdout;
  result.ahead = Number(ahead || 0);
  result.behind = Number(behind || 0);
  if (result.ahead > 0 && result.behind > 0) return fail(result, 'local main has diverged from origin/main'), false;
  if (result.ahead > 0) return fail(result, 'local main is ahead of origin/main'), false;
  return true;
}

function rollbackDeploy(result, previousCommit) {
  result.rollback_attempted = true;
  const reset = git(['reset', '--hard', previousCommit]);
  if (!reset.ok) {
    result.rollback_status = 'failed';
    result.rollback_error = reset.stderr;
    return;
  }
  const install = npmInstall(APP_DIR);
  result.rollback_dependency_install = install.ok ? 'ok' : 'failed';
  for (const svc of SERVICES) service('restart', svc);
  result.rollback_status = install.ok ? 'completed' : 'partial';
}

function restartServices(result) {
  result.restarted_services = result.restarted_services || [];
  for (const svc of deploymentServices()) {
    const restart = service('restart', svc);
    result.restarted_services.push({ service: svc, status: restart.ok ? 'restarted' : 'failed' });
  }
  const states = serviceStates();
  result.health = { services: states, ok: servicesActive(states) };
  return result.health.ok;
}

function stopServices(result) {
  result.stopped_services = {};
  for (const svc of deploymentServices()) {
    const stop = service('stop', svc);
    result.stopped_services[svc] = stop.ok ? 'stopped' : 'failed';
    if (!stop.ok) return false;
  }
  result.stopped_services = serviceStates();
  return servicesStopped(result.stopped_services);
}

function pruneDeployBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return;
  const backups = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^deploy-\d{8}T\d{6}Z$/.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .reverse();
  for (const name of backups.slice(BACKUP_RETENTION)) {
    fs.rmSync(path.join(BACKUP_ROOT, name), { recursive: true, force: true });
  }
}

function createDeployBackup(result, previousCommit) {
  const stamp = utcStamp();
  const backup = path.join(BACKUP_ROOT, `deploy-${stamp}`);
  fs.mkdirSync(BACKUP_ROOT, { recursive: true, mode: 0o700 });
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const envSource = path.join(APP_DIR, '.env');
  const dataSource = path.join(APP_DIR, 'data');
  if (!fs.existsSync(envSource) || !fs.existsSync(dataSource)) throw new Error('backup source validation failed');
  fs.cpSync(envSource, path.join(backup, '.env'), { preserveTimestamps: true });
  fs.chmodSync(path.join(backup, '.env'), 0o600);
  fs.cpSync(dataSource, path.join(backup, 'data'), { recursive: true, dereference: false, preserveTimestamps: true });
  fs.writeFileSync(path.join(backup, 'previous-commit.txt'), `${previousCommit}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(backup, 'manifest.json'), `${JSON.stringify({
    created_at: new Date().toISOString(),
    previous_commit: previousCommit,
    contents: ['.env', 'data']
  }, null, 2)}\n`, { mode: 0o600 });
  if (!fs.existsSync(path.join(backup, '.env')) || !fs.existsSync(path.join(backup, 'data'))) {
    throw new Error('backup validation failed');
  }
  result.backup = backup;
  result.backup_retention = BACKUP_RETENTION;
  pruneDeployBackups();
  return backup;
}

function verify(mode = 'verify') {
  const result = { mode, status: 'unknown', repo_path: APP_DIR };
  if (!fs.existsSync(path.join(APP_DIR, '.git'))) return fail(result, 'deployment path is not a Git checkout', { repo_path: APP_DIR });
  const preflight = repoInfo(APP_DIR);
  if (hasCredential(preflight.fetch_url)) return fail(result, 'origin fetch URL contains embedded credentials');
  if (!allowedFetchUrl(preflight.fetch_url)) return fail(result, 'origin fetch URL is not the expected read-only repository', { fetch_url: redact(preflight.fetch_url) });
  const fetch = git(['fetch', '--prune', 'origin', 'main']);
  result.fetch = fetch.ok ? 'ok' : 'failed';
  if (!fetch.ok) return fail(result, 'git fetch failed', { stderr: fetch.stderr });
  if (!validateExistingCheckout(result)) return result;
  if (!compareWithOrigin(result)) return result;
  const info = repoInfo(APP_DIR);
  const states = serviceStates();
  result.deployed_commit = info.head;
  result.origin_main = info.origin;
  result.changed = false;
  result.health = { services: states, ok: servicesActive(states) };
  result.status = info.head === info.origin && servicesActive(states) ? 'ok' : 'failed';
  if (result.status !== 'ok') result.error = 'deployed commit or service health does not match expected state';
  return result;
}

function deploy() {
  const result = { mode: 'deploy', status: 'unknown', repo_path: APP_DIR, restarted_services: [] };
  if (!acquireLock(result)) return result;
  let servicesStoppedForBackup = false;
  try {
    if (!fs.existsSync(path.join(APP_DIR, '.git'))) return fail(result, 'deployment path is not a Git checkout', { repo_path: APP_DIR });
    const preflight = repoInfo(APP_DIR);
    if (hasCredential(preflight.fetch_url)) return fail(result, 'origin fetch URL contains embedded credentials');
    if (!allowedFetchUrl(preflight.fetch_url)) return fail(result, 'origin fetch URL is not the expected read-only repository', { fetch_url: redact(preflight.fetch_url) });
    const fetch = git(['fetch', '--prune', 'origin', 'main']);
    result.fetch = fetch.ok ? 'ok' : 'failed';
    if (!fetch.ok) return fail(result, 'git fetch failed', { stderr: fetch.stderr });
    if (!validateExistingCheckout(result)) return result;
    if (!compareWithOrigin(result)) return result;

    const oldHead = result.previous_commit;
    if (result.behind > 0) {
      servicesStoppedForBackup = true;
      if (!stopServices(result)) return fail(result, 'service stop verification failed', { services: result.stopped_services });
      try {
        createDeployBackup(result, oldHead);
      } catch (error) {
        return fail(result, redact(error.message));
      }
    }
    const merge = git(['merge', '--ff-only', 'origin/main']);
    result.fast_forward = merge.ok ? 'ok' : 'failed';
    if (!merge.ok) return fail(result, 'fast-forward failed', { stderr: merge.stderr });

    const newHead = git(['rev-parse', 'HEAD']).stdout;
    const origin = git(['rev-parse', 'origin/main']).stdout;
    const pushUrl = git(['remote', 'get-url', '--push', 'origin']).stdout;
    result.deployed_commit = newHead;
    result.origin_main = origin;
    result.push_url = redact(pushUrl);
    result.changed = oldHead !== newHead;
    if (newHead !== origin) return fail(result, 'HEAD does not equal origin/main after deployment');
    if (pushUrl !== PUSH_URL) return fail(result, 'origin push URL is not disabled after deployment', { push_url: redact(pushUrl) });

    const install = npmInstall(APP_DIR);
    result.dependency_install = install.ok ? 'ok' : 'failed';
    if (!install.ok) {
      if (result.changed) rollbackDeploy(result, oldHead);
      return fail(result, 'dependency installation failed', { stderr: install.stderr });
    }

    const seed = runSeed(APP_DIR);
    result.knowledge_seed = seed.ok ? (seed.skipped ? 'skipped' : 'ok') : 'failed';
    if (!seed.ok) {
      if (result.changed) rollbackDeploy(result, oldHead);
      return fail(result, 'knowledge seed failed', { stderr: seed.stderr });
    }

    if (!restartServices(result)) {
      if (result.changed) rollbackDeploy(result, oldHead);
      const restartFailed = result.restarted_services.some(item => item.status === 'failed');
      return fail(result, restartFailed ? 'service restart failed' : 'service health check failed', { services: result.health.services });
    }
    servicesStoppedForBackup = false;

    result.mcp_restart = 'scheduled by caller when running inside MCP';
    const states = serviceStates();
    result.health = { services: states, ok: servicesActive(states) };
    if (!servicesActive(states)) {
      if (result.changed) rollbackDeploy(result, oldHead);
      return fail(result, 'service health check failed');
    }
    const postStatus = git(['status', '--porcelain']).stdout || '';
    if (postStatus) {
      if (result.changed) rollbackDeploy(result, oldHead);
      return fail(result, 'tracked working tree is not clean after deployment', { git_status: postStatus });
    }
    result.rollback = { previous_commit: oldHead, command: `cd ${APP_DIR} && git reset --hard ${oldHead} && npm ci --omit=dev && sudo systemctl restart sidekick-agent sidekick-dashboard` };
    result.status = 'ok';
    return result;
  } finally {
    if (servicesStoppedForBackup) restartServices(result);
    releaseLock();
  }
}

function copyIfExists(src, dest) {
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true, dereference: false, preserveTimestamps: true });
    return true;
  }
  return false;
}

function ensureSpace(result) {
  const df = run('df', ['-Pk', HOME_DIR]);
  if (!df.ok) return fail(result, 'disk space check failed'), false;
  const lines = df.stdout.split('\n');
  const cols = lines[1]?.trim().split(/\s+/) || [];
  const availableKb = Number(cols[3] || 0);
  result.available_kb = availableKb;
  if (availableKb < 1024 * 1024) return fail(result, 'insufficient free disk space', { available_kb: availableKb }), false;
  return true;
}

function convert() {
  const stamp = utcStamp();
  const staging = path.join(WORK_DIR, `sidekick-${stamp}`);
  const backup = path.join(BACKUP_ROOT, `deploy-${stamp}`);
  const rollback = path.join(HOME_DIR, `sidekick.rollback-${stamp}`);
  const result = { mode: 'convert', status: 'unknown', repo_path: APP_DIR, staging, backup, rollback, restarted_services: [] };
  if (!acquireLock(result)) return result;
  let stopped = false;
  try {
    if (!ensureSpace(result)) return result;
    fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
    fs.mkdirSync(BACKUP_ROOT, { recursive: true, mode: 0o700 });

    const clone = run('git', ['clone', '--branch', 'main', '--single-branch', REPO_URL, staging], { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
    if (!clone.ok) return fail(result, 'git clone failed', { stderr: clone.stderr });
    const fetchUrl = git(['remote', 'get-url', 'origin'], staging).stdout;
    if (!allowedFetchUrl(fetchUrl) || hasCredential(fetchUrl)) return fail(result, 'staging clone has unsafe origin URL', { fetch_url: redact(fetchUrl) });
    git(['remote', 'set-url', '--push', 'origin', PUSH_URL], staging);
    const pushUrl = git(['remote', 'get-url', '--push', 'origin'], staging).stdout;
    if (pushUrl !== PUSH_URL) return fail(result, 'failed to disable push URL in staging');

    const install = npmInstall(staging);
    result.dependency_install = install.ok ? 'ok' : 'failed';
    if (!install.ok) return fail(result, 'staging dependency installation failed', { stderr: install.stderr });

    for (const svc of SERVICES) {
      const stop = service('stop', svc);
      result.restarted_services.push({ service: svc, status: stop.ok ? 'stopped' : 'stop_failed' });
      if (!stop.ok) return fail(result, 'service stop failed', { service: svc, stderr: stop.stderr });
    }
    const stoppedStates = serviceStates();
    result.stopped_services = stoppedStates;
    if (!servicesStopped(stoppedStates)) return fail(result, 'service stop verification failed', { services: stoppedStates });
    stopped = true;

    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    copyIfExists(path.join(APP_DIR, '.env'), path.join(backup, '.env'));
    copyIfExists(path.join(APP_DIR, 'data'), path.join(backup, 'data'));
    fs.writeFileSync(path.join(backup, 'previous-revision.txt'), fs.existsSync(path.join(APP_DIR, '.git')) ? (git(['rev-parse', 'HEAD']).stdout || 'unknown') : 'non-git deployment');
    if (!fs.existsSync(path.join(backup, '.env')) || !fs.existsSync(path.join(backup, 'data'))) return fail(result, 'backup validation failed');

    copyIfExists(path.join(backup, '.env'), path.join(staging, '.env'));
    copyIfExists(path.join(backup, 'data'), path.join(staging, 'data'));
    fs.chmodSync(path.join(staging, '.env'), 0o600);
    const chown = run('chown', ['-R', 'sidekick:sidekick', staging]);
    if (!chown.ok) return fail(result, 'ownership fix failed', { stderr: chown.stderr });

    fs.renameSync(APP_DIR, rollback);
    fs.renameSync(staging, APP_DIR);

    const seed = runSeed(APP_DIR);
    result.knowledge_seed = seed.ok ? (seed.skipped ? 'skipped' : 'ok') : 'failed';
    if (!seed.ok) throw new Error('knowledge seed failed');

    for (const svc of SERVICES) {
      const restart = service('restart', svc);
      result.restarted_services.push({ service: svc, status: restart.ok ? 'restarted' : 'restart_failed' });
      if (!restart.ok) throw new Error(`service restart failed: ${svc}`);
    }
    const states = serviceStates();
    result.health = { services: states, ok: servicesActive(states) };
    if (!servicesActive(states)) throw new Error('service health check failed');
    result.deployed_commit = git(['rev-parse', 'HEAD']).stdout;
    result.push_url = git(['remote', 'get-url', '--push', 'origin']).stdout;
    result.status = result.push_url === PUSH_URL ? 'ok' : 'failed';
    if (result.status !== 'ok') result.error = 'push URL verification failed';
    return result;
  } catch (error) {
    result.rollback_attempted = stopped;
    result.error = redact(error.message);
    try {
      if (fs.existsSync(APP_DIR) && fs.existsSync(rollback)) fs.renameSync(APP_DIR, `${APP_DIR}.failed-${stamp}`);
      if (fs.existsSync(rollback)) fs.renameSync(rollback, APP_DIR);
      for (const svc of SERVICES) service('restart', svc);
      result.rollback_status = 'completed';
    } catch (rollbackError) {
      result.rollback_status = 'failed';
      result.rollback_error = redact(rollbackError.message);
    }
    result.status = 'failed';
    return result;
  } finally {
    releaseLock();
  }
}

function main(argv = process.argv.slice(2)) {
  const mode = argv[0] || 'verify';
  let result;
  if (mode === 'verify') result = verify();
  else if (mode === 'deploy') result = deploy();
  else if (mode === 'convert') result = convert();
  else result = { status: 'failed', error: 'invalid mode; use verify, deploy, or convert' };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'ok' ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  APP_DIR,
  REPO_URL,
  PUSH_URL,
  redact,
  allowedFetchUrl,
  hasCredential,
  setExecFileSyncForTest,
  verify,
  deploy,
  convert,
  main
};
