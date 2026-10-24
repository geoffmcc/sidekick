"use strict";

// Communication tool family: outbound notifications and received-webhook access.
//
// Extracted from src/tools-legacy.js. `notify` uses only Node's http/https and
// SMTP/webhook env vars; `webhook` reads/clears the received-webhook document
// through the database store via its own private helpers. Neither depends on
// tools-legacy.js. The dashboard keeps its own separate webhook receiver
// (dashboard.js loadWebhooks/saveWebhooks), which is unaffected. Webhook is
// high risk by default; reviewed list/get action overrides reduce reads to
// medium risk, while clear remains high.

const { z } = require("zod");
const dbStore = require("../../db");
const { resolveOutboundUrl } = require("../../security/outbound-url");
const { readSecret } = require("../../core/runtime-secrets");
const toolContext = require("../context");
const authorization = require("../../core/authorization");
const { requireCanonicalInvocation, requireToolExecution, requirePermission } = require("../read-authorization");
const MAX_NOTIFICATION_REQUEST_BYTES = 1024 * 1024;
function notificationEndpointFailure(statusCode, response = null) {
  // Drain without retaining or reflecting untrusted body bytes.
  try {
    response?.on?.("error", () => {});
    response?.resume?.();
  } catch { /* response may already be closed */ }
  const status = Number(statusCode) || 0;
  return {
    content: [{ type: "text", text: `Notification endpoint returned HTTP ${status}` }],
    isError: true,
    code: "notification_endpoint_rejected",
  };
}

function validateEmailHeaders(recipient, title) {
  if (typeof recipient !== "string" || recipient.length > 320 || /[\r\n\0]/.test(recipient)) {
    return "Email recipient must be a single bounded address without control characters";
  }
  if (typeof title === "string" && (title.length > 500 || /[\r\n\0]/.test(title))) {
    return "Email subject must be no longer than 500 characters and contain no control characters";
  }
  return null;
}

async function resolveSmtpDestination(host, port) {
  const hostText = String(host || "").trim();
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return { refusal: "SMTP_PORT must be an integer from 1 through 65535", code: "invalid_smtp_configuration" };
  }
  let endpoint;
  try {
    endpoint = new URL(`https://${hostText}`);
  } catch {
    return { refusal: "SMTP_HOST must be a valid hostname or IP address", code: "invalid_smtp_configuration" };
  }
  if (!hostText || endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    return { refusal: "SMTP_HOST must contain only a hostname or IP address, without credentials, port, or path", code: "invalid_smtp_configuration" };
  }
  endpoint.port = String(portNumber);
  return resolveOutboundUrl(endpoint.href, "SMTP endpoint", { allowPrivate: true });
}

function loadWebhooks() {
  return dbStore.loadDocument("webhooks", []);
}

function saveWebhooks(webhooks) {
  dbStore.setDocument("webhooks", webhooks);
}

