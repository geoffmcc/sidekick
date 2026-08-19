"use strict";
function requireFromSidekick(name) {
  try { return require(name); } catch { return require(`/home/sidekick/sidekick/node_modules/${name}`); }
}
function requireSidekickSrc(name) { return require(`/home/sidekick/sidekick/${name}`); }
module.exports = { requireFromSidekick, requireSidekickSrc };
