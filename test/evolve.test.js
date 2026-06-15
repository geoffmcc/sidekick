const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-evolve');
if (!fs.existsSync(TEST_DATA_DIR)) {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

delete require.cache[require.resolve('../src/tools')];
const { TOOLS, setSource } = require('../src/tools');
const { sidekick_evolve } = TOOLS;

console.log('Running Evolve Tests...\n');

(async () => {
  try {
    setSource('test');

    // Test cleanup action - preview mode
    console.log('Test: sidekick_evolve - cleanup preview');
    const previewResult = await sidekick_evolve({ action: 'cleanup' });
    assert.ok(!previewResult.isError, 'Cleanup preview should succeed');
    assert.ok(previewResult.content[0].text.includes('Cleanup Preview'), 'Should show cleanup preview');
    console.log('✓ Passed\n');

    // Test cleanup action - confirm mode (with no old entries)
    console.log('Test: sidekick_evolve - cleanup confirm (no old entries)');
    const confirmResult = await sidekick_evolve({ action: 'cleanup', confirm: true });
    assert.ok(!confirmResult.isError, 'Cleanup confirm should succeed');
    assert.ok(
      confirmResult.content[0].text.includes('Deleted') || 
      confirmResult.content[0].text.includes('No entries'),
      'Should report cleanup result'
    );
    console.log('✓ Passed\n');

    // Test analyze action
    console.log('Test: sidekick_evolve - analyze');
    const analyzeResult = await sidekick_evolve({ action: 'analyze' });
    assert.ok(!analyzeResult.isError, 'Analyze should succeed');
    assert.ok(
      analyzeResult.content[0].text.includes('Tool Usage Analysis') ||
      analyzeResult.content[0].text.includes('No frequent patterns'),
      'Should return analysis or indicate no patterns'
    );
    console.log('✓ Passed\n');

    // Test list action
    console.log('Test: sidekick_evolve - list');
    const listResult = await sidekick_evolve({ action: 'list' });
    assert.ok(!listResult.isError, 'List should succeed');
    assert.ok(
      listResult.content[0].text.includes('Proposals') ||
      listResult.content[0].text.includes('No proposals'),
      'Should list proposals or indicate none'
    );
    console.log('✓ Passed\n');

    // Test report action
    console.log('Test: sidekick_evolve - report');
    const reportResult = await sidekick_evolve({ action: 'report' });
    assert.ok(!reportResult.isError, 'Report should succeed');
    assert.ok(reportResult.content[0].text.includes('Evolve Report'), 'Should show evolve report');
    console.log('✓ Passed\n');

    // Test invalid action
    console.log('Test: sidekick_evolve - invalid action');
    const invalidResult = await sidekick_evolve({ action: 'invalid_action' });
    assert.ok(invalidResult.isError, 'Should return error for invalid action');
    assert.ok(invalidResult.content[0].text.includes('Unknown action'), 'Should mention unknown action');
    console.log('✓ Passed\n');

    // Clean up
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    
    console.log('All Evolve Tests Passed! ✓');
  } catch (e) {
    console.error('Test failed:', e);
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    process.exit(1);
  }
})();
