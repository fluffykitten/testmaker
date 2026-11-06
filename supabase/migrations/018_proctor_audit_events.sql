-- ============================================================================
-- Migration 018: Durable proctor audit events
-- ============================================================================
-- Live heartbeats stay off the database (they are high-frequency). Discrete security
-- violations and invigilator interventions are written here so a dashboard reload — or a
-- different invigilator machine — can rebuild the event log.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.proctor_audit_events (
  id TEXT PRIMARY KEY,
  quiz_code TEXT NOT NULL,
  student_id TEXT NOT NULL,
  student_name TEXT NOT NULL,
  candidate_number TEXT,
  candidate_class TEXT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  detail TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'student', -- 'student' | 'invigilator'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proctor_audit_quiz_code
  ON public.proctor_audit_events (quiz_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_proctor_audit_student
  ON public.proctor_audit_events (quiz_code, student_id, created_at DESC);

-- The app authenticates teachers with a local PIN and talks to Supabase with the anon key,
-- so — like every other table in this schema — access is open. Tighten these two policies to
-- the teacher role once server-side auth exists.
ALTER TABLE public.proctor_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow read proctor audit events" ON public.proctor_audit_events;
CREATE POLICY "Allow read proctor audit events"
  ON public.proctor_audit_events FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow insert proctor audit events" ON public.proctor_audit_events;
CREATE POLICY "Allow insert proctor audit events"
  ON public.proctor_audit_events FOR INSERT WITH CHECK (true);

COMMENT ON TABLE public.proctor_audit_events IS
  'Durable invigilation audit trail: discrete student violations and teacher interventions.';
