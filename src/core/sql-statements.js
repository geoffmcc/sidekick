"use strict";

// Content-preserving SQL statement utilities for the migration runner.
//
// This is deliberately distinct from the module-system validation tokenizer in
// `src/modules/migrations.js`. That tokenizer strips string and comment content
// because it only needs to classify statement *shapes* for its data-only
// allowlist. The functions here preserve every character of each statement so
// the migration runner can execute them verbatim, one at a time, which is what
// makes idempotent `ALTER TABLE ADD COLUMN` handling possible.

// Split a SQL script into individual statements on top-level `;` boundaries,
// preserving the original text of each statement (including string literals and
// comments). Quote and comment state is tracked so a `;` inside a string, an
// identifier, or a comment is never treated as a separator. The Sidekick
// migration files contain no compound `BEGIN ... END` statements; if that ever
// changes this splitter must be extended before it is used on them.
function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inBlock = false;
  let inLine = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    current += c;
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { current += next; i++; inBlock = false; }
      continue;
    }
    if (inSingle) {
      if (c === "'") { if (next === "'") { current += next; i++; } else inSingle = false; }
      continue;
    }
    if (inDouble) {
      if (c === '"') { if (next === '"') { current += next; i++; } else inDouble = false; }
      continue;
    }
    if (inBacktick) {
      if (c === "`") inBacktick = false;
      continue;
    }
    if (c === "-" && next === "-") { current += next; i++; inLine = true; continue; }
    if (c === "/" && next === "*") { current += next; i++; inBlock = true; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === "`") { inBacktick = true; continue; }
    if (c === ";") {
      const trimmed = current.slice(0, -1).trim();
      if (trimmed) statements.push(trimmed);
      current = "";
    }
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

// Strip leading line/block comments and whitespace so a statement can be matched
// against its leading keyword. Does not alter the statement that is executed.
function stripLeadingComments(statement) {
  let s = statement;
  for (;;) {
    s = s.replace(/^\s+/, "");
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl < 0 ? "" : s.slice(nl + 1);
      continue;
    }
    if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end < 0 ? "" : s.slice(end + 2);
      continue;
    }
    break;
  }
  return s;
}

// SECURITY CONTROL: the [A-Za-z0-9_] capture groups are what make it safe for
// the migration runner to interpolate the returned table/column names into a
// PRAGMA statement (see src/db.js migrationColumnExists). Do not relax these
// character classes to accept quoted identifiers or arbitrary bytes without
// re-parameterizing every consumer — doing so would reintroduce SQL injection.
const ADD_COLUMN_RE =
  /^ALTER\s+TABLE\s+"?([A-Za-z0-9_]+)"?\s+ADD\s+(?:COLUMN\s+)?"?([A-Za-z0-9_]+)"?/i;

// If a statement is `ALTER TABLE <table> ADD COLUMN <column> ...`, return the
// unquoted table and column names; otherwise null. Leading comments are ignored.
function parseAddColumn(statement) {
  const match = stripLeadingComments(statement).match(ADD_COLUMN_RE);
  if (!match) return null;
  return { table: match[1], column: match[2] };
}

module.exports = { splitSqlStatements, stripLeadingComments, parseAddColumn };
