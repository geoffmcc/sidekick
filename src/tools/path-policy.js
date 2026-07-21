"use strict";

const fs = require("fs");
const path = require("path");
const { parsePolicyList, sourceEnvName } = require("../core/policy-env");
const toolContext = require("./context");

// Filesystem path policy: the security boundary that decides whether a tool
// invocation may touch a given path, based on the allow/deny lists configured
// for the current execution source.
//
// Policy is open by default. A deny match always wins. When any allow entry is
// configured, a path must match one to be permitted. Environment variables are
// read on every call so configuration changes take effect without a restart,
// and the execution source is resolved per call from the request-scoped
// context.
//
// Paths are canonicalized through realpath before they are compared, so a
// symlink is judged by where it points rather than by where it sits. See
// canonicalizePath for how targets that do not exist yet are handled.
//
// This module requires only `fs`, `path`, `../core/policy-env`, and
// `./context`, so descriptor families can depend on it without requiring
// `src/tools-legacy.js` at module top level.

function normalizePolicyPath(filePath) {
  return path.resolve(String(filePath || ""));
}

// How many path components we are willing to resolve. Comfortably above any
// legitimate target, and it bounds the syscalls a single request can provoke.
const MAX_PATH_COMPONENTS = 256;

// Windows accepts both separators, so both must be recognized there or a ".."
// spelled with the other one would slip past the check below. On POSIX a
// backslash is an ordinary filename character and must not split a component.
const PATH_SEPARATOR_PATTERN = process.platform === "win32" ? /[\\/]/ : /\//;

// Classify a component that realpath refused to resolve.
//
// A dangling symlink is indistinguishable from an absent entry by realpath
// alone: both fail with ENOENT, and existsSync reports false for both. Treating
// the two alike would let `<allowRoot>/dangling` be judged as an ordinary new
// file under the allow root, hiding wherever the link actually points. lstat
// inspects the link itself, so it separates them.
//
// Returns null when the component is merely absent, or an error string when the
// path must not be used.
function classifyUnresolvedComponent(candidate, error) {
  const code = error && error.code;

  // ENOENT: nothing at this component. ENOTDIR: an ancestor is a file, so the
  // component cannot exist either. Anything else — ELOOP from a symlink cycle,
  // EACCES from an unreadable directory — we refuse to guess past.
  if (code !== "ENOENT" && code !== "ENOTDIR") {
    return "path could not be resolved";
  }

  let entry = null;
  try {
    entry = fs.lstatSync(candidate);
  } catch {
    entry = null;
  }
  return entry && entry.isSymbolicLink() ? "path contains an unresolvable symlink" : null;
}

// Canonicalize a path that contains no ".." component. realpath resolves the
// whole chain in one call, so this is a single syscall for the common case of
// an existing target. Only when the target does not exist yet do we walk up to
// the deepest existing ancestor and carry the missing tail.
//
// Correct only because no ".." is present: with none, resolving the whole path
// at once and resolving it component by component agree.
function canonicalizeWithoutParentSegments(absolutePath) {
  const unresolved = [];
  let current = absolutePath;

  for (;;) {
    try {
      const resolved = fs.realpathSync(current);
      if (unresolved.length === 0) return { path: resolved };
      return { path: path.join(resolved, ...unresolved.reverse()) };
    } catch (error) {
      const failure = classifyUnresolvedComponent(current, error);
      if (failure) return { error: failure };

      const parent = path.dirname(current);
      if (parent === current) return { error: "path could not be resolved" };
      unresolved.push(path.basename(current));
      if (unresolved.length > MAX_PATH_COMPONENTS) return { error: "path could not be resolved" };
      current = parent;
    }
  }
}

// Canonicalize a path containing at least one "..", component by component.
//
// The ordering is the security-relevant part: ".." must be applied to a
// symlink's *target* directory, the way the kernel applies it, not collapsed
// lexically beforehand. Collapsing first erases the link entirely —
// `<allowRoot>/link/../elsewhere` normalizes to a path under the allow root
// while the kernel reads through the link to somewhere else.
function canonicalizeWithParentSegments(absolutePath) {
  const root = path.parse(absolutePath).root;
  const segments = absolutePath.slice(root.length).split(PATH_SEPARATOR_PATTERN).filter(seg => seg && seg !== ".");

  if (segments.length > MAX_PATH_COMPONENTS) return { error: "path could not be resolved" };

  let base;
  try {
    base = fs.realpathSync(root);
  } catch {
    return { error: "path could not be resolved" };
  }

  // Components below the deepest existing ancestor, still unresolved.
  const pending = [];

  for (const segment of segments) {
    if (segment === "..") {
      // Below the last existing ancestor there is nothing to resolve, so ".."
      // just pops. At or above it, `base` is already canonical, which is
      // precisely what makes dirname here match kernel behavior.
      if (pending.length > 0) pending.pop();
      else base = path.dirname(base);
      continue;
    }

    if (pending.length > 0) {
      pending.push(segment);
      continue;
    }

    const candidate = path.join(base, segment);
    try {
      base = fs.realpathSync(candidate);
    } catch (error) {
      const failure = classifyUnresolvedComponent(candidate, error);
      if (failure) return { error: failure };
      pending.push(segment);
    }
  }

  return { path: pending.length > 0 ? path.join(base, ...pending) : base };
}

