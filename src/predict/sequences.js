const DEFAULT_SEQUENCE_GAP_MINUTES = 30;
const KEY_SEP = String.fromCharCode(0);
const VALID_SCOPES = ["project", "session", "task", "global"];

/**
 * Maps a raw `tool_logs` row onto the shape the detectors consume.
 *
 * The table stores `success INTEGER`; it has no `ok` column. Reading `row.ok`
 * yields undefined, which previously made every call look like a failure and
 * silently disabled the sequence detectors that required a success.
 */
function normalizeToolLog(row) {
  return {
    id: row.id,
    tool_name: row.tool_name,
    ok: row.success === 1 || row.success === true,
    timestamp: row.timestamp,
    time: Date.parse(row.timestamp || "") || 0,
    project: row.project || null,
    session_id: row.session_id || null,
    task_id: row.task_id || null,
    correlation_id: row.correlation_id || null,
    error_category: row.error_category || null,
    arg_fingerprint: row.arg_fingerprint || null,
    result_summary: row.result_summary || row.summary || null,
  };
}

/**
 * Returns the durable correlation identifier for a tool log, or null when the
 * record cannot be placed in a trustworthy execution boundary.
 *
 * Unscoped records are never merged into a synthetic global session: doing so
 * fabricates adjacency between calls that never ran together.
 */
function boundaryId(log) {
  return log.session_id || log.task_id || log.correlation_id || null;
}

/**
 * Builds explicitly ordered, boundary-isolated sequences from tool logs.
 *
 * Guarantees:
 *  - each segment is sorted ascending by (timestamp, id) regardless of SQL order
 *  - records without a durable correlation id are skipped entirely
 *  - different sessions, tasks, correlations and projects are never stitched
 *  - a reused identifier is split when calls are separated by a large time gap
 */
function buildSequences(logs, options) {
  const gapMs = (options && options.gapMinutes ? options.gapMinutes : DEFAULT_SEQUENCE_GAP_MINUTES) * 60 * 1000;
  const groups = new Map();
  let skippedUnscoped = 0;

  for (const log of logs) {
    const boundary = boundaryId(log);
    if (!boundary) { skippedUnscoped++; continue; }
    // Project participates in the key so one identifier spanning projects
    // cannot merge cross-project activity into one sequence.
    const key = [log.project || "", boundary].join(KEY_SEP);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(log);
  }

  const segments = [];
  for (const [key, groupLogs] of groups) {
    // Explicit chronological sort — never rely on the query's incidental ordering.
    groupLogs.sort((a, b) => (a.time - b.time) || (a.id - b.id));

    let current = [];
    for (const log of groupLogs) {
      if (current.length > 0) {
        const gap = log.time - current[current.length - 1].time;
        if (gap > gapMs) {
          segments.push(makeSegment(key, current));
          current = [];
        }
      }
      current.push(log);
    }
    if (current.length > 0) segments.push(makeSegment(key, current));
  }

  return { segments, skippedUnscoped };
}

function makeSegment(key, logs) {
  const first = logs[0];
  return {
    key: [key, first.time].join(KEY_SEP),
    boundary: boundaryId(first),
    project: first.project || null,
    session_id: first.session_id || null,
    task_id: first.task_id || null,
    logs,
  };
}

/**
 * Resolves the analysis scope. A global (all-project) analysis must be selected
 * deliberately — it is never inferred from missing parameters.
 */
function resolveScope(options) {
  const opts = options || {};
  let mode = opts.scope || null;

  if (mode && !VALID_SCOPES.includes(mode)) {
    return { ok: false, error: `scope must be one of: ${VALID_SCOPES.join(", ")}` };
  }

  if (!mode) {
    if (opts.task_id) mode = "task";
    else if (opts.session_id) mode = "session";
    else if (opts.project) mode = "project";
    else {
      return {
        ok: false,
        error: "An analysis scope is required. Pass project, session_id or task_id, " +
          "or request scope='global' explicitly to analyze every project.",
      };
    }
  }

  if (mode === "project" && !opts.project) return { ok: false, error: "scope='project' requires a project" };
  if (mode === "session" && !opts.session_id) return { ok: false, error: "scope='session' requires a session_id" };
  if (mode === "task" && !opts.task_id) return { ok: false, error: "scope='task' requires a task_id" };

  return {
    ok: true,
    scope: {
      mode,
      project: mode === "global" ? null : (opts.project || null),
      session_id: mode === "session" || mode === "task" ? (opts.session_id || null) : null,
      task_id: mode === "task" ? (opts.task_id || null) : null,
      max_age: opts.maxAge || "7d",
    },
  };
}

module.exports = { normalizeToolLog, boundaryId, buildSequences, resolveScope, VALID_SCOPES };
