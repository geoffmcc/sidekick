"use strict";

// Browser action implementations.
//
// Every action operates on a session owned by sessions.js, honors the
// dispatcher's cancellation signal, bounds its output, and returns structured
// data with page-derived content kept separable so the tool layer can label it
// untrusted. No action executes caller-supplied JavaScript: the few internal
// page.evaluate calls run fixed functions defined in this file.

const fs = require("fs");
const path = require("path");
const { browserConfig } = require("./config");
const egress = require("./egress");
const sessionsStore = require("./sessions");
const browserArtifacts = require("./artifacts");
const { getPathPolicyDecision } = require("../tools/path-policy");
const { matchHostPattern } = require("./egress");

class BrowserActionError extends Error {
  constructor(message, category, extra = {}) {
    super(message);
    this.name = "BrowserActionError";
    this.category = category;
    Object.assign(this, extra);
  }
}

function classifyError(error) {
  if (error instanceof BrowserActionError) return error;
  const message = String(error && error.message || error);
  const first = message.split("\n")[0].slice(0, 400);
  if (/ERR_BLOCKED_BY_CLIENT/.test(message)) {
    return new BrowserActionError("Request blocked by the session's egress policy", "blocked_by_policy");
  }
  if (/Timeout .*exceeded|timeout.*exceeded/i.test(message)) {
    return new BrowserActionError(`Timed out: ${first}`, "timeout");
  }
  if (/strict mode violation/i.test(message)) {
    return new BrowserActionError(`Locator matched multiple elements: ${first}. Refine the target or add nth.`, "ambiguous_locator");
  }
  if (/Target page, context or browser has been closed|Target closed/i.test(message)) {
    return new BrowserActionError("The page or browser closed during the operation", "target_closed");
  }
  if (/net::ERR_NAME_NOT_RESOLVED/.test(message)) {
    return new BrowserActionError(`Navigation failed: DNS name not resolved`, "navigation_failed");
  }
  if (/net::ERR_/.test(message)) {
    return new BrowserActionError(`Navigation failed: ${first}`, "navigation_failed");
  }
  if (/waiting for|not visible|not found|failed to find/i.test(message)) {
    return new BrowserActionError(first, "element_not_found");
  }
  return new BrowserActionError(first, "browser_error");
}

