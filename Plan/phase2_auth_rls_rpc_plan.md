# Phase 2 Plan: Unified Teacher Login System, Server-Side Student Exam RPCs & Strict Database RLS

> **Status:** Completed (Pending Supabase SQL Execution of Migration 021)  
> **Parent Diagnosis:** `Plan/exam_paper_download_security_plan.md`  
> **Prerequisite Completed:** `supabase/migrations/020_verify_teacher_access_pin_rpc.sql` (Phase 1 hardening & server-side Master PIN verification)  
> **Target Migration:** `supabase/migrations/021_phase2_teacher_login_rls_and_exam_rpcs.sql`

---

## 1. Objectives & Resolved Architecture Decisions

Phase 2 closes direct anonymous browser access to sensitive database tables while preserving fast **Exam Code + Roster PIN** access for students and replacing the shared 6-digit teacher keypad with a **Unified Teacher Login System**:

1. **Teacher/Admin Authentication Scope**:
   - Teachers sign in with **Email / Username + Password** on one unified screen (`PinGate.tsx`), which automatically issues a 12-hour `x-teacher-session` token and loads the matching `TeacherProfile` workspace.
   - Students continue using fast **Exam Code + Roster / Student PIN** without needing separate auth accounts.
2. **Master-PIN Gated Provisioning & Recovery**:
   - Creating a new educator account, claiming a legacy passwordless `teacher_profiles` row, or resetting a forgotten password requires the **6-digit School Master PIN** (`app_config.access_pin`, verified server-side via `public.verify_teacher_access_pin`).
   - Students cannot self-register teacher accounts even if they discover the teacher login page.
3. **Zero Sensitive Direct Table Queries from Student Browsers**:
   - Strict Row-Level Security (`RLS`) locks `syllabuses`, `questions`, `custom_tests`, `quiz_submissions`, `teacher_profiles`, `app_config` (except an explicit 8-key UI allowlist), and `proctor_audit_events` (`SELECT`/`UPDATE`/`DELETE`).
   - Student exam loading, cloud draft syncing, submission writes, and result lookups run through narrow `SECURITY DEFINER` RPCs that validate codes/flags and strip mark-scheme answers, `source_pdf_url`, `metadata`, `teacherPin`, and grading rationales server-side.

---

## 2. Database Migration (`021_phase2_teacher_login_rls_and_exam_rpcs.sql`)

### 2A. Teacher Account Schema & Session Store
- Extend `public.teacher_profiles` (`ADD COLUMN IF NOT EXISTS`):
  - `email TEXT`, `username TEXT`, `password_hash TEXT`, `role TEXT NOT NULL DEFAULT 'teacher'`, `is_active BOOLEAN NOT NULL DEFAULT TRUE`, `last_login_at TIMESTAMPTZ`.
  - Add case-insensitive partial unique indexes `idx_teacher_profiles_email_unique` and `idx_teacher_profiles_username_unique`.
- Create `public.teacher_auth_sessions` (`token_hash TEXT PRIMARY KEY`, `teacher_id UUID REFERENCES teacher_profiles(id) ON DELETE CASCADE`, `role`, `created_at`, `expires_at TIMESTAMPTZ`) with RLS enabled (no public policies; accessed strictly inside `SECURITY DEFINER` RPCs / helpers).
- Helper functions:
  - `public.sanitize_teacher_profile_json(p_row public.teacher_profiles) RETURNS JSONB` — strips `password_hash` and `pin_hash` and adds `has_password`.
  - `public.is_authenticated_teacher() RETURNS BOOLEAN` (`SECURITY DEFINER STABLE`) — accepts `auth.role() = 'authenticated'` OR validates SHA-256 of the `x-teacher-session` HTTP header against `public.teacher_auth_sessions` (`expires_at > NOW()`).

### 2B. Teacher Auth RPCs (`SECURITY DEFINER`)
1. `public.login_teacher_account(p_identifier TEXT, p_password TEXT) RETURNS JSONB`
   - Matches active `teacher_profiles` by `email`, `username`, or `name`.
   - Returns `'setup_required'` with sanitized profile if `password_hash` is empty (legacy profile ready to claim).
   - Verifies salted SHA-256 (`<salt>:<sha256hex>`) or legacy SHA-256 hash, purges expired sessions, mints a 12-hour random token, stores its SHA-256 hash in `teacher_auth_sessions`, updates `last_login_at`, and returns `'ok'`, `token`, `expiresAt`, and `profile`.
2. `public.register_or_claim_teacher_account(...) RETURNS JSONB`
   - Verifies `p_master_pin` via `public.verify_teacher_access_pin(p_master_pin)`.
   - Validates password length (`>= 6`), username/email, and display name.
   - Claims a passwordless legacy row (`p_claim_profile_id`) or inserts a new `teacher_profiles` row, mints a session token, and returns `'ok'`, `token`, `expiresAt`, `profile`.
3. `public.reset_teacher_password_with_master_pin(p_identifier TEXT, p_new_password TEXT, p_master_pin TEXT) RETURNS JSONB`
   - Verifies `p_master_pin`, updates `password_hash` with a fresh salt, invalidates prior sessions for that teacher, mints a new 12-hour session token, and returns `'ok'`.
4. `public.logout_teacher_session() RETURNS BOOLEAN`
   - Deletes the matching hashed `x-teacher-session` token from `public.teacher_auth_sessions`.

