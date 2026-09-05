-- ============================================================================
-- Migration: Expand paper_number to VARCHAR(50)
-- Description: Allows paper_number to store alphanumeric labels such as
-- 'Try Out TKA 1', 'Section A', 'Paket 01', as well as numeric papers '1', '2'.
-- ============================================================================

ALTER TABLE questions 
  ALTER COLUMN paper_number TYPE VARCHAR(50) USING paper_number::VARCHAR(50);
