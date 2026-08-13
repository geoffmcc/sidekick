"use strict";

/**
 * Detection of OPTIONAL local automation providers (Ansible, nodex, SSH,
 * OpenTofu/Terraform).
 *
 * Detection is presence-only and execution-free: it scans PATH and stats
 * candidate files. It never runs a binary, so it needs no governed shell
 * permission and cannot be turned into a command-execution primitive.
 *
 * The distinction the capability model draws is deliberate: `installed` means
 * the binary exists on the Sidekick host; it does NOT mean configured,
 * authorized, or usable. This release exposes NO execution through any of these
 * providers — a guest being discoverable via Proxmox never implies it is
 * SSH- or Ansible-manageable. Execution is a documented future phase; reporting
 * presence here is what lets that phase be designed without pretending it
 * already works.
 */

const fs = require("fs");
const path = require("path");

const IS_WINDOWS = process.platform === "win32";
const EXE_SUFFIXES = IS_WINDOWS ? ["", ".exe", ".cmd", ".bat"] : [""];

function whichSync(binary) {
  const pathVar = process.env.PATH || "";
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const suffix of EXE_SUFFIXES) {
      const candidate = path.join(dir, binary + suffix);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return true;
      } catch {}
    }
  }
  return false;
}

// Provider name → the binaries whose presence indicates it. First hit wins.
const PROVIDER_BINARIES = Object.freeze({
  ansible: ["ansible-playbook", "ansible"],
  nodex: ["nodex"],
  ssh: ["ssh"],
  opentofu: ["tofu"],
  terraform: ["terraform"],
});

function detectProvider(name) {
  const binaries = PROVIDER_BINARIES[name] || [name];
  const installed = binaries.some(whichSync);
  return {
    name,
    installed,
    state: installed ? "installed" : "not_installed",
    // Honesty: presence is not usability, and no execution path is wired.
    execution: "not_implemented",
    note: installed
      ? `${name} is present on the Sidekick host but no execution capability is exposed in this release.`
      : `${name} was not found on the Sidekick host.`,
  };
}

function detectAll(names) {
  const list = names && names.length ? names : Object.keys(PROVIDER_BINARIES);
  const out = {};
  for (const name of list) out[name] = detectProvider(name);
  return out;
}

module.exports = { whichSync, detectProvider, detectAll, PROVIDER_BINARIES };
