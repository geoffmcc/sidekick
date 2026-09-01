# Local AI and Model Operations: routing and readiness

`model-readiness` reviews Compute overview, providers, workers, registered
models, and queued jobs. Model selection is capability-gated: chat, generation,
and embeddings are distinct, and a provider serving a model does not prove that
the model is suitable for a workload. Check model capability, context limit,
worker capacity, provider health, and job state independently.

Routing also enforces trust level and data classification. Private data should
remain on an approved private provider or worker; never infer permission from
availability. This pack does not download models or call providers directly.
Create, cancel, or retry jobs only through the governed Compute job contract,
and treat queued or accepted work as incomplete until its result is verified.
