"use strict";

class ContainerError extends Error {
  constructor(code, message, details = {}) {
    super(String(message || code));
    this.name = "ContainerError";
    this.code = code;
    this.details = details;
  }
}

module.exports = { ContainerError };
