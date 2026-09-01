# Production Certification: 26-Phase Evidence Matrix

This matrix records the current local evidence for the production-certification
campaign. A phase is not marked passed from intent or from an unavailable
environment.

| Phase | Scope | Status | Evidence |
| ---: | --- | --- | --- |
| 1 | Threat model | PASS | `test/security-phase-01-threat-model.test.js` |
| 2 | Central dispatch boundary | PASS | `test/security-phase-02-dispatch-boundary.test.js` |
| 3 | Authentication and authorization | PASS | `test/security-phase-03-auth-authorization.test.js` |
| 4 | Secure defaults and remote exposure | PASS | `test/security-phase-04-secure-defaults.test.js` |
| 5 | Subprocess and shell safety | PASS | `test/security-phase-05-subprocess-shell.test.js` |
| 6 | Filesystem and data security | PASS | `test/security-phase-06-filesystem-data.test.js` |
| 7 | Secrets and redaction | PASS | `test/security-phase-07-secrets-redaction.test.js` |
| 8 | HTTP, network, and SSRF security | PASS | `test/security-phase-08-http-network.test.js` |
| 9 | Dashboard and web security | PASS | `test/security-phase-09-dashboard-web.test.js` |
| 10 | Packs and modules | PASS | `test/security-phase-10-packs-modules.test.js` |
| 11 | Pack-specific security | PASS | `test/security-phase-11-pack-specific.test.js` |
| 12 | Browser automation security | PASS | `test/security-phase-12-browser-automation.test.js`, browser E2E suites |
| 13 | Security Research safety | PASS | `test/security-phase-13-security-research.test.js`, Research unit/integration suites |
| 14 | Compute security | PASS | `test/security-phase-14-compute.test.js`, Compute protocol and placement suites |
| 15 | Autonomous Agent security | PASS | `test/security-phase-15-agent-autonomous.test.js`, Agent recovery suites |
| 16 | Memory and data security | PASS | `test/security-phase-16-memory-data.test.js`, memory/context suites |
| 17 | Supply-chain security | PASS | `test/security-phase-17-supply-chain.test.js`, release manifest and package suites |
| 18 | Deployment and system security | PASS | `test/security-phase-18-deployment-system.test.js` |
| 19 | CI hardening | PASS | `test/security-phase-19-ci-hardening.test.js`, CI workflow contract |
| 20 | Final security verification | PASS | `test/security-final.test.js`, full security suites |
| 21 | System certification harness | PASS | Certification CLI, invariants, Doctor, and isolated-data suites |
| 22 | Reliability metrics and durable lifecycle | PASS | Lifecycle, recovery, bounded-runner, and metrics suites |
| 23 | Live production/provider certification | BLOCKED | Requires an authorized live Compute endpoint/key and configured lab environments; no live evidence is claimed |
| 24 | Certification isolation | PASS | `test/certification-isolation.test.js` |
| 25 | Agent lifecycle and custody separation | PASS | `test/certification-lifecycle.test.js`, artifact scope/custody suites |
| 26 | Execution-node protocol and bounds | PASS | `test/execution-node-protocol.test.js`, execution-node suites |

## Aggregate Verification

- Complete registered local suite: **243 passed, 0 failed, 0 skipped**.
- Certification gate: **6 suites passed**.
- No commit, push, merge, deployment, or modification to `main` was performed.
- Live Compute smoke is opt-in and was not run without an authorized endpoint
  and credential.
- Security Research reports no configured lab environments and local probes are
  disabled.
- Proxmox profiles are `production` and `operator`; neither is a separate lab
  profile for destructive or research certification.
