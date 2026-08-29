-- ============================================================================
-- Add audio_url and audio_metadata columns to questions table
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================================

ALTER TABLE questions ADD COLUMN IF NOT EXISTS audio_url TEXT DEFAULT NULL;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS audio_metadata JSONB DEFAULT NULL;

COMMENT ON COLUMN questions.audio_url IS 'Public storage URL for audio listening track / recording';
COMMENT ON COLUMN questions.audio_metadata IS 'Audio metadata (title, duration, transcript, play_limit, size)';
