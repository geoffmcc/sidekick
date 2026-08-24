"use strict";

/**
 * browser-tools module — the runtime of the Governed Browser Automation
 * capability pack.
 *
 * Contributes three task-level tools that add STRUCTURE on top of the Core
 * `browser` tool, rather than aliasing it:
 *
 *   web_capture   navigate to a URL and capture evidence (screenshot + text)
 *                 in one governed call, returning artifact references
 *   web_extract   navigate a (JS-rendered) page and return bounded structured
 *                 data from caller-supplied field locators
 *   web_check     navigate and run deterministic UI assertions, returning a
 *                 pass/fail verdict with optional evidence
 *
 * Each tool opens an ephemeral, isolated browser session, does its work, and
 * ALWAYS closes it. Every browser operation goes through
 * `services.dispatch("browser", …)`, so the Core tool's egress policy,
 * isolation, secret handling, artifact custody, approval and audit apply
 * unchanged — this module reimplements none of it.
 */

const path = require("path");
const { requireFromSidekick } = require("./lib/deps");
const {
  browserAction,
  withEphemeralSession,
  jsonResult,
  errorResult,
  resolveOpenOptions,
  UNTRUSTED_NOTE,
} = require("./lib/session");

const { z } = requireFromSidekick("zod");

const targetSchema = z.union([
  z.string(),
  z.object({
    kind: z.enum(["role", "label", "placeholder", "text", "testid", "css"]),
    value: z.string(),
    name: z.string().optional(),
    exact: z.boolean().optional(),
    nth: z.number().int().optional(),
  }),
]);

function handleComposeError(error) {
  return errorResult(String(error && error.message || error), {
    code: error && error.code ? error.code : "browser_error",
    failed_step: error && error.label ? error.label : undefined,
  });
}

// --- web_capture -----------------------------------------------------------

async function webCapture(services, args) {
  const config = services.config || {};
  try {
    const openOptions = resolveOpenOptions(config, args);
    const out = await withEphemeralSession(services, openOptions, async (sessionId) => {
      const nav = await browserAction(services, {
        action: "navigate", session: sessionId, url: args.url, wait_until: args.wait_until,
      }, { label: "navigate" });

      const result = {
        ok: true,
        tool: "web_capture",
        url: nav.page.url,
        title: nav.page.title,
        status: nav.status,
      };

      if (args.include_text !== false) {
        const snap = await browserAction(services, {
          action: "snapshot", session: sessionId, kind: "text",
          max_chars: args.max_text_chars || config.max_text_chars,
        }, { label: "snapshot" });
        result.untrusted_page_content = snap.untrusted_page_content;
        result.text_truncated = snap.truncated;
      }

      const shot = await browserAction(services, {
        action: "screenshot", session: sessionId,
        label: args.label || "web_capture",
        full_page: args.full_page === true || (args.full_page === undefined && config.full_page === true),
      }, { label: "screenshot" });
      result.screenshot = shot.artifact;
      result.untrusted_content_note = UNTRUSTED_NOTE;
      return result;
    });
    return jsonResult(out);
  } catch (error) {
    return handleComposeError(error);
  }
}

// --- web_extract -----------------------------------------------------------

async function webExtract(services, args) {
  const config = services.config || {};
  try {
    const openOptions = resolveOpenOptions(config, args);
    const out = await withEphemeralSession(services, openOptions, async (sessionId) => {
      const nav = await browserAction(services, {
        action: "navigate", session: sessionId, url: args.url, wait_until: args.wait_until,
      }, { label: "navigate" });

      const extract = await browserAction(services, {
        action: "extract", session: sessionId,
        fields: args.fields, selector: args.selector,
        max_matches: args.max_matches,
      }, { label: "extract" });

      return {
        ok: true,
        tool: "web_extract",
        url: nav.page.url,
        title: nav.page.title,
        untrusted_page_content: extract.untrusted_page_content,
        missing: extract.missing,
        truncated: extract.truncated,
        untrusted_content_note: UNTRUSTED_NOTE,
      };
    });
    return jsonResult(out);
  } catch (error) {
    return handleComposeError(error);
  }
}

