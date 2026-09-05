-- ============================================================================
-- Migration: Expand VARCHAR Limits for Questions Table
-- Description: Increases the character limit for series, question_number,
-- and diagram_source from 20 to 50 to accommodate longer extractions 
-- from English and complex papers without throwing insertion errors.
-- ============================================================================

-- 1. Drop the generated column that depends on question_number
ALTER TABLE questions 
  DROP COLUMN IF EXISTS question_number_numeric;

-- 2. Expand the VARCHAR limits
ALTER TABLE questions
  ALTER COLUMN series TYPE VARCHAR(50),
  ALTER COLUMN question_number TYPE VARCHAR(50),
  ALTER COLUMN diagram_source TYPE VARCHAR(50);

-- 3. Re-add the generated column for natural sorting
ALTER TABLE questions 
ADD COLUMN question_number_numeric INT 
GENERATED ALWAYS AS (
  COALESCE(NULLIF(regexp_replace(question_number, '\D', '', 'g'), ''), '0')::int
) STORED;

-- 4. Re-create the index for the generated column
CREATE INDEX IF NOT EXISTS idx_questions_qnum_numeric ON questions(question_number_numeric);

COMMENT ON COLUMN questions.question_number_numeric IS 'Generated numeric prefix of question_number for natural sorting (e.g. "10(a)" -> 10)';
