-- Migration 006: Memory deferred features
-- Adds state tracking, expiration, and confirmation requirements

-- Add state field for lifecycle tracking
ALTER TABLE memories ADD COLUMN state TEXT DEFAULT 'active';

-- Add requires_confirmation flag for high-value memories
ALTER TABLE memories ADD COLUMN requires_confirmation INTEGER DEFAULT 0;

-- Add confirmed_by to track who confirmed the memory
ALTER TABLE memories ADD COLUMN confirmed_by TEXT;

-- Add deleted_at for soft-delete tracking
ALTER TABLE memories ADD COLUMN deleted_at TEXT;

-- Add expiration tracking
ALTER TABLE memories ADD COLUMN expired_at TEXT;

-- Index for efficient state queries
CREATE INDEX idx_memories_state ON memories(state);
CREATE INDEX idx_memories_requires_confirmation ON memories(requires_confirmation);

-- Update existing superseded memories to have correct state
UPDATE memories SET state = 'superseded' 
WHERE metadata_json LIKE '%"state":"superseded"%';