// --- web_check -------------------------------------------------------------

async function webCheck(services, args) {
  const config = services.config || {};
  try {
    const openOptions = resolveOpenOptions(config, args);
    const out = await withEphemeralSession(services, openOptions, async (sessionId) => {
      const nav = await browserAction(services, {
        action: "navigate", session: sessionId, url: args.url, wait_until: args.wait_until,
      }, { label: "navigate" });

      const assertion = await browserAction(services, {
        action: "assert", session: sessionId, assertions: args.assertions,
      }, { label: "assert" });

      const result = {
        ok: assertion.passed === true,
        tool: "web_check",
        url: nav.page.url,
        title: nav.page.title,
        passed: assertion.passed,
        assertions: assertion.assertions,
      };

      if (args.capture_evidence === true) {
        const shot = await browserAction(services, {
          action: "screenshot", session: sessionId, label: args.label || "web_check",
        }, { label: "screenshot" });
        result.evidence = shot.artifact;
      }
      return result;
    });
    // A failed assertion set is a truthful "check did not pass" result, not a
    // tool error — the caller asked a yes/no question and got a definitive no.
    return out.passed === false
      ? { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] }
      : jsonResult(out);
  } catch (error) {
    return handleComposeError(error);
  }
}

// --- module contract -------------------------------------------------------

const GOVERNANCE_ARGS = {
  allowed_hosts: z.array(z.string()).optional().describe("Restrict the ephemeral session to these hosts (*.example.com patterns supported); narrows policy, never widens it"),
  network_scope: z.string().max(80).optional().describe("Exact operator-created named outbound network scope; private access requires this binding"),
  allow_private_network: z.boolean().optional().describe("Deprecated compatibility flag; cannot grant private access without network_scope"),
  project: z.string().optional().describe("Project association for isolation and artifact custody linkage"),
  wait_until: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional().describe("Navigation wait condition (default load)"),
};

const GOVERNANCE_ARGS_DOC = {
  allowed_hosts: "string[] (restrict the session to these hosts; *.example.com supported)",
  network_scope: "string (exact operator-created named outbound network scope)",
  allow_private_network: "boolean (deprecated; cannot grant private access without network_scope)",
  project: "string (project association for isolation/custody)",
  wait_until: "string (load|domcontentloaded|networkidle|commit - default load)",
};