/** Race a Playwright operation against the dispatcher's cancellation signal. */
async function withCancellation(promise, signal, { onCancel = null } = {}) {
  if (!signal) return promise;
  if (signal.aborted) {
    if (onCancel) await onCancel().catch(() => {});
    throw new BrowserActionError("Operation cancelled", "cancelled");
  }
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(new BrowserActionError("Operation cancelled", "cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } catch (error) {
    if (error && error.category === "cancelled" && onCancel) await onCancel().catch(() => {});
    // The raced Playwright promise may still settle later; swallow its outcome
    // so a late rejection cannot become an unhandled rejection.
    Promise.resolve(promise).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function stopLoading(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.stopLoading");
    await cdp.detach().catch(() => {});
  } catch { /* best-effort interrupt */ }
}

function boundTimeout(requested, fallback, ceiling) {
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(100, Math.min(value, ceiling));
}

/**
 * Build a Playwright locator from a target spec. String targets are CSS /
 * Playwright selector syntax; object targets use semantic locators (role,
 * label, placeholder, text, testid) which survive markup churn far better
 * than generated CSS.
 */
function buildLocator(page, target) {
  if (target === undefined || target === null || target === "") {
    throw new BrowserActionError("This action requires a target (string selector or locator object)", "invalid_argument");
  }
  if (typeof target === "string") return page.locator(target);
  const { kind, value, name, exact, nth } = target;
  let locator;
  switch (kind) {
    case "role":
      locator = page.getByRole(value, name !== undefined ? { name, exact: exact === true } : {});
      break;
    case "label": locator = page.getByLabel(value, { exact: exact === true }); break;
    case "placeholder": locator = page.getByPlaceholder(value, { exact: exact === true }); break;
    case "text": locator = page.getByText(value, { exact: exact === true }); break;
    case "testid": locator = page.getByTestId(value); break;
    case "css": locator = page.locator(value); break;
    default:
      throw new BrowserActionError(`Unknown target kind "${kind}" (use role|label|placeholder|text|testid|css)`, "invalid_argument");
  }
  if (Number.isInteger(nth)) locator = locator.nth(nth);
  return locator;
}

function truncate(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

async function pageState(session, entry) {
  let title = "";
  try { title = await entry.page.title(); } catch { /* page may be navigating */ }
  return {
    id: entry.id,
    url: entry.page.url(),
    title: sessionsStore.scrubSecrets(session, String(title).slice(0, 300)),
  };
}

// ---------------------------------------------------------------------------
// Navigation

async function navigate(session, args, runtime) {
  const config = browserConfig();
  const entry = sessionsStore.activePage(session, args.page);
  const refusal = egress.evaluateBrowserUrl(args.url, session.policy);
  if (refusal) throw new BrowserActionError(`Navigation refused: ${refusal}`, "blocked_by_policy");
  const timeout = boundTimeout(args.timeout_ms, config.navTimeoutMs, config.navTimeoutMs * 2);
  const response = await withCancellation(
    entry.page.goto(args.url, { waitUntil: args.wait_until || "load", timeout }),
    runtime.signal,
    { onCancel: () => stopLoading(entry.page) }
  ).catch((error) => { throw classifyError(error); });
  const status = response ? response.status() : null;
  const result = { status, page: await pageState(session, entry) };
  // A proxy-blocked navigation surfaces as a 403 whose body the proxy wrote.
  // Attach the recorded reason when the block evidence is fresh.
  if (status === 403 && session.blockedRequests.length) {
    const last = session.blockedRequests[session.blockedRequests.length - 1];
    if (last && Date.now() - Date.parse(last.at) < 5000) result.blocked_by_egress_policy = last.reason;
  }
  return result;
}

async function history(session, args, runtime, direction) {
  const config = browserConfig();
  const entry = sessionsStore.activePage(session, args.page);
  const timeout = boundTimeout(args.timeout_ms, config.navTimeoutMs, config.navTimeoutMs * 2);
  const op = direction === "back" ? entry.page.goBack({ timeout })
    : direction === "forward" ? entry.page.goForward({ timeout })
    : entry.page.reload({ timeout });
  const response = await withCancellation(op, runtime.signal, { onCancel: () => stopLoading(entry.page) })
    .catch((error) => { throw classifyError(error); });
  return { status: response ? response.status() : null, page: await pageState(session, entry) };
}

// ---------------------------------------------------------------------------
// Observation

const INTERACTIVE_SELECTOR = [
  "a[href]", "button", "input", "select", "textarea", "summary",
  "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]",
  "[role=tab]", "[role=menuitem]", "[role=combobox]", "[role=textbox]",
].join(", ");

// Fixed inspection function — runs in the page but is defined here, not by the
// caller. Password values are never read.
function describeElementInPage(el) {
  const type = (el.getAttribute && (el.getAttribute("type") || "")).toLowerCase();
  const isPassword = type === "password";
  return {
    tag: el.tagName ? el.tagName.toLowerCase() : null,
    type: type || null,
    role: el.getAttribute ? el.getAttribute("role") : null,
    id: el.id || null,
    name: el.getAttribute ? el.getAttribute("name") : null,
    placeholder: el.getAttribute ? el.getAttribute("placeholder") : null,
    aria_label: el.getAttribute ? el.getAttribute("aria-label") : null,
    text: (el.innerText || el.value === undefined ? el.innerText || "" : "").trim().slice(0, 120),
    value: isPassword ? "[password field]" : (el.value !== undefined ? String(el.value).slice(0, 120) : null),
    href: el.href ? String(el.href).slice(0, 300) : null,
    disabled: el.disabled === true,
    checked: el.checked === true ? true : (el.checked === false ? false : null),
  };
}

async function snapshot(session, args, runtime) {
  const config = browserConfig();
  const entry = sessionsStore.activePage(session, args.page);
  const kind = args.kind || "text";
  const maxChars = boundTimeout(args.max_chars, config.maxOutputChars, config.maxOutputChars);
  const scope = args.selector ? entry.page.locator(args.selector) : entry.page.locator("body");

  let content;
  let truncated = false;
  if (kind === "text" || kind === "html") {
    // Slice IN THE PAGE so a giant text/DOM node never crosses into Node as a
    // full string before truncation — `max_chars` bounds the fetch, not just
    // the returned value. A tiny margin over the cap lets us report truncation.
    const property = kind === "text" ? "innerText" : "innerHTML";
    const bounded = await withCancellation(
      scope.evaluate((el, args2) => {
        const value = String(el[args2.prop] || "");
        return { text: value.slice(0, args2.n + 1), full: value.length };
      }, { prop: property, n: maxChars }, { timeout: config.actionTimeoutMs }),
      runtime.signal
    ).catch((error) => { throw classifyError(error); });
    truncated = bounded.full > maxChars;
    content = truncated ? bounded.text.slice(0, maxChars) : bounded.text;
    if (kind === "text") content = content.replace(/\n{3,}/g, "\n\n");
  } else if (kind === "aria") {
    const raw = await withCancellation(scope.ariaSnapshot({ timeout: config.actionTimeoutMs }), runtime.signal)
      .catch((error) => { throw classifyError(error); });
    const bounded = truncate(raw, maxChars);
    content = bounded.text;
    truncated = bounded.truncated;
  } else if (kind === "interactive") {
    const locator = args.selector
      ? entry.page.locator(args.selector).locator(INTERACTIVE_SELECTOR)
      : entry.page.locator(INTERACTIVE_SELECTOR);
    const limit = Math.min(Number(args.max_matches) > 0 ? Number(args.max_matches) : 50, config.maxExtractMatches);
    const elements = await withCancellation(locator.all(), runtime.signal)
      .catch((error) => { throw classifyError(error); });
    truncated = elements.length > limit;
    const described = [];
    for (const element of elements.slice(0, limit)) {
      try {
        described.push(await element.evaluate(describeElementInPage));
      } catch { /* element detached between enumeration and inspection */ }
    }
    content = described;
  } else {
    throw new BrowserActionError(`Unknown snapshot kind "${kind}" (use text|aria|interactive|html)`, "invalid_argument");
  }
  return {
    kind,
    truncated,
    page: await pageState(session, entry),
    content: sessionsStore.scrubSecretsDeep(session, content),
  };
}

async function extract(session, args, runtime) {
  const config = browserConfig();
  const entry = sessionsStore.activePage(session, args.page);
  if (!Array.isArray(args.fields) || !args.fields.length) {
    throw new BrowserActionError("extract requires a non-empty fields array", "invalid_argument");
  }
  if (args.fields.length > 25) {
    throw new BrowserActionError("extract supports at most 25 fields per call", "invalid_argument");
  }
  const scope = args.selector ? entry.page.locator(args.selector) : entry.page;
  const maxMatches = Math.min(Number(args.max_matches) > 0 ? Number(args.max_matches) : 20, config.maxExtractMatches);
  const data = {};
  const missing = [];
  let truncated = false;

  for (const field of args.fields) {
    const fieldName = String(field.name || "").trim();
    if (!fieldName) throw new BrowserActionError("every extract field needs a name", "invalid_argument");
    let locator;
    try {
      locator = buildLocator(scope, field.target);
    } catch (error) {
      throw new BrowserActionError(`field "${fieldName}": ${error.message}`, "invalid_argument");
    }
    const FIELD_CAP = 2000;
    const readValue = async (element) => {
      const attr = field.attr || "text";
      let raw;
      if (attr === "text" || attr === "html") {
        // Bounded in-page read so a huge node cannot materialize fully in Node.
        const prop = attr === "text" ? "innerText" : "innerHTML";
        const out = await element.evaluate((el, args2) => {
          const value = String(el[args2.prop] || "");
          return { text: value.slice(0, args2.n + 1), full: value.length };
        }, { prop, n: FIELD_CAP }, { timeout: config.actionTimeoutMs });
        if (out.full > FIELD_CAP) truncated = true;
        return out.text.slice(0, FIELD_CAP).trim();
      }
      if (attr === "value") raw = await element.inputValue({ timeout: config.actionTimeoutMs });
      else raw = await element.getAttribute(attr, { timeout: config.actionTimeoutMs });
      if (raw === null || raw === undefined) return null;
      const bounded = truncate(String(raw).trim(), FIELD_CAP);
      if (bounded.truncated) truncated = true;
      return bounded.text;
    };
    try {
      if (field.all === true) {
        const elements = await withCancellation(locator.all(), runtime.signal);
        if (elements.length > maxMatches) truncated = true;
        const values = [];
        for (const element of elements.slice(0, maxMatches)) values.push(await readValue(element));
        if (!values.length && field.required !== false) missing.push(fieldName);
        data[fieldName] = values;
      } else {
        const count = await withCancellation(locator.count(), runtime.signal);
        if (count === 0) {
          if (field.required !== false) missing.push(fieldName);
          data[fieldName] = null;
        } else {
          data[fieldName] = await withCancellation(readValue(locator.first()), runtime.signal);
        }
      }
    } catch (error) {
      const classified = classifyError(error);
      if (classified.category === "cancelled") throw classified;
      data[fieldName] = null;
      if (field.required !== false) missing.push(fieldName);
    }
  }
  return {
    page: await pageState(session, entry),
    data: sessionsStore.scrubSecretsDeep(session, data),
    missing,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Interaction

async function interact(session, args, runtime, operation) {
  const config = browserConfig();
  const entry = sessionsStore.activePage(session, args.page);
  const timeout = boundTimeout(args.timeout_ms, config.actionTimeoutMs, config.actionTimeoutMs * 6);
  const run = async () => {
    switch (operation) {
      case "click": {
        const locator = buildLocator(entry.page, args.target);
        await locator.click({
          timeout,
          button: args.button || "left",
          clickCount: args.double === true ? 2 : 1,
        });
        return {};
      }
      case "fill": {
        const locator = buildLocator(entry.page, args.target);
        await locator.fill(args.value ?? "", { timeout });
        return {};
      }
      case "clear": {
        const locator = buildLocator(entry.page, args.target);
        await locator.clear({ timeout });
        return {};
      }
      case "select": {
        const locator = buildLocator(entry.page, args.target);
        const values = Array.isArray(args.values) ? args.values : [args.value];
        const selected = await locator.selectOption(values.map((v) => String(v)), { timeout });
        return { selected };
      }
      case "check": {
        const locator = buildLocator(entry.page, args.target);
        await locator.setChecked(args.checked !== false, { timeout });
        return { checked: args.checked !== false };
      }
      case "press": {
        if (!args.key) throw new BrowserActionError("press requires a key", "invalid_argument");
        if (args.target) await buildLocator(entry.page, args.target).press(args.key, { timeout });
        else await entry.page.keyboard.press(args.key);
        return { key: args.key };
      }
      case "hover": {
        await buildLocator(entry.page, args.target).hover({ timeout });
        return {};
      }
      case "focus": {
        await buildLocator(entry.page, args.target).focus({ timeout });
        return {};
      }
      case "scroll": {
        if (args.target) {
          await buildLocator(entry.page, args.target).scrollIntoViewIfNeeded({ timeout });
          return { scrolled: "element" };
        }
        if (args.to === "top") { await entry.page.evaluate(() => window.scrollTo(0, 0)); return { scrolled: "top" }; }
        if (args.to === "bottom") { await entry.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); return { scrolled: "bottom" }; }
        const byY = Number(args.by_y) || 0;
        await entry.page.evaluate((delta) => window.scrollBy(0, delta), byY);
        return { scrolled: `by ${byY}px` };
      }
      default:
        throw new BrowserActionError(`Unknown interaction "${operation}"`, "invalid_argument");
    }
  };
  const result = await withCancellation(run(), runtime.signal).catch((error) => { throw classifyError(error); });
  return { ...result, page: await pageState(session, entry) };
}

/**
 * Fill a field with a secret resolved by the tool layer. The plaintext is
 * tracked for output scrubbing and never returned. Filling a non-password
 * field with a secret marks the page sensitive, which gates screenshots.
 */
async function secretFill(session, args, runtime, plaintext) {
  const config = browserConfig();
  const entry = sessionsStore.activePage(session, args.page);
  const timeout = boundTimeout(args.timeout_ms, config.actionTimeoutMs, config.actionTimeoutMs * 6);

  // Destination binding — the core of "safe credential entry". A credential
  // must never be typed into a page whose origin the caller did not intend,
  // because page JavaScript can read a filled field's value and POST it
  // anywhere the egress policy allows. Resolve the CURRENT page origin and
  // require it to be bound before the secret is resolved into the DOM:
  //   * a session opened with allowed_hosts is already scoped — the current
  //     origin must match that list;
  //   * otherwise the caller MUST pass expected_host equal to the current
  //     page origin, forcing an explicit, checkable destination.
  let currentHost;
  try {
    currentHost = new URL(entry.page.url()).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    throw new BrowserActionError("secret_fill requires the page to be on an http(s) origin", "invalid_argument");
  }
  if (!currentHost) throw new BrowserActionError("secret_fill requires a navigated page with a host origin", "invalid_argument");

  if (session.policy.allowedHosts) {
    const bound = session.policy.allowedHosts.some((pattern) => matchHostPattern(currentHost, pattern));
    if (!bound) {
      throw new BrowserActionError(
        `secret_fill refused: current page host "${currentHost}" is not in this session's allowed_hosts, so the credential's destination is not bound`,
        "secret_destination_unbound"
      );
    }
  } else {
    const expected = args.expected_host ? String(args.expected_host).toLowerCase() : null;
    if (!expected) {
      throw new BrowserActionError(
        `secret_fill refused: this session has no allowed_hosts, so you must pass expected_host to bind the credential to a destination. Current page host is "${currentHost}".`,
        "secret_destination_unbound"
      );
    }
    if (!matchHostPattern(currentHost, expected)) {
      throw new BrowserActionError(
        `secret_fill refused: current page host "${currentHost}" does not match expected_host "${expected}"`,
        "secret_destination_mismatch"
      );
    }
  }

  const locator = buildLocator(entry.page, args.target);
  sessionsStore.trackSecret(session, plaintext);
  const warnings = [];
  await withCancellation(locator.fill(plaintext, { timeout }), runtime.signal)
    .catch((error) => {
      // Defense in depth: scrub the tracked secret from any error text before
      // it leaves this function, in case a driver error ever echoes the value.
      const classified = classifyError(error);
      classified.message = sessionsStore.scrubSecrets(session, classified.message);
      throw classified;
    });
  let fieldType = null;
  try {
    fieldType = await locator.evaluate((el) => (el.getAttribute && el.getAttribute("type")) || (el.type || null));
  } catch { /* detached after fill */ }
  if (String(fieldType || "").toLowerCase() !== "password") {
    sessionsStore.markPageSensitive(session, entry.id);
    warnings.push("secret was filled into a non-password field; this page is now marked sensitive and screenshots require acknowledge_sensitive=true");
  }
  return { filled: true, field_type: fieldType, warnings, page: await pageState(session, entry) };
}

// ---------------------------------------------------------------------------
// Waiting

async function waitFor(session, args, runtime) {
  const config = browserConfig();
  const entry = sessionsStore.activePage(session, args.page);
  const timeout = boundTimeout(args.timeout_ms, config.actionTimeoutMs, config.navTimeoutMs * 2);
  const condition = args.for || (args.target ? "selector" : null);
  const run = async () => {
    switch (condition) {
      case "selector":
        await buildLocator(entry.page, args.target).waitFor({ state: "visible", timeout });
        return { condition: "selector visible" };
      case "hidden":
        await buildLocator(entry.page, args.target).waitFor({ state: "hidden", timeout });
        return { condition: "selector hidden" };
      case "url":
        if (!args.pattern) throw new BrowserActionError("wait for=url requires pattern", "invalid_argument");
        await entry.page.waitForURL((url) => url.href.includes(args.pattern), { timeout });
        return { condition: `url contains "${args.pattern}"` };
      case "load":
        await entry.page.waitForLoadState(args.state || "load", { timeout });
        return { condition: `load state ${args.state || "load"}` };
      case "text":
        if (!args.text) throw new BrowserActionError("wait for=text requires text", "invalid_argument");
        await entry.page.getByText(args.text).first().waitFor({ state: "visible", timeout });
        return { condition: `text visible` };
      case "download": {
        const baseline = session.downloads.length;
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (runtime.signal && runtime.signal.aborted) throw new BrowserActionError("Operation cancelled", "cancelled");
          const settled = session.downloads.slice(baseline).find((d) => d.status !== "pending");
          if (settled) return { condition: "download completed", download: settled };
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new BrowserActionError(`No download completed within ${timeout}ms`, "timeout");
      }
      default:
        throw new BrowserActionError(`wait requires for=selector|hidden|url|load|text|download`, "invalid_argument");
    }
  };
  const result = await withCancellation(run(), runtime.signal).catch((error) => { throw classifyError(error); });
  return { ...result, page: await pageState(session, entry) };
}

// ---------------------------------------------------------------------------
// Evidence

async function screenshot(session, args, runtime) {
  const config = browserConfig();
  const entry = sessionsStore.activePage(session, args.page);
  const sensitive = sessionsStore.isPageSensitive(session, entry.id);
  if (sensitive && args.acknowledge_sensitive !== true) {
    throw new BrowserActionError(
      "A secret was filled into a visible field on this page. Pass acknowledge_sensitive=true to capture it anyway; the artifact will be registered with sensitivity=sensitive.",
      "sensitive_page"
    );
  }
  const run = async () => {
    if (args.target) return buildLocator(entry.page, args.target).screenshot({ timeout: config.actionTimeoutMs });
    return entry.page.screenshot({ fullPage: args.full_page === true, timeout: config.navTimeoutMs });
  };
  const bytes = await withCancellation(run(), runtime.signal).catch((error) => { throw classifyError(error); });
  const state = await pageState(session, entry);
  const artifact = browserArtifacts.storeArtifact({
    sessionId: session.id,
    kind: "screenshot",
    name: `${args.label || "screenshot"}.png`,
    bytes,
    contentType: "image/png",
    sensitivity: sensitive ? "sensitive" : "normal",
    executionContext: session.executionContext,
    metadata: { url: state.url, full_page: args.full_page === true },
  });
  return { page: state, artifact };
}

async function upload(session, args, runtime) {
  const config = browserConfig();
  const entry = sessionsStore.activePage(session, args.page);
  let filePath;
  let provenance;
  if (args.artifact_id) {
    const resolved = browserArtifacts.resolveArtifactFile(args.artifact_id, { project: session.project });
    if (resolved.error) throw new BrowserActionError(`upload source: ${resolved.error}`, "invalid_argument");
    filePath = resolved.path;
    provenance = { kind: "artifact", artifact_id: args.artifact_id, name: resolved.artifact.name || null };
  } else if (args.path) {
    const roots = String(process.env.SIDEKICK_BROWSER_UPLOAD_ROOTS || "")
      .split(path.delimiter).map((entry2) => entry2.trim()).filter(Boolean);
    if (!roots.length) {
      throw new BrowserActionError(
        "Path uploads are disabled: no SIDEKICK_BROWSER_UPLOAD_ROOTS configured. Upload a registered artifact instead (artifact_id).",
        "upload_not_permitted"
      );
    }
    // Resolve symlinks BEFORE the containment and policy checks: a symlink
    // inside an upload root pointing at /etc/shadow would otherwise pass a
    // lexical containment test while setInputFiles follows it to the real
    // target. realpath makes both checks judge where the path actually points.
    let resolved;
    try {
      resolved = fs.realpathSync(path.resolve(String(args.path)));
    } catch {
      throw new BrowserActionError("upload source file does not exist", "invalid_argument");
    }
    const inRoot = roots.some((root) => {
      let r;
      try { r = fs.realpathSync(path.resolve(root)); } catch { return false; }
      return resolved === r || resolved.startsWith(r + path.sep);
    });
    if (!inRoot) {
      throw new BrowserActionError(`upload path (after resolving symlinks) is outside the configured upload roots`, "upload_not_permitted");
    }
    const decision = getPathPolicyDecision(resolved, "read");
    if (!decision.allowed) {
      throw new BrowserActionError(`upload path blocked by path policy: ${decision.reason}`, "upload_not_permitted");
    }
    filePath = resolved;
    provenance = { kind: "path", path: resolved };
  } else {
    throw new BrowserActionError("upload requires artifact_id or path", "invalid_argument");
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch {
    throw new BrowserActionError("upload source file does not exist", "invalid_argument");
  }
  if (!stat.isFile()) throw new BrowserActionError("upload source is not a regular file", "invalid_argument");
  if (stat.size > config.maxUploadBytes) {
    throw new BrowserActionError(`upload of ${stat.size} bytes exceeds the ${config.maxUploadBytes}-byte limit`, "upload_too_large");
  }
  const locator = buildLocator(entry.page, args.target);
  await withCancellation(locator.setInputFiles(filePath, { timeout: config.actionTimeoutMs }), runtime.signal)
    .catch((error) => { throw classifyError(error); });
  return {
    uploaded: true,
    provenance,
    byte_size: stat.size,
    page: await pageState(session, entry),
  };
}

// ---------------------------------------------------------------------------
// Verification

async function runAssertions(session, args, runtime) {
  const config = browserConfig();
  const entry = sessionsStore.activePage(session, args.page);
  if (!Array.isArray(args.assertions) || !args.assertions.length) {
    throw new BrowserActionError("assert requires a non-empty assertions array", "invalid_argument");
  }
  if (args.assertions.length > 25) {
    throw new BrowserActionError("assert supports at most 25 assertions per call", "invalid_argument");
  }
  const results = [];
  for (const assertion of args.assertions) {
    if (runtime.signal && runtime.signal.aborted) throw new BrowserActionError("Operation cancelled", "cancelled");
    const kind = assertion.kind;
    const item = { kind, passed: false };
    try {
      switch (kind) {
        case "url_contains": {
          const actual = entry.page.url();
          item.actual = actual;
          item.passed = actual.includes(String(assertion.value));
          break;
        }
        case "title_contains": {
          const actual = await entry.page.title();
          item.actual = String(actual).slice(0, 300);
          item.passed = String(actual).includes(String(assertion.value));
          break;
        }
        case "text_visible": {
          item.passed = await entry.page.getByText(String(assertion.value)).first()
            .isVisible({ timeout: config.actionTimeoutMs }).catch(() => false);
          break;
        }
        case "element_visible": {
          item.passed = await buildLocator(entry.page, assertion.target).first()
            .isVisible({ timeout: config.actionTimeoutMs }).catch(() => false);
          break;
        }
        case "element_absent": {
          const count = await buildLocator(entry.page, assertion.target).count();
          item.actual = count;
          item.passed = count === 0;
          break;
        }
        case "value_equals": {
          const actual = await buildLocator(entry.page, assertion.target).inputValue({ timeout: config.actionTimeoutMs });
          item.actual = String(actual).slice(0, 300);
          item.passed = actual === String(assertion.value);
          break;
        }
        case "checked": {
          const actual = await buildLocator(entry.page, assertion.target).isChecked({ timeout: config.actionTimeoutMs });
          item.actual = actual;
          item.passed = actual === (assertion.value !== false && assertion.value !== "false");
          break;
        }
        case "count": {
          const actual = await buildLocator(entry.page, assertion.target).count();
          item.actual = actual;
          item.passed = actual === Number(assertion.value);
          break;
        }
        default:
          item.error = `unknown assertion kind "${kind}"`;
      }
    } catch (error) {
      const classified = classifyError(error);
      if (classified.category === "cancelled") throw classified;
      item.error = classified.message;
    }
    results.push(item);
  }
  const scrubbed = sessionsStore.scrubSecretsDeep(session, results);
  return {
    page: await pageState(session, entry),
    passed: scrubbed.every((r) => r.passed),
    assertions: scrubbed,
  };
}

// ---------------------------------------------------------------------------
// Pages

async function listPages(session) {
  const pages = [];
  for (const entry of session.pages.values()) pages.push(await pageState(session, entry));
  return { pages, active_page: session.activePageId };
}

async function switchPage(session, args) {
  const entry = sessionsStore.activePage(session, args.page);
  session.activePageId = entry.id;
  try { await entry.page.bringToFront(); } catch { /* headless no-op */ }
  return { page: await pageState(session, entry) };
}

async function closePage(session, args) {
  const entry = sessionsStore.activePage(session, args.page);
  await entry.page.close().catch(() => {});
  return { closed: entry.id, active_page: session.activePageId };
}

module.exports = {
  BrowserActionError,
  classifyError,
  buildLocator,
  withCancellation,
  navigate,
  history,
  snapshot,
  extract,
  interact,
  secretFill,
  waitFor,
  screenshot,
  upload,
  runAssertions,
  listPages,
  switchPage,
  closePage,
};
