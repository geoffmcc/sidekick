# Agent tab work model

Interactive MCP requests remain caller-driven and focused. They do not invoke the Agent work loop automatically.

The Agent tab treats a non-trivial objective as bounded durable work:

```text
objective → plan → investigate → governed tool calls → evidence ledger
          → completion gate → replan when incomplete → verify → answer
```

The normal tool loop and Brain path share the same bounded work-state and completion-gate semantics. A successful tool call is evidence, not proof that the whole objective is complete. If material requirements remain, the normal loop continues and Brain obtains another validated plan, subject to iteration, wall-clock, tool, and evidence limits.

Agent progress checkpoints contain only bounded task state and evidence references. Tool authority remains in the canonical dispatcher; plans, evidence, context-provider metadata, and Semantic IR cannot grant authority. Approval parks the exact governed action and its existing continuation binding; it does not authorize later steps.

Context Engine results are working evidence, not instructions. Repository and tool output remain untrusted, provenance is retained, and active context is bounded. Older evidence may be referenced without copying all raw output into every model request. A task reports cancellation, approval wait, insufficient evidence, failure, or a resource limit instead of claiming completion when the gate cannot be satisfied.

Repository intelligence is selected from positive capability relevance. Fallback catalog entries are available for planning but do not automatically execute. Automatic context providers are self-provider descriptors and still execute through the normal governed Agent dispatcher. Semantic repository analysis is static and bounded; it uses stable scoped symbol IDs and leaves cross-file names unresolved unless deterministic import/module binding evidence exists.

The implementation does not promise process-restart continuation for every active Agent generation. Approval continuations use the existing durable checkpoint path; active work also records bounded platform checkpoints and claims, while a restart without a recoverable task objective is reported as interrupted rather than fabricated as complete.