const entry = {
  buildDescriptors(services) {
    return [
      {
        name: "web_capture",
        aliases: ["capture_page"],
        description:
          "Navigate to a URL in an isolated governed browser session and capture evidence in one call: a real screenshot registered in artifact custody plus a bounded visible-text snapshot. Returns the page URL/title/status, the screenshot artifact reference, and the untrusted page text. All traffic is enforced by the Core browser egress policy",
        schema: z.object({
          url: z.string().describe("Absolute http/https URL to capture"),
          full_page: z.boolean().optional().describe("Capture the full scrollable page"),
          include_text: z.boolean().optional().describe("Include a visible-text snapshot (default true)"),
          max_text_chars: z.number().int().min(500).max(200000).optional().describe("Bound on captured text"),
          label: z.string().optional().describe("Artifact label for the screenshot"),
          ...GOVERNANCE_ARGS,
        }),
        args: {
          url: "string (absolute http/https URL)",
          full_page: "boolean (capture full scrollable page)",
          include_text: "boolean (include visible-text snapshot, default true)",
          max_text_chars: "number (bound on captured text)",
          label: "string (screenshot artifact label)",
          ...GOVERNANCE_ARGS_DOC,
        },
        risk: "medium",
        category: "Networking",
        handler: (args) => webCapture(services, args),
      },
      {
        name: "web_extract",
        aliases: ["extract_page"],
        description:
          "Navigate a (JavaScript-rendered) page in an isolated governed browser session and return bounded, deterministic structured data from caller-supplied field locators (role/label/text/testid/css). Missing required fields are reported explicitly rather than invented. Returns structured JSON marked as untrusted page-derived data",
        schema: z.object({
          url: z.string().describe("Absolute http/https URL to extract from"),
          fields: z.array(z.object({
            name: z.string(),
            target: targetSchema,
            attr: z.string().optional().describe("text|html|value|<attribute> (default text)"),
            all: z.boolean().optional().describe("Collect all matches as an array"),
            required: z.boolean().optional().describe("Report as missing when absent (default true)"),
          })).min(1).max(25).describe("Fields to extract"),
          selector: z.string().optional().describe("Optional CSS scope for extraction"),
          max_matches: z.number().int().min(1).max(500).optional().describe("Bound on rows for all-matches fields"),
          ...GOVERNANCE_ARGS,
        }),
        args: {
          url: "string (absolute http/https URL)",
          fields: "object[] ([{name, target, attr?, all?, required?}])",
          selector: "string (optional CSS scope)",
          max_matches: "number (bound on all-matches rows)",
          ...GOVERNANCE_ARGS_DOC,
        },
        risk: "medium",
        category: "Networking",
        handler: (args) => webExtract(services, args),
      },
      {
        name: "web_check",
        aliases: ["ui_check"],
        description:
          "Navigate to a URL in an isolated governed browser session and evaluate deterministic UI assertions (url/title contains, text/element visible, element absent, value equals, checked, count), returning a pass/fail verdict per assertion and overall, optionally with a screenshot as evidence. Useful for UI smoke and deployment verification",
        schema: z.object({
          url: z.string().describe("Absolute http/https URL to check"),
          assertions: z.array(z.object({
            kind: z.enum(["url_contains", "title_contains", "text_visible", "element_visible", "element_absent", "value_equals", "checked", "count"]),
            target: targetSchema.optional(),
            value: z.union([z.string(), z.number(), z.boolean()]).optional(),
          })).min(1).max(25).describe("Assertions to evaluate"),
          capture_evidence: z.boolean().optional().describe("Capture a screenshot artifact as evidence"),
          label: z.string().optional().describe("Evidence artifact label"),
          ...GOVERNANCE_ARGS,
        }),
        args: {
          url: "string (absolute http/https URL)",
          assertions: "object[] ([{kind, target?, value?}])",
          capture_evidence: "boolean (screenshot as evidence)",
          label: "string (evidence artifact label)",
          ...GOVERNANCE_ARGS_DOC,
        },
        risk: "medium",
        category: "Networking",
        handler: (args) => webCheck(services, args),
      },
    ];
  },

  healthCheck({ config }) {
    // Synchronous and cheap by contract. Verify the module's own preconditions
    // and, best-effort, the Core browser RUNTIME readiness — the pack lifecycle
    // separately verifies the `browser` tool is available via requires.tools.
    //
    // The module runs from the managed pack store (outside the repo), so it
    // resolves the Core driver against candidate installation roots rather than
    // a fixed relative path; when it cannot (unusual), runtime is "unknown"
    // and health stays ok (the tool's own status action remains authoritative).
    const details = { tools: 3 };
    let browserStatus = "unknown";
    const roots = [process.cwd(), path.resolve(__dirname, "..", "..", "..", "..", "..")];
    for (const root of roots) {
      try {
        const driver = require(path.join(root, "src", "browser", "driver"));
        const resolved = driver.resolveExecutable();
        browserStatus = resolved.executable ? "runtime_present" : "runtime_missing";
        break;
      } catch { /* try next root */ }
    }
    details.browser_runtime = browserStatus;
    details.default_allowed_hosts = Array.isArray(config.default_allowed_hosts) ? config.default_allowed_hosts : [];
    details.allow_private_network = config.allow_private_network === true;

    if (browserStatus === "runtime_missing") {
      // Degraded, not failed: the pack is correctly installed and its tools are
      // callable; the operator must install the browser runtime to use them.
      return { ok: true, degraded: true, error: "browser runtime is not installed; run `node scripts/install-browser.js`", details };
    }
    return { ok: true, details };
  },
};

module.exports = { entry, buildDescriptors: entry.buildDescriptors, healthCheck: entry.healthCheck };