async function sidekick_notify({ channel, webhook_url, recipient, message, title }) {
  const authorizationError = requireToolExecution({ tool: "notify", channel: channel || null }, "tools.execute_high", "notify");
  if (authorizationError) return authorizationError;
  const https = require("https");
  const http = require("http");

  if (channel === "discord" || channel === "slack") {
    // Resolve the configured webhook only from the protected secret store.
    if (!webhook_url) {
      const secretDenied = requirePermission("secrets.use", { tool: "notify", secret: channel === "discord" ? "DISCORD_WEBHOOK_URL" : "SLACK_WEBHOOK_URL" });
      if (secretDenied) return secretDenied;
      webhook_url = channel === "discord" ? readSecret("DISCORD_WEBHOOK_URL") : readSecret("SLACK_WEBHOOK_URL");
    }
    if (!webhook_url) {
      return { content: [{ type: "text", text: "webhook_url required for " + channel + " (configure the protected webhook secret)" }], isError: true };
    }

    // The webhook URL is caller-controlled (or env-configured); either way the
    // request originates inside the trust boundary, so it must pass the same
    // outbound destination policy as web_fetch (SSRF guard).
    const destination = await resolveOutboundUrl(webhook_url, "webhook_url");
    if (destination.refusal) {
      return { content: [{ type: "text", text: destination.refusal }], isError: true };
    }

    const payload = channel === "discord"
      ? JSON.stringify({ content: title ? `**${title}**\n${message}` : message })
      : JSON.stringify({ text: title ? `*${title}*\n${message}` : message });

    return new Promise((resolve) => {
      const urlObj = destination.url;
      const lib = urlObj.protocol === "https:" ? https : http;
      const requestOptions = {
        hostname: destination.address,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 10000
      };
      requestOptions.headers.Host = urlObj.host;
      if (urlObj.protocol === "https:") requestOptions.servername = urlObj.hostname.replace(/^\[|\]$/g, "");
      const req = lib.request(requestOptions, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ content: [{ type: "text", text: "Sent to " + channel }] });
          res.destroy();
          return;
        }
        // Do not reflect an untrusted endpoint body: Slack/Discord webhook
        // credentials live in the URL path and a remote error can echo them.
        resolve(notificationEndpointFailure(res.statusCode, res));
      });
      req.on("error", (err) => resolve({ content: [{ type: "text", text: `Notification request failed (${err.code || "network_error"})` }], isError: true, code: "notification_request_failed" }));
      req.on("timeout", () => { req.destroy(); resolve({ content: [{ type: "text", text: "Timeout" }], isError: true }); });
      req.write(payload);
      req.end();
    });
  }

  if (channel === "email") {
    if (!recipient) {
      return { content: [{ type: "text", text: "recipient required for email" }], isError: true };
    }

    const headerError = validateEmailHeaders(recipient, title);
    if (headerError) return { content: [{ type: "text", text: headerError }], isError: true, code: "invalid_email_header" };

    const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
    const smtpPort = process.env.SMTP_PORT || "587";
    const secretDenied = requirePermission("secrets.use", { tool: "notify", secrets: ["SMTP_USER", "SMTP_PASS"] });
    if (secretDenied) return secretDenied;
    const smtpUser = readSecret("SMTP_USER");
    const smtpPass = readSecret("SMTP_PASS");

    if (!smtpUser || !smtpPass) {
      return { content: [{ type: "text", text: "SMTP credentials are not configured in the protected secret store" }], isError: true };
    }

    const subject = title || "Sidekick Notification";
    const emailContent = `From: ${smtpUser}\nTo: ${recipient}\nSubject: ${subject}\n\n${message}`;
    if (Buffer.byteLength(emailContent, "utf8") > MAX_NOTIFICATION_REQUEST_BYTES) {
      return { content: [{ type: "text", text: `Email notification exceeds ${MAX_NOTIFICATION_REQUEST_BYTES} bytes` }], isError: true, code: "notification_too_large" };
    }
    const destination = await resolveSmtpDestination(smtpHost, smtpPort);
    if (destination.refusal) {
      return { content: [{ type: "text", text: destination.refusal }], isError: true, code: destination.code || "outbound_target_denied" };
    }
    const smtpUrl = destination.url;

    return new Promise((resolve) => {
      const req = https.request({
        hostname: destination.address,
        port: smtpUrl.port || 443,
        path: "/",
        method: "POST",
        auth: `${smtpUser}:${smtpPass}`,
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": Buffer.byteLength(emailContent),
          Host: smtpUrl.host,
        },
        servername: smtpUrl.hostname.replace(/^\[|\]$/g, ""),
        timeout: 30000
      }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ content: [{ type: "text", text: "Email sent to " + recipient }] });
        } else {
          resolve({ content: [{ type: "text", text: `Email relay returned HTTP ${res.statusCode || 0}` }], isError: true, code: "email_relay_failed" });
        }
        res.destroy();
      });
      req.on("error", (err) => resolve({ content: [{ type: "text", text: "Email error: " + err.message }], isError: true }));
      req.on("timeout", () => { req.destroy(); resolve({ content: [{ type: "text", text: "Email timeout" }], isError: true }); });
      req.write(emailContent);
      req.end();
    });
  }

  return { content: [{ type: "text", text: "Invalid channel. Use: discord, slack, or email" }], isError: true };
}

