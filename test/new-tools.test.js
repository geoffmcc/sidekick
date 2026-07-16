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
const { search, git, notify } = TOOLS;

console.log('Running New Tools Tests...\n');

(async () => {
  try {
    setSource('test');

    // Test search
    console.log('Test: search - find pattern in files');
    const searchResult = await search({ 
      pattern: 'sidekick_bash', 
      path: path.join(__dirname, '..', 'src'),
      include: '*.js'
    });
    assert.ok(!searchResult.isError, 'Search should succeed');
    assert.ok(searchResult.content[0].text.includes('sidekick_bash'), 'Should find sidekick_bash');
    console.log('✓ Passed\n');

    // Test search - no matches
    console.log('Test: search - no matches');
    const noMatchResult = await search({ 
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

    // Test search - invalid path
    console.log('Test: search - invalid path');
    const invalidPathResult = await search({ 
      pattern: 'test', 
      path: '/nonexistent/path/xyz'
    });
    assert.ok(invalidPathResult.isError, 'Should return error for invalid path');
    assert.ok(invalidPathResult.content[0].text.includes('not found'), 'Should mention path not found');
    console.log('✓ Passed\n');

    // Test git - status
    console.log('Test: git - status');
    const gitStatusResult = await git({ 
      action: 'status', 
      path: path.join(__dirname, '..')
    });
    assert.ok(!gitStatusResult.isError, 'Git status should succeed');
    assert.ok(
      gitStatusResult.content[0].text.includes('branch') || 
      gitStatusResult.content[0].text.includes('On branch') ||
      gitStatusResult.content[0].text.includes('nothing to commit') ||
      gitStatusResult.content[0].text.includes('HEAD detached'),
      'Should contain git status output'
    );
    console.log('✓ Passed\n');

    // Test git - log
    console.log('Test: git - log');
    const gitLogResult = await git({ 
      action: 'log', 
      path: path.join(__dirname, '..'),
      args: '--oneline -5'
    });
    assert.ok(!gitLogResult.isError, 'Git log should succeed');
    console.log('✓ Passed\n');

    // Test git - invalid action
    console.log('Test: git - invalid action');
    const invalidActionResult = await git({ 
      action: 'invalid_action', 
      path: path.join(__dirname, '..')
    });
    assert.ok(invalidActionResult.isError, 'Should return error for invalid action');
    assert.ok(invalidActionResult.content[0].text.includes('Invalid action'), 'Should mention invalid action');
    console.log('✓ Passed\n');

    // Test git - invalid path
    console.log('Test: git - invalid path');
    const invalidRepoResult = await git({ 
      action: 'status', 
      path: '/nonexistent/repo/xyz'
    });
    assert.ok(invalidRepoResult.isError, 'Should return error for invalid repo path');
    assert.ok(invalidRepoResult.content[0].text.includes('not found'), 'Should mention path not found');
    console.log('✓ Passed\n');

    // Test notify - missing webhook
    console.log('Test: notify - discord without webhook');
    const noWebhookResult = await notify({ 
      channel: 'discord', 
      message: 'test'
    });
    assert.ok(noWebhookResult.isError, 'Should return error without webhook');
    assert.ok(noWebhookResult.content[0].text.includes('webhook_url required'), 'Should mention webhook required');
    console.log('✓ Passed\n');

    // Test notify - email without recipient
    console.log('Test: notify - email without recipient');
    const noRecipientResult = await notify({ 
      channel: 'email', 
      message: 'test'
    });
    assert.ok(noRecipientResult.isError, 'Should return error without recipient');
    assert.ok(noRecipientResult.content[0].text.includes('recipient required'), 'Should mention recipient required');
    console.log('✓ Passed\n');

    // Test notify - invalid channel
    console.log('Test: notify - invalid channel');
    const invalidChannelResult = await notify({ 
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