// Canonicalize a requested path for policy comparison, resolving every symlink
// in the parts of it that exist.
//
// A write target usually does not exist yet, and the policy has to decide
// before anything is created, so components below the last existing ancestor
// are carried unresolved and reattached. An escaping symlink in the existing
// prefix is still caught even when the leaf is missing.
//
// Returns { path } on success or { error } when the path must not be used.
// Nothing is created, and no failure falls back to a lexical comparison.
function canonicalizePath(requestedPath) {
  const raw = String(requestedPath || "");

  // A drive-relative spelling such as "C:tmp" is not absolute, and it resolves
  // against that drive's own working directory — which the concatenation below
  // cannot reproduce, so we would judge a different path than the one that
  // would be opened. Refuse instead of guessing.
  if (process.platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(raw)) {
    return { error: "path could not be resolved" };
  }

  // Concatenated rather than joined: path.join normalizes, and normalizing here
  // would collapse a relative path's ".." before the check below ever sees it,
  // reopening the escape for every relative input. Nothing downstream requires
  // a tidy string — canonicalizeWithParentSegments drops empty and "." segments,
  // and the fast path resolves separately.
  const absolute = path.isAbsolute(raw) ? raw : process.cwd() + path.sep + raw;
  const hasParentSegment = absolute
    .split(PATH_SEPARATOR_PATTERN)
    .some(segment => segment === "..");

  return hasParentSegment
    ? canonicalizeWithParentSegments(absolute)
    : canonicalizeWithoutParentSegments(path.resolve(absolute));
}

