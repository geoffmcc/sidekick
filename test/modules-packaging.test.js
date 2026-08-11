const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectModulePackage } = require('../src/modules/packaging');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-module-package-'));
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ name: 'packaged-module', version: '1.0.0', description: 'Package test module', tools: {} }));
fs.writeFileSync(path.join(root, 'entry.js'), 'module.exports = {};\n');
fs.mkdirSync(path.join(root, 'node_modules', 'ignored'), { recursive: true });
fs.writeFileSync(path.join(root, 'node_modules', 'ignored', 'bad.js'), 'ignored');

const first = inspectModulePackage(root);
assert.strictEqual(first.format, 'sidekick-module-package-v1');
assert.deepStrictEqual(first.files.map(file => file.path), ['entry.js', 'manifest.json']);
assert.strictEqual(first.files.find(file => file.path === 'entry.js').size, 21);
assert.strictEqual(first.package_hash, inspectModulePackage(root).package_hash, 'Package hash should be deterministic');

fs.writeFileSync(path.join(root, '.env'), 'SECRET=do-not-package');
assert.throws(() => inspectModulePackage(root), /sensitive file/);

console.log('Module packaging tests passed');
