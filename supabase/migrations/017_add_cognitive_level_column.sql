-- ============================================================================
-- Migration 017: Add Cognitive Level Column to Questions Table
-- ============================================================================

-- 1. Add native cognitive_level column to questions table if not already present
ALTER TABLE questions ADD COLUMN IF NOT EXISTS cognitive_level VARCHAR(10) DEFAULT NULL;

COMMENT ON COLUMN questions.cognitive_level IS 'Bloom Taxonomy cognitive level (C1 to C6)';

-- 2. Populate native column from existing mark_scheme JSONB metadata
UPDATE questions
SET cognitive_level = mark_scheme->>'_cognitive_level'
WHERE (mark_scheme->>'_cognitive_level') IS NOT NULL
  AND cognitive_level IS NULL;

-- 3. Create performance index
CREATE INDEX IF NOT EXISTS idx_questions_cognitive_level ON questions(cognitive_level);

