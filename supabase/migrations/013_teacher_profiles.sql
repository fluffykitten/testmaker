-- ============================================================================
-- 013: Teacher Profiles Table — Cloud-synced teacher profiles and subject presets
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.teacher_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    title TEXT DEFAULT 'Dr.',
    subject TEXT NOT NULL DEFAULT 'Chemistry',
    subject_code TEXT NOT NULL DEFAULT '0620',
    pin_hash TEXT, -- SHA-256 hashed 4-digit PIN (null if PIN-free)
    default_classes TEXT[] DEFAULT ARRAY['10-A', '10-B', '11-A'],
    preferences JSONB DEFAULT '{
      "autoEnablePeriodicTable": true,
      "defaultCalculator": "scientific",
      "showOtherSubjects": false
    }'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.teacher_profiles IS 'Stores teacher profiles, personal 4-digit PIN hashes, default cohorts, and subject workspace filters.';

-- Allow client read/write via anon key (consistent with custom_tests and app_config)
ALTER TABLE public.teacher_profiles DISABLE ROW LEVEL SECURITY;

-- Optional default seed for the Chemistry department
INSERT INTO public.teacher_profiles (name, title, subject, subject_code, default_classes, preferences)
VALUES (
    'Dr. Budi Santoso',
    'Dr.',
    'Chemistry',
    '0620',
    ARRAY['10-A', '11-A', '12-A'],
    '{
      "autoEnablePeriodicTable": true,
      "defaultCalculator": "scientific",
      "showOtherSubjects": false
    }'::jsonb
)
ON CONFLICT DO NOTHING;
