"use strict";

const active = new Map();

function enableFailpoint(name, error = new Error(`Injected failpoint: ${name}`)) {
  if (!name || typeof name !== "string") throw new TypeError("failpoint name is required");
  active.set(name, error);
  return () => active.delete(name);
}

function hitFailpoint(name) {
  if (!process.env.SIDEKICK_TEST_FAILPOINTS) return;
  const error = active.get(name);
  if (error) throw error;
}

function resetFailpoints() { active.clear(); }

module.exports = { enableFailpoint, hitFailpoint, resetFailpoints };
