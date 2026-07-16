# Predict

Predict is Sidekick's evidence-backed decision-support engine. It suggests likely next actions, failure risks, missing prerequisites, relevant context, incident recurrence, and workflow automation opportunities from local Sidekick evidence.

Predict is not an autonomous executor. Predictions are advisory records with evidence, confidence, lifecycle state, feedback, and outcome tracking.

## Evidence Sources

Predict analyzes bounded local Sidekick data:

- recent tool logs
- structured memories
- handoffs
- incidents
- workflow and generated-tool records

Operational telemetry is treated as evidence, not durable knowledge. Promote only verified conclusions into memory or knowledge.

## Prediction Types

Supported prediction types are defined in `src/predict.js` and include:

- `next_action`
- `failure_risk`
- `missing_prerequisite`
- `relevant_context`
- `incident_recurrence`
- `workflow_opportunity`
- `tool_sequence`
- `deployment_risk`
- `debugging_path`

## Confidence

Confidence is based on evidence quantity and score thresholds. Sparse evidence remains `low` or `medium`; `high` and `very_high` require larger sample sizes. A successful prediction record should explain why it was generated and which evidence contributed.

## Lifecycle

Use the `predict` tool actions to manage prediction state:

- `analyze`: generate new predictions from current evidence.
- `list`: list predictions with optional status/type/confidence filters.
- `get`: inspect a specific prediction.
- `explain`: inspect evidence for a prediction.
- `feedback`: record whether a prediction was useful, incorrect, already known, acted on, or dismissed.
- `outcome`: record whether the predicted event occurred or the suggested action succeeded.
- `dismiss`: mark a prediction dismissed.
- `migrate`: import legacy file-backed predictions into SQLite.

## Privacy And Redaction

Prediction summaries and evidence snippets should not expose secrets. Existing redaction applies to tool outputs before storage, and Predict stores bounded summaries rather than raw credentials. Do not place tokens, passwords, private keys, raw `.env` content, or full incident bundles into prediction notes.

## Dashboard

Dashboard endpoints expose prediction listing, status, migration, feedback, and lifecycle views under authenticated routes. Use dashboard views to triage active predictions, but verify current repository/runtime state before acting.

## Tests

Focused tests:

```bash
node test/predict.test.js
node test/predict-lifecycle.test.js
```

The full regression suite also includes Predict coverage through `npm test`.
