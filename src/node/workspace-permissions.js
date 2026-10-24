"use strict";

/** Permission required by a node tool operation, shared by Core and the node. */
function workspacePermissionForTool(toolName, args = {}) {
  const name = String(toolName || "");
  if (name === "bash") return "execute";
  if (name === "dev_verify") return args.dry_run === true ? "read" : "execute";
  if (["read", "list", "search", "summarize", "filter", "diff_files", "find", "semantic_repo", "dev_repo_profile", "dev_change_summary", "security_scan", "hash", "parse", "validate", "transform", "extract", "anonymize"].includes(name)) return "read";
  if (name === "write") return "write";
  if (name === "git") {
    const action = String(args.action || "");
    if (["add", "commit", "push", "pull", "checkout", "stash", "clone"].includes(action)) return "write";
    if (action === "branch" && String(args.args || "").trim()) return "write";
    return "read";
  }
  if (name === "changelog") return String(args.action || "") === "save" ? "write" : "read";
  return null;
}

module.exports = Object.freeze({ workspacePermissionForTool });
