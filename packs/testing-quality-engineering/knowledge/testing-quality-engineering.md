# Testing and Quality Engineering

Quality gates use the repository's detected or explicitly selected verification commands through `dev_verify`. Dry-run plans do not execute. Executions are bounded and retain command-level evidence; semantic index integrity is checked independently so a passing test command cannot conceal an indexing or repository-state problem.
