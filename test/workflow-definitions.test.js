// Workflow definition registry, static reference validation, and the runner's
// contract with the canonical execution subsystems.
//
// The runner is not a second engine: these tests assert that a definition run
// produces durable kernel workflow state, a platform execution, governed tool
// dispatch, cooperative cancellation, tolerated-failure semantics and
// checkpointed resumption.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-workflow-definitions');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_DB_FILE = path.join(TEST_DATA_DIR, 'sidekick.db');
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';
process.env.SIDEKICK_SECRET_KEY = 'workflow-definitions-test-secret-key';

require('../src/db').runPendingMigrations();

const definition = require('../src/workflows/definition');
const repository = require('../src/workflows/repository');
const runner = require('../src/workflows/runner');
const platformKernel = require('../src/platform/kernel');
const dbStore = require('../src/db');

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

function baseDefinition(overrides = {}) {
  return {
    name: 'core/test-flow',
    version: '1.0.0',
    title: 'Test flow',
    description: 'A workflow definition used to exercise the runner',
    mode: 'read_only',
    inputs: { key: { type: 'string', required: true } },
    steps: [
      { name: 'store_value', tool: 'store', args: { key: '${inputs.key}', value: 'workflow-value' }, expect: 'text' },
      { name: 'read_back', tool: 'get', args: { key: '${inputs.key}' }, expect: 'text' },
    ],
    result: { stored: '${steps.read_back.text}' },
    ...overrides,
  };
}

