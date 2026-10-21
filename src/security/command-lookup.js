"use strict";

const fs = require("fs");
const path = require("path");

function resolveCommandOnPath(name, searchPath = process.env.PATH || "", pathExt = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD", platform = process.platform) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  const windows = platform === "win32";
  const pathApi = windows ? path.win32 : path;
  const delimiter = windows ? ";" : path.delimiter;
  const extensions = windows ? pathExt.split(";").map(value => value.trim()).filter(value => /^\.[A-Za-z0-9]{1,8}$/.test(value)) : [""];
  for (const rawDirectory of String(searchPath).split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, "");
    if (!directory || !pathApi.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, windows ? `${name}${extension}` : name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!windows) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

module.exports = { resolveCommandOnPath };
