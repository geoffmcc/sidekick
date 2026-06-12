/**
 * Deploy Scripts Tests
 * 
 * Tests for deploy.sh and deploy.ps1 to ensure:
 * - Scripts have correct structure and required functions
 * - SSH ControlMaster is configured for single password prompt
 * - SSH key validation is implemented
 * - Error handling is in place
 * - Progress indicators are present
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Running Deploy Scripts Tests...\n');

// ============================================================================
// TEST SETUP
// ============================================================================

const PROJECT_ROOT = path.join(__dirname, '..');
const DEPLOY_SH_PATH = path.join(PROJECT_ROOT, 'deploy.sh');
const DEPLOY_PS1_PATH = path.join(PROJECT_ROOT, 'deploy.ps1');
const BOOTSTRAP_SH_PATH = path.join(PROJECT_ROOT, 'scripts', 'bootstrap.sh');

// Read script contents
let deployShContent = '';
let deployPs1Content = '';
let bootstrapShContent = '';

try {
  deployShContent = fs.readFileSync(DEPLOY_SH_PATH, 'utf8');
} catch (e) {
  console.error('ERROR: deploy.sh not found at', DEPLOY_SH_PATH);
  process.exit(1);
}

try {
  deployPs1Content = fs.readFileSync(DEPLOY_PS1_PATH, 'utf8');
} catch (e) {
  console.error('ERROR: deploy.ps1 not found at', DEPLOY_PS1_PATH);
  process.exit(1);
}

try {
  bootstrapShContent = fs.readFileSync(BOOTSTRAP_SH_PATH, 'utf8');
} catch (e) {
  console.error('ERROR: scripts/bootstrap.sh not found at', BOOTSTRAP_SH_PATH);
  process.exit(1);
}

// ============================================================================
// DEPLOY.SH TESTS
// ============================================================================

console.log('=== DEPLOY.SH TESTS ===\n');

// Test 1.1: deploy.sh has ControlMaster configuration
console.log('Test 1.1: deploy.sh has ControlMaster configuration');
{
  assert.ok(
    deployShContent.includes('ControlMaster'),
    'deploy.sh should contain ControlMaster configuration'
  );
  assert.ok(
    deployShContent.includes('CONTROL_PATH'),
    'deploy.sh should define CONTROL_PATH variable'
  );
  assert.ok(
    deployShContent.includes('ControlPersist=60'),
    'deploy.sh should set ControlPersist timeout'
  );
  console.log('✓ ControlMaster configuration present\n');
}

// Test 1.2: deploy.sh validates SSH public key
console.log('Test 1.2: deploy.sh validates SSH public key');
{
  assert.ok(
    deployShContent.includes('SSH_PUB_KEY'),
    'deploy.sh should reference SSH_PUB_KEY'
  );
  assert.ok(
    deployShContent.includes('Public key missing, regenerating'),
    'deploy.sh should check if public key is missing'
  );
  assert.ok(
    deployShContent.includes('[ ! -f "$SSH_PUB_KEY" ]'),
    'deploy.sh should check if public key file exists'
  );
  console.log('✓ SSH public key validation present\n');
}

// Test 1.3: deploy.sh uses single SSH session for bootstrap
console.log('Test 1.3: deploy.sh uses single SSH session for bootstrap');
{
  assert.ok(
    deployShContent.includes('ControlMaster=yes'),
    'deploy.sh should open control master connection'
  );
  assert.ok(
    deployShContent.includes('1 password prompt'),
    'deploy.sh should indicate single password prompt to user'
  );
  assert.ok(
    deployShContent.includes('ControlPath="$CONTROL_PATH"'),
    'deploy.sh should use control path for subsequent operations'
  );
  console.log('✓ Single SSH session implementation present\n');
}

// Test 1.4: deploy.sh has progress indicators
console.log('Test 1.4: deploy.sh has progress indicators');
{
  assert.ok(
    deployShContent.includes('✓ bootstrap.sh'),
    'deploy.sh should show checkmark for bootstrap.sh upload'
  );
  assert.ok(
    deployShContent.includes('✓ $svc.service'),
    'deploy.sh should show checkmark for service file uploads'
  );
  assert.ok(
    deployShContent.includes('SSH connection established'),
    'deploy.sh should indicate SSH connection status'
  );
  console.log('✓ Progress indicators present\n');
}

// Test 1.5: deploy.sh has error handling for bootstrap
console.log('Test 1.5: deploy.sh has error handling for bootstrap');
{
  assert.ok(
    deployShContent.includes('Failed to establish SSH connection'),
    'deploy.sh should handle SSH connection failure'
  );
  assert.ok(
    deployShContent.includes('Failed to upload bootstrap script'),
    'deploy.sh should handle bootstrap script upload failure'
  );
  assert.ok(
    deployShContent.includes('Bootstrap execution failed'),
    'deploy.sh should handle bootstrap execution failure'
  );
  assert.ok(
    deployShContent.includes('Bootstrap verification failed'),
    'deploy.sh should handle bootstrap verification failure'
  );
  console.log('✓ Error handling present\n');
}

// Test 1.6: deploy.sh cleans up control connection on error
console.log('Test 1.6: deploy.sh cleans up control connection on error');
{
  // Count occurrences of cleanup command
  const cleanupMatches = deployShContent.match(/ssh -o ControlPath="\$CONTROL_PATH" -O exit/g);
  assert.ok(
    cleanupMatches && cleanupMatches.length >= 3,
    'deploy.sh should clean up control connection in multiple error paths'
  );
  console.log('✓ Control connection cleanup present\n');
}

// Test 1.7: deploy.sh validates local files before bootstrap
console.log('Test 1.7: deploy.sh validates local files before bootstrap');
{
  assert.ok(
    deployShContent.includes('Validating local files'),
    'deploy.sh should indicate file validation step'
  );
  assert.ok(
    deployShContent.includes('Bootstrap script not found'),
    'deploy.sh should check for bootstrap script'
  );
  assert.ok(
    deployShContent.includes('SSH public key not found'),
    'deploy.sh should check for SSH public key'
  );
  assert.ok(
    deployShContent.includes('SSH public key is empty'),
    'deploy.sh should check for empty SSH public key'
  );
  console.log('✓ Local file validation present\n');
}

// ============================================================================
// DEPLOY.PS1 TESTS
// ============================================================================

console.log('=== DEPLOY.PS1 TESTS ===\n');

// Test 2.1: deploy.ps1 has ControlMaster configuration
console.log('Test 2.1: deploy.ps1 has ControlMaster configuration');
{
  assert.ok(
    deployPs1Content.includes('ControlMaster'),
    'deploy.ps1 should contain ControlMaster configuration'
  );
  assert.ok(
    deployPs1Content.includes('$ControlPath'),
    'deploy.ps1 should define $ControlPath variable'
  );
  assert.ok(
    deployPs1Content.includes('ControlPersist=60'),
    'deploy.ps1 should set ControlPersist timeout'
  );
  console.log('✓ ControlMaster configuration present\n');
}

// Test 2.2: deploy.ps1 validates SSH public key
console.log('Test 2.2: deploy.ps1 validates SSH public key');
{
  assert.ok(
    deployPs1Content.includes('$SSH_PUB_KEY'),
    'deploy.ps1 should reference $SSH_PUB_KEY'
  );
  assert.ok(
    deployPs1Content.includes('Public key missing, regenerating'),
    'deploy.ps1 should check if public key is missing'
  );
  assert.ok(
    deployPs1Content.includes('Test-Path $SSH_PUB_KEY'),
    'deploy.ps1 should check if public key file exists'
  );
  console.log('✓ SSH public key validation present\n');
}

// Test 2.3: deploy.ps1 uses single SSH session for bootstrap
console.log('Test 2.3: deploy.ps1 uses single SSH session for bootstrap');
{
  assert.ok(
    deployPs1Content.includes('ControlMaster=yes'),
    'deploy.ps1 should open control master connection'
  );
  assert.ok(
    deployPs1Content.includes('1 password prompt'),
    'deploy.ps1 should indicate single password prompt to user'
  );
  assert.ok(
    deployPs1Content.includes('ControlPath="$ControlPath"'),
    'deploy.ps1 should use control path for subsequent operations'
  );
  console.log('✓ Single SSH session implementation present\n');
}

// Test 2.4: deploy.ps1 has progress indicators
console.log('Test 2.4: deploy.ps1 has progress indicators');
{
  assert.ok(
    deployPs1Content.includes('✓ bootstrap.sh'),
    'deploy.ps1 should show checkmark for bootstrap.sh upload'
  );
  assert.ok(
    deployPs1Content.includes('✓ $svc.service'),
    'deploy.ps1 should show checkmark for service file uploads'
  );
  assert.ok(
    deployPs1Content.includes('SSH connection established'),
    'deploy.ps1 should indicate SSH connection status'
  );
  console.log('✓ Progress indicators present\n');
}

// Test 2.5: deploy.ps1 has error handling for bootstrap
console.log('Test 2.5: deploy.ps1 has error handling for bootstrap');
{
  assert.ok(
    deployPs1Content.includes('Failed to establish SSH connection'),
    'deploy.ps1 should handle SSH connection failure'
  );
  assert.ok(
    deployPs1Content.includes('Failed to upload bootstrap script'),
    'deploy.ps1 should handle bootstrap script upload failure'
  );
  assert.ok(
    deployPs1Content.includes('Bootstrap execution failed'),
    'deploy.ps1 should handle bootstrap execution failure'
  );
  assert.ok(
    deployPs1Content.includes('Bootstrap verification failed'),
    'deploy.ps1 should handle bootstrap verification failure'
  );
  console.log('✓ Error handling present\n');
}

// Test 2.6: deploy.ps1 cleans up control connection on error
console.log('Test 2.6: deploy.ps1 cleans up control connection on error');
{
  // Count occurrences of cleanup command
  const cleanupMatches = deployPs1Content.match(/ssh -o ControlPath="\$ControlPath" -O exit/g);
  assert.ok(
    cleanupMatches && cleanupMatches.length >= 3,
    'deploy.ps1 should clean up control connection in multiple error paths'
  );
  console.log('✓ Control connection cleanup present\n');
}

// Test 2.7: deploy.ps1 validates local files before bootstrap
console.log('Test 2.7: deploy.ps1 validates local files before bootstrap');
{
  assert.ok(
    deployPs1Content.includes('Validating local files'),
    'deploy.ps1 should indicate file validation step'
  );
  assert.ok(
    deployPs1Content.includes('Bootstrap script not found'),
    'deploy.ps1 should check for bootstrap script'
  );
  assert.ok(
    deployPs1Content.includes('SSH public key not found'),
    'deploy.ps1 should check for SSH public key'
  );
  assert.ok(
    deployPs1Content.includes('SSH public key is empty'),
    'deploy.ps1 should check for empty SSH public key'
  );
  console.log('✓ Local file validation present\n');
}

// Test 2.8: deploy.ps1 SSH key generation is correct
console.log('Test 2.8: deploy.ps1 SSH key generation is correct');
{
  // Should NOT have the old broken -N '""' syntax
  assert.ok(
    !deployPs1Content.includes("-N '\"\"'"),
    'deploy.ps1 should not have broken -N \'""\' syntax'
  );
  // Should have correct -N "" syntax
  assert.ok(
    deployPs1Content.includes('-N ""'),
    'deploy.ps1 should have correct -N "" syntax for empty passphrase'
  );
  console.log('✓ SSH key generation syntax correct\n');
}

// ============================================================================
// BOOTSTRAP.SH TESTS
// ============================================================================

console.log('=== BOOTSTRAP.SH TESTS ===\n');

// Test 3.1: bootstrap.sh has --install-services flag
console.log('Test 3.1: bootstrap.sh has --install-services flag');
{
  assert.ok(
    bootstrapShContent.includes('--install-services'),
    'bootstrap.sh should support --install-services flag'
  );
  assert.ok(
    bootstrapShContent.includes('INSTALL_SERVICES'),
    'bootstrap.sh should have INSTALL_SERVICES variable'
  );
  console.log('✓ --install-services flag present\n');
}

// Test 3.2: bootstrap.sh has --ssh-key flag
console.log('Test 3.2: bootstrap.sh has --ssh-key flag');
{
  assert.ok(
    bootstrapShContent.includes('--ssh-key'),
    'bootstrap.sh should support --ssh-key flag'
  );
  assert.ok(
    bootstrapShContent.includes('SSH_PUB_KEY'),
    'bootstrap.sh should have SSH_PUB_KEY variable'
  );
  console.log('✓ --ssh-key flag present\n');
}

// Test 3.3: bootstrap.sh installs systemd services
console.log('Test 3.3: bootstrap.sh installs systemd services');
{
  assert.ok(
    bootstrapShContent.includes('systemctl daemon-reload'),
    'bootstrap.sh should run systemctl daemon-reload'
  );
  assert.ok(
    bootstrapShContent.includes('systemctl enable'),
    'bootstrap.sh should enable services'
  );
  assert.ok(
    bootstrapShContent.includes('/etc/systemd/system/'),
    'bootstrap.sh should copy service files to systemd directory'
  );
  console.log('✓ Systemd service installation present\n');
}

// Test 3.4: bootstrap.sh configures sudoers
console.log('Test 3.4: bootstrap.sh configures sudoers');
{
  assert.ok(
    bootstrapShContent.includes('/etc/sudoers.d/sidekick'),
    'bootstrap.sh should create sudoers file'
  );
  assert.ok(
    bootstrapShContent.includes('NOPASSWD'),
    'bootstrap.sh should configure NOPASSWD sudo'
  );
  assert.ok(
    bootstrapShContent.includes('systemctl start sidekick-mcp'),
    'bootstrap.sh should allow starting sidekick-mcp'
  );
  assert.ok(
    bootstrapShContent.includes('systemctl restart sidekick-dashboard'),
    'bootstrap.sh should allow restarting sidekick-dashboard'
  );
  console.log('✓ Sudoers configuration present\n');
}

// Test 3.5: bootstrap.sh installs Node.js
console.log('Test 3.5: bootstrap.sh installs Node.js');
{
  assert.ok(
    bootstrapShContent.includes('nodesource.com'),
    'bootstrap.sh should use NodeSource for Node.js installation'
  );
  assert.ok(
    bootstrapShContent.includes('apt-get install'),
    'bootstrap.sh should use apt-get for package installation'
  );
  console.log('✓ Node.js installation present\n');
}

// Test 3.6: bootstrap.sh creates sidekick user
console.log('Test 3.6: bootstrap.sh creates sidekick user');
{
  assert.ok(
    bootstrapShContent.includes('useradd'),
    'bootstrap.sh should create user with useradd'
  );
  assert.ok(
    bootstrapShContent.includes('sidekick'),
    'bootstrap.sh should create sidekick user'
  );
  assert.ok(
    bootstrapShContent.includes('/bin/bash'),
    'bootstrap.sh should set bash as default shell'
  );
  console.log('✓ User creation present\n');
}

// Test 3.7: bootstrap.sh is idempotent
console.log('Test 3.7: bootstrap.sh is idempotent');
{
  assert.ok(
    bootstrapShContent.includes('already exists'),
    'bootstrap.sh should check if user already exists'
  );
  assert.ok(
    bootstrapShContent.includes('already installed'),
    'bootstrap.sh should check if Node.js is already installed'
  );
  console.log('✓ Idempotent checks present\n');
}

// ============================================================================
// CROSS-SCRIPT CONSISTENCY TESTS
// ============================================================================

console.log('=== CROSS-SCRIPT CONSISTENCY TESTS ===\n');

// Test 4.1: Both deploy scripts use same ControlMaster configuration
console.log('Test 4.1: Both deploy scripts use same ControlMaster configuration');
{
  const shHasControlMaster = deployShContent.includes('ControlMaster=auto');
  const ps1HasControlMaster = deployPs1Content.includes('ControlMaster=auto');
  assert.ok(
    shHasControlMaster === ps1HasControlMaster,
    'Both scripts should use ControlMaster=auto'
  );
  
  const shHasPersist60 = deployShContent.includes('ControlPersist=60');
  const ps1HasPersist60 = deployPs1Content.includes('ControlPersist=60');
  assert.ok(
    shHasPersist60 === ps1HasPersist60,
    'Both scripts should use ControlPersist=60'
  );
  console.log('✓ ControlMaster configuration consistent\n');
}

// Test 4.2: Both deploy scripts validate same files
console.log('Test 4.2: Both deploy scripts validate same files');
{
  const shValidatesBootstrap = deployShContent.includes('bootstrap.sh');
  const ps1ValidatesBootstrap = deployPs1Content.includes('bootstrap.sh');
  assert.ok(
    shValidatesBootstrap === ps1ValidatesBootstrap,
    'Both scripts should validate bootstrap.sh'
  );
  
  const shValidatesServices = deployShContent.includes('sidekick-mcp') && 
                               deployShContent.includes('sidekick-dashboard') && 
                               deployShContent.includes('sidekick-agent');
  const ps1ValidatesServices = deployPs1Content.includes('sidekick-mcp') && 
                                deployPs1Content.includes('sidekick-dashboard') && 
                                deployPs1Content.includes('sidekick-agent');
  assert.ok(
    shValidatesServices === ps1ValidatesServices,
    'Both scripts should validate all three service files'
  );
  console.log('✓ File validation consistent\n');
}

// Test 4.3: Both deploy scripts have same error messages
console.log('Test 4.3: Both deploy scripts have same error messages');
{
  const errorMessages = [
    'Failed to establish SSH connection',
    'Failed to upload bootstrap script',
    'Bootstrap execution failed',
    'Bootstrap verification failed'
  ];
  
  errorMessages.forEach(msg => {
    const shHas = deployShContent.includes(msg);
    const ps1Has = deployPs1Content.includes(msg);
    assert.ok(
      shHas === ps1Has,
      `Both scripts should have error message: "${msg}"`
    );
  });
  console.log('✓ Error messages consistent\n');
}

// ============================================================================
// SUMMARY
// ============================================================================

console.log('═'.repeat(60));
console.log('✅ All deploy script tests passed!');
console.log('═'.repeat(60));
console.log('');
console.log('Summary:');
console.log('  • deploy.sh: ControlMaster, SSH key validation, error handling ✓');
console.log('  • deploy.ps1: ControlMaster, SSH key validation, error handling ✓');
console.log('  • bootstrap.sh: --install-services, --ssh-key, idempotent ✓');
console.log('  • Cross-script consistency verified ✓');
console.log('');
