-- Migration 005: Cross-machine sync support
-- Adds origin tracking and sync metadata to memories

-- Add origin tracking
ALTER TABLE memories ADD COLUMN origin_machine_id TEXT;
ALTER TABLE memories ADD COLUMN origin_user_id TEXT;

-- Add sync metadata
ALTER TABLE memories ADD COLUMN sync_version INTEGER DEFAULT 1;
ALTER TABLE memories ADD COLUMN last_synced_at TEXT;

-- Initialize origin for existing memories (will be set to current machine on first sync)
UPDATE memories SET origin_machine_id = NULL, origin_user_id = NULL WHERE origin_machine_id IS NULL;

-- Index for efficient sync queries
CREATE INDEX idx_memories_origin_machine ON memories(origin_machine_id);
CREATE INDEX idx_memories_sync_version ON memories(sync_version);