async function sidekick_webhook({ action, id, limit }) {
  const dispatchError = requireCanonicalInvocation("webhook");
  if (dispatchError) return dispatchError;
  const allowedActions = ["list", "get", "clear"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
  }

  const execution = toolContext.getExecutionContext();
  const permission = action === "clear" ? "webhooks.manage" : "webhooks.read";
  if (!execution.authIdentity?.principal_id) {
    if (execution.source !== "test") return { content: [{ type: "text", text: "Authenticated principal required for webhook access" }], isError: true, code: "unauthenticated" };
  } else {
    const decision = authorization.authorize({
      principalId: execution.authIdentity.principal_id,
      permission,
      credentialScopes: execution.authIdentity.scopes,
      delegationId: execution.authIdentity.delegation_id || execution.authIdentity.delegationId || null,
      resource: { tool: "webhook", action },
    });
    if (!decision.ok) return { content: [{ type: "text", text: `Webhook access denied: ${decision.code}` }], isError: true, code: "authorization_denied" };
  }

  const webhooks = loadWebhooks();

  if (action === "list") {
    if (webhooks.length === 0) {
      return { content: [{ type: "text", text: "No webhooks received" }] };
    }
    const n = limit || 20;
    const recent = webhooks.slice(-n);
    const summary = recent.map(w =>
      w.id + " | " + w.source + " | " + w.timestamp + " | " + JSON.stringify(w.payload).substring(0, 50) + "..."
    ).join("\n");
    return { content: [{ type: "text", text: summary }] };
  }

  if (action === "get") {
    if (!id) {
      return { content: [{ type: "text", text: "id required" }], isError: true };
    }
    const webhook = webhooks.find(w => w.id === id);
    if (!webhook) {
      return { content: [{ type: "text", text: "Webhook not found" }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(webhook, null, 2) }] };
  }

  if (action === "clear") {
    saveWebhooks([]);
    return { content: [{ type: "text", text: "Cleared all webhooks" }] };
  }
}

const descriptors = Object.freeze([
  Object.freeze({
    name: "notify",
    description: "Send notifications to Discord, Slack, or email",
    schema: z.object({
      channel: z.enum(["discord", "slack", "email"]).describe("Notification channel"),
      webhook_url: z.string().max(4096).optional().describe("Webhook URL (required for discord/slack; maximum 4096 characters)"),
      recipient: z.string().max(320).optional().describe("Email recipient (required for email; maximum 320 characters)"),
      message: z.string().max(MAX_NOTIFICATION_REQUEST_BYTES).describe(`Message content to send (maximum ${MAX_NOTIFICATION_REQUEST_BYTES} characters)`),
      title: z.string().max(500).optional().describe("Optional title/subject (maximum 500 characters)"),
    }),
    args: { channel: "string", webhook_url: "string (optional)", recipient: "string (optional)", message: "string", title: "string (optional)" },
    risk: "medium",
    category: "Communication",
    source: "builtin",
    family: "comms",
    handler: sidekick_notify,
  }),
  Object.freeze({
    name: "webhook",
    description: "Manage received webhooks (list, get, clear)",
    schema: z.object({
      action: z.enum(["list", "get", "clear"]).describe("Webhook action to perform"),
      id: z.string().optional().describe("Webhook ID (required for get)"),
      limit: z.number().optional().describe("Number of webhooks to list (default: 20)"),
    }),
    args: { action: "string", id: "string (optional)", limit: "number (optional)" },
    risk: "high",
    category: "Communication",
    source: "builtin",
    family: "comms",
    handler: sidekick_webhook,
  }),
]);

module.exports = { descriptors, sidekick_notify, sidekick_webhook, notificationEndpointFailure, MAX_NOTIFICATION_REQUEST_BYTES, validateEmailHeaders, resolveSmtpDestination };
