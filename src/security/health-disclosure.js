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

module.exports = Object.freeze({ projectStartupFailures });
