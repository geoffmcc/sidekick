const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-new-tools-'));
const REPO_ROOT = path.join(__dirname, '..');
const gitHome = path.join(TEST_DATA_DIR, 'git-home');
fs.mkdirSync(gitHome, { recursive: true });
fs.writeFileSync(path.join(gitHome, '.gitconfig'), `[safe]\n\tdirectory = "${REPO_ROOT.replace(/\\/g, '/') }"\n`);

process.env.SIDEKICK_DATA_DIR = TEST_DATA_DIR;
process.env.SIDEKICK_ALLOWED_PATHS = REPO_ROOT;
process.env.HOME = gitHome;
process.env.USERPROFILE = gitHome;
process.env.SIDEKICK_TOOL_POLICY = 'open';
process.env.SIDEKICK_APPROVAL_MODE = 'off';

delete require.cache[require.resolve('../src/tools')];
const { TOOLS: rawTools } = require('../src/tools');
const TOOLS = require('./helpers/authorized-context').withOwnerToolContext(rawTools, { source: 'test', project: 'new-tools-test' });
const { search, git, notify } = TOOLS;

console.log('Running New Tools Tests...\n');

(async () => {
  try {
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
    assert.match(invalidPathResult.content[0].text, /not found|blocked by policy|not visible/i, 'Should report missing or unauthorized path');
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
    assert.match(invalidActionResult.content[0].text, /invalid action|invalid arguments/i, 'Should explain invalid action');
    console.log('✓ Passed\n');

    // Test git - invalid path
    console.log('Test: git - invalid path');
    const invalidRepoResult = await git({ 
      action: 'status', 
      path: '/nonexistent/repo/xyz'
    });
    assert.ok(invalidRepoResult.isError, 'Should return error for invalid repo path');
    assert.match(invalidRepoResult.content[0].text, /not found|blocked by policy|not visible/i, 'Should report missing or unauthorized repo path');
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
    assert.match(invalidChannelResult.content[0].text, /invalid channel|invalid arguments/i, 'Should explain invalid channel');
    console.log('✓ Passed\n');

    // Clean up
    try { require('../src/db').getDb().close(); } catch {}
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    
    console.log('All New Tools Tests Passed! ✓');
  } catch (e) {
    console.error('Test failed:', e);
    try { require('../src/db').getDb().close(); } catch {}
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    process.exit(1);
  }
})();
