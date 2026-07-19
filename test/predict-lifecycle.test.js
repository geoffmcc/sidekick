const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-predict-lifecycle');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

delete require.cache[require.resolve('../src/db')];
delete require.cache[require.resolve('../src/predict')];
const dbStore = require('../src/db');
const predictEngine = require('../src/predict');

console.log('Running Predict Lifecycle Tests...\n');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message}`);
  }
}
function assertOk(val, msg) {
  assert.ok(val, msg || `expected truthy, got ${val}`);
}

const PROJECT = 'predict_lifecycle';
const T0 = Date.now();
const iso = (ms) => new Date(T0 + ms).toISOString();
const db = dbStore.getDb();

// Fixture: a clean forward sequence plus a genuinely failing tool.
for (let i = 0; i < 3; i++) {
  dbStore.appendToolLog({ t: iso(i * 1000), n: 'knowledge', ok: true, src: 'mcp', session_id: `lc-seq-${i}`, project: PROJECT, s: 'searched docs' });
  dbStore.appendToolLog({ t: iso(i * 1000 + 500), n: 'tools', ok: true, src: 'mcp', session_id: `lc-seq-${i}`, project: PROJECT, s: 'inspected catalog' });
}
for (let i = 0; i < 4; i++) {
  dbStore.appendToolLog({ t: iso(20000 + i * 1000), n: 'web_fetch', ok: false, src: 'mcp', session_id: `lc-fail-${i % 3}`, project: PROJECT, error_category: 'timeout', s: 'request timed out' });
}
for (let i = 0; i < 2; i++) {
  dbStore.appendToolLog({ t: iso(30000 + i * 1000), n: 'web_fetch', ok: true, src: 'mcp', session_id: `lc-fail-${i}`, project: PROJECT, s: 'fetched' });
}

const analysisResult = predictEngine.analyze({ project: PROJECT });
const testPredictions = analysisResult.predictions || [];
console.log(`  (Analyze produced ${testPredictions.length} predictions for lifecycle tests)\n`);

console.log('LC.1: analyze produces identified, evidence-backed predictions');
test('analyze produces IDs and evidence', () => {
  assert.ok(testPredictions.length >= 2, `fixture produces at least two predictions, got ${testPredictions.length}`);
  assert.ok(testPredictions[0].id.startsWith('pred_'), 'id is prefixed');
  assert.ok(testPredictions.every(p => p.identity_key), 'every prediction has a logical identity');
});

console.log('LC.2: prediction, evidence and audit are written atomically');
test('every prediction has evidence and a creation audit row', () => {
  for (const p of testPredictions) {
    assert.ok(predictEngine.getPredictionEvidence(p.id).length >= 1, `evidence missing for ${p.type}`);
    const audit = db.prepare("SELECT COUNT(*) AS cnt FROM prediction_audit WHERE prediction_id = ? AND event_type = 'created'").get(p.id).cnt;
    assert.equal(audit, 1, 'exactly one creation audit row');
  }
});

test('a failing evidence insert rolls back the whole prediction', () => {
  const before = db.prepare('SELECT COUNT(*) AS cnt FROM predictions').get().cnt;
  const pred = {
    id: 'pred_atomic_test', type: 'next_action', subject: 'S', explanation: 'E',
    project: PROJECT, time_horizon: 'current_session', probability: 0.6, confidence: 'medium',
    score_breakdown: {}, recommended_action: null, observation_count: 3, status: 'active',
    identity_key: 'atomic-test-identity', fingerprint: 'atomic', rule_version: predictEngine.RULE_VERSION,
    created_at: new Date().toISOString(), expires_at: null,
  };
  // summary is NOT NULL — the evidence insert must fail and take the prediction with it.
  assert.throws(
    () => predictEngine.persistPrediction(pred, [{ source_type: 'tool_call', summary: null }]),
    'the transaction must surface the error'
  );
  const after = db.prepare('SELECT COUNT(*) AS cnt FROM predictions').get().cnt;
  assert.equal(after, before, 'no orphaned prediction row survives');
  assert.equal(predictEngine.getPrediction('pred_atomic_test'), null, 'prediction was rolled back');
});

console.log('LC.3: repeated analysis is idempotent');
test('re-analysis refreshes instead of duplicating', () => {
  const before = db.prepare('SELECT COUNT(*) AS cnt FROM predictions').get().cnt;
  const again = predictEngine.analyze({ project: PROJECT });
  assert.equal(again.created, 0, 'no new predictions created');
  assert.ok(again.refreshed >= 1, 'existing logical predictions are refreshed');
  const after = db.prepare('SELECT COUNT(*) AS cnt FROM predictions').get().cnt;
  assert.equal(after, before, 'row count is unchanged');
});

console.log('LC.4: analysis after expiration reactivates rather than duplicating');
test('an expired identity is reactivated in place', () => {
  const target = testPredictions[0];
  const identity = target.identity_key;
  // Force expiry of the whole identity.
  db.prepare("UPDATE predictions SET expires_at = ? WHERE identity_key = ?")
    .run(new Date(T0 - 86400000).toISOString(), identity);

  const result = predictEngine.analyze({ project: PROJECT });
  assert.ok(result.expired >= 1, 'the stale prediction was expired');

  const rows = db.prepare('SELECT * FROM predictions WHERE identity_key = ?').all(identity);
  assert.equal(rows.length, 1, 'expiry + reanalysis must not create an equivalent second row');
  assert.equal(rows[0].id, target.id, 'the original row is reused');
  assert.equal(rows[0].status, 'active', 'the identity is reactivated');
  assert.ok(/reactivated/.test(rows[0].lifecycle_reason || ''), 'the transition is explained');
});

console.log('LC.5: the active-identity invariant is enforced by the database');
test('a duplicate active identity cannot be inserted concurrently', () => {
  const existing = db.prepare("SELECT * FROM predictions WHERE status = 'active' AND identity_key IS NOT NULL LIMIT 1").get();
  assertOk(existing, 'an active prediction exists');
  assert.throws(() => {
    db.prepare(`
      INSERT INTO predictions (id, type, subject, explanation, project, time_horizon, probability,
        confidence, score_breakdown_json, status, identity_key, rule_version, observation_count,
        created_at, updated_at, enabled)
      VALUES (?, ?, 'dup', 'dup', ?, 'current_session', 0.5, 'medium', '{}', 'active', ?, ?, 1, ?, ?, 1)
    `).run('pred_dup_test', existing.type, existing.project, existing.identity_key,
      predictEngine.RULE_VERSION, new Date().toISOString(), new Date().toISOString());
  }, /UNIQUE/, 'the partial unique index rejects a second active row for one identity');
});

console.log('LC.6: time horizons drive expiration');
test('expiration follows the time horizon, not a single global constant', () => {
  assert.equal(predictEngine.expiresAtForHorizon('open_ended'), null, 'open-ended predictions do not get an arbitrary expiry');
  const horizons = ['current_task', 'current_session', 'days_7', 'days_30'];
  let last = 0;
  for (const h of horizons) {
    const exp = predictEngine.expiresAtForHorizon(h);
    assertOk(exp, `${h} has an expiry`);
    const delta = Date.parse(exp) - Date.now();
    assertOk(delta > last, `${h} expires later than the previous horizon`);
    last = delta;
  }
  assertOk(predictEngine.HORIZON_EXPIRY_HOURS.days_7 === 168, 'days_7 is seven days');
  assertOk(predictEngine.HORIZON_EXPIRY_HOURS.days_30 === 720, 'days_30 is thirty days');
});

test('persisted predictions carry a horizon-consistent expiry', () => {
  for (const p of predictEngine.listPredictions({ project: PROJECT, limit: 50 })) {
    if (p.time_horizon === 'open_ended') {
      assert.equal(p.expires_at, null, 'open-ended rows have no expiry');
    } else {
      assertOk(p.expires_at, `${p.type} (${p.time_horizon}) has an expiry`);
    }
  }
});

console.log('LC.7: outcomes, feedback and dismissal');
test('recordFeedback stores feedback and rejects duplicates', () => {
  const id = testPredictions[0].id;
  const first = predictEngine.recordFeedback(id, 'useful');
  assert.ok(first.ok && first.recorded, 'first submission recorded');
  const second = predictEngine.recordFeedback(id, 'useful');
  assert.ok(second.ok && second.duplicate === true && second.recorded === false, 'duplicate submission is ignored');
  const fb = predictEngine.getPredictionFeedback(id);
  assert.equal(fb.filter(f => f.feedback === 'useful').length, 1, 'only one row stored');
});

test('recordOutcome updates status and preserves the outcome', () => {
  const id = testPredictions[0].id;
  const result = predictEngine.recordOutcome(id, 'confirmed');
  assert.ok(result.ok, 'outcome ok');
  const p = predictEngine.getPrediction(id);
  assert.equal(p.status, 'confirmed', 'status updated');
  assert.equal(p.outcome, 'confirmed', 'outcome recorded');
});

test('dismissPrediction sets dismissed status', () => {
  const id = testPredictions[1].id;
  assert.ok(predictEngine.dismissPrediction(id).ok, 'dismiss ok');
  assert.equal(predictEngine.getPrediction(id).status, 'dismissed', 'status updated');
});

test('a dismissed identity is not silently recreated', () => {
  const dismissed = predictEngine.getPrediction(testPredictions[1].id);
  const result = predictEngine.analyze({ project: PROJECT });
  const rows = db.prepare("SELECT COUNT(*) AS cnt FROM predictions WHERE identity_key = ?").get(dismissed.identity_key).cnt;
  assert.equal(rows, 1, 'the dismissed identity keeps exactly one row');
  assert.equal(predictEngine.getPrediction(dismissed.id).status, 'dismissed', 'the user decision is preserved');
  assertOk((result.rejected_by_reason.dismissed_by_user || 0) >= 1, 'suppression is reported with a reason');
});

test('a recorded outcome is never silently rewritten', () => {
  const confirmed = predictEngine.getPrediction(testPredictions[0].id);
  predictEngine.analyze({ project: PROJECT });
  const after = predictEngine.getPrediction(testPredictions[0].id);
  assert.equal(after.status, 'confirmed', 'confirmed history is preserved');
  assert.equal(after.outcome, 'confirmed', 'outcome untouched');
  assert.equal(confirmed.outcome_at, after.outcome_at, 'outcome timestamp untouched');
});

console.log('LC.8: feedback scope');
test('feedback is scoped and the no-project case uses IS NULL', () => {
  const RV = predictEngine.RULE_VERSION;
  db.prepare("DELETE FROM prediction_feedback").run();

  // Global (project-less) feedback must actually match the no-project case.
  db.prepare("INSERT INTO prediction_feedback (prediction_id, feedback, project, rule_version, scope_key, created_at) VALUES (?,?,NULL,?,?,?)")
    .run('p-global-1', 'incorrect', RV, 'next_action', new Date().toISOString());
  const noProject = predictEngine.feedbackWeight(null, RV, 'next_action');
  assert.ok(noProject < 0, `no-project feedback must apply, got ${noProject}`);

  // It must not leak into a named project's scope.
  assert.equal(predictEngine.feedbackWeight('some_project', RV, 'next_action'), 0,
    'project-scoped weighting ignores global feedback rows');

  // Nor into an unrelated prediction type.
  assert.equal(predictEngine.feedbackWeight(null, RV, 'likely_failure'), 0,
    'feedback affects only the rule and scope it was given for');
});

test('repeated feedback cannot drive a large global adjustment', () => {
  const RV = predictEngine.RULE_VERSION;
  db.prepare("DELETE FROM prediction_feedback").run();
  const stmt = db.prepare("INSERT INTO prediction_feedback (prediction_id, feedback, project, rule_version, scope_key, created_at) VALUES (?,?,NULL,?,?,?)");
  for (let i = 0; i < 50; i++) stmt.run(`p-${i}`, 'incorrect', RV, 'next_action', new Date().toISOString());
  const w = predictEngine.feedbackWeight(null, RV, 'next_action');
  assert.ok(w >= -0.1, `adjustment is bounded, got ${w}`);

  db.prepare("DELETE FROM prediction_feedback").run();
  const same = db.prepare("INSERT INTO prediction_feedback (prediction_id, feedback, project, rule_version, scope_key, created_at) VALUES ('same-pred',?,NULL,?,?,?)");
  for (let i = 0; i < 20; i++) same.run('incorrect', RV, 'next_action', new Date().toISOString());
  const repeated = predictEngine.feedbackWeight(null, RV, 'next_action');
  assert.ok(Math.abs(repeated) <= 0.08 + 1e-9,
    `twenty rows on one prediction count once, got ${repeated}`);
  db.prepare("DELETE FROM prediction_feedback").run();
});

console.log('LC.9: contradicted predictions are transitioned, not wrapped');
test('stale handling never creates recursive meta-predictions', () => {
  // Fresh scope: earlier tests deliberately drove this project's predictions
  // into terminal states, so seed an independent one.
  const STALE_PROJECT = 'predict_stale_project';
  for (let i = 0; i < 3; i++) {
    dbStore.appendToolLog({ t: iso(50000 + i * 1000), n: 'alpha', ok: true, src: 'mcp', session_id: `stale-${i}`, project: STALE_PROJECT, s: 'a' });
    dbStore.appendToolLog({ t: iso(50000 + i * 1000 + 500), n: 'beta', ok: true, src: 'mcp', session_id: `stale-${i}`, project: STALE_PROJECT, s: 'b' });
  }
  const seeded = predictEngine.analyze({ project: STALE_PROJECT });
  assertOk(seeded.created >= 1, 'seeded an active prediction');

  const active = predictEngine.listPredictions({ project: STALE_PROJECT, status: 'active', limit: 10 });
  assertOk(active.length >= 1, 'an active prediction exists');
  const target = active[0];

  predictEngine.recordFeedback(target.id, 'incorrect');
  const result = predictEngine.analyze({ project: STALE_PROJECT });

  const after = predictEngine.getPrediction(target.id);
  assert.equal(after.status, 'superseded', 'the original record is transitioned');
  assert.equal(after.lifecycle_reason, 'contradicted_by_feedback', 'the reason is recorded on the original');
  assert.ok(result.superseded >= 1, 'the analysis reports the transition');

  const all = db.prepare('SELECT subject, type FROM predictions').all();
  assert.equal(all.filter(r => r.type === 'stale_or_contradicted').length, 0,
    'no prediction-about-a-prediction is created');
  assert.equal(all.filter(r => /Prediction may be stale/.test(r.subject)).length, 0,
    'no recursive "Prediction may be stale: ..." subjects');
});

test('a scoped analysis does not transition another project\'s predictions', () => {
  const OTHER = 'predict_other_project';
  for (let i = 0; i < 3; i++) {
    dbStore.appendToolLog({ t: iso(70000 + i * 1000), n: 'gamma', ok: true, src: 'mcp', session_id: `other-${i}`, project: OTHER, s: 'g' });
    dbStore.appendToolLog({ t: iso(70000 + i * 1000 + 500), n: 'delta', ok: true, src: 'mcp', session_id: `other-${i}`, project: OTHER, s: 'd' });
  }
  assertOk(predictEngine.analyze({ project: OTHER }).created >= 1, 'seeded the other project');
  const target = predictEngine.listPredictions({ project: OTHER, status: 'active', limit: 5 })[0];
  assertOk(target, 'other project has an active prediction');

  // Contradict it, then analyze a *different* project.
  predictEngine.recordFeedback(target.id, 'incorrect');
  predictEngine.analyze({ project: PROJECT });

  assert.equal(predictEngine.getPrediction(target.id).status, 'active',
    'an out-of-scope prediction is untouched by another project\'s analysis');

  // Analyzing its own scope does transition it.
  predictEngine.analyze({ project: OTHER });
  assert.equal(predictEngine.getPrediction(target.id).status, 'superseded',
    'the owning scope performs the transition');
});

console.log('LC.10: retention keeps terminal records until an explicit purge');
test('terminal records are retained by analysis', () => {
  const terminal = db.prepare(
    `SELECT COUNT(*) AS cnt FROM predictions WHERE status IN ('expired','superseded','dismissed','confirmed','did_not_occur')`
  ).get().cnt;
  assertOk(terminal >= 1, 'terminal records exist');
  predictEngine.analyze({ project: PROJECT });
  const after = db.prepare(
    `SELECT COUNT(*) AS cnt FROM predictions WHERE status IN ('expired','superseded','dismissed','confirmed','did_not_occur')`
  ).get().cnt;
  assert.ok(after >= terminal, 'analysis never deletes terminal records');
});

test('purge_preview does not mutate any data', () => {
  const snapshot = () => ({
    predictions: db.prepare('SELECT COUNT(*) AS c FROM predictions').get().c,
    evidence: db.prepare('SELECT COUNT(*) AS c FROM prediction_evidence').get().c,
    feedback: db.prepare('SELECT COUNT(*) AS c FROM prediction_feedback').get().c,
    audit: db.prepare('SELECT COUNT(*) AS c FROM prediction_audit').get().c,
  });
  const before = snapshot();
  const preview = predictEngine.purgePreview({ retention_days: 0 });
  assert.ok(preview.ok && preview.preview === true, 'preview flag set');
  assert.ok(preview.would_delete, 'reports what would be deleted');
  assert.ok(preview.totals_before, 'reports counts by table');
  assert.deepStrictEqual(snapshot(), before, 'preview is strictly read-only');
});

test('purge requires explicit confirmation', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM predictions').get().c;
  const refused = predictEngine.purge({ retention_days: 0 });
  assert.equal(refused.ok, false, 'purge without confirm is refused');
  assert.ok(/confirm/i.test(refused.error), 'the error explains confirmation is required');
  assert.equal(predictEngine.purge({ retention_days: 0, confirm: 'yes' }).ok, false, 'only boolean true confirms');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM predictions').get().c, before, 'nothing deleted');
});

// Inserts a terminal, feedback-free, non-legacy prediction that retention policy
// permits deleting.
function seedPurgeableRecord(id, identity) {
  const old = new Date(T0 - 10 * 86400000).toISOString();
  db.prepare(`
    INSERT INTO predictions (id, type, subject, explanation, project, time_horizon, probability,
      confidence, score_breakdown_json, status, identity_key, rule_version, observation_count,
      created_at, updated_at, enabled)
    VALUES (?, 'next_action', 'purge me', 'purge me', ?, 'current_session', 0.5, 'medium', '{}',
      'expired', ?, ?, 1, ?, ?, 1)
  `).run(id, PROJECT, identity, predictEngine.RULE_VERSION, old, old);
  db.prepare("INSERT INTO prediction_evidence (id, prediction_id, source_type, summary, created_at) VALUES (?, ?, 'tool_call', 'x', ?)")
    .run('evi_' + id, id, old);
  return id;
}

test('purge preserves records required by policy', () => {
  // Give a terminal record feedback so policy must keep it.
  const dismissed = db.prepare("SELECT * FROM predictions WHERE status = 'dismissed' LIMIT 1").get();
  assertOk(dismissed, 'a dismissed record exists');
  db.prepare("INSERT INTO prediction_feedback (prediction_id, feedback, project, rule_version, created_at) VALUES (?, 'not_useful', ?, ?, ?)")
    .run(dismissed.id, PROJECT, predictEngine.RULE_VERSION, new Date().toISOString());

  const confirmed = db.prepare("SELECT * FROM predictions WHERE status = 'confirmed' LIMIT 1").get();
  assertOk(confirmed, 'a confirmed record exists');

  // Ensure the purge actually has work to do, so this exercises the real path.
  seedPurgeableRecord('pred_policy_probe', 'policy-probe-identity');

  const feedbackBefore = db.prepare('SELECT COUNT(*) AS c FROM prediction_feedback').get().c;
  const result = predictEngine.purge({ retention_days: 0, confirm: true });
  assert.ok(result.ok, 'purge executed');
  assert.ok(result.deleted.predictions >= 1,
    'the purge actually deleted something, so the preservation assertions are meaningful');

  assertOk(predictEngine.getPrediction(confirmed.id), 'confirmed records are never purged');
  assertOk(predictEngine.getPrediction(dismissed.id), 'records carrying feedback are never purged');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM prediction_feedback').get().c, feedbackBefore,
    'feedback rows are always retained for rule-quality evaluation');
  assert.equal(result.deleted.prediction_feedback, 0, 'purge reports that no feedback was deleted');
  assert.ok(result.totals_before && result.totals_after, 'counts reported before and after');
});

test('purge deletes eligible terminal records and their children', () => {
  // A terminal record with no feedback and no protective status.
  const id = seedPurgeableRecord('pred_purge_me', 'purge-me-identity');

  const preview = predictEngine.purgePreview({ retention_days: 0 });
  assert.ok(preview.would_delete.predictions >= 1, 'preview counts the eligible record');

  const auditBefore = db.prepare("SELECT COUNT(*) AS c FROM prediction_audit WHERE event_type = 'purged'").get().c;
  const result = predictEngine.purge({ retention_days: 0, confirm: true });
  assert.ok(result.deleted.predictions >= 1, 'the eligible record is deleted');
  assert.equal(predictEngine.getPrediction(id), null, 'record is gone');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM prediction_evidence WHERE prediction_id = ?").get(id).c, 0,
    'child evidence is removed with it');
  const auditAfter = db.prepare("SELECT COUNT(*) AS c FROM prediction_audit WHERE event_type = 'purged'").get().c;
  assert.equal(auditAfter - auditBefore, 1, 'exactly one audit row for the whole purge, not one per record');
});

test('degenerate retention_days values fall back to the configured default', () => {
  const configured = predictEngine.engineStatus().config.retention_days;
  // Number(null), Number(''), Number([]) and Number(false) are all 0, which would
  // silently mean "purge everything"; a negative would push the cutoff into the future.
  for (const bad of [null, '', [], false, -1, -36500, 'abc', {}, NaN, Infinity]) {
    const preview = predictEngine.purgePreview({ retention_days: bad });
    assert.equal(preview.retention_days, configured,
      `retention_days=${JSON.stringify(bad)} must fall back to the default, got ${preview.retention_days}`);
  }
  // A genuine 0 remains valid.
  assert.equal(predictEngine.purgePreview({ retention_days: 0 }).retention_days, 0,
    'zero is a legitimate retention period');
  assert.equal(predictEngine.isValidRetentionDays(undefined), true, 'omitted is valid');
  assert.equal(predictEngine.isValidRetentionDays(null), false, 'null is rejected at the boundary');
  assert.equal(predictEngine.isValidRetentionDays(-1), false, 'negative is rejected at the boundary');
});

test('a negative retention cannot widen the purge beyond policy', () => {
  const id = seedPurgeableRecord('pred_negative_probe', 'negative-probe-identity');
  // With the configured 90-day default this 10-day-old record is not eligible.
  const result = predictEngine.purge({ retention_days: -36500, confirm: true });
  assert.ok(result.ok, 'purge ran');
  assert.equal(result.retention_days, predictEngine.engineStatus().config.retention_days,
    'the negative value was rejected in favour of the default');
  assertOk(predictEngine.getPrediction(id), 'the recent terminal record survived');
  db.prepare('DELETE FROM prediction_evidence WHERE prediction_id = ?').run(id);
  db.prepare('DELETE FROM predictions WHERE id = ?').run(id);
});

test('purge_preview handles a backlog larger than the SQLite variable limit', () => {
  const old = new Date(T0 - 10 * 86400000).toISOString();
  const ins = db.prepare(`
    INSERT INTO predictions (id, type, subject, explanation, project, time_horizon, probability,
      confidence, score_breakdown_json, status, identity_key, rule_version, observation_count,
      created_at, updated_at, enabled)
    VALUES (?, 'next_action', 'bulk', 'bulk', ?, 'current_session', 0.5, 'medium', '{}',
      'expired', ?, ?, 1, ?, ?, 1)
  `);
  const ev = db.prepare("INSERT INTO prediction_evidence (id, prediction_id, source_type, summary, created_at) VALUES (?, ?, 'tool_call', 'x', ?)");
  const bulk = db.transaction(() => {
    for (let i = 0; i < 1200; i++) {
      ins.run(`pred_bulk_${i}`, PROJECT, `bulk-identity-${i}`, predictEngine.RULE_VERSION, old, old);
      ev.run(`evi_bulk_${i}`, `pred_bulk_${i}`, old);
    }
  });
  bulk();

  const preview = predictEngine.purgePreview({ retention_days: 0 });
  assert.ok(preview.ok, 'preview succeeds above the parameter limit');
  assert.ok(preview.would_delete.predictions >= 1200, `counted ${preview.would_delete.predictions} predictions`);
  assert.ok(preview.would_delete.prediction_evidence >= 1200, `counted ${preview.would_delete.prediction_evidence} evidence rows`);

  const result = predictEngine.purge({ retention_days: 0, confirm: true });
  assert.ok(result.deleted.predictions >= 1200, 'the bulk purge completes');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM predictions WHERE id LIKE 'pred_bulk_%'").get().c, 0,
    'all bulk records removed');
});

test('legacy terminal rows are preserved unless purge_legacy is requested', () => {
  const old = new Date(T0 - 10 * 86400000).toISOString();
  db.prepare(`
    INSERT INTO predictions (id, type, subject, explanation, project, time_horizon, probability,
      confidence, score_breakdown_json, status, identity_key, rule_version, observation_count,
      created_at, updated_at, legacy, enabled)
    VALUES ('pred_legacy_probe', 'next_action', 'legacy', 'legacy', ?, 'current_session', 0.5,
      'medium', '{}', 'expired', 'legacy-probe-identity', 'legacy', 1, ?, ?, 1, 1)
  `).run(PROJECT, old, old);

  const defaultPreview = predictEngine.purgePreview({ retention_days: 0 });
  assertOk((defaultPreview.preserved.by_reason.legacy_record || 0) >= 1,
    'legacy rows are reported as preserved by policy');
  predictEngine.purge({ retention_days: 0, confirm: true });
  assertOk(predictEngine.getPrediction('pred_legacy_probe'), 'a default purge preserves legacy rows');

  const optIn = predictEngine.purgePreview({ retention_days: 0, purge_legacy: true });
  assertOk(optIn.would_delete.predictions >= 1, 'opting in makes the legacy row eligible');
  const result = predictEngine.purge({ retention_days: 0, confirm: true, purge_legacy: true });
  assert.ok(result.deleted.predictions >= 1, 'the legacy row is deleted when explicitly requested');
  assert.equal(predictEngine.getPrediction('pred_legacy_probe'), null, 'legacy row removed');
});

console.log('LC.11: diagnostics and status');
test('diagnose is read-only and reports v1 data quality', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM predictions').get().c;
  const d = predictEngine.diagnose();
  assert.ok(d.ok && d.read_only === true, 'marked read-only');
  assert.ok(Array.isArray(d.by_type) && Array.isArray(d.by_status), 'breakdowns present');
  assert.ok(d.null_scope && typeof d.null_scope.null_project === 'number', 'null scope counts present');
  assert.ok(d.amplification && typeof d.amplification.evidence_per_prediction === 'number', 'amplification reported');
  assert.ok('likely_low_quality_v1_records' in d, 'low-quality v1 count reported');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM predictions').get().c, before, 'nothing mutated');
});

test('engineStatus reports the real analysis summary and retention', () => {
  const s = predictEngine.engineStatus();
  assert.ok(typeof s.active === 'number' && typeof s.terminal === 'number' && typeof s.total === 'number', 'counts present');
  assert.ok(s.last_analyzed, 'last analysis timestamp present');
  assert.ok(s.last_analysis_scope && s.last_analysis_scope.mode, 'scope of last analysis reported');
  assert.ok(s.last_analysis_summary, 'summary of last analysis reported');
  assert.ok(typeof s.last_analysis_summary.candidates_considered === 'number', 'candidates considered');
  assert.ok(s.last_analysis_summary.rejected_by_reason, 'rejections by reason');
  assert.equal(s.retention_days, predictEngine.engineStatus().config.retention_days, 'retention is the configured value');
  assert.ok(s.last_purge, 'last purge is reported after a purge ran');
});

test('migrateLegacy is idempotent', () => {
  const r1 = predictEngine.migrateLegacy();
  assert.ok(typeof r1.migrated === 'number', 'first call returns a count');
  const r2 = predictEngine.migrateLegacy();
  assert.ok(typeof r2.migrated === 'number', 'second call returns a count');
});

test('dismiss on a nonexistent ID returns an error', () => {
  const result = predictEngine.dismissPrediction('nonexistent_id');
  assert.ok(result.ok === false || result.error, 'returns error for unknown ID');
});

console.log('\nPredict Lifecycle tests: ' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
