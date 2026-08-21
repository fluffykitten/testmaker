-- ============================================================================
-- Custom Exam Test Maker — Initial Database Schema
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Table 1: Syllabuses ────────────────────────────────────────────────────────

CREATE TABLE syllabuses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_name TEXT NOT NULL,
    subject_code VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE syllabuses IS 'Exam board syllabuses/subjects (e.g., IGCSE Chemistry 0620)';

-- ─── Table 2: Questions ─────────────────────────────────────────────────────────

CREATE TABLE questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    syllabus_id UUID REFERENCES syllabuses(id) ON DELETE CASCADE,
    year INT NOT NULL,
    series VARCHAR(20),                     -- e.g. 'May/June', 'Oct/Nov'
    paper_number INT,
    question_number VARCHAR(20) NOT NULL,   -- e.g. '1(a)', '3(b)(ii)'
    parent_question_id TEXT,                -- e.g. 'Q1' to group sub-parts together
    question_text TEXT NOT NULL,            -- LaTeX-enriched text with $...$
    question_style VARCHAR(50),             -- Structured, Multiple Choice, etc.
    topic TEXT NOT NULL,
    sub_topic TEXT,
    difficulty VARCHAR(20) CHECK (difficulty IN ('Easy', 'Medium', 'Hard')),
    marks INT NOT NULL DEFAULT 1,
    diagram_url TEXT,                       -- Supabase Storage public URL
    sub_questions JSONB DEFAULT '[]'::jsonb,-- Nested sub-parts if grouped
    mark_scheme JSONB,                      -- Structured marking points
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE questions IS 'Individual exam questions extracted from past papers';

-- ─── Table 3: Custom Tests ──────────────────────────────────────────────────────

CREATE TABLE custom_tests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    total_marks INT DEFAULT 0,
    question_ids UUID[] DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE custom_tests IS 'User-created custom exam papers with selected questions';

-- ─── Performance Indexes ────────────────────────────────────────────────────────

CREATE INDEX idx_questions_topic ON questions(topic);
CREATE INDEX idx_questions_subtopic ON questions(sub_topic);
CREATE INDEX idx_questions_difficulty ON questions(difficulty);
CREATE INDEX idx_questions_style ON questions(question_style);
CREATE INDEX idx_questions_parent ON questions(parent_question_id);
CREATE INDEX idx_questions_syllabus ON questions(syllabus_id);
CREATE INDEX idx_questions_year ON questions(year);

-- ─── Row Level Security ─────────────────────────────────────────────────────────

-- Disable RLS on tables to allow client applications to insert, read, and manage questions
ALTER TABLE syllabuses DISABLE ROW LEVEL SECURITY;
ALTER TABLE questions DISABLE ROW LEVEL SECURITY;
ALTER TABLE custom_tests DISABLE ROW LEVEL SECURITY;
