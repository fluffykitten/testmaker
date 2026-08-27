-- ============================================================================
-- Migration 007: Quiz Submissions Table
-- Stores student exam submissions, raw answers, evaluated scores, and status.
-- Supports asynchronous batch grading and student result retrieval.
-- ============================================================================

CREATE TABLE IF NOT EXISTS quiz_submissions (
    id TEXT PRIMARY KEY,
    quiz_id TEXT NOT NULL,
    quiz_code TEXT NOT NULL,
    quiz_title TEXT,
    subject TEXT,
    student_name TEXT NOT NULL,
    student_class TEXT,
    candidate_number TEXT,
    submitted_at TIMESTAMPTZ DEFAULT NOW(),
    duration_seconds INT DEFAULT 0,
    score NUMERIC DEFAULT 0,
    total_marks NUMERIC DEFAULT 0,
    percentage NUMERIC DEFAULT 0,
    violations_count INT DEFAULT 0,
    proctoring_logs JSONB DEFAULT '[]'::jsonb,
    raw_answers JSONB DEFAULT '{}'::jsonb,
    question_results JSONB DEFAULT '[]'::jsonb,
    topic_breakdown JSONB DEFAULT '{}'::jsonb,
    status TEXT DEFAULT 'submitted', -- 'submitted' | 'grading' | 'graded' | 'published'
    teacher_adjusted_marks NUMERIC DEFAULT 0,
    teacher_notes TEXT,
    result_pin TEXT,              -- 3-digit personal PIN for secure result retrieval
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE quiz_submissions IS 'Stores student quiz/exam submission attempts and grading results.';

-- Fast lookup indexes
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_quiz_code ON quiz_submissions (quiz_code);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_quiz_id ON quiz_submissions (quiz_id);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_student_name ON quiz_submissions (student_name);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_candidate_number ON quiz_submissions (candidate_number);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_status ON quiz_submissions (status);

-- Disable RLS to allow seamless client inserts from student runners and teacher dashboards
-- (Matches the pattern of app_config and custom_tests in this environment)
ALTER TABLE quiz_submissions DISABLE ROW LEVEL SECURITY;

-- If this column was not present in the original migration, add it:
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'quiz_submissions' AND column_name = 'result_pin'
  ) THEN
    ALTER TABLE quiz_submissions ADD COLUMN result_pin TEXT;
  END IF;
END $$;
