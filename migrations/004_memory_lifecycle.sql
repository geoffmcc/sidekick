-- Migration 004: Memory lifecycle features
-- Adds confirmation tracking and decay support

-- Add last_confirmed_at to track when memory was last confirmed (separate from last_seen_at)
ALTER TABLE memories ADD COLUMN last_confirmed_at TEXT;

-- Initialize last_confirmed_at for existing memories
UPDATE memories SET last_confirmed_at = last_seen_at WHERE last_confirmed_at IS NULL;

-- Add index for efficient expiration queries
CREATE INDEX idx_memories_last_confirmed ON memories(last_confirmed_at);
CREATE INDEX idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
