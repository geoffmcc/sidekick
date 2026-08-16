"use strict";

const dbStore = require("../db");
const { encryptSecret, decryptSecret } = require("../core/secret-cipher");
const { loadPackSecrets, savePackSecret, deletePackSecret } = require("../core/secrets-store");

const PACK_NAME_RE = /^[a-z][a-z0-9-]*$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

function validateKey(key) {
  if (!KEY_RE.test(String(key || ""))) throw new Error("pack state key must be a bounded safe name");
  return String(key);
}

function requireCapability(capabilities, capability) {
  if (!capabilities.has(capability)) {
    const error = new Error(`capability pack is not declared ${capability}`);
    error.code = "pack_capability_denied";
    throw error;
  }
}

function namespacedStateKey(packName, key) {
  return `pack:${packName}:${validateKey(key)}`;
}

function createPackServices(packName, permissions = [], base = {}) {
  if (!PACK_NAME_RE.test(String(packName || ""))) {
    throw new Error("services.v2 requires an installed capability-pack owner");
  }
  const capabilities = new Set((permissions || [])
    .filter(entry => entry && typeof entry.capability === "string")
    .map(entry => entry.capability));

  const secrets = Object.freeze({
    list() {
      requireCapability(capabilities, "pack.secrets.metadata");
      return Object.freeze(Object.keys(loadPackSecrets(packName)).sort());
    },
    get(key) {
      requireCapability(capabilities, "pack.secrets.use");
      const value = loadPackSecrets(packName)[validateKey(key)];
      return value === undefined ? null : decryptSecret(value);
    },
    set(key, value) {
      requireCapability(capabilities, "pack.secrets.write");
      if (typeof value !== "string") throw new Error("pack secret value must be a string");
      savePackSecret(packName, validateKey(key), encryptSecret(value));
      return { stored: true };
    },
    delete(key) {
      requireCapability(capabilities, "pack.secrets.write");
      return { removed: deletePackSecret(packName, validateKey(key)) };
    },
  });

  const storage = Object.freeze({
    get(key) {
      requireCapability(capabilities, "pack.storage.read");
      const entry = dbStore.getKV(namespacedStateKey(packName, key));
      return entry ? entry.value : null;
    },
    set(key, value) {
      requireCapability(capabilities, "pack.storage.write");
      dbStore.setKV(namespacedStateKey(packName, key), value, `pack:${packName}`, `pack:${packName}`, "capability-pack");
      return { stored: true };
    },
    delete(key) {
      requireCapability(capabilities, "pack.storage.delete");
      dbStore.deleteKV(namespacedStateKey(packName, key));
      return { removed: true };
    },
  });

  return Object.freeze({
    moduleName: base.moduleName,
    config: base.config,
    dispatch: base.dispatch,
    paths: base.paths,
    packName,
    secrets,
    storage,
  });
}

module.exports = { createPackServices };
