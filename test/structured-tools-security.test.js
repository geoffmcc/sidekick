const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DIR = path.join(__dirname, 'test-data-structured-tools-security');
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.SIDEKICK_DATA_DIR = TEST_DIR;
process.env.SIDEKICK_API_KEY = 'sk-structured-tools-security-test-key';

const tools = require('../src/tools');

async function assertRejected(resultPromise, pattern, label) {
  const result = await resultPromise;
  assert.strictEqual(result.isError, true, `${label} should be rejected`);
  assert.match(result.content[0].text, pattern, label);
}

(async () => {
  console.log('Running Structured Tool Security Tests...');
  const sample = path.join(TEST_DIR, 'sample.txt');
  fs.writeFileSync(sample, 'safe');

  assert.strictEqual(tools.getToolRisk('ocr'), 'medium');
  assert.strictEqual(tools.getToolRisk('media'), 'medium');
  assert.strictEqual(tools.getToolRisk('transcribe'), 'medium');
  assert.strictEqual(tools.getToolRisk('download'), 'medium');

  await assertRejected(tools.TOOLS.ocr({ path: sample, language: 'eng;touch /tmp/pwned' }), /Invalid language code/, 'ocr language metacharacters');
  await assertRejected(tools.TOOLS.transcribe({ path: sample, model: 'base;touch /tmp/pwned' }), /Invalid transcription model/, 'transcribe model metacharacters');
  await assertRejected(tools.TOOLS.media({ action: 'thumbnail', input: sample, output: path.join(TEST_DIR, 'thumb.jpg'), options: '00:00:01;touch /tmp/pwned' }), /Invalid timestamp/, 'media timestamp metacharacters');
  await assertRejected(tools.TOOLS.media({ action: 'resize', input: sample, output: path.join(TEST_DIR, 'out.jpg'), options: '800:-1;touch /tmp/pwned' }), /Invalid scale/, 'media scale metacharacters');
  await assertRejected(tools.TOOLS.media({ action: 'convert', input: sample, output: path.join(TEST_DIR, 'out.mp4'), options: '-vf scale=1:1;touch /tmp/pwned' }), /Raw media options/, 'media raw options');
  await assertRejected(tools.TOOLS.download({ url: 'file:///etc/passwd', output: path.join(TEST_DIR, '%(title)s.%(ext)s') }), /Only http and https/, 'download protocol');
  await assertRejected(tools.TOOLS.download({ url: 'https://example.com/video', output: path.join(TEST_DIR, '%(title)s.%(ext)s'), format: 'best;touch /tmp/pwned' }), /Invalid download format/, 'download format metacharacters');

  console.log('Structured Tool Security Tests passed');
})().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