// Lexical containment: does `filePath` sit at or below `entry` by name alone?
// Used only to keep deny roots at least as strong as they were before
// canonicalization; allow roots never consult it.
function pathContainedLexically(filePath, entry) {
  const relative = path.relative(entry, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathPolicyEntries(source, suffix) {
  return [
    ...parsePolicyList(process.env["SIDEKICK_" + suffix]),
    ...parsePolicyList(process.env[sourceEnvName(source, suffix)])
  ];
}

// Containment test for a single entry. This is not an authorization check on
// its own: it knows nothing about deny-list precedence. Call
// getPathPolicyDecision or enforcePathPolicy to make a policy decision.
//
// Both sides are canonicalized, so this answers "does the effective filesystem
// target lie at or below this root", not "do these two strings nest". A path
// that cannot be resolved is reported as not contained; callers that need a
// policy outcome must use getPathPolicyDecision, which fails such a path closed.
function pathMatchesPolicyEntry(filePath, entry) {
  const canonicalPath = canonicalizePath(filePath);
  const canonicalEntry = canonicalizePath(entry);
  if (canonicalPath.error || canonicalEntry.error) return false;
  return pathContainedLexically(canonicalPath.path, canonicalEntry.path);
}

// Resolve every configured root once per decision. A root that simply does not
// exist yet keeps its lexical form, as it always has. A root that exists but
// cannot be resolved — a dangling symlink, an unreadable parent — is a
// configuration fault we refuse to evaluate against rather than silently drop,
// since dropping a deny root would widen access.
function resolvePolicyEntries(entries) {
  const resolved = [];
  for (const entry of entries) {
    const canonical = canonicalizePath(entry);
    // The offending root is deliberately not echoed to the caller: policy
    // configuration is not theirs to enumerate.
    if (canonical.error) return { error: "policy configuration could not be resolved" };
    resolved.push({ entry, lexical: normalizePolicyPath(entry), canonical: canonical.path });
  }
  return { resolved };
}

// The lexical half of deny matching, which needs no resolution. Answering with
// it first keeps deny at least as strong as it was before canonicalization — a
// symlink sitting inside a deny root that points elsewhere stays denied — and
// means a caller probing a deny root never reaches the resolution code below,
// so a failure there cannot describe what lives inside one.
function findLexicalDeniedMatch(entries, lexicalTarget) {
  return entries.find(entry => pathContainedLexically(lexicalTarget, normalizePolicyPath(entry)));
}

// Containment against canonicalized roots. Deny uses it to catch an alias that
// reaches into a deny root by another name; allow uses it so a symlink beneath
// an allow root whose target lies outside it is not permitted by where it sits.
function findCanonicalMatch(resolvedEntries, canonicalTarget) {
  const hit = resolvedEntries.find(entry => pathContainedLexically(canonicalTarget, entry.canonical));
  return hit ? hit.entry : undefined;
}

function getPathPolicyDecision(filePath, operation = "access", source = toolContext.getExecutionSource() || "unknown") {
  const target = normalizePolicyPath(filePath);
  const allowedEntries = pathPolicyEntries(source, "ALLOWED_PATHS");
  const deniedEntries = pathPolicyEntries(source, "DENIED_PATHS");

  // An open policy has no roots to compare against, so there is nothing a
  // symlink could subvert; skip resolution and keep today's behavior.
  if (deniedEntries.length === 0 && allowedEntries.length === 0) {
    return { allowed: true, source, operation, path: target, reason: "path policy is open" };
  }

  // Lexical deny before anything else. It is the pre-change comparison exactly,
  // so deny can only have grown; it reports the ordinary deny decision, so a
  // caller probing a deny root gets one uniform answer and the denial is still
  // recorded with the root it matched.
  const lexicalDeniedMatch = findLexicalDeniedMatch(deniedEntries, target);
  if (lexicalDeniedMatch) {
    return { allowed: false, source, operation, path: target, reason: "path denied by policy", matched: lexicalDeniedMatch, list: "denied" };
  }

  // Canonicalize the path as requested, not the lexically collapsed form: a
  // `..` after a symlink component must be applied to the link's target.
  const canonicalTarget = canonicalizePath(filePath);
  if (canonicalTarget.error) {
    // Explaining *why* resolution failed distinguishes "absent" from "exists
    // but unreadable" from "dangling symlink", which is a filesystem oracle for
    // anywhere the caller can name. Say so only inside an allow root, where the
    // caller is entitled to look and an operator needs the diagnosis; elsewhere
    // answer exactly as an ordinary out-of-policy path would. With no allow list
    // there is no confinement to leak against, so the diagnosis is kept.
    const insideAllowRoot = allowedEntries
      .some(entry => pathContainedLexically(target, normalizePolicyPath(entry)));
    const reason = insideAllowRoot || allowedEntries.length === 0
      ? canonicalTarget.error
      : "path not in allowed paths";
    return { allowed: false, source, operation, path: target, reason, matched: null };
  }

  const resolvedDenied = resolvePolicyEntries(deniedEntries);
  if (resolvedDenied.error) {
    return { allowed: false, source, operation, path: target, reason: resolvedDenied.error, matched: null };
  }
  const deniedMatch = findCanonicalMatch(resolvedDenied.resolved, canonicalTarget.path);

  if (deniedMatch) {
    return { allowed: false, source, operation, path: target, reason: "path denied by policy", matched: deniedMatch, list: "denied" };
  }

  if (allowedEntries.length > 0) {
    const resolvedAllowed = resolvePolicyEntries(allowedEntries);
    if (resolvedAllowed.error) {
      return { allowed: false, source, operation, path: target, reason: resolvedAllowed.error, matched: null };
    }
    const allowedMatch = findCanonicalMatch(resolvedAllowed.resolved, canonicalTarget.path);
    return {
      allowed: Boolean(allowedMatch),
      source,
      operation,
      path: target,
      reason: allowedMatch ? "path allowed by policy" : "path not in allowed paths",
      matched: allowedMatch || null,
      list: "allowed"
    };
  }

  return { allowed: true, source, operation, path: target, reason: "path policy is open" };
}

function enforcePathPolicy(filePath, operation = "access") {
  const decision = getPathPolicyDecision(filePath, operation);
  if (decision.allowed) return null;
  return {
    content: [{
      type: "text",
      text: `Path blocked by policy: ${decision.path} (source=${decision.source}, operation=${decision.operation}). ${decision.reason}.`
    }],
    isError: true
  };
}

// pathPolicyEntries stays module-private, as it was in src/tools-legacy.js, and
// so do the canonicalization helpers: resolution is the boundary's own
// responsibility and callers must not be able to opt out of it. Export them if
// a caller ever genuinely needs them.
module.exports = {
  normalizePolicyPath,
  pathMatchesPolicyEntry,
  getPathPolicyDecision,
  enforcePathPolicy,
};
