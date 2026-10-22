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
const { requireCanonicalInvocation, requireToolExecution } = require("../read-authorization");
const MAX_NOTIFICATION_ERROR_BYTES = 64 * 1024;

function readBoundedNotificationError(response, maxBytes = MAX_NOTIFICATION_ERROR_BYTES) {
  return new Promise(resolve => {
    const chunks = [];
    let totalBytes = 0;
    let truncated = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks, totalBytes).toString("utf8");
      resolve(truncated ? `${text} [truncated: response exceeded ${maxBytes} bytes]` : text);
    };
    response.on("data", chunk => {
      if (truncated) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const available = Math.max(0, maxBytes - totalBytes);
      if (buffer.byteLength > available) {
        if (available) chunks.push(buffer.subarray(0, available));
        totalBytes += Math.min(buffer.byteLength, available);
        truncated = true;
        try { response.destroy(); } catch {}
        finish();
        return;
      }
      chunks.push(buffer);
      totalBytes += buffer.byteLength;
    });
    response.on("end", finish);
    response.on("close", finish);
    response.on("error", finish);
  });
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
        readBoundedNotificationError(res).then(data => {
          resolve({ content: [{ type: "text", text: "Failed: " + res.statusCode + " " + data }], isError: true });
        });
      });
      req.on("error", (err) => resolve({ content: [{ type: "text", text: "Error: " + err.message }], isError: true }));
      req.on("timeout", () => { req.destroy(); resolve({ content: [{ type: "text", text: "Timeout" }], isError: true }); });
      req.write(payload);
      req.end();
    });
  }

  if (channel === "email") {
    if (!recipient) {
      return { content: [{ type: "text", text: "recipient required for email" }], isError: true };
    }

    const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
    const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);
    const smtpUser = readSecret("SMTP_USER");
    const smtpPass = readSecret("SMTP_PASS");

    if (!smtpUser || !smtpPass) {
      return { content: [{ type: "text", text: "SMTP credentials are not configured in the protected secret store" }], isError: true };
    }

    const subject = title || "Sidekick Notification";
    const emailContent = `From: ${smtpUser}\nTo: ${recipient}\nSubject: ${subject}\n\n${message}`;

    return new Promise((resolve) => {
      const req = https.request({
        hostname: smtpHost,
        port: smtpPort,
        path: "/",
        method: "POST",
        auth: `${smtpUser}:${smtpPass}`,
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": Buffer.byteLength(emailContent)
        },
        timeout: 30000
      }, (res) => {
        resolve({ content: [{ type: "text", text: "Email sent to " + recipient }] });
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
      webhook_url: z.string().optional().describe("Webhook URL (required for discord/slack)"),
      recipient: z.string().optional().describe("Email recipient (required for email)"),
      message: z.string().describe("Message content to send"),
      title: z.string().optional().describe("Optional title/subject"),
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

module.exports = { descriptors, sidekick_notify, sidekick_webhook, readBoundedNotificationError, MAX_NOTIFICATION_ERROR_BYTES };
