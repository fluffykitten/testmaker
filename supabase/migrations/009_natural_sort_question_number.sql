-- ============================================================================
-- Migration 009: Natural sorting for question numbers
-- Add generated numeric column for natural question number sorting (1, 2, 3... 10, 11)
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================================

ALTER TABLE questions 
ADD COLUMN IF NOT EXISTS question_number_numeric INT 
GENERATED ALWAYS AS (
  COALESCE(NULLIF(regexp_replace(question_number, '\D', '', 'g'), ''), '0')::int
) STORED;

CREATE INDEX IF NOT EXISTS idx_questions_qnum_numeric ON questions(question_number_numeric);

COMMENT ON COLUMN questions.question_number_numeric IS 'Generated numeric prefix of question_number for natural sorting (e.g. "10(a)" -> 10)';
