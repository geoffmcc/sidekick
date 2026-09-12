"use strict";

const crypto = require("crypto");
const { redactSensitiveKeysDeep } = require("../redact");

const PUBLIC_ERRORS = Object.freeze({
  invalid_request: { status: 400, message: "Request could not be processed." },
  invalid_body: { status: 400, message: "Request body is invalid." },
  invalid_format: { status: 400, message: "The requested format is not supported." },
  authentication_required: { status: 401, message: "Authentication required." },
  forbidden: { status: 403, message: "The requested operation is not permitted." },
  csrf_invalid: { status: 403, message: "Request origin is not allowed." },
  policy_denied: { status: 403, message: "Operation denied by dashboard policy." },
  approval_required: { status: 202, message: "Approval is required before this operation can continue." },
  confirmation_required: { status: 400, message: "Explicit confirmation is required." },
  not_found: { status: 404, message: "The requested resource was not found." },
  conflict: { status: 409, message: "The requested state change conflicts with current state." },
  payload_too_large: { status: 413, message: "Request payload is too large." },
  rate_limited: { status: 429, message: "Too many requests. Try again later." },
  upstream_unavailable: { status: 502, message: "An upstream service is unavailable." },
  service_unavailable: { status: 503, message: "Dashboard service is temporarily unavailable." },
  unsupported_operation: { status: 501, message: "The requested operation is not supported." },
  internal_error: { status: 500, message: "Dashboard request failed." },
});

const STATUS_CODES = Object.freeze({
  400: "invalid_request",
  401: "authentication_required",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  429: "rate_limited",
  501: "unsupported_operation",
  502: "upstream_unavailable",
  503: "service_unavailable",
  500: "internal_error",
});

const CORRELATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_PUBLIC_MESSAGE_RE = /^[A-Za-z0-9][A-Za-z0-9 .,;:'()?!_-]{0,199}$/;
const SAFE_EXTRA_KEYS = new Set(["approvalRequired", "connector_id", "deleted", "limit", "probe_execution", "windowMs"]);

function requestCorrelationId(req) {
  if (req && req.dashboardCorrelationId) return req.dashboardCorrelationId;
  const supplied = String(req?.headers?.["x-request-id"] || "");
  const correlationId = CORRELATION_ID_RE.test(supplied)
    ? supplied
    : `dash_${crypto.randomBytes(12).toString("hex")}`;
  if (req) req.dashboardCorrelationId = correlationId;
  return correlationId;
}

function publicErrorCode(code, status = 500) {
  return Object.prototype.hasOwnProperty.call(PUBLIC_ERRORS, code) ? code : STATUS_CODES[status] || "internal_error";
}

function publicError(status, code, publicMessage) {
  const resolvedCode = publicErrorCode(code, status);
  const definition = PUBLIC_ERRORS[resolvedCode];
  const message = typeof publicMessage === "string" && SAFE_PUBLIC_MESSAGE_RE.test(publicMessage)
    ? publicMessage
    : definition.message;
  return { status: definition.status, code: resolvedCode, message };
}

function statusFromError(error, fallback = 500) {
  const candidate = Number(error?.statusCode || error?.status || fallback);
  return Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : fallback;
}

function safeResponseExtras(extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return {};
  return Object.fromEntries(Object.entries(extra).filter(([key, value]) => {
    if (!SAFE_EXTRA_KEYS.has(key)) return false;
    return value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 200 && SAFE_PUBLIC_MESSAGE_RE.test(value));
  }));
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
}

function safeRoute(req, fallback = "dashboard") {
  const route = req?.route?.path;
  if (typeof route === "string" && route.length <= 160 && !route.includes("?") && !route.includes("//")) return route;
  return fallback;
}

function writeDiagnostic({ fs, logFile, req, error, status, code, component, url }) {
  const rawMessage = error instanceof Error ? error.message : String(error || "");
  const rawStack = error instanceof Error ? error.stack : "";
  const entry = redactSensitiveKeysDeep({
    timestamp: new Date().toISOString(),
    correlation_id: requestCorrelationId(req),
    method: req?.method || null,
    route: safeRoute(req, component || "dashboard"),
    component: component || "dashboard",
    status,
    code,
    error_type: error?.name || typeof error,
    error_code: typeof error?.code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.code) ? error.code : null,
    message: "[REDACTED]",
    message_digest: digest(rawMessage),
    stack: "[REDACTED]",
    stack_digest: digest(rawStack),
    source_url: typeof url === "string" && !url.includes("?") ? safeRoute({ route: { path: url } }, component || "dashboard") : null,
  });
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
  return entry;
}

function createDashboardErrorBoundary({ fs, logFile }) {
  function logError(req, error, options = {}) {
    try {
      return writeDiagnostic({ fs, logFile, req, error, status: options.status || 500, code: publicErrorCode(options.code, options.status || 500), component: options.component, url: options.url });
    } catch {
      return null;
    }
  }

  function respond(req, res, error, options = {}) {
    const status = Number.isInteger(options.status) ? options.status : statusFromError(error, 500);
    const safe = publicError(status, options.code, options.publicMessage);
    logError(req, error, { ...options, status, code: safe.code });
    if (res.headersSent) return;
    return res.status(safe.status).json({
      ok: false,
      error: safe.message,
      code: safe.code,
      correlation_id: requestCorrelationId(req),
      ...safeResponseExtras(options.extra),
    });
  }

  function middleware(error, req, res, next) {
    if (res.headersSent) return next(error);
    return respond(req, res, error, { component: "unhandled_route" });
  }

  return { logError, respond, middleware };
}

function addCorrelationMiddleware(req, res, next) {
  const correlationId = requestCorrelationId(req);
  res.setHeader("X-Correlation-ID", correlationId);
  next();
}

module.exports = {
  CORRELATION_ID_RE,
  PUBLIC_ERRORS,
  STATUS_CODES,
  addCorrelationMiddleware,
  createDashboardErrorBoundary,
  publicError,
  publicErrorCode,
  requestCorrelationId,
  statusFromError,
};
