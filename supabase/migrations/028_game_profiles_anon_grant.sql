-- Migration 028: Restore anon role GRANT on public.game_profiles so
-- educator sessions authenticated via x-teacher-session + public.is_authenticated_teacher()
-- can back up and restore Arena profiles alongside other teacher-owned tables.
-- Row-Level Security remains enabled and enforced via "Teacher full access game_profiles".

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.game_profiles TO anon;
