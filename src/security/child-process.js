"use strict";

// Child processes are not trusted with Sidekick's service environment by
// default. In particular, a command supplied to a governed shell-capable tool
// must not inherit file-backed credentials or runtime loader hooks.
const SECRET_ENV_KEY = /(?:API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|(?:^|[_-])AUTH(?:ORIZATION)?(?:[_-]|$)|TOKEN|PASSWORD|PASSWD|PASSPHRASE|SECRET|CREDENTIAL)/i;
// Credential material is sometimes named after its format or purpose rather
// than containing the generic words above (for example FERNET_KEY or
// OIDC_BEARER). Keep the matches token-like and key-specific to avoid dropping
// unrelated application settings such as COOKIE_DOMAIN or SESSION_TIMEOUT.
const SENSITIVE_MATERIAL_ENV_KEY = /(?:^|[_-])(?:BEARER(?:[_-]?TOKEN)?|JWT|(?:SESSION[_-]?(?:TOKEN|ID|COOKIE))|(?:AUTH[_-]?COOKIE)|(?:COOKIE[_-]?(?:TOKEN|SECRET|VALUE))|(?:FERNET[_-]?KEY)|(?:MASTER[_-]?KEY)|(?:(?:DATA[_-]?)?ENCRYPTION[_-]?KEY)|(?:SIGNING[_-]?KEY))(?:[_-]|$)/i;
const CREDENTIAL_LOCATOR_ENV_KEYS = new Set([
  "AWS_CONFIG_FILE", "AWS_DEFAULT_PROFILE", "AWS_PROFILE", "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AZURE_CONFIG_DIR", "AZURE_FEDERATED_TOKEN_FILE", "BOTO_CONFIG", "CLOUDSDK_CONFIG",
  "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "CURL_HOME", "DOCKER_CONFIG", "GH_CONFIG_DIR",
  "GOOGLE_APPLICATION_CREDENTIALS", "GPG_AGENT_INFO", "GNUPGHOME", "HELM_CONFIG_HOME",
  "HELM_REGISTRY_CONFIG", "HELM_REPOSITORY_CONFIG", "KRB5CCNAME", "KRB5_CONFIG",
  "KUBECONFIG", "MYSQL_TEST_LOGIN_FILE", "NETRC", "NPM_CONFIG_USERCONFIG",
  "NUGET_CREDENTIALPROVIDERS_PATH", "PGPASSFILE", "PGSERVICEFILE", "PIP_CONFIG_FILE",
  "SSH_AGENT_PID", "SSH_AUTH_SOCK", "TF_CLI_CONFIG_FILE", "TERRAFORM_CLI_CONFIG_FILE", "WGETRC",
]);
const LOADER_ENV_KEYS = new Set([
  "BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "GCONV_PATH", "LOCPATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
  "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONINSPECT", "PYTHONSTARTUP", "PYTHONBREAKPOINT",
  "RUBYLIB", "RUBYOPT", "PERL5LIB", "PERL5OPT", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH",
  "GIT_ASKPASS", "GIT_PAGER",
  "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_SSH", "GIT_SSH_COMMAND", "SSH_ASKPASS", "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_OBJECT_DIRECTORY_RELATIVE",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM", "PAGER", "EDITOR", "VISUAL",
]);

function isLoaderEnvKey(key) {
  const normalized = String(key || "").toUpperCase();
  return LOADER_ENV_KEYS.has(normalized) || normalized.startsWith("GIT_TRACE") || normalized.startsWith("GIT_CONFIG_");
}

function isCredentialLocatorEnvKey(key) {
  return CREDENTIAL_LOCATOR_ENV_KEYS.has(String(key || "").toUpperCase());
}

function isSecretEnvKey(key) {
  const normalized = String(key || "");
  return SECRET_ENV_KEY.test(normalized) || SENSITIVE_MATERIAL_ENV_KEY.test(normalized) || /^MYSQL_PWD$/i.test(normalized);
}

function containsCredentialUrl(value) {
  if (typeof value !== "string" || !value.includes("://")) return false;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return true;
    const hasCredentialParameter = (name, parameterValue) => {
      const key = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const signedUrlParameter = key === "sig" || key.endsWith("signature");
      return Boolean(parameterValue) && (key === "key" || signedUrlParameter || /(?:password|passwd|passphrase|pwd|token|secret|credential|authorization|auth|apikey|accesskey|privatekey|bearer|jwt)/i.test(key));
    };
    // Credentials are also commonly carried in URL query strings, especially
    // by database, cache, and identity-provider connection URLs. These env
    // variable names often look harmless (DATABASE_URL, REDIS_URL), so inspect
    // parameter names without logging or retaining any parameter values.
    for (const [name, parameterValue] of parsed.searchParams) {
      if (hasCredentialParameter(name, parameterValue)) return true;
    }
    // OAuth implicit-flow and callback URLs may carry bearer material in the
    // fragment. Fragments are not sent in HTTP requests, but they are still
    // copied into child environments and must not cross that boundary.
    const fragment = parsed.hash.slice(1);
    for (const match of fragment.matchAll(/(?:^|[&;])([^=&#;]+)=([^&#;]*)/g)) {
      let name = match[1];
      let parameterValue = match[2];
      try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch {}
      try { parameterValue = decodeURIComponent(parameterValue.replace(/\+/g, " ")); } catch {}
      if (hasCredentialParameter(name, parameterValue)) return true;
    }
    // JDBC and other semicolon-style connection strings keep credentials in
    // the URL path instead of searchParams (for example, `jdbc:sqlserver://host;password=...`).
    const withoutFragment = value.split("#", 1)[0];
    for (const match of withoutFragment.matchAll(/;([^=?&#;]+)=([^&#;]*)/g)) {
      let name = match[1];
      let parameterValue = match[2];
      try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch {}
      try { parameterValue = decodeURIComponent(parameterValue.replace(/\+/g, " ")); } catch {}
      if (hasCredentialParameter(name, parameterValue)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function childProcessEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (isSecretEnvKey(key) || isCredentialLocatorEnvKey(key) || isLoaderEnvKey(key) || containsCredentialUrl(value)) continue;
    // Windows exposes this key as `Path` in some launch environments while
    // Unix and our child-process callers conventionally use `PATH`. Normalize
    // it so filtered environments retain executable discovery consistently.
    env[key.toUpperCase() === "PATH" ? "PATH" : key] = value;
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value == null) delete env[key];
    else {
      const text = String(value);
      if (!isSecretEnvKey(key) && !isCredentialLocatorEnvKey(key) && !isLoaderEnvKey(key) && !containsCredentialUrl(text)) {
        env[key] = text;
      }
    }
  }
  return env;
}

module.exports = { childProcessEnv };
