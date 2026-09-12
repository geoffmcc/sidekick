"use strict";

/**
 * Durable event subscriptions and delivery state.
 *
 * The kernel owns the event ledger and calls this boundary for fan-out. Keeping
 * subscription and delivery mutations together makes the transaction and
 * redaction rules explicit without making the kernel a second implementation.
 */

function createEventDeliveryStore({
  ensureSchema,
  getDb,
  eventVocabulary,
  redactSensitiveKeysDeep,
  json,
  parseJson,
  nowIso,
  newId,
  runWithCausation,
}) {
  function normalizeEventSubscription(row) {
    if (!row) return null;
    return { ...row, metadata: parseJson(row.metadata_json, {}) };
  }

  function normalizeEventDelivery(row) {
    if (!row) return null;
    return {
      ...row,
      metadata: parseJson(row.metadata_json, {}),
    };
  }

  function registerEventSubscription(input = {}) {
    ensureSchema();
    const name = String(input.name || "").trim();
    const eventType = String(input.event_type || "").trim();
    if (!name) throw new Error("subscription name is required");
    if (!eventType) throw new Error("subscription event_type is required");
    // Fan-out is exact-match, so a typo produces a subscription that silently
    // never fires. Shape is enforced; an unrecognised namespace is reported and
    // logged but allowed, because a new subsystem must not be blocked from
    // subscribing before someone edits the vocabulary.
    const typeCheck = eventVocabulary.validateSubscriptionEventType(eventType);
    if (!typeCheck.valid) throw new Error(typeCheck.reason);
    if (typeCheck.unknown_namespace) {
      console.error(JSON.stringify({
        level: "warn",
        event: "platform.event.subscription_unknown_namespace",
        subscription_name: name,
        event_type: eventType,
        namespace: eventVocabulary.getEventNamespace(eventType),
      }));
    }
    const maxAttempts = Number.isInteger(input.max_attempts) ? input.max_attempts : 3;
    if (maxAttempts < 1 || maxAttempts > 20) throw new Error("max_attempts must be between 1 and 20");
    const subscriptionId = input.subscription_id || newId("sub");
    const ts = nowIso();
    const db = getDb();
    db.prepare(`
      INSERT INTO platform_event_subscriptions
        (subscription_id, name, event_type, state, max_attempts, created_at, updated_at, metadata_json)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(subscriptionId, name, eventType, maxAttempts, ts, ts, json({
      ...(input.metadata || {}),
      ...(typeCheck.unknown_namespace ? { unknown_namespace: true } : {}),
    }));
    db.prepare(`
      INSERT INTO platform_event_offsets (subscription_id, last_event_rowid, updated_at)
      VALUES (?, 0, ?)
    `).run(subscriptionId, ts);
    return normalizeEventSubscription(db.prepare("SELECT * FROM platform_event_subscriptions WHERE subscription_id = ?").get(subscriptionId));
  }

  function setEventSubscriptionState(subscriptionId, state) {
    ensureSchema();
    if (!["active", "paused"].includes(state)) throw new Error("subscription state must be active or paused");
    const db = getDb();
    const result = db.prepare("UPDATE platform_event_subscriptions SET state = ?, updated_at = ? WHERE subscription_id = ?").run(state, nowIso(), String(subscriptionId));
    if (!result.changes) throw new Error(`Event subscription not found: ${subscriptionId}`);
    return normalizeEventSubscription(db.prepare("SELECT * FROM platform_event_subscriptions WHERE subscription_id = ?").get(String(subscriptionId)));
  }

  function listEventSubscriptions() {
    ensureSchema();
    return getDb().prepare("SELECT * FROM platform_event_subscriptions ORDER BY created_at DESC").all().map(normalizeEventSubscription);
  }

  const DEFAULT_EVENT_BACKLOG_CAP = 10000;

  function getEventBacklogCap() {
    const configured = parseInt(process.env.SIDEKICK_EVENT_BACKLOG_CAP || "", 10);
    if (!Number.isFinite(configured)) return DEFAULT_EVENT_BACKLOG_CAP;
    // Floor at 10 so a misconfiguration cannot pause every subscription on the
    // first event; ceiling high enough that the cap stays a safety net rather
    // than a queue-depth policy.
    return Math.min(Math.max(configured, 10), 1_000_000);
  }

  /**
   * Bounded backlog probe. Counting the full undelivered set on every publish
   * would make a subscription that is millions behind expensive exactly when
   * it is already unhealthy, so the subquery stops at cap + 1.
   */
  function countUndeliveredDeliveries(db, subscriptionId, cap) {
    return db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM platform_event_deliveries
        WHERE subscription_id = ? AND status IN ('pending', 'retry', 'in_flight')
        LIMIT ?
      )
    `).get(String(subscriptionId), cap + 1).count;
  }

  /**
   * Fan-out for one event. Runs inside the caller's transaction (see
   * `appendEvent`) and must therefore never throw for an ordinary condition.
   */
  function enqueueDeliveriesForEvent(db, event) {
    const subscriptions = db.prepare("SELECT * FROM platform_event_subscriptions WHERE state = 'active' AND (event_type = ? OR event_type = '*')").all(event.event_type);
    if (!subscriptions.length) return 0;
    const cap = getEventBacklogCap();
    const ts = nowIso();
    const eventSensitivity = event.sensitivity || "normal";
    let queued = 0;
    for (const subscription of subscriptions) {
      // Gating at fan-out means an event a subscription may not see never
      // becomes a row addressed to it, so it cannot leak through a later
      // handler change, a requeue, or the dashboard's delivery list.
      const maxSensitivity = parseJson(subscription.metadata_json, {}).max_sensitivity || "normal";
      if (!eventVocabulary.sensitivityAllowed(eventSensitivity, maxSensitivity)) continue;
      if (countUndeliveredDeliveries(db, subscription.subscription_id, cap) >= cap) {
        // Auto-pause at the cap. Dropping the delivery would lose the event,
        // while failing the publish would let a dead consumer take down every
        // producer. Pausing is durable and visible to the operator.
        const metadata = parseJson(subscription.metadata_json, {});
        metadata.auto_paused_at = ts;
        metadata.auto_pause_reason = `backlog cap of ${cap} undelivered deliveries reached`;
        db.prepare("UPDATE platform_event_subscriptions SET state = 'paused', updated_at = ?, metadata_json = ? WHERE subscription_id = ? AND state = 'active'")
          .run(ts, json(metadata), subscription.subscription_id);
        continue;
      }
      const result = db.prepare(`
        INSERT OR IGNORE INTO platform_event_deliveries
          (delivery_id, subscription_id, event_id, status, created_at, updated_at, metadata_json)
        VALUES (?, ?, ?, 'pending', ?, ?, '{}')
      `).run(newId("delivery"), subscription.subscription_id, event.event_id, ts, ts);
      queued += result.changes;
    }
    return queued;
  }

  function enqueueEventDeliveries(eventId) {
    ensureSchema();
    const db = getDb();
    const event = db.prepare("SELECT event_id, event_type, sensitivity FROM platform_execution_events WHERE event_id = ?").get(eventId);
    if (!event) return 0;
    return db.transaction(() => enqueueDeliveriesForEvent(db, event))();
  }

  function listClaimableEventDeliveries({ limit = 50, subscription_ids = null } = {}) {
    ensureSchema();
    const now = nowIso();
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 500));
    const params = [now];
    let filter = "";
    if (Array.isArray(subscription_ids) && subscription_ids.length) {
      filter = ` AND d.subscription_id IN (${subscription_ids.map(() => "?").join(",")})`;
      params.push(...subscription_ids.map(String));
    }
    return getDb().prepare(`
      SELECT d.delivery_id, d.subscription_id, d.event_id, d.attempt_count, s.name AS subscription_name, s.event_type, s.max_attempts
      FROM platform_event_deliveries d
      JOIN platform_event_subscriptions s ON s.subscription_id = d.subscription_id
      WHERE d.status IN ('pending', 'retry')
        AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
        AND s.state = 'active'${filter}
      ORDER BY d.created_at ASC, d.rowid ASC
      LIMIT ?
    `).all(...params, bounded).map(normalizeEventDelivery);
  }

  function recoverStaleEventDeliveries({ olderThanMs = 300000 } = {}) {
    ensureSchema();
    const cutoff = new Date(Date.now() - Math.max(1000, Number(olderThanMs) || 300000)).toISOString();
    const ts = nowIso();
    const result = getDb().prepare(`
      UPDATE platform_event_deliveries
      SET status = CASE
            WHEN attempt_count >= (SELECT s.max_attempts FROM platform_event_subscriptions s WHERE s.subscription_id = platform_event_deliveries.subscription_id)
            THEN 'dead_letter' ELSE 'retry' END,
          next_attempt_at = NULL,
          last_error = 'reclaimed after stale in-flight delivery',
          updated_at = ?
      WHERE status = 'in_flight' AND updated_at <= ?
    `).run(ts, cutoff);
    return result.changes;
  }

  function claimEventDelivery(deliveryId) {
    ensureSchema();
    const db = getDb();
    const now = nowIso();
    const result = db.prepare(`
      UPDATE platform_event_deliveries
      SET status = 'in_flight', attempt_count = attempt_count + 1, updated_at = ?
      WHERE delivery_id = ?
        AND status IN ('pending', 'retry')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND subscription_id IN (SELECT subscription_id FROM platform_event_subscriptions WHERE state = 'active')
    `).run(now, String(deliveryId), now);
    if (!result.changes) return null;
    return normalizeEventDelivery(db.prepare(`
      SELECT d.*, s.name AS subscription_name, s.event_type, s.max_attempts
      FROM platform_event_deliveries d
      JOIN platform_event_subscriptions s ON s.subscription_id = d.subscription_id
      WHERE d.delivery_id = ?
    `).get(String(deliveryId)));
  }

  function completeEventDelivery(deliveryId, { ok = true, error = null } = {}) {
    ensureSchema();
    const db = getDb();
    const delivery = db.prepare(`
      SELECT d.*, s.max_attempts
      FROM platform_event_deliveries d
      JOIN platform_event_subscriptions s ON s.subscription_id = d.subscription_id
      WHERE d.delivery_id = ?
    `).get(String(deliveryId));
    if (!delivery) throw new Error(`Event delivery not found: ${deliveryId}`);
    if (delivery.status !== "in_flight") throw new Error(`Event delivery is not in flight: ${delivery.status}`);
    const ts = nowIso();
    if (ok) {
      const event = db.prepare("SELECT rowid, event_id FROM platform_execution_events WHERE event_id = ?").get(delivery.event_id);
      db.transaction(() => {
        db.prepare("UPDATE platform_event_deliveries SET status = 'delivered', delivered_at = ?, updated_at = ?, last_error = NULL WHERE delivery_id = ?").run(ts, ts, delivery.delivery_id);
        db.prepare(`
          INSERT INTO platform_event_offsets (subscription_id, last_event_id, last_event_rowid, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(subscription_id) DO UPDATE SET last_event_id = excluded.last_event_id, last_event_rowid = excluded.last_event_rowid, updated_at = excluded.updated_at
            WHERE excluded.last_event_rowid > platform_event_offsets.last_event_rowid
        `).run(delivery.subscription_id, event.event_id, event.rowid, ts);
      })();
    } else {
      const exhausted = delivery.attempt_count >= delivery.max_attempts;
      const nextAttempt = exhausted ? null : new Date(Date.now() + Math.min(60 * 60 * 1000, 1000 * (2 ** Math.max(0, delivery.attempt_count - 1)))).toISOString();
      db.prepare(`
        UPDATE platform_event_deliveries
        SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
        WHERE delivery_id = ?
      `).run(exhausted ? "dead_letter" : "retry", nextAttempt, String(error || "delivery failed").replace(/\s+/g, " ").slice(0, 500), ts, delivery.delivery_id);
    }
    return normalizeEventDelivery(db.prepare("SELECT * FROM platform_event_deliveries WHERE delivery_id = ?").get(delivery.delivery_id));
  }

  function requeueEventDelivery(deliveryId) {
    ensureSchema();
    const db = getDb();
    const result = db.prepare(`
      UPDATE platform_event_deliveries
      SET status = 'pending', attempt_count = 0, next_attempt_at = NULL, last_error = NULL, updated_at = ?
      WHERE delivery_id = ? AND status = 'dead_letter'
    `).run(nowIso(), String(deliveryId));
    if (!result.changes) throw new Error("Only dead-lettered deliveries can be requeued");
    return normalizeEventDelivery(db.prepare("SELECT * FROM platform_event_deliveries WHERE delivery_id = ?").get(String(deliveryId)));
  }

  /**
   * Prepares the event handed to a handler. Delivery redacts anything not
   * already stored redacted unless the subscription explicitly opts in.
   */
  function prepareDeliveredEvent(row, subscriptionMetadata = {}) {
    const event = { ...row, payload: parseJson(row.payload_json, {}) };
    const alreadyRedacted = row.redaction_state === "redacted";
    if (alreadyRedacted || subscriptionMetadata.accepts_unredacted === true) {
      event.redacted_by_delivery = false;
      return event;
    }
    event.payload = redactSensitiveKeysDeep(event.payload);
    event.original_redaction_state = row.redaction_state;
    event.redaction_state = "redacted";
    event.redacted_by_delivery = true;
    return event;
  }

  function deliverEvent(deliveryId, handler) {
    if (typeof handler !== "function") throw new Error("delivery handler is required");
    const delivery = claimEventDelivery(deliveryId);
    if (!delivery) return null;
    const db = getDb();
    const row = db.prepare("SELECT * FROM platform_execution_events WHERE event_id = ?").get(delivery.event_id);
    const subscriptionMetadata = parseJson(
      db.prepare("SELECT metadata_json FROM platform_event_subscriptions WHERE subscription_id = ?").get(delivery.subscription_id)?.metadata_json,
      {}
    );
    const event = prepareDeliveredEvent(row, subscriptionMetadata);
    try {
      // Anything the handler publishes is caused by the event it is handling.
      runWithCausation(event.event_id, () => handler(event));
      return completeEventDelivery(delivery.delivery_id, { ok: true });
    } catch (error) {
      return completeEventDelivery(delivery.delivery_id, { ok: false, error: error.message });
    }
  }

  function listEventDeliveries({ subscription_id, status, limit = 50 } = {}) {
    ensureSchema();
    const conditions = [];
    const params = [];
    if (subscription_id) { conditions.push("d.subscription_id = ?"); params.push(String(subscription_id)); }
    if (status) { conditions.push("d.status = ?"); params.push(String(status)); }
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    return getDb().prepare(`
      SELECT d.*, s.name AS subscription_name, s.event_type, s.max_attempts
      FROM platform_event_deliveries d
      JOIN platform_event_subscriptions s ON s.subscription_id = d.subscription_id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY d.created_at DESC LIMIT ?
    `).all(...params, boundedLimit).map(normalizeEventDelivery);
  }

  function getEventDeliveryStats() {
    ensureSchema();
    const rows = getDb().prepare("SELECT status, COUNT(*) AS count FROM platform_event_deliveries GROUP BY status").all();
    return rows.reduce((stats, row) => { stats[row.status] = row.count; return stats; }, { pending: 0, in_flight: 0, retry: 0, delivered: 0, dead_letter: 0 });
  }

  return {
    registerEventSubscription,
    setEventSubscriptionState,
    listEventSubscriptions,
    enqueueDeliveriesForEvent,
    enqueueEventDeliveries,
    getEventBacklogCap,
    listClaimableEventDeliveries,
    recoverStaleEventDeliveries,
    claimEventDelivery,
    completeEventDelivery,
    requeueEventDelivery,
    prepareDeliveredEvent,
    deliverEvent,
    listEventDeliveries,
    getEventDeliveryStats,
  };
}

module.exports = { createEventDeliveryStore };