(async () => {
  console.log('Running workflow definition tests...\n');

  // --- WD.1 static validation ---------------------------------------------
  await test('WD.1: a definition validates references, step names and inputs statically', async () => {
    const valid = definition.normalizeDefinition(baseDefinition());
    assert.strictEqual(valid.name, 'core/test-flow');
    assert.strictEqual(valid.steps.length, 2);

    assert.throws(
      () => definition.normalizeDefinition(baseDefinition({
        steps: [{ name: 'a', tool: 'get', args: { key: '${steps.later.text}' } }, { name: 'later', tool: 'get', args: {} }],
      })),
      /references step "later" before it runs/
    );
    assert.throws(
      () => definition.normalizeDefinition(baseDefinition({
        steps: [{ name: 'a', tool: 'get', args: { key: '${inputs.missing}' } }],
      })),
      /references undeclared input "missing"/
    );
    assert.throws(
      () => definition.normalizeDefinition(baseDefinition({
        steps: [{ name: 'a', tool: 'get', args: {} }, { name: 'a', tool: 'get', args: {} }],
      })),
      /duplicate step name/
    );
    assert.throws(
      () => definition.normalizeDefinition(baseDefinition({
        steps: [{ name: 'a', tool: 'get', args: { key: '${steps.a.nope}' } }],
      })),
      /unknown reference root|unknown step projection|before it runs/
    );
  });

  await test('WD.2: references resolve by type, not by string substitution alone', async () => {
    const scope = { inputs: { path: '/tmp' }, steps: { s: { json: { a: { b: [1, 2, 3] } }, text: 'hello', ok: true } } };
    assert.deepStrictEqual(definition.resolveValue('${steps.s.json}', scope), { a: { b: [1, 2, 3] } });
    assert.strictEqual(definition.resolveValue('${steps.s.json.a.b[1]}', scope), 2);
    assert.strictEqual(definition.resolveValue('prefix ${steps.s.text}', scope), 'prefix hello');
    assert.strictEqual(definition.resolveValue('${steps.s.ok}', scope), true);
    // An unresolved key is dropped rather than becoming the string "undefined".
    assert.deepStrictEqual(definition.resolveValue({ a: '${steps.s.json.missing}' }, scope), {});
  });

  // --- WD.3 registry and ownership ----------------------------------------
  await test('WD.3: definitions register, list and enforce ownership', async () => {
    const record = repository.registerWorkflowDefinition(baseDefinition(), { ownerKind: 'core' });
    assert.strictEqual(record.name, 'core/test-flow');
    assert.strictEqual(record.state, 'registered');
    assert.strictEqual(record.owner_kind, 'core');
    assert.match(record.checksum, /^[a-f0-9]{64}$/);

    assert.throws(
      () => repository.registerWorkflowDefinition(baseDefinition(), { ownerKind: 'pack', ownerName: 'other-pack' }),
      /already owned by core/
    );

    // Re-registering with the same owner replaces the definition (the pack
    // upgrade path) without duplicating the row.
    const replaced = repository.registerWorkflowDefinition(baseDefinition({ version: '1.1.0', title: 'Test flow v2' }), { ownerKind: 'core' });
    assert.strictEqual(replaced.version, '1.1.0');
    assert.strictEqual(replaced.title, 'Test flow v2');
    assert.strictEqual(repository.listWorkflowDefinitions().filter(d => d.name === 'core/test-flow').length, 1);
  });

  // --- WD.4 the run drives the canonical subsystems ------------------------
  let firstRun;
  await test('WD.4: a run creates durable kernel workflow state and a platform execution', async () => {
    firstRun = await runner.runWorkflowDefinition('core/test-flow', { key: 'wf-test-key' }, { project: 'workflow-suite' });
    assert.strictEqual(firstRun.status, 'completed', JSON.stringify(firstRun.steps));
    assert.strictEqual(firstRun.ok, true);
    assert.strictEqual(firstRun.steps.length, 2);
    assert.ok(firstRun.result.stored.includes('workflow-value'), firstRun.result.stored);

    const workflow = platformKernel.getWorkflow(firstRun.run_id);
    assert.strictEqual(workflow.state, 'completed');
    assert.strictEqual(workflow.total_steps, 2);
    assert.strictEqual(workflow.current_step, 2);
    assert.deepStrictEqual(workflow.steps.map(step => step.state), ['completed', 'completed']);
    assert.deepStrictEqual(workflow.steps.map(step => step.tool_name), ['store', 'get']);

    const execution = platformKernel.getExecution(firstRun.execution_id);
    assert.strictEqual(execution.state, 'completed');
    assert.strictEqual(execution.operation_type, 'workflow_definition_run');
    assert.strictEqual(execution.project_id, 'workflow_suite');
    const runnerSession = dbStore.getDb().prepare('SELECT * FROM platform_runner_sessions WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 1').get(firstRun.run_id);
    assert.ok(runnerSession, 'workflow run creates a durable runner session');
    assert.strictEqual(runnerSession.state, 'completed');

    // Checkpointed state is durable.
    const checkpoint = JSON.parse(workflow.checkpoint_json);
    assert.strictEqual(checkpoint.next_step, 2);
    assert.deepStrictEqual(checkpoint.inputs, { key: 'wf-test-key' });
    assert.ok(checkpoint.steps.store_value.ok);
  });

  await test('WD.5: every step is dispatched through the audited tool path', async () => {
    const rows = dbStore.getDb()
      .prepare("SELECT tool_name FROM tool_logs WHERE tool_name IN ('store','get') ORDER BY id DESC LIMIT 4")
      .all()
      .map(row => row.tool_name);
    assert.ok(rows.includes('store'), 'the store step was audited');
    assert.ok(rows.includes('get'), 'the get step was audited');
  });

  // --- WD.6 tolerated failures --------------------------------------------
  await test('WD.6: a tolerated failure is recorded as failed but does not stop the run', async () => {
    repository.registerWorkflowDefinition({
      name: 'core/tolerant-flow',
      version: '1.0.0',
      title: 'Tolerant flow',
      description: 'Continues past a failing step',
      inputs: {},
      steps: [
        { name: 'missing_file', tool: 'read', args: { path: '/nonexistent/definitely-not-here.txt' }, expect: 'text', on_error: 'continue' },
        { name: 'after', tool: 'get', args: { key: 'wf-test-key' }, expect: 'text' },
      ],
      result: { first_ok: '${steps.missing_file.ok}', after: '${steps.after.text}' },
    }, { ownerKind: 'core' });

    const run = await runner.runWorkflowDefinition('core/tolerant-flow', {});
    assert.strictEqual(run.status, 'completed');
    assert.strictEqual(run.steps[0].status, 'failed');
    assert.strictEqual(run.steps[1].status, 'ok');
    assert.strictEqual(run.result.first_ok, false);

    // Durable state agrees: the step is failed, the workflow still completed.
    const workflow = platformKernel.getWorkflow(run.run_id);
    assert.strictEqual(workflow.state, 'completed');
    assert.deepStrictEqual(workflow.steps.map(step => step.state), ['failed', 'completed']);
    assert.strictEqual(workflow.current_step, 2, 'the cursor advanced past the tolerated failure');
  });

  await test('WD.7: an untolerated failure stops the run and fails the workflow', async () => {
    repository.registerWorkflowDefinition({
      name: 'core/strict-flow',
      version: '1.0.0',
      title: 'Strict flow',
      description: 'Stops on the first failure',
      inputs: {},
      steps: [
        { name: 'missing_file', tool: 'read', args: { path: '/nonexistent/definitely-not-here.txt' }, expect: 'text', on_error: 'fail' },
        { name: 'never_runs', tool: 'get', args: { key: 'wf-test-key' }, expect: 'text' },
      ],
      result: {},
    }, { ownerKind: 'core' });

    const run = await runner.runWorkflowDefinition('core/strict-flow', {});
    assert.strictEqual(run.status, 'failed');
    assert.strictEqual(run.ok, false);
    assert.strictEqual(run.steps.length, 1, 'the run stopped at the failing step');
    assert.strictEqual(run.failure.step, 'missing_file');

    const workflow = platformKernel.getWorkflow(run.run_id);
    assert.strictEqual(workflow.state, 'failed');
    assert.strictEqual(workflow.steps[0].state, 'failed');
    assert.strictEqual(workflow.steps[1].state, 'pending', 'the later step never ran');
    const execution = platformKernel.getExecution(run.execution_id);
    assert.strictEqual(execution.state, 'failed');
  });

  // --- WD.8 conditions -----------------------------------------------------
  await test('WD.8: a step whose condition is not met is skipped and recorded', async () => {
    repository.registerWorkflowDefinition({
      name: 'core/conditional-flow',
      version: '1.0.0',
      title: 'Conditional flow',
      description: 'Skips an optional step',
      inputs: { optional: { type: 'string', required: false } },
      steps: [
        { name: 'maybe', tool: 'get', args: { key: '${inputs.optional}' }, when: '${inputs.optional}', expect: 'text' },
        { name: 'always', tool: 'get', args: { key: 'wf-test-key' }, expect: 'text' },
      ],
      result: { skipped: '${steps.maybe.ok}' },
    }, { ownerKind: 'core' });

    const run = await runner.runWorkflowDefinition('core/conditional-flow', {});
    assert.strictEqual(run.status, 'completed');
    assert.strictEqual(run.steps[0].status, 'skipped');
    assert.strictEqual(run.steps[1].status, 'ok');
    const workflow = platformKernel.getWorkflow(run.run_id);
    assert.strictEqual(workflow.current_step, 2, 'the durable cursor stays aligned across a skipped step');
    assert.match(workflow.steps[0].result_summary, /^skipped: condition not met/);
  });

  // --- WD.9 input validation ----------------------------------------------
  await test('WD.9: inputs are validated before anything executes', async () => {
    const missing = await runner.runWorkflowDefinition('core/test-flow', {});
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.code, 'invalid_inputs');
    assert.ok(missing.errors.some(error => /input "key" is required/.test(error)));

    const unknown = await runner.runWorkflowDefinition('core/test-flow', { key: 'x', bogus: 1 });
    assert.strictEqual(unknown.code, 'invalid_inputs');
    assert.ok(/unknown input/.test(unknown.error));
  });

  // --- WD.10 disabled definitions -----------------------------------------
  await test('WD.10: a disabled definition is not runnable but is not destroyed', async () => {
    repository.setWorkflowDefinitionState('core/test-flow', 'disabled');
    const blocked = await runner.runWorkflowDefinition('core/test-flow', { key: 'wf-test-key' });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.code, 'workflow_unavailable');
    assert.ok(repository.getWorkflowDefinition('core/test-flow'), 'the definition is retained');
    repository.setWorkflowDefinitionState('core/test-flow', 'registered');
    const restored = await runner.runWorkflowDefinition('core/test-flow', { key: 'wf-test-key' });
    assert.strictEqual(restored.status, 'completed');
  });

  // --- WD.11 cancellation --------------------------------------------------
  await test('WD.11: a cancel request stops the run at the next step boundary', async () => {
    repository.registerWorkflowDefinition({
      name: 'core/cancellable-flow',
      version: '1.0.0',
      title: 'Cancellable flow',
      description: 'Used to prove cooperative cancellation',
      inputs: {},
      steps: [
        { name: 'first', tool: 'get', args: { key: 'wf-test-key' }, expect: 'text' },
        { name: 'second', tool: 'get', args: { key: 'wf-test-key' }, expect: 'text' },
        { name: 'third', tool: 'get', args: { key: 'wf-test-key' }, expect: 'text' },
      ],
      result: {},
    }, { ownerKind: 'core' });

    // Request cancellation from "another process" as soon as the run's
    // execution exists, by intercepting the first dispatched step.
    const originalGet = platformKernel.getExecutionClaim;
    let seen = 0;
    platformKernel.getExecutionClaim = function patched(executionId) {
      const claim = originalGet.call(this, executionId);
      seen++;
      // Report a cancel request from the second boundary onward.
      if (claim && seen >= 2) return { ...claim, cancel_requested: true };
      return claim;
    };
    try {
      const run = await runner.runWorkflowDefinition('core/cancellable-flow', {});
      assert.strictEqual(run.status, 'cancelled', JSON.stringify(run.steps));
      assert.ok(run.steps.length < 3, 'the run stopped before every step executed');
      const execution = platformKernel.getExecution(run.execution_id);
      assert.strictEqual(execution.state, 'cancelled');
    } finally {
      platformKernel.getExecutionClaim = originalGet;
    }
  });

  // --- WD.12 removal -------------------------------------------------------
  await test('WD.12: removing a definition leaves historical runs intact', async () => {
    const runId = firstRun.run_id;
    repository.removeWorkflowDefinition('core/test-flow');
    assert.strictEqual(repository.getWorkflowDefinition('core/test-flow'), null);
    const historical = platformKernel.getWorkflow(runId);
    assert.ok(historical, 'the historical run record survives');
    assert.strictEqual(historical.state, 'completed');
    const unknown = await runner.runWorkflowDefinition('core/test-flow', { key: 'x' });
    assert.strictEqual(unknown.code, 'unknown_workflow');
  });

  console.log(`\n${failures === 0 ? 'All workflow definition tests passed.' : `${failures} workflow definition test(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
