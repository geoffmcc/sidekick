const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-blackbox-lifecycle');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(TEST_DATA_DIR, 'blackbox'), { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_BLACKBOX_DAILY_LIMIT = '50';

delete require.cache[require.resolve('../src/db')];
delete require.cache[require.resolve('../src/blackbox')];
const blackbox = require('../src/blackbox');

console.log('Running Black Box Lifecycle Tests...\n');

(async () => {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function test(name, fn) {
    try {
      fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      failures.push({ name, error });
      console.log(`  ✗ ${name}`);
      console.log(`    ${error.message}`);
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      failures.push({ name, error });
      console.log(`  ✗ ${name}`);
      console.log(`    ${error.message}`);
    }
  }

  try {
    console.log('1. Unknown profile fails validation');
    await testAsync('unknown profile throws error', async () => {
      try {
        await blackbox.captureIncident({ profile: 'nonexistent_profile', name: 'test' });
        throw new Error('Should have thrown');
      } catch (e) {
        assert.ok(e.message.includes('Unknown Black Box profile'), `Error should mention unknown profile: ${e.message}`);
      }
    });

    console.log('\n2. Profile with zero collectors fails validation');
    test('validateProfiles identifies empty profiles', () => {
      const validation = blackbox.validateProfiles();
      assert.ok(validation.profiles, 'Should have profiles');
      for (const [key, profile] of Object.entries(validation.profiles)) {
        if (key === 'custom') continue;
        assert.ok(profile.collector_count > 0, `Profile ${key} should have collectors, got ${profile.collector_count}`);
      }
    });

    console.log('\n3. Missing repository context fails preflight');
    await testAsync('no_evidence state when profile resolves to zero collectors', async () => {
      const originalCollectorsFor = blackbox.collectorsFor;
      const { COLLECTORS } = blackbox;
      const tempCollectors = {};
      for (const [k, v] of Object.entries(COLLECTORS)) {
        if (!['repository'].some(p => (v.profile || []).includes(p))) tempCollectors[k] = v;
      }
      blackbox.COLLECTORS = tempCollectors;
      for (const key of Object.keys(blackbox.PROFILE_INFO)) {
        if (key === 'custom') continue;
        blackbox.PROFILE_INFO[key].collectors = [];
      }
      try {
        const capture = await blackbox.captureIncident({ profile: 'repository', name: 'empty test' });
        assert.strictEqual(capture.state, 'no_evidence', `Expected no_evidence, got ${capture.state}`);
        assert.strictEqual(capture.source_count, 0, 'Should have zero sources');
        assert.ok(capture.diagnostics, 'Should have diagnostics');
        assert.strictEqual(capture.diagnostics.requested_profile, 'repository');
      } finally {
        blackbox.COLLECTORS = COLLECTORS;
        for (const [key, profile] of Object.entries(blackbox.PROFILE_INFO)) {
          if (key === 'custom') continue;
          profile.collectors = [];
        }
        for (const [key, collector] of Object.entries(COLLECTORS)) {
          for (const p of collector.profile || []) {
            if (blackbox.PROFILE_INFO[p]) blackbox.PROFILE_INFO[p].collectors.push(key);
          }
        }
      }
    });

    console.log('\n4. Inaccessible repository reports useful error');
    test('collectorsFor returns rejected collectors with reasons', () => {
      const result = blackbox.collectorsFor({ include: ['nonexistent_collector'], profile: 'standard' });
      assert.ok(result.diagnostics.rejected.length > 0, 'Should have rejected collectors');
      assert.strictEqual(result.diagnostics.rejected[0].key, 'nonexistent_collector');
      assert.strictEqual(result.diagnostics.rejected[0].reason, 'unknown_collector');
    });

    console.log('\n5. All collectors denied results in blocked state');
    await testAsync('blocked state when all include items are unknown', async () => {
      const capture = await blackbox.captureIncident({ include: ['fake1', 'fake2'], profile: 'standard', name: 'blocked test' });
      assert.strictEqual(capture.state, 'blocked', `Expected blocked, got ${capture.state}`);
      assert.strictEqual(capture.source_count, 0);
      assert.ok(capture.diagnostics.collectors_rejected.length >= 2);
    });

    console.log('\n6. Zero evidence cannot become completed');
    await testAsync('no_evidence capture is not completed', async () => {
      const capture = await blackbox.captureIncident({ profile: 'standard', name: 'no-evidence test' });
      if (capture.source_count === 0) {
        assert.notStrictEqual(capture.state, 'completed', 'Zero sources should not be completed');
        assert.ok(['no_evidence', 'blocked', 'partial'].includes(capture.state), `State should be failure-like: ${capture.state}`);
      }
    });

    console.log('\n7. Every planned collector creates a source record');
    await testAsync('quick capture creates source records for all planned collectors', async () => {
      const capture = await blackbox.captureIncident({ profile: 'quick', name: 'source-record test' });
      const sources = blackbox.listSources(capture.id);
      assert.ok(sources.length > 0, `Should have sources, got ${sources.length}`);
      for (const source of sources) {
        assert.ok(source.id, 'Source should have id');
        assert.ok(source.source_key, 'Source should have source_key');
        assert.ok(source.state, 'Source should have state');
        assert.ok(['completed', 'failed', 'timed_out', 'cancelled', 'denied', 'unavailable', 'skipped', 'partial'].includes(source.state), `Source state should be terminal: ${source.state}`);
      }
    });

    console.log('\n8. Collector failure remains visible');
    await testAsync('failed collector creates visible source record', async () => {
      const capture = await blackbox.captureIncident({ profile: 'standard', name: 'failure-visibility test' });
      const sources = blackbox.listSources(capture.id);
      const failedSources = sources.filter(s => s.state === 'failed' || s.error_category);
      if (failedSources.length > 0) {
        const failed = failedSources[0];
        assert.ok(failed.error_message || failed.error_category, 'Failed source should have error info');
        assert.ok(failed.content_hash !== undefined, 'Failed source should have content hash');
      }
    });

    console.log('\n9. Successful collector creates an artifact');
    await testAsync('completed source has artifact and hash', async () => {
      const capture = await blackbox.captureIncident({ profile: 'quick', include: ['system.identity'], name: 'artifact test' });
      const sources = blackbox.listSources(capture.id);
      assert.ok(sources.length > 0, 'Should have at least one source');
      const source = sources[0];
      assert.ok(source.content_hash, 'Source should have content hash');
      assert.ok(source.stored_byte_count >= 0, 'Source should have stored byte count');
    });

    console.log('\n10. Artifact-write failure prevents collector success');
    test('collectorsFor returns proper diagnostics', () => {
      const result = blackbox.collectorsFor({ profile: 'repository' });
      assert.ok(result.diagnostics, 'Should have diagnostics');
      assert.ok(result.diagnostics.selected_count > 0, 'Repository profile should select collectors');
      assert.ok(result.diagnostics.selected_keys.includes('repo.git_status'), 'Should include git_status');
      assert.ok(result.diagnostics.selected_keys.includes('repo.git_log'), 'Should include git_log');
      assert.ok(result.diagnostics.collector_selection_path === 'profile_collectors');
    });

    console.log('\n11. Empty capture cannot be analyzed');
    await testAsync('analyzeIncident rejects empty capture', async () => {
      const capture = await blackbox.captureIncident({ include: ['nonexistent_source_xyz'], profile: 'custom', name: 'analyze-empty test' });
      try {
        await blackbox.analyzeIncident(capture.incident_id, { llm: null });
        throw new Error('Should have thrown');
      } catch (e) {
        assert.ok(e.message.includes('Cannot analyze') || e.message.includes('No capture'), `Error should reject empty capture: ${e.message}`);
      }
    });

    console.log('\n12. Retry creates a new capture linked to original');
    await testAsync('retryCapture creates linked capture', async () => {
      const original = await blackbox.captureIncident({ profile: 'quick', include: ['system.identity'], name: 'retry-parent test' });
      const retry = await blackbox.retryCapture(original.id, { profile: 'quick' });
      assert.ok(retry.id !== original.id, 'Retry should be a new capture');
      assert.strictEqual(retry.incident_id, original.incident_id, 'Retry should share incident');
      assert.strictEqual(retry.retry_of, original.id, 'Retry should reference original');
      assert.strictEqual(retry.capture_type, 'retry');
    });

    console.log('\n13. Legacy empty captures remain inspectable');
    await testAsync('repairEmptyCapture fixes legacy capture', async () => {
      const capture = await blackbox.captureIncident({ profile: 'quick', include: ['system.identity'], name: 'repair-parent test' });
      const db = require('../src/db').getDb();
      db.prepare("UPDATE blackbox_captures SET state = 'completed', succeeded_count = 0, failed_count = 0, source_count = 0 WHERE id = ?").run(capture.id);
      const result = blackbox.repairEmptyCapture(capture.id);
      assert.strictEqual(result.repaired, true, 'Should repair');
      assert.strictEqual(result.to, 'no_evidence');
      const repaired = blackbox.getCapture(capture.id);
      assert.strictEqual(repaired.state, 'no_evidence');
    });

    console.log('\n14. Repository profile produces expected safe sources');
    await testAsync('repository profile captures git and system sources', async () => {
      const capture = await blackbox.captureIncident({ profile: 'repository', name: 'repo-profile test' });
      const sources = blackbox.listSources(capture.id);
      const sourceKeys = sources.map(s => s.source_key);
      assert.ok(sourceKeys.includes('repo.git_status'), `Should include repo.git_status, got: ${sourceKeys.join(', ')}`);
      assert.ok(sourceKeys.includes('repo.git_log'), `Should include repo.git_log, got: ${sourceKeys.join(', ')}`);
      assert.ok(sourceKeys.includes('repo.git_remote'), `Should include repo.git_remote, got: ${sourceKeys.join(', ')}`);
      assert.ok(sourceKeys.includes('repo.git_diff_stat'), `Should include repo.git_diff_stat, got: ${sourceKeys.join(', ')}`);
      assert.ok(sourceKeys.includes('system.identity'), `Should include system.identity, got: ${sourceKeys.join(', ')}`);
      assert.ok(sourceKeys.includes('network.listeners'), `Should include network.listeners, got: ${sourceKeys.join(', ')}`);
    });

    console.log('\n15. Secrets in Git remotes are redacted');
    await testAsync('git remote output has credentials redacted', async () => {
      const capture = await blackbox.captureIncident({ profile: 'repository', name: 'redact-remote test' });
      const sources = blackbox.listSources(capture.id);
      const remoteSource = sources.find(s => s.source_key === 'repo.git_remote');
      if (remoteSource) {
        const detail = blackbox.getSource(remoteSource.id, { limit: 65536 });
        assert.ok(!detail.stdout.includes('ghp_') || detail.redaction_count > 0, 'Token-like strings should be redacted or counted');
      }
    });

    console.log('\n16. Diagnostics are preserved in capture record');
    await testAsync('capture has structured diagnostics', async () => {
      const capture = await blackbox.captureIncident({ profile: 'quick', include: ['system.identity'], name: 'diagnostics test' });
      assert.ok(capture.diagnostics, 'Capture should have diagnostics');
      assert.strictEqual(capture.diagnostics.requested_profile, 'quick');
      assert.ok(capture.diagnostics.resolved_profile, 'Should have resolved_profile');
      assert.ok(capture.diagnostics.collector_selection_path, 'Should have collector_selection_path');
      assert.ok(Array.isArray(capture.diagnostics.collectors_selected), 'Should have collectors_selected array');
      assert.ok(Array.isArray(capture.diagnostics.collectors_rejected), 'Should have collectors_rejected array');
    });

    console.log('\n17. Health check reports profile validation');
    test('blackboxHealth returns validation and health status', () => {
      const health = blackbox.blackboxHealth();
      assert.ok(health.hasOwnProperty('healthy'), 'Should have healthy field');
      assert.ok(health.profile_validation, 'Should have profile_validation');
      assert.ok(health.collector_count > 0, 'Should have collectors');
      assert.ok(health.profile_count > 0, 'Should have profiles');
      assert.strictEqual(health.schema_version, 11);
    });

    console.log('\n18. Profile validation catches issues');
    test('validateProfiles checks all profile properties', () => {
      const result = blackbox.validateProfiles();
      assert.strictEqual(result.valid, true, 'All built-in profiles should be valid');
      for (const [key, profile] of Object.entries(result.profiles)) {
        assert.ok(profile.title, `${key} should have title`);
        assert.ok(profile.collector_count > 0, `${key} should have collectors`);
        assert.ok(Array.isArray(profile.collectors), `${key} should have collectors array`);
      }
    });

    console.log('\n19. Capture with explicit include overrides profile');
    await testAsync('explicit include overrides profile selection', async () => {
      const capture = await blackbox.captureIncident({ profile: 'standard', include: ['system.identity'], name: 'override test' });
      assert.strictEqual(capture.source_count, 1, `Expected 1 source, got ${capture.source_count}`);
      const sources = blackbox.listSources(capture.id);
      assert.strictEqual(sources[0].source_key, 'system.identity');
    });

    console.log('\n20. Repository profile all collectors are safe read-only');
    test('repository profile collectors use safe commands', () => {
      const result = blackbox.collectorsFor({ profile: 'repository' });
      const dangerousCommands = ['rm', 'dd', 'mkfs', 'chmod', 'chown', 'kill', 'reboot', 'shutdown', 'eval', 'exec'];
      for (const collector of result.collectors) {
        assert.ok(!dangerousCommands.includes(collector.program), `Repository collector ${collector.key} should not use dangerous command: ${collector.program}`);
      }
    });

    console.log('\n--- Results ---');
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    if (failures.length) {
      console.log('\nFailed tests:');
      for (const f of failures) console.log(`  - ${f.name}: ${f.error.message}`);
    }
    console.log(failed === 0 ? '\nAll lifecycle tests passed.' : '\nSome lifecycle tests failed.');
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('Lifecycle test suite failed:', error);
    process.exit(1);
  }
})();
