const SUPPORTED_JOB_TYPES = Object.freeze(["chat", "generate", "embeddings"]);
const SUPPORTED_EXECUTORS = Object.freeze(["mock.inference", "ollama.inference"]);
const PROTOCOL_VERSION = "1";
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_STRING_LENGTH = 8 * 1024;
const MAX_ARRAY_LENGTH = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 8;

function canonicalJobType(jobType) {
  if (jobType === "embedding") return "embeddings";
  if (jobType === "inference") return "chat";
  return jobType;
}

function validateJsonBounds(value, path = "payload", depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(`${path} exceeds maximum nesting depth`);
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) throw new Error(`${path} string exceeds maximum length`);
    if (value.includes("\0")) throw new Error(`${path} contains a null byte`);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) throw new Error(`${path} array exceeds maximum length`);
    value.forEach((item, index) => validateJsonBounds(item, `${path}[${index}]`, depth + 1));
    return;
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_OBJECT_KEYS) throw new Error(`${path} object has too many keys`);
  for (const key of keys) {
    if (key.length > 120 || key.includes("\0")) throw new Error(`${path} has an invalid key`);
    validateJsonBounds(value[key], `${path}.${key}`, depth + 1);
  }
}

function validateJsonByteSize(value, path) {
  const bytes = Buffer.byteLength(JSON.stringify(value || {}), "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) throw new Error(`${path} exceeds ${MAX_PAYLOAD_BYTES} bytes`);
}

function validateJobContract({
  protocolVersion = PROTOCOL_VERSION,
  jobType,
  capability,
  requestPayload = {},
  capabilityRequirements = {},
  routingPreferences = {},
  retryPolicy = {},
  resourceRequirements = {},
  artifactExpectations = [],
  outputLimits = {},
  priority = 50,
  timeoutMs,
  expiresAt,
}) {
  if (String(protocolVersion) !== PROTOCOL_VERSION) throw new Error(`Unsupported compute job protocol version: ${protocolVersion}`);
  const canonical = canonicalJobType(jobType || capability);
  if (!SUPPORTED_JOB_TYPES.includes(canonical)) {
    throw new Error(`Unsupported compute job type: ${jobType || capability}. Supported: ${SUPPORTED_JOB_TYPES.join(", ")}`);
  }
  const executor = capabilityRequirements.executor || requestPayload.executor;
  if (executor && !SUPPORTED_EXECUTORS.includes(executor)) {
    throw new Error(`Unsupported compute executor: ${executor}. Supported: ${SUPPORTED_EXECUTORS.join(", ")}`);
  }
  if (requestPayload.command || requestPayload.argv || requestPayload.executable || requestPayload.shell) {
    throw new Error("Compute jobs do not accept shell commands or raw process arguments");
  }
  for (const [path, value] of Object.entries({ requestPayload, capabilityRequirements, routingPreferences, retryPolicy, resourceRequirements, outputLimits })) {
    validateJsonByteSize(value, path);
    validateJsonBounds(value, path);
  }
  if (!Array.isArray(artifactExpectations)) throw new Error("artifactExpectations must be an array");
  validateJsonByteSize(artifactExpectations, "artifactExpectations");
  validateJsonBounds(artifactExpectations, "artifactExpectations");
  const normalizedPriority = Number.isInteger(Number(priority)) ? Math.max(0, Math.min(100, Number(priority))) : 50;
  if (timeoutMs !== undefined && (!Number.isInteger(Number(timeoutMs)) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 24 * 60 * 60 * 1000)) {
    throw new Error("timeoutMs must be between 1000 and 86400000");
  }
  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) throw new Error("expiresAt must be an ISO timestamp");
  return {
    protocolVersion: PROTOCOL_VERSION,
    jobType: canonical,
    capability: canonical,
    priority: normalizedPriority,
  };
}

module.exports = {
  SUPPORTED_JOB_TYPES,
  SUPPORTED_EXECUTORS,
  PROTOCOL_VERSION,
  canonicalJobType,
  validateJobContract,
};
