# Sidekick Privacy Policy

Effective date: 2026-08-20

Sidekick is self-hosted software. The operator who installs and runs a
Sidekick instance controls its machine, network, configuration, credentials,
retention, and access. This policy describes the software's default privacy
boundaries; an operator may configure stricter or different retention and
network policies.

## Information Sidekick processes

Depending on the tools and features enabled, an instance may process:

- MCP requests, authentication metadata, request/session identifiers, and
  client information needed to authenticate, authorize, audit, and correlate
  work;
- tool arguments and results, subject to the instance's redaction and audit
  settings;
- persistent project memory, knowledge, key-value data, workflow state, and
  incident or monitoring evidence explicitly created by an operator or tool;
- credentials and secrets supplied by the operator. Secret values are intended
  to remain in the instance's protected secret storage and are not returned by
  secret-name or workspace metadata operations;
- data sent to external systems when an operator invokes a tool configured to
  access them, such as GitHub, a web site, a database, a model provider, or a
  notification destination.

## Use and sharing

Sidekick uses this information to provide the requested tool, maintain durable
state, enforce policy and approvals, produce audit evidence, and recover or
resume work. Sidekick does not require a central Sidekick account and does not
sell instance data. External transmission occurs only through configured
integrations or tools that the operator invokes or authorizes. Those external
services have their own privacy policies and terms.

## Retention and deletion

Retention is controlled by the instance operator and its configured data
directory, databases, logs, evidence policies, and backups. Operators can
delete supported stored values, memories, evidence, logs, and other state using
the applicable Sidekick controls or by following the deployment's documented
data-management procedures. Backups and external systems may retain copies
under their own policies.

## Security

Operators are responsible for protecting the host, network, API credentials,
encrypted-secret key material, backups, and any connected services. Sidekick
provides authentication, authorization, approval, redaction, and audit
controls, but no software can guarantee absolute security.

## Changes and contact

This policy may be updated with the software. For questions or privacy
requests, contact the Sidekick maintainers through the project's issue tracker:
https://github.com/geoffmcc/sidekick/issues
