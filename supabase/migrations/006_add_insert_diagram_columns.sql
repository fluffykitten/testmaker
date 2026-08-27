-- ============================================================================
-- Add Insert & Diagram source tracking columns to questions table
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================================

ALTER TABLE questions ADD COLUMN IF NOT EXISTS diagram_source VARCHAR(20) DEFAULT NULL;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS resource_ref TEXT DEFAULT NULL;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS insert_page_number INT DEFAULT NULL;

COMMENT ON COLUMN questions.diagram_source IS 'Source of visual asset: "qp" (Question Paper) or "insert" (Insert/Resource Booklet)';
COMMENT ON COLUMN questions.resource_ref IS 'Visual reference label, e.g. "Fig. 1.1", "Photograph A"';
COMMENT ON COLUMN questions.insert_page_number IS 'Page number in the Insert / Resource Booklet';
