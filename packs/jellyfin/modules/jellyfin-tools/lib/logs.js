"use strict";

/**
 * Bounded Jellyfin log intelligence.
 *
 * GET /System/Logs lists log files; GET /System/Logs/Log?name= returns the
 * raw file as text/plain (verified against the official 10.9/10.10 OpenAPI).
 * Only a bounded TAIL is ever retrieved (client.getTail), only file names the
 * server itself listed may be requested (no caller-controlled name reaches the
 * route unchecked), and raw content never leaves this module — summaries only,
 * redacted through Sidekick's shared redaction when reachable with a
 * conservative local scrub applied regardless.
 */

const { JellyfinError } = require("./errors");
const { requireSidekickSrc } = require("./deps");

let redactSensitive = null;
try {
  ({ redactSensitive } = requireSidekickSrc("src/redact.js"));
} catch {
  /* managed-store layout without reachable src: local scrub still applies */
}

// Serilog console format Jellyfin writes:
// [2026-08-14 12:34:56.789 +00:00] [INF] [21] Namespace.Class: Message
const LINE_RE =
  /^\[(\d{4}-\d{2}-\d{2}[ T][\d:.]+(?:\s*[+-]\d{2}:\d{2})?)\]\s+\[(VRB|DBG|INF|WRN|ERR|FTL)\]\s*(?:\[[^\]]*\]\s*)?(.*)$/;

// Conservative local secret scrub — applied even when the shared redactor is
// available, because log lines can embed Jellyfin API keys as query params.
function scrubLine(text) {
  return String(text)
    .replace(/(api[_-]?key|token|authorization|password|secret)(["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, "$1$2[REDACTED]")
    .replace(/([?&](?:api_key|ApiKey|X-Emby-Token)=)[^\s&"']+/gi, "$1[REDACTED]");
}

function redact(text) {
  const base = redactSensitive ? redactSensitive(String(text)) : String(text);
  return scrubLine(base);
}

// Collapse volatile fragments so repeated occurrences of the same fault share
// one signature: GUIDs, long hex, numbers, quoted paths.
function signatureOf(message) {
  return scrubLine(message)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<guid>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/"[^"]{0,200}"/g, '"<value>"')
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * Choose the log file to inspect. A requested name must EXACTLY match a name
 * the server listed — the listing is the allowlist, so a crafted name can
 * never be smuggled into the ?name= route. Default: most recently modified.
 */
function pickLogFile(files, requestedName) {
  const list = (Array.isArray(files) ? files : []).filter((f) => f && f.Name);
  if (!list.length) throw new JellyfinError("not_found", "Jellyfin listed no log files");
  if (requestedName) {
    const match = list.find((f) => f.Name === requestedName);
    if (!match)
      throw new JellyfinError(
        "not_found",
        "requested log_file is not among the files Jellyfin listed",
      );
    return match;
  }
  return [...list].sort(
    (a, b) => new Date(b.DateModified || 0) - new Date(a.DateModified || 0),
  )[0];
}

/** Parse a bounded tail into counts, a time range and deduplicated error signatures. */
function summarizeTail(text) {
  const counts = { VRB: 0, DBG: 0, INF: 0, WRN: 0, ERR: 0, FTL: 0 };
  const signatures = new Map();
  let first = null;
  let last = null;
  let parsed = 0;
  let unparsed = 0;
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = LINE_RE.exec(line);
    if (!match) {
      // Continuation lines (stack traces) belong to the preceding entry.
      unparsed += 1;
      continue;
    }
    parsed += 1;
    const [, timestamp, level, message] = match;
    counts[level] += 1;
    if (!first) first = timestamp;
    last = timestamp;
    if (level === "ERR" || level === "FTL") {
      const signature = signatureOf(message);
      const existing = signatures.get(signature) || { count: 0, last_seen: null, level };
      existing.count += 1;
      existing.last_seen = timestamp;
      signatures.set(signature, existing);
    }
  }
  const topErrors = [...signatures.entries()]
    .map(([signature, meta]) => ({ signature: redact(signature), ...meta }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return {
    // The first line of a tail is usually cut mid-entry; the range is the
    // parseable span, honestly labelled as tail-bounded by the caller.
    time_range: { first, last },
    level_counts: counts,
    top_errors: topErrors,
    lines_parsed: parsed,
    continuation_or_unparsed_lines: unparsed,
  };
}

/**
 * Evidence-based incident classification in the playback_diagnose style:
 * observed / conclusion / unknowns / next check. Never invents a root cause —
 * a dominant repeated error signature is the strongest claim made.
 */
function classifyIncident({ logSummary, failedTasks = [], errorActivity = [], unknowns = [] }) {
  const observed = [];
  const nextChecks = [];
  const errorCount = logSummary
    ? logSummary.level_counts.ERR + logSummary.level_counts.FTL
    : null;
  if (logSummary) {
    observed.push({ fact: "log_error_count_in_tail", value: errorCount });
    if (logSummary.top_errors.length)
      observed.push({ fact: "top_error_signatures", value: logSummary.top_errors });
  }
  if (failedTasks.length)
    observed.push({
      fact: "failed_scheduled_tasks",
      value: failedTasks.map((t) => ({ id: t.id, name: t.name, last_status: t.last_status })),
    });
  if (errorActivity.length)
    observed.push({ fact: "error_severity_activity_entries", value: errorActivity.slice(0, 10) });

  let classification;
  let conclusion;
  const dominant = logSummary?.top_errors?.[0];
  if (dominant && dominant.count >= 3) {
    classification = "recurring_error";
    conclusion = `A repeated error signature appears ${dominant.count} times in the bounded log tail.`;
    nextChecks.push("Correlate the dominant signature's timestamps with the reported incident window");
  } else if ((errorCount ?? 0) > 0 || failedTasks.length || errorActivity.length) {
    classification = "errors_present";
    conclusion =
      "Error-level evidence exists but no single dominant signature; the evidence does not identify one cause.";
    nextChecks.push("Inspect the listed signatures and failed tasks individually");
  } else if (logSummary) {
    classification = "no_error_evidence";
    conclusion =
      "The bounded log tail, scheduled tasks and activity log show no error-level evidence for the incident window covered.";
    nextChecks.push("Widen the window (older log file) or check host/network layers outside Jellyfin");
  } else {
    classification = "insufficient_evidence";
    conclusion = "Jellyfin-side log evidence could not be retrieved.";
    nextChecks.push("Retry logs_summary or inspect the log file on the host directly");
  }
  return {
    classification,
    observed,
    conclusion,
    unknowns,
    recommended_next_check: nextChecks[0] || null,
  };
}

module.exports = { pickLogFile, summarizeTail, classifyIncident, redact, signatureOf };
