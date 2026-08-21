-- ============================================================================
-- Fix RLS Policies for custom_tests
-- Run this in your Supabase SQL Editor to allow saving and managing custom tests
-- ============================================================================

-- Ensure custom_tests has RLS enabled with full public CRUD policies
ALTER TABLE custom_tests ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Allow public read custom_tests" ON custom_tests;
DROP POLICY IF EXISTS "Allow public insert custom_tests" ON custom_tests;
DROP POLICY IF EXISTS "Allow public update custom_tests" ON custom_tests;
DROP POLICY IF EXISTS "Allow public delete custom_tests" ON custom_tests;

-- Recreate open policies for custom_tests
CREATE POLICY "Allow public read custom_tests"
    ON custom_tests FOR SELECT
    USING (true);

CREATE POLICY "Allow public insert custom_tests"
    ON custom_tests FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Allow public update custom_tests"
    ON custom_tests FOR UPDATE
    USING (true);

CREATE POLICY "Allow public delete custom_tests"
    ON custom_tests FOR DELETE
    USING (true);
