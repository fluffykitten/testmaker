-- ============================================================================
-- Fix RLS Policies for all tables (syllabuses, questions, custom_tests)
-- Run this in your Supabase SQL Editor to allow uploading and creating tests
-- ============================================================================

-- Method 1 (Recommended): Disable RLS to allow direct client inserts & queries
ALTER TABLE syllabuses DISABLE ROW LEVEL SECURITY;
ALTER TABLE questions DISABLE ROW LEVEL SECURITY;
ALTER TABLE custom_tests DISABLE ROW LEVEL SECURITY;

-- Method 2 (Alternative if RLS is desired): Open full access policies
/*
ALTER TABLE syllabuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_tests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for syllabuses" ON syllabuses;
DROP POLICY IF EXISTS "Allow all for questions" ON questions;
DROP POLICY IF EXISTS "Allow all for custom_tests" ON custom_tests;

CREATE POLICY "Allow all for syllabuses" ON syllabuses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for questions" ON questions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for custom_tests" ON custom_tests FOR ALL USING (true) WITH CHECK (true);
*/
