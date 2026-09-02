"use strict";

// The factory is only handed to an explicitly allowlisted built-in operation
// by the dispatcher. Results are branded in memory and cannot be recreated by
// JSON, a pack manifest, or a returned object property.
const envelopes = new WeakSet();

function createFactory() {
  return value => {
    const envelope = Object.freeze({ value });
    envelopes.add(envelope);
    return envelope;
  };
}

function unwrap(value) {
  return envelopes.has(value) ? value.value : null;
}

module.exports = { createFactory, unwrap };
