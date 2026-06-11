const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DATA_DIR = path.join(__dirname, 'test-data-new');
if (!fs.existsSync(TEST_DATA_DIR)) {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;

delete require.cache[require.resolve('../src/tools')];
const { TOOLS, setSource } = require('../src/tools');
const { sidekick_search, sidekick_git, sidekick_notify } = TOOLS;

console.log('Running New Tools Tests...\n');

(async () => {
  try {
    setSource('test');

    // Test sidekick_search
    console.log('Test: sidekick_search - find pattern in files');
    const searchResult = await sidekick_search({ 
      pattern: 'sidekick_bash', 
      path: path.join(__dirname, '..', 'src'),
      include: '*.js'
    });
    assert.ok(!searchResult.isError, 'Search should succeed');
    assert.ok(searchResult.content[0].text.includes('sidekick_bash'), 'Should find sidekick_bash');
    console.log('✓ Passed\n');

    // Test sidekick_search - no matches
    console.log('Test: sidekick_search - no matches');
    const noMatchResult = await sidekick_search({ 
      pattern: 'thispatternwillnevermatch12345xyz', 
      path: path.join(__dirname, '..', 'src')
    });
    assert.ok(!noMatchResult.isError, 'Should not be error');
    assert.ok(
      noMatchResult.content[0].text.includes('No matches') || 
      noMatchResult.content[0].text.includes('no matches'),
      'Should indicate no matches'
    );
    console.log('✓ Passed\n');

    // Test sidekick_search - invalid path
    console.log('Test: sidekick_search - invalid path');
    const invalidPathResult = await sidekick_search({ 
      pattern: 'test', 
      path: '/nonexistent/path/xyz'
    });
    assert.ok(invalidPathResult.isError, 'Should return error for invalid path');
    assert.ok(invalidPathResult.content[0].text.includes('not found'), 'Should mention path not found');
    console.log('✓ Passed\n');

    // Test sidekick_git - status
    console.log('Test: sidekick_git - status');
    const gitStatusResult = await sidekick_git({ 
      action: 'status', 
      path: path.join(__dirname, '..')
    });
    assert.ok(!gitStatusResult.isError, 'Git status should succeed');
    assert.ok(
      gitStatusResult.content[0].text.includes('branch') || 
      gitStatusResult.content[0].text.includes('On branch') ||
      gitStatusResult.content[0].text.includes('nothing to commit'),
      'Should contain git status output'
    );
    console.log('✓ Passed\n');

    // Test sidekick_git - log
    console.log('Test: sidekick_git - log');
    const gitLogResult = await sidekick_git({ 
      action: 'log', 
      path: path.join(__dirname, '..'),
      args: '--oneline -5'
    });
    assert.ok(!gitLogResult.isError, 'Git log should succeed');
    console.log('✓ Passed\n');

    // Test sidekick_git - invalid action
    console.log('Test: sidekick_git - invalid action');
    const invalidActionResult = await sidekick_git({ 
      action: 'invalid_action', 
      path: path.join(__dirname, '..')
    });
    assert.ok(invalidActionResult.isError, 'Should return error for invalid action');
    assert.ok(invalidActionResult.content[0].text.includes('Invalid action'), 'Should mention invalid action');
    console.log('✓ Passed\n');

    // Test sidekick_git - invalid path
    console.log('Test: sidekick_git - invalid path');
    const invalidRepoResult = await sidekick_git({ 
      action: 'status', 
      path: '/nonexistent/repo/xyz'
    });
    assert.ok(invalidRepoResult.isError, 'Should return error for invalid repo path');
    assert.ok(invalidRepoResult.content[0].text.includes('not found'), 'Should mention path not found');
    console.log('✓ Passed\n');

    // Test sidekick_notify - missing webhook
    console.log('Test: sidekick_notify - discord without webhook');
    const noWebhookResult = await sidekick_notify({ 
      channel: 'discord', 
      message: 'test'
    });
    assert.ok(noWebhookResult.isError, 'Should return error without webhook');
    assert.ok(noWebhookResult.content[0].text.includes('webhook_url required'), 'Should mention webhook required');
    console.log('✓ Passed\n');

    // Test sidekick_notify - email without recipient
    console.log('Test: sidekick_notify - email without recipient');
    const noRecipientResult = await sidekick_notify({ 
      channel: 'email', 
      message: 'test'
    });
    assert.ok(noRecipientResult.isError, 'Should return error without recipient');
    assert.ok(noRecipientResult.content[0].text.includes('recipient required'), 'Should mention recipient required');
    console.log('✓ Passed\n');

    // Test sidekick_notify - invalid channel
    console.log('Test: sidekick_notify - invalid channel');
    const invalidChannelResult = await sidekick_notify({ 
      channel: 'invalid', 
      message: 'test'
    });
    assert.ok(invalidChannelResult.isError, 'Should return error for invalid channel');
    assert.ok(invalidChannelResult.content[0].text.includes('Invalid channel'), 'Should mention invalid channel');
    console.log('✓ Passed\n');

    // Clean up
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    
    console.log('All New Tools Tests Passed! ✓');
  } catch (e) {
    console.error('Test failed:', e);
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    process.exit(1);
  }
})();
