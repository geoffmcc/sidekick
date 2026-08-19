"use strict";
class NetworkFirewallError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "NetworkFirewallError"; this.code = code; this.details = details; }
}
module.exports = { NetworkFirewallError };
