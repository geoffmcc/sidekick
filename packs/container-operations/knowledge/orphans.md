# Orphan candidates and cleanup

Orphan detection is advisory. A Compose container absent from the current project, unattached network, dangling image, or unused volume is a candidate—not permission to delete. Volumes can contain valuable data and old images can be required for rollback. The pack does not expose automatic prune or default volume deletion; any future cleanup must revalidate current state and require explicit high-risk approval.
