"use strict";

(function installDashboardErrorBoundary() {
  const messages = Object.freeze({
    invalid_request: "Request could not be processed.",
    invalid_body: "Request body is invalid.",
    invalid_format: "The requested format is not supported.",
    authentication_required: "Authentication required.",
    forbidden: "The requested operation is not permitted.",
    csrf_invalid: "Request origin is not allowed.",
    policy_denied: "Operation denied by dashboard policy.",
    approval_required: "Approval is required before this operation can continue.",
    confirmation_required: "Explicit confirmation is required.",
    not_found: "The requested resource was not found.",
    payload_too_large: "Request payload is too large.",
    conflict: "The requested state change conflicts with current state.",
    rate_limited: "Too many requests. Try again later.",
    upstream_unavailable: "An upstream service is unavailable.",
    service_unavailable: "Dashboard service is temporarily unavailable.",
    unsupported_operation: "The requested operation is not supported.",
    internal_error: "Dashboard request failed.",
  });
  const statusCodes = { 400: "invalid_request", 401: "authentication_required", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "payload_too_large", 429: "rate_limited", 500: "internal_error", 501: "unsupported_operation", 502: "upstream_unavailable", 503: "service_unavailable" };

  function details(error, status) {
    const candidate = error && typeof error === "object" ? error : {};
    const code = Object.prototype.hasOwnProperty.call(messages, candidate.code) ? candidate.code : statusCodes[status] || "internal_error";
    return {
      code,
      status: Number(candidate.status) || Number(status) || 500,
      message: messages[code],
      correlation_id: typeof candidate.correlation_id === "string" ? candidate.correlation_id : null,
    };
  }

  function fromResponse(response, payload) {
    const detail = details(payload, response && response.status);
    const error = new Error(detail.message);
    error.code = detail.code;
    error.status = detail.status;
    error.correlation_id = detail.correlation_id || response?.headers?.get("X-Correlation-ID") || null;
    return error;
  }

  window.dashboardErrorDetails = details;
  window.dashboardErrorFromResponse = fromResponse;
  window.dashboardSafeErrorMessage = (error, status) => details(error, status).message;
})();
