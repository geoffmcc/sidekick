# Security Policy

## Supported Versions

Sidekick is pre-1.0 operational software in active hardening. Security fixes are supported for the current `main` branch and the latest deployed release maintained by the project owner.

## Reporting A Vulnerability

Report security issues privately to the repository owner. Do not open public issues containing exploit details, secrets, private infrastructure information, or sensitive evidence.

Include:

- affected version or commit;
- affected component;
- steps to reproduce safely;
- expected impact;
- whether credentials, private data, or infrastructure access may be exposed.

## Handling

The project will triage reports, preserve evidence, assess exploitability, and publish fixes or mitigations without exposing sensitive details. Public disclosure should wait until a fix or mitigation is available unless active exploitation requires faster notice.

## Security Expectations

Sidekick controls projects and infrastructure. Treat API keys, dashboard credentials, secret-store values, database backups, artifacts, Black Box evidence, memory, handoffs, and logs as sensitive operational data.

Do not submit vulnerabilities that require disabling authentication, weakening policy, publishing secrets, or running destructive tests against production systems.
