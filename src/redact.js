/**
 * Redacts sensitive information from text to prevent credential leaks
 * @param {string} text - Text to redact
 * @returns {string} - Redacted text
 */
function redactSensitive(text) {
  if (typeof text !== 'string') return text;
  
  return text
    // SSH private keys (RSA, EC, DSA, OPENSSH)
    .replace(/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    
    // GitHub tokens
    .replace(/ghp_[A-Za-z0-9_]{36}/g, '[REDACTED GITHUB TOKEN]')
    .replace(/github_pat_[A-Za-z0-9_]{82}/g, '[REDACTED GITHUB PAT]')
    
    // Generic API keys
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED API KEY]')
    .replace(/api[_-]?key[:\s=]+['"]?([A-Za-z0-9_-]{20,})['"]?/gi, 'api_key=[REDACTED]')
    
    // AWS keys
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED AWS ACCESS KEY]')
    .replace(/aws[_-]?secret[_-]?access[_-]?key[:\s=]+['"]?([A-Za-z0-9/+=]{40})['"]?/gi, 'aws_secret_access_key=[REDACTED]')
    
    // Passwords in environment variables
    .replace(/(PASSWORD|SECRET|TOKEN|API[_-]?KEY)[:\s=]+['"]?([^\s'"]{8,})['"]?/gi, '$1=[REDACTED]')
    
    // Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    
    // Database connection strings
    .replace(/(postgres|mysql|mongodb(?:\+srv)?):\/\/([^:]+):([^@]+)@/gi, '$1://$2:[REDACTED]@')
    
    // Stripe keys
    .replace(/sk_live_[A-Za-z0-9]{24,}/g, '[REDACTED STRIPE SECRET KEY]')
    .replace(/rk_live_[A-Za-z0-9]{24,}/g, '[REDACTED STRIPE RESTRICTED KEY]')
    .replace(/pk_live_[A-Za-z0-9]{24,}/g, '[REDACTED STRIPE PUBLISHABLE KEY]')
    
    // JWT tokens
    .replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED JWT]');
}

module.exports = { redactSensitive };
