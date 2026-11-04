-- ============================================================================
-- Migration 016: Add Source PDF URL and Page Number Columns to Questions Table
-- ============================================================================

-- 1. Add native columns to questions table if not already present
ALTER TABLE questions ADD COLUMN IF NOT EXISTS source_pdf_url TEXT DEFAULT NULL;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS page_number INT DEFAULT NULL;

COMMENT ON COLUMN questions.source_pdf_url IS 'Public storage URL of the original past paper Question Paper PDF for Table of Specifications citations';
COMMENT ON COLUMN questions.page_number IS '1-indexed page number in the source Question Paper PDF where this question appears';

-- 2. Populate native columns from existing mark_scheme JSONB metadata
UPDATE questions
SET source_pdf_url = mark_scheme->>'_source_pdf_url'
WHERE (mark_scheme->>'_source_pdf_url') IS NOT NULL
  AND source_pdf_url IS NULL;

UPDATE questions
SET page_number = (mark_scheme->>'_page_number')::INT
WHERE (mark_scheme->>'_page_number') IS NOT NULL
  AND (mark_scheme->>'_page_number') ~ '^\d+$'
  AND page_number IS NULL;

-- 3. Create performance indexes
CREATE INDEX IF NOT EXISTS idx_questions_source_pdf_url ON questions(source_pdf_url);
CREATE INDEX IF NOT EXISTS idx_questions_paper_composite ON questions(syllabus_id, year, series, paper_number);

