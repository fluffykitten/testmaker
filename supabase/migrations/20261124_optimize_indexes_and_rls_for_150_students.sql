-- Optimization migration for 150 concurrent students:
-- 1) Covering indexes for unindexed foreign keys
CREATE INDEX IF NOT EXISTS idx_teacher_auth_sessions_teacher_id
  ON public.teacher_auth_sessions (teacher_id);

CREATE INDEX IF NOT EXISTS idx_custom_tests_user_id
  ON public.custom_tests (user_id);

-- 2) Consolidate duplicate permissive RLS policies on public.app_config
DROP POLICY IF EXISTS "Teacher full access app_config" ON public.app_config;
DROP POLICY IF EXISTS "Public read non-sensitive ui app_config" ON public.app_config;

CREATE POLICY "Read public ui or teacher app_config"
  ON public.app_config
  FOR SELECT
  TO public
  USING (
    (key = ANY (ARRAY[
      'school_classes'::text,
      'school_subjects'::text,
      'google_drive_client_id'::text,
      'hide_creative_mode_landing'::text,
      'hide_emergency_exam_button'::text,
      'gemini_extraction_model'::text,
      'gemini_api_key_tier'::text,
      'exam_security_tiers'::text,
      'allow_teacher_account_claiming'::text
    ]))
    OR (SELECT public.is_authenticated_teacher())
  );

CREATE POLICY "Teacher insert app_config"
  ON public.app_config
  FOR INSERT
  TO public
  WITH CHECK ((SELECT public.is_authenticated_teacher()));

CREATE POLICY "Teacher update app_config"
  ON public.app_config
  FOR UPDATE
  TO public
  USING ((SELECT public.is_authenticated_teacher()))
  WITH CHECK ((SELECT public.is_authenticated_teacher()));

CREATE POLICY "Teacher delete app_config"
  ON public.app_config
  FOR DELETE
  TO public
  USING ((SELECT public.is_authenticated_teacher()));

-- 3) Consolidate duplicate permissive RLS policies on public.proctor_audit_events
DROP POLICY IF EXISTS "Teacher full access proctor_audit_events" ON public.proctor_audit_events;
DROP POLICY IF EXISTS "Student insert audit events only" ON public.proctor_audit_events;

CREATE POLICY "Student or teacher insert proctor_audit_events"
  ON public.proctor_audit_events
  FOR INSERT
  TO public
  WITH CHECK (
    (actor = 'student'::text)
    OR (SELECT public.is_authenticated_teacher())
  );

CREATE POLICY "Teacher select proctor_audit_events"
  ON public.proctor_audit_events
  FOR SELECT
  TO public
  USING ((SELECT public.is_authenticated_teacher()));

CREATE POLICY "Teacher update proctor_audit_events"
  ON public.proctor_audit_events
  FOR UPDATE
  TO public
  USING ((SELECT public.is_authenticated_teacher()))
  WITH CHECK ((SELECT public.is_authenticated_teacher()));

CREATE POLICY "Teacher delete proctor_audit_events"
  ON public.proctor_audit_events
  FOR DELETE
  TO public
  USING ((SELECT public.is_authenticated_teacher()));
