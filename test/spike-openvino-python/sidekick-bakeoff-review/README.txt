Sidekick bake-off review utility

Reads sidekick-doc-bakeoff-report.json and produces:

- RRF fusion metrics using the union of each model's top 10 results
- a perfect-router diagnostic upper bound
- a Markdown review of every E5/Qwen rank disagreement
- side-by-side top-5 previews with labeled relevance markers

This does not rerun either model and does not modify Sidekick.
