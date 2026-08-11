const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { discoverModules } = require('../src/modules/discovery');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-module-discovery-'));
fs.mkdirSync(path.join(root, 'modules', 'alpha'), { recursive: true });
fs.mkdirSync(path.join(root, 'plugins', 'beta'), { recursive: true });
fs.mkdirSync(path.join(root, 'modules', 'broken'), { recursive: true });

const manifest = (name, version = '1.0.0') => JSON.stringify({ name, version, description: `${name} module`, tools: {} });
fs.writeFileSync(path.join(root, 'modules', 'alpha', 'manifest.json'), manifest('alpha'));
fs.writeFileSync(path.join(root, 'plugins', 'beta', 'sidekick.module.json'), manifest('beta'));
fs.writeFileSync(path.join(root, 'modules', 'broken', 'manifest.json'), '{not json');

const discovered = discoverModules(root);
assert.deepStrictEqual(discovered.candidates.map(candidate => candidate.manifest.name), ['alpha', 'beta']);
assert.strictEqual(discovered.errors.length, 1);
assert.match(discovered.errors[0].error, /Unexpected token|JSON/);

fs.mkdirSync(path.join(root, 'plugins', 'duplicate'), { recursive: true });
fs.writeFileSync(path.join(root, 'plugins', 'duplicate', 'manifest.json'), manifest('alpha', '2.0.0'));
const duplicate = discoverModules(root);
assert.strictEqual(duplicate.candidates.length, 2, 'Duplicate candidates must not be returned as activatable results');
assert.ok(duplicate.errors.some(error => /duplicate module name/.test(error.error)));

console.log('Module discovery tests passed');
