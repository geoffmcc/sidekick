const fs = require('fs');
const path = require('path');

/**
 * Create a test environment with isolated data directory
 * @param {string} name - Test suite name
 * @returns {string} - Path to test data directory
 */
function createTestEnv(name) {
  const dir = path.join(__dirname, '..', 'test-data-' + name);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  process.env.SIDEKICK_DATA_DIR = dir;
  return dir;
}

/**
 * Clean up test environment
 * @param {string} dir - Path to test data directory
 */
function cleanupTestEnv(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Clear require cache for a module to force reload
 * @param {string} modulePath - Path to module
 */
function clearRequireCache(modulePath) {
  const resolvedPath = require.resolve(modulePath);
  if (require.cache[resolvedPath]) {
    delete require.cache[resolvedPath];
  }
}

/**
 * Create a mock log file
 * @param {string} dataDir - Data directory path
 * @param {Array} entries - Log entries to write
 */
function createMockLogFile(dataDir, entries) {
  const logFile = path.join(dataDir, 'log.jsonl');
  const content = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(logFile, content);
}

/**
 * Read log file
 * @param {string} dataDir - Data directory path
 * @returns {Array} - Log entries
 */
function readLogFile(dataDir) {
  const logFile = path.join(dataDir, 'log.jsonl');
  if (!fs.existsSync(logFile)) {
    return [];
  }
  const content = fs.readFileSync(logFile, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map(line => JSON.parse(line));
}

/**
 * Wait for a specified number of milliseconds
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate a random string
 * @param {number} length - String length
 * @returns {string}
 */
function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a random ISO timestamp
 * @returns {string}
 */
function randomTimestamp() {
  const now = Date.now();
  const randomOffset = Math.floor(Math.random() * 86400000); // Random offset up to 24 hours
  return new Date(now - randomOffset).toISOString();
}

/**
 * Create a mock tool result
 * @param {string} text - Result text
 * @param {boolean} isError - Whether this is an error result
 * @returns {object}
 */
function mockToolResult(text, isError = false) {
  return {
    content: [{ type: 'text', text }],
    isError
  };
}

/**
 * Assert that a string contains a substring
 * @param {string} str - String to check
 * @param {string} substr - Substring to find
 * @param {string} message - Error message
 */
function assertContains(str, substr, message) {
  if (!str.includes(substr)) {
    throw new Error(message || `Expected "${str}" to contain "${substr}"`);
  }
}

/**
 * Assert that a string does not contain a substring
 * @param {string} str - String to check
 * @param {string} substr - Substring to find
 * @param {string} message - Error message
 */
function assertNotContains(str, substr, message) {
  if (str.includes(substr)) {
    throw new Error(message || `Expected "${str}" NOT to contain "${substr}"`);
  }
}

module.exports = {
  createTestEnv,
  cleanupTestEnv,
  clearRequireCache,
  createMockLogFile,
  readLogFile,
  sleep,
  randomString,
  randomTimestamp,
  mockToolResult,
  assertContains,
  assertNotContains
};
