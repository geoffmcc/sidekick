"use strict";

/**
 * Keep unauthenticated health probes useful for routing while withholding
 * exception text that can disclose local paths, configuration, or endpoints.
 * The detailed form is returned only after the caller is authorized by Core.
 */
function projectStartupFailures(failures, includeDetails = false) {
  const entries = Object.entries(failures || {});
  if (includeDetails) return Object.fromEntries(entries);
  return Object.fromEntries(entries.map(([component]) => [component, "unavailable"]));
}

function projectMcpSessionHealth(snapshot, includeDetails = false) {
  const projected = {
    sessions: Number.isSafeInteger(snapshot?.sessions) && snapshot.sessions >= 0 ? snapshot.sessions : 0,
    staleMappings: Number.isSafeInteger(snapshot?.staleMappings) && snapshot.staleMappings >= 0 ? snapshot.staleMappings : 0,
  };
  if (includeDetails) projected.sessionDetails = Array.isArray(snapshot?.sessionDetails) ? snapshot.sessionDetails : [];
  return projected;
}

module.exports = Object.freeze({ projectMcpSessionHealth, projectStartupFailures });
