/**
 * Redacts sensitive information from text to prevent credential leaks
 * @param {string} text - Text to redact
 * @returns {string} - Redacted text
 */
// Key names whose values must never be persisted, regardless of value shape.
// Keys are normalized (NFKC-folded, lowercased, non-alphanumerics stripped)
// before testing, so `api_key`, `apiKey`, and `API-KEY` all match `apikey`.
// Tokens are matched as substrings, so short entries are limited to spellings
// unlikely to occur inside benign key names (`auth` would match `author`).
const SENSITIVE_KEY_RE = /(password|passwd|passphrase|pwd|secret|token|bearer|apikey|accesskey|sshkey|authorization|cookie|privatekey|credential|otp)/;
const PEM_PRIVATE_KEY_BEGIN_LABELS = new Set(["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "DSA PRIVATE KEY", "OPENSSH PRIVATE KEY"]);
const MAX_STRUCTURED_REDACTION_BYTES = 1024 * 1024;

/**
 * Returns true when an argument/field name denotes a credential. Pattern
 * redaction alone cannot catch a generic secret value (e.g. a plain password),
 * so persistence paths must check the key name before storing `key=value`.
 * @param {string} key - Argument or field name
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  const normalized = String(key || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
  // A governed credential record ID is a non-secret lookup reference needed
  // to revalidate durable authority; raw credential material remains denied.
  if (normalized === "credentialid" || normalized === "credentialscopes") return false;
  // Workspace APIs deliberately expose credential names for administration;
  // the corresponding values never leave the encrypted store.
  if (normalized === "secretnames") return false;
  return normalized === "sig" || normalized.endsWith("signature") || SENSITIVE_KEY_RE.test(normalized);
}

/**
 * Recursively sanitizes a value for persistence: values under sensitive key
 * names are replaced wholesale, and remaining strings are pattern-redacted.
 * JSON.stringify of an unsanitized object defeats the `key=value` patterns in
 * redactSensitive (the quote after the key breaks the match), so nested
 * structures must be walked with their key context before serialization.
 * @param {*} value - Value to sanitize
 * @param {string} [key] - The key this value sits under, when known
 * @returns {*} - Sanitized copy; primitives other than strings pass through
 */
function redactSensitiveKeysDeep(value, key = "") {
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redactSensitiveKeysDeep(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactSensitiveKeysDeep(childValue, childKey)
    ]));
  }
  return typeof value === "string" ? redactSensitive(value) : value;
}

function redactSensitiveJsonStringFields(text) {
  // Large JSON diagnostics skip JSON.parse to keep redaction work bounded, but
  // string-valued fields still need key-aware treatment. Match JSON string
  // property names and values, decoding the key before applying the common
  // sensitive-key classifier (including escaped key spellings).
  return text.replace(/("(?:\\.|[^"\\])*"\s*:\s*")((?:\\.|[^"\\])*)(")/g,
    (match, prefix, _value, suffix) => {
      const colon = prefix.lastIndexOf(":");
      try {
        const key = JSON.parse(prefix.slice(0, colon).trim());
        return isSensitiveKey(key) ? `${prefix}[REDACTED]${suffix}` : match;
      } catch {
        return match;
      }
    });
}

