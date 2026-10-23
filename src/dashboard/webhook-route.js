"use strict";

const WEBHOOK_SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MAX_WEBHOOK_PAYLOAD_BYTES = 256 * 1024;
const MAX_STORED_WEBHOOKS = 1000;
const MAX_STORED_WEBHOOK_BYTES = 16 * 1024 * 1024;

function registerWebhookRoute({ app, dbStore, requireIdentityPermission, auditLog, errorResponse }) {
  function loadWebhooks() { return dbStore.loadDocument("webhooks", []); }
  function saveWebhooks(webhooks) { dbStore.setDocument("webhooks", webhooks); }

  app.post("/api/webhook/:source", (req, res) => {
    if (!requireIdentityPermission(req, res, "webhooks.receive")) return;
    const source = String(req.params.source || "");
    if (!WEBHOOK_SOURCE_PATTERN.test(source)) return res.status(400).json({ ok: false, error: "invalid webhook source", code: "invalid_source" });
    const payload = req.body;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return res.status(400).json({ ok: false, error: "webhook payload must be a JSON object", code: "invalid_payload" });
    try {
      const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      if (payloadBytes > MAX_WEBHOOK_PAYLOAD_BYTES) return res.status(413).json({ ok: false, error: "webhook payload exceeds the 256 KiB limit", code: "payload_too_large" });
      const loaded = loadWebhooks();
      const webhooks = Array.isArray(loaded) ? loaded : [];
      const webhook = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        source,
        timestamp: new Date().toISOString(),
        payload,
      };
      webhooks.push(webhook);
      const retained = [];
      let retainedBytes = 2; // JSON array brackets
      for (let index = webhooks.length - 1; index >= 0 && retained.length < MAX_STORED_WEBHOOKS; index--) {
        const encoded = JSON.stringify(webhooks[index]);
        const entryBytes = Buffer.byteLength(encoded, "utf8") + (retained.length ? 1 : 0);
        if (retainedBytes + entryBytes > MAX_STORED_WEBHOOK_BYTES) continue;
        retained.push(webhooks[index]);
        retainedBytes += entryBytes;
      }
      retained.reverse();
      try { auditLog(req, "webhook.received.requested", { id: webhook.id, source, payload_bytes: payloadBytes }); }
      catch (error) { return errorResponse(req, res, error, { status: 503, code: "audit_unavailable", component: "webhook" }); }
      saveWebhooks(retained);
      let auditStatus = "complete";
      try { auditLog(req, "webhook.received", { id: webhook.id, source }); }
      catch { auditStatus = "degraded"; }
      res.json({ ok: true, id: webhook.id, audit_status: auditStatus });
    } catch (error) { return errorResponse(req, res, error, { status: 400, code: "invalid_request", component: "webhook" }); }
  });
}

module.exports = { registerWebhookRoute, WEBHOOK_SOURCE_PATTERN, MAX_WEBHOOK_PAYLOAD_BYTES, MAX_STORED_WEBHOOKS, MAX_STORED_WEBHOOK_BYTES };
