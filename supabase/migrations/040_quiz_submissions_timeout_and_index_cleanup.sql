-- Drop unused indexes on public.quiz_submissions identified by Supabase Performance Advisors
-- to reduce write amplification during batch and single-row upserts.

DROP INDEX IF EXISTS public.idx_quiz_submissions_attempt_lookup;
DROP INDEX IF EXISTS public.idx_quiz_submissions_candidate_number;
DROP INDEX IF EXISTS public.idx_quiz_submissions_student_name;
