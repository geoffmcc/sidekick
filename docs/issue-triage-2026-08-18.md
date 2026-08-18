# Open issue triage — 2026-08-18

This is a current-state triage record for the remaining issues that were open
when the product-completion campaign resumed. It records evidence from the
current `main` lineage and does not replace the issue tracker.

## Results

| Issue | Current result | Evidence | Recommended tracker state |
| --- | --- | --- | --- |
| #361 named capability routing | Fixed in the canonical Brain shortlist. Named first-party capability mentions retain their corresponding pack tools, including Browser Automation, Developer, Jellyfin, Proxmox, and Security Research. | `test/brain.test.js` — named capability shortlist regression; PR #416. | Close as fixed after review. |
| #356 multi-word knowledge retrieval | Fixed. Search tokenizes a multi-word query for FTS while retaining the bounded literal fallback. | `src/tools/families/knowledge.js`; knowledge promotion/search regression coverage. | Close as fixed after review. |
| #334 Agent live-output triangle | Fixed. The control has real expanded state, an accessible label, and a delegated toggle handler. | `test/agent-followup-ui.test.js` — expanded-state and toggle wiring checks. | Close as fixed after review. |
| #333 Dashboard Agent history | Fixed. History and detail preserve task lineage and remain usable for older tasks without lineage. | `test/agent-followup-ui.test.js`; `test/agent-bridge-followup.test.js`. | Close as fixed after review. |
| #312 prediction expiry/count lifecycle | Fixed. Status reconciles overdue active rows before reporting counts; expiration, reactivation, terminal retention, and contract aliases are covered. | `test/predict-lifecycle.test.js`; `test/predict-contract.test.js`. | Close as fixed after review. |

## Verification boundary

The evidence above is focused source and regression verification. It is not a
claim that every external provider or deployment environment was live-tested
in this pass. The complete local suite remains delegated to GitHub CI by the
campaign procedure.

The local dependency audit currently reports zero npm vulnerabilities. GitHub
still reports two high and one moderate default-branch dependency alerts; the
exact advisory identities were not available through the configured GitHub
integration, so no speculative major-version upgrade is recorded here.

The current live registry reports 138 tools and five enabled first-party packs:
Browser Automation, Developer, Jellyfin, Proxmox, and Security Research. The
Core `browser` tool owns privileged Chromium behavior; Browser Automation is a
thin composition pack over that governed Core path.