### 2C. Server-Side Student Exam Delivery, Draft & Submission RPCs (`SECURITY DEFINER`)
1. `public.sanitize_question_json_for_student(p_question JSONB, p_strip_keys BOOLEAN) RETURNS JSONB`
   - Always removes `'source_pdf_url'` and `'metadata'`.
   - When `p_strip_keys` is `TRUE` (exam / locked mark-scheme delivery): preserves non-answer `_insert_resources` and `_data_tables` (stripping `expectedAnswers` cells), strips `mark_scheme`, `guidance`, `common_misconceptions`, `acceptable_answers` from top-level and `sub_questions`, and strips `scratchpad`.
2. `public.get_student_exam_paper(p_code TEXT) RETURNS JSONB`
   - Resolves `quiz_by_code:<CODE>` or `published_quizzes` array in `app_config`.
   - Derives `v_teacher_pin_hash` (`sha256:<CODE>::<PIN>`), removes plaintext `teacherPin` and `questionOverrides`.
   - Returns `{ isActive: false, questions: [] }` when inactive; otherwise fetches ordered questions from `public.questions`, applies `questionOverrides` from header config, sanitizes every question server-side, and returns the paper payload.
3. `public.save_student_exam_draft(p_key TEXT, p_value TEXT) RETURNS BOOLEAN`, `public.get_student_exam_draft(p_key TEXT) RETURNS TEXT`, `public.delete_student_exam_draft(p_key TEXT) RETURNS BOOLEAN`
   - Enforces `p_key LIKE 'draft_%' AND LENGTH(p_key) <= 180` so students can only touch their own draft keys.
4. `public.submit_student_exam_attempt(p_row JSONB) RETURNS BOOLEAN`
   - Forces `status = 'submitted'` and `teacher_adjusted_marks = 0` on insert; `ON CONFLICT (id) DO UPDATE` rejects modifying already-reviewed/locked submissions (`status <> 'submitted'`) or mismatched `result_pin`.
5. `public.lookup_student_exam_result(p_quiz_code TEXT, p_student_query TEXT, p_result_pin TEXT)`
   - Respects `allowStudentScriptDownload` from `published_quizzes`: when `FALSE` (default), strips `questionText`, `correctAnswer`, and `criteriaBreakdown` inside `question_results`.

### 2D. Strict Row-Level Security
Enable RLS and replace permissive public policies across all 7 workspace tables:
- `syllabuses`, `questions`, `custom_tests`, `quiz_submissions`, `teacher_profiles`: Teacher `FOR ALL` gated by `public.is_authenticated_teacher()`.
- `app_config`: Teacher `FOR ALL` (`public.is_authenticated_teacher()`), plus Public `FOR SELECT` restricted to the 8 safe UI configuration keys (`school_classes`, `school_subjects`, `google_drive_client_id`, `hide_creative_mode_landing`, `hide_emergency_exam_button`, `gemini_extraction_model`, `gemini_api_key_tier`, `exam_security_tiers`).
- `proctor_audit_events`: Teacher `FOR ALL` (`public.is_authenticated_teacher()`), plus Student `FOR INSERT` (`WITH CHECK (actor = 'student')`).

---

## 3. Client Application Changes

| Area | File(s) | Responsibility |
| :--- | :--- | :--- |
| Types & Supabase Header | `src/types/database.ts`, `src/lib/supabase.ts` | Extend `TeacherProfile`; inject `x-teacher-session` header from `sessionStorage` (`TEACHER_SESSION_TOKEN_KEY = 'testmaker_teacher_token'`) safely in browser & Node contexts; export `hasActiveTeacherSession()`. |
| Auth Services & Context | `src/services/teacherProfileService.ts`, `src/contexts/TeacherProfileContext.tsx` | Add `loginTeacherAccount`, `registerOrClaimTeacherAccount`, `resetTeacherPasswordWithMasterPin`, `logoutTeacherSession`; strip `pin_hash`/`password_hash` in cache; gate cloud profile loading on `hasActiveTeacherSession()` and listen to `'teacher_session_authenticated'`. |
| Unified Login UI & Sign Out | `src/components/PinGate.tsx`, `src/components/PinGate.css`, `src/App.tsx` | Replace 6-digit PIN pad with 3-view Unified Teacher Login (`signin`, `register`/`claim`, `reset` via Master PIN) with Turnstile & brute-force lockout; revoke session token on Lock/Sign Out. |
| Student RPC Wiring | `src/services/quizCodeService.ts`, `src/services/examDraftService.ts`, `src/services/quizSubmissionService.ts` | Call `get_student_exam_paper`, `save_student_exam_draft` / `get_student_exam_draft` / `delete_student_exam_draft`, and `submit_student_exam_attempt` when `!hasActiveTeacherSession()`; prevent anonymous student writes to shared `app_config` mirrors. |

---

## 4. Verification Plan

1. Automated structural & logic test suite: `scripts/test-phase2-auth-rls-rpcs.mjs` (`npm run test:phase2-security`).
2. Existing regression suites: `npm run test:phase1-security`, `npm run test:pilot-exam`, `npm run test:resource-booklet`, `npm run test:fillable-tables`, `npm run test:inline-gaps`.
3. Static typecheck, lint & production bundle: `npm run lint` (`oxlint`) and `npm run build` (`tsc -b && vite build`).
4. Post-deploy SQL & live Supabase verification checklist (apply `020` + `021` in Supabase SQL Editor, claim legacy teacher profile with Master PIN, verify anonymous REST `GET /rest/v1/questions` returns `[]`).
