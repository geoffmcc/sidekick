"use strict";

// Communication tool family: outbound notifications and received-webhook access.
//
// Extracted from src/tools-legacy.js. `notify` uses only Node's http/https and
// SMTP/webhook env vars; `webhook` reads/clears the received-webhook document
// through the database store via its own private helpers. Neither depends on
// tools-legacy.js. The dashboard keeps its own separate webhook receiver
// (dashboard.js loadWebhooks/saveWebhooks), which is unaffected. Risk is
// preserved from src/tools/metadata.js (notify medium, webhook low) and gated
// by the dispatcher.

const { z } = require("zod");
const dbStore = require("../../db");

function loadWebhooks() {
  return dbStore.loadDocument("webhooks", []);
}

function saveWebhooks(webhooks) {
  dbStore.setDocument("webhooks", webhooks);
}

async function sidekick_notify({ channel, webhook_url, recipient, message, title }) {
  const https = require("https");
  const http = require("http");

  if (channel === "discord" || channel === "slack") {
    // Fall back to environment variables if webhook_url not provided
    if (!webhook_url) {
      webhook_url = channel === "discord" ? process.env.DISCORD_WEBHOOK_URL : process.env.SLACK_WEBHOOK_URL;
    }
    if (!webhook_url) {
      return { content: [{ type: "text", text: "webhook_url required for " + channel + " (set DISCORD_WEBHOOK_URL or SLACK_WEBHOOK_URL env var)" }], isError: true };
    }

    const payload = channel === "discord"
      ? JSON.stringify({ content: title ? `**${title}**\n${message}` : message })
      : JSON.stringify({ text: title ? `*${title}*\n${message}` : message });

    return new Promise((resolve) => {
      const urlObj = new URL(webhook_url);
      const lib = urlObj.protocol === "https:" ? https : http;
      const req = lib.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 10000
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ content: [{ type: "text", text: "Sent to " + channel }] });
          } else {
            resolve({ content: [{ type: "text", text: "Failed: " + res.statusCode + " " + data }], isError: true });
          }
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
    const smtpUser = process.env.SMTP_USER || "";
    const smtpPass = process.env.SMTP_PASS || "";

    if (!smtpUser || !smtpPass) {
      return { content: [{ type: "text", text: "SMTP_USER and SMTP_PASS env vars required" }], isError: true };
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
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          resolve({ content: [{ type: "text", text: "Email sent to " + recipient }] });
        });
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
  const allowedActions = ["list", "get", "clear"];
  if (!allowedActions.includes(action)) {
    return { content: [{ type: "text", text: "Invalid action. Allowed: " + allowedActions.join(", ") }], isError: true };
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
    risk: "low",
    category: "Communication",
    source: "builtin",
    family: "comms",
    handler: sidekick_webhook,
  }),
]);

module.exports = { descriptors, sidekick_notify, sidekick_webhook };
