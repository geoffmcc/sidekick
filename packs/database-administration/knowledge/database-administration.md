# Database Administration

This pack composes the existing database tools. Audit and health operations are read-only. Query operations require an explicit parameter array and SQL placeholders, and always dispatch `readonly: true`; callers cannot use this pack to write. Migration workflows inspect status only. Backups, restores, exports and migration application remain separate governed operations requiring their own approval and verification.