function redactUrlCredentials(text) {
  let output = "";
  let copyFrom = 0;
  let searchFrom = 0;
  while (true) {
    const delimiter = text.indexOf("://", searchFrom);
    if (delimiter < 0) break;

    let schemeStart = delimiter - 1;
    while (schemeStart >= 0 && /[a-z0-9+.-]/i.test(text[schemeStart])) schemeStart--;
    schemeStart++;
    while (schemeStart < delimiter && !/[a-z]/i.test(text[schemeStart])) schemeStart++;
    if (schemeStart >= delimiter) {
      searchFrom = delimiter + 3;
      continue;
    }

    const authorityStart = delimiter + 3;
    let authorityEnd = authorityStart;
    while (authorityEnd < text.length && !/[\/?#\s]/.test(text[authorityEnd])) authorityEnd++;
    const authority = text.slice(authorityStart, authorityEnd);
    const at = authority.indexOf("@");
    const colon = authority.indexOf(":");
    if (at >= 0 && colon > 0 && colon < at) {
      output += text.slice(copyFrom, authorityStart) + "[REDACTED]@";
      copyFrom = authorityStart + at + 1;
      searchFrom = copyFrom;
    } else {
      searchFrom = delimiter + 3;
    }
  }
  return copyFrom === 0 ? text : output + text.slice(copyFrom);
}

function redactUrlSensitiveParameters(text) {
  return text.replace(/([?&#;])([^=?&#\s;]+)=([^&#\s;]*)/g, (match, separator, rawName, value) => {
    if (!value) return match;
    let name = rawName;
    try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch {}
    const key = String(name).normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
    const sensitive = key === "key" || key === "auth" || key === "sig" || key.endsWith("signature") || SENSITIVE_KEY_RE.test(key);
    return sensitive ? `${separator}${rawName}=[REDACTED]` : match;
  });
}

function redactJwtTokens(text) {
  let output = "";
  let copyFrom = 0;
  let searchFrom = 0;
  while (true) {
    const start = text.indexOf("eyJ", searchFrom);
    if (start < 0) break;

    let cursor = start + 3;
    while (cursor < text.length && /[A-Za-z0-9_-]/.test(text[cursor])) cursor++;
    if (cursor === start + 3) {
      searchFrom = cursor + 1;
      continue;
    }
    if (cursor >= text.length) break;
    if (text[cursor] !== ".") {
      searchFrom = cursor + 1;
      continue;
    }

    const payloadStart = cursor + 1;
    if (!text.startsWith("eyJ", payloadStart)) {
      searchFrom = cursor + 1;
      continue;
    }
    cursor = payloadStart + 3;
    while (cursor < text.length && /[A-Za-z0-9_-]/.test(text[cursor])) cursor++;
    if (cursor === payloadStart + 3) {
      searchFrom = cursor + 1;
      continue;
    }
    if (cursor >= text.length) break;
    if (text[cursor] !== ".") {
      searchFrom = cursor + 1;
      continue;
    }

    const signatureStart = cursor + 1;
    cursor = signatureStart;
    while (cursor < text.length && /[A-Za-z0-9_-]/.test(text[cursor])) cursor++;
    if (cursor === signatureStart) {
      searchFrom = signatureStart + 1;
      continue;
    }
    output += text.slice(copyFrom, start) + "[REDACTED JWT]";
    copyFrom = cursor;
    searchFrom = cursor;
  }
  return copyFrom === 0 ? text : output + text.slice(copyFrom);
}

function readPemLabel(text, start) {
  let end = start;
  while (end < text.length && /[A-Z ]/.test(text[end])) {
    end++;
    if (end - start > 64) return null;
  }
  return end > start ? { value: text.slice(start, end), end } : null;
}

function redactPemPrivateKeys(text) {
  const beginMarker = "-----BEGIN ";
  const endMarker = "-----END ";
  let output = "";
  let copyFrom = 0;
  let searchFrom = 0;
  while (true) {
    const start = text.indexOf(beginMarker, searchFrom);
    if (start < 0) break;
    const labelStart = start + beginMarker.length;
    const label = readPemLabel(text, labelStart);
    if (!label || !PEM_PRIVATE_KEY_BEGIN_LABELS.has(label.value) || !text.startsWith("-----", label.end)) {
      searchFrom = start + 1;
      continue;
    }

    let endSearch = label.end + 5;
    let end = -1;
    while (true) {
      const candidate = text.indexOf(endMarker, endSearch);
      if (candidate < 0) break;
      const footerLabelStart = candidate + endMarker.length;
      const footerLabel = readPemLabel(text, footerLabelStart);
      if (footerLabel && footerLabel.value.endsWith("PRIVATE KEY") && text.startsWith("-----", footerLabel.end)) {
        end = footerLabel.end + 5;
        break;
      }
      endSearch = footerLabel ? footerLabel.end + 1 : footerLabelStart + 1;
    }
    if (end < 0) break;

    output += text.slice(copyFrom, start) + "[REDACTED PRIVATE KEY]";
    copyFrom = end;
    searchFrom = end;
  }
  return copyFrom === 0 ? text : output + text.slice(copyFrom);
}

function redactSensitive(text) {
  if (typeof text !== 'string') return text;

  // Tool output and diagnostics are often already serialized JSON. Redacting
  // only textual key=value patterns misses values such as {"sig":"..."}.
  // Parse only bounded object/array JSON, redact using the same key-aware
  // walker used by persistence, and leave non-JSON text on the existing path.
  if (Buffer.byteLength(text, "utf8") <= MAX_STRUCTURED_REDACTION_BYTES) {
    const first = text.trimStart()[0];
    if (first === "{" || first === "[") {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          return JSON.stringify(redactSensitiveKeysDeep(parsed));
        }
      } catch {
        // Malformed JSON remains ordinary text and receives pattern redaction.
      }
    }
  }

  return redactSensitiveText(redactSensitiveJsonStringFields(text));
}

function redactSensitiveText(text) {
  
  const redacted = redactUrlSensitiveParameters(redactPemPrivateKeys(text))
    
    // GitHub tokens
    .replace(/ghp_[A-Za-z0-9_]{36}/g, '[REDACTED GITHUB TOKEN]')
    .replace(/github_pat_[A-Za-z0-9_]{82}/g, '[REDACTED GITHUB PAT]')
    
    // Generic API keys
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED API KEY]')
    .replace(/api[_-]?key[:\s=]+['"]?([A-Za-z0-9_-]{20,})['"]?/gi, 'api_key=[REDACTED]')
    .replace(/x-api-key[:\s=]+['"]?([^\s'"]+)['"]?/gi, 'x-api-key=[REDACTED]')
    
    // AWS keys
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED AWS ACCESS KEY]')
    .replace(/aws[_-]?secret[_-]?access[_-]?key[:\s=]+['"]?([A-Za-z0-9/+=]{40})['"]?/gi, 'aws_secret_access_key=[REDACTED]')
    
    // Passwords in environment variables
    .replace(/(PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API[_-]?KEY|CREDENTIALS?)[:\s=]+['"]?([^\s'"&;#]{4,})['"]?/gi, '$1=[REDACTED]')
    .replace(/(password|passwd|passphrase|secret|token|api[_-]?key|credentials?)\s*[:=]\s*['"]?([^\s,'"}&;#]{4,})['"]?/gi, '$1=[REDACTED]')
    .replace(/(Authorization\s*:\s*)Bearer\s+[^\s]+/gi, '$1Bearer [REDACTED]')
    .replace(/(Authorization\s*:\s*)(?!Bearer\b)[^\s]+/gi, '$1[REDACTED]')
    
    // Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')

    ;
  const withUrlCredentialsRedacted = redactUrlCredentials(redacted)
    // Database connection strings
    .replace(/(postgres|mysql|mongodb(?:\+srv)?):\/\/([^:]+):([^@]+)@/gi, '$1://$2:[REDACTED]@')
    .replace(/(postgres|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi, '[REDACTED DATABASE URL]')

    // Stripe keys (constructed to avoid secret scanners)
    .replace(new RegExp('sk_' + 'live_[A-Za-z0-9]{24,}', 'g'), '[REDACTED STRIPE SECRET KEY]')
    .replace(new RegExp('rk_' + 'live_[A-Za-z0-9]{24,}', 'g'), '[REDACTED STRIPE RESTRICTED KEY]')
    .replace(new RegExp('pk_' + 'live_[A-Za-z0-9]{24,}', 'g'), '[REDACTED STRIPE PUBLISHABLE KEY]')

    ;
  return redactJwtTokens(withUrlCredentialsRedacted);
}

module.exports = { redactSensitive, isSensitiveKey, redactSensitiveKeysDeep };
