-- ============================================================================
-- Add options column to questions table if not already present
-- Run this in your Supabase SQL Editor if you encounter MCQ options column errors
-- ============================================================================

ALTER TABLE questions ADD COLUMN IF NOT EXISTS options JSONB DEFAULT NULL;
