# 170-Student Simultaneous Exam Scale & Admin Pre-Warm Optimization Plan

## Goal & Safety Guarantees
Ensure **170+ simultaneous students** across multiple exam codes (`ICM-1`..`ICM-13`) experience fast, error-free exam entry, mid-exam saving, pausing/resuming, and simultaneous timer-expiry submission **without relaxing any anti-tamper, PIN, single-attempt, or RLS security boundary**.

### Non-Negotiable Security Invariants
1. **`exam_paper_cache` stays `REVOKE ALL` from `anon` & `authenticated`**: Students never read the cache table directly; only `SECURITY DEFINER` RPCs access it.
2. **Zero secret leakage in cached payloads**: `teacherPin`, `teacherPinHash`, `questionOverrides`, and (in Exam/Game mode without instant solutions) `mark_scheme` / `acceptable_answers` remain stripped before insertion into `exam_paper_cache`.
3. **Strict time-window & pause gating**: Pre-warming a `scheduled` quiz populates `exam_paper_cache` on the server, **never** returns `questions` before `NOW() >= scheduled_start_at`, and deletes/blocks cache immediately when paused or closed.
4. **Server-side PIN, attempt, & device-lock authority**: All PIN verification, rate-limit lockouts, single-attempt checks, `exam_draft_locks` owner-token verification, and score zeroing in `isExamMode` stay strictly server-side inside `SECURITY DEFINER` Postgres functions.

---

## Step-by-Step Executable Breakdown

### Step 1: Database Migration `037` Part A — 90-Minute `exam_paper_cache` & Schedule-Safe Admin Pre-Warm RPC
**Files to edit/create:**
- Create `supabase/migrations/037_admin_prewarm_and_unified_exam_entry.sql` (Part A)

**Concrete Changes:**
1. **Extract a shared private helper `public._compile_and_cache_exam_paper(p_code TEXT, p_allow_scheduled BOOLEAN DEFAULT FALSE)`**:
   - Deduplicates paper building, question/override merging, sanitization (`sanitize_question_json_for_student`), and `exam_paper_cache` upsert logic used by both `get_student_exam_paper` and the new pre-warm RPC.
   - Revoke execution from `PUBLIC`, `anon`, and `authenticated`.
2. **Extend `exam_paper_cache` TTL from `5 minutes` -> `90 minutes`**:
   - Update both cache lookup checks in `get_student_exam_paper` (`036` lines `564` & `697`) from `INTERVAL '5 minutes'` to `INTERVAL '90 minutes'`.
   - Keep `AND (c.scheduled_start_at IS NULL OR v_now >= c.scheduled_start_at)` and `AND (c.scheduled_end_at IS NULL OR v_now <= c.scheduled_end_at)` so expired/future windows never leak.
   - Dynamic invalidation triggers (`trg_invalidate_exam_paper_cache_app_config_*`, `questions`, `custom_tests`) continue to invalidate modified quizzes immediately.
   - Note: `publicRosterDirectory` is still injected dynamically from `school_roster_meta` on return, so roster/PIN edits before start stay live.
3. **Preserve pre-warmed cache during `'scheduled'` wait**:
   - In `get_student_exam_paper`, only `DELETE FROM public.exam_paper_cache` when `v_schedule_status IN ('paused', 'closed')`.
   - When `v_schedule_status = 'scheduled'`, leave any pre-warmed row in `exam_paper_cache` intact and still return `{ publishedQuiz, isActive: FALSE, scheduleStatus: 'scheduled', serverNow: v_now, questions: '[]'::jsonb }`.
   - The instant `NOW() >= scheduled_start_at`, all 170 waiting/joining students immediately hit the pre-warmed row without triggering a cold build or `pg_advisory_xact_lock` queue.
4. **Filter `publicRosterDirectory` by `targetClass` (optional payload reduction)**:
   - When `v_quiz->>'targetClass'` is non-empty, optionally filter the returned `publicRosterDirectory` array to matching normalized class labels so `ICM-1`..`ICM-13` payloads shrink ~13× and cross-class names aren't unnecessarily shipped.
5. **Add Teacher-Only `public.prewarm_exam_paper_cache(p_quiz_codes TEXT[])`**:
   - Guard with `IF NOT public.is_authenticated_teacher() THEN RAISE EXCEPTION ... USING ERRCODE = '42501'; END IF;`.
   - Loops over distinct normalized codes, calls `_compile_and_cache_exam_paper(code, TRUE)` for `active` or `scheduled` quizzes (skipping `paused` / `closed`), and returns a summary JSON `{ warmed: [...], skipped: [...], missing: [...], ttlMinutes: 90, cachedAt }`.

**Verification for Step 1:**
- Apply SQL locally/staging or verify syntax cleanly.
- Assert `anon` calling `prewarm_exam_paper_cache` fails with SQLSTATE `42501`.
- Assert calling `get_student_exam_paper` on a pre-warmed `scheduled` quiz returns `scheduleStatus = 'scheduled'` and `questions = []` before `scheduledStartAt`, and returns populated sanitized `questions` immediately at `scheduledStartAt` without `mark_scheme` or `teacherPin`.

---

### Step 2: Admin UI "Pre-Warm Cache" Button & Sequential Pause Hardening
**Files to edit:**
- `src/services/quizManagerService.ts`
- `src/pages/QuizManagerPage.tsx`

**Concrete Changes:**
1. **Add `prewarmExamPaperCache(quizCodes: string[])` in `quizManagerService.ts`**:
   - Calls `supabase.rpc('prewarm_exam_paper_cache', { p_quiz_codes: cleanCodes })` and returns typed counts + error/missing fallback cleanly if `037` is not yet applied.
2. **Admin Pre-Warm Trigger in `QuizManagerPage.tsx`**:
   - Add a **"Pre-Warm Exam Cache"** action button in the toolbar near `School Live Proctor` (`QuizManagerPage.tsx` ~line `1249`) that warms all `active` + `scheduled` exams in the current view (e.g., all 13 `ICM-1..13` exams in one single RPC call!) and displays a clear status pill (`"Warmed 13 exams for 90 min"`).
   - Also trigger non-blocking `prewarmExamPaperCache([savedQuiz.quizCode])` right after saving/publishing/unpausing an exam in `handleSaveQuizConfig` / `publishQuiz`.
3. **Fix `toggleQuizActiveStatus` Concurrent Writes in `quizManagerService.ts` (`L1064-L1123`)**:
   - Replace `await Promise.all([syncPublishedQuizzesToCloud(cloudList), upsertQuizCodeIndexToCloud(slimTarget)])` with sequential execution (`await upsertQuizCodeIndexToCloud(slimTarget); await syncPublishedQuizzesToCloud(cloudList);`) so pausing multiple exams never creates overlapping `app_config` write storms or invalidates caches mid-write.
   - Skip unnecessary header backfills for untouched sibling quizzes during a simple pause/resume toggle.

**Verification for Step 2:**
- Run `npx tsc --noEmit`.
- Verify in `QuizManagerPage` UI that clicking **Pre-Warm Exam Cache** invokes one single RPC for all active/scheduled exams and reports the warmed count accurately, and pausing/resuming an exam performs sequential cloud writes cleanly.

---

### Step 3: Landing Boot & Waiting-Room Request De-Bursting
**Files to edit:**
- `src/lib/settings.ts`
- `src/pages/StudentQuizRunner.tsx`

**Concrete Changes:**
1. **Eliminate 170-way `app_config` Read on Portal Open (`settings.ts`)**:
   - Update `loadAndSyncCreativeModeLandingVisibility()` (`L539`) to honor a `10 minute` `localStorage` timestamp TTL (`creativeModeLandingSyncedAt`) matching `lastStudentLobbySettingsSeededAt`, returning cached `localVal` immediately within the TTL window.
   - Result: Students opening `/` or refreshing before entering an exam code generate **0** `app_config` queries (or at most 1 per 10 minutes per browser).
2. **Smooth Exam Code Entry & Waiting Room Release (`StudentQuizRunner.tsx`)**:
   - Widen `bootJitterMs` (`L950`) from `0..3400 ms` to `0..6000 ms` when `!hasActiveTeacherSession()`.
   - Add `1500..7500 ms` randomized jitter on `handleRefreshScheduledOrPausedStatus` (`L4880`) or any scheduled countdown auto-unlock so 170 waiting-room clients do not fire simultaneously at `08:00:00`.

**Verification for Step 3:**
- Add/update a unit test in `src/lib/__tests__/` proving back-to-back calls to `loadAndSyncCreativeModeLandingVisibility()` within the TTL issue only 1 Supabase query.
- Run `npx tsc --noEmit` and unit tests.

---

### Step 4: Database Migration `037` Part B & Client Wiring — Unified `enter_student_exam_session` RPC
**Files to edit:**
- `supabase/migrations/037_admin_prewarm_and_unified_exam_entry.sql` (Part B)
- `src/services/examDraftService.ts`
- `src/pages/StudentQuizRunner.tsx`

**Concrete Changes:**
1. **Create `public.enter_student_exam_session(p_payload JSONB)`**:
   - Accepts `{ quiz_code, quiz_id, student_name, student_class, candidate_number, student_pin, draft_key, draft_owner_token, require_student_pin, limit_one_attempt, expected_quiz_ids }`.
   - Performs all 4 exam-start checks in **one single Postgres round-trip**:
     1. **PIN verification** against `school_roster_entries` + `security_rate_limits` lockout (`10` attempts / `600 s`) + `clear_rate_limit` on success when `require_student_pin = true` (server still verifies authoritative `requireStudentPin` flag from `exam_paper_cache` / `quiz_by_code_*` so a client cannot spoof `require_student_pin: false`!).
     2. **Single-attempt check** against `quiz_submissions` using `idx_quiz_submissions_code_norm_name_class` when `limitOneAttempt = true`.
     3. **Cloud draft lookup & device-lock verification** (`app_config` + `exam_draft_locks`) returning any existing `in_progress` cloud draft payload **only after** PIN + owner token pass.
     4. **Initial lock acquisition** in `exam_draft_locks` if no active draft exists yet (so starting a fresh exam does not need an immediate extra `save_student_exam_draft` call unless local answers change!).
   - Returns structured verdict JSON: `{ status: 'ready' | 'draft_found' | 'invalid_pin' | 'already_submitted' | 'locked_other_device', error?, student?, submittedAt?, draftJson? }`.
2. **Update `StudentQuizRunner.tsx` (`handleStartExam` & `handleResumeDraft`)**:
   - Remove the automatic speculative `fetchExamDraft` debounce (`L3873-3888`) that fires 1.2s after typing the 4th PIN digit in the lobby; instead check `localStorage` synchronously for local crash drafts, and call `enterStudentExamSession(...)` once when clicking **"Start Examination"**.
   - If `enterStudentExamSession` returns `status: 'draft_found'`, hydrate `detectedDraft` and prompt the student to resume (or auto-resume directly with the verified PIN & lock), avoiding all 4 separate lobby/start RPCs (`get_student_exam_draft` + `verify_student_pin` + `check_student_attempt_submitted` + initial `save_student_exam_draft`).
   - Keep full backward-compatible fallback (`isMissingRpcError`) to the legacy 3-step client path if Migration `037` is absent.

**Verification for Step 4:**
- SQL / integration assertions for `enter_student_exam_session`:
  - Rejects forged `require_student_pin: false` when server quiz config requires PIN.
  - Enforces rate limit after 10 wrong PINs.
  - Blocks second attempt when `quiz_submissions` already has a row for the same `(quiz_code, norm_name, norm_class)`.
  - Rejects mismatched `draft_owner_token` when a live session lock exists on another device.
  - Returns `draftJson` cleanly for same-device / PIN-matched recovery.

---

### Step 5: Simultaneous Submission Smoothing & Safe Payload Trimming
**Files to edit:**
- `src/pages/StudentQuizRunner.tsx`
- `src/services/quizSubmissionService.ts`
- `src/services/quizReportPdfService.ts` (verification/fallback hydration guard)

**Concrete Changes:**
1. **Widen Auto-Submit & Manual Submit Jitter (`StudentQuizRunner.tsx`)**:
   - Timer-expiry `jitterMs` (`L3779`): increase from `0..6000 ms` to **`0..15000 ms`** (candidate answers are already locked at countdown `0` while *"Time Expired! Finalizing and uploading..."* shows, dropping peak Postgres write rate from `~28/s` to `~11/s`).
   - Manual submit `uploadJitterMs` (`L2777`): increase from `0..4500 ms` to **`0..7000 ms`**.
2. **Resilient Transient Backoff (`quizSubmissionService.ts`)**:
   - In `saveQuizSubmissionWithVerification` (`L1655-L1702`), increase `maxRetries` default to `4` with wider jittered backoff (`2–4 s`, `5–9 s`, `10–16 s`) on transient network/5xx errors, while still aborting immediately on deterministic rejections (`42501`, duplicate attempt, invalid PIN).
3. **Lean Formal-Exam `question_results` Payload (Optional Guarded Trim)**:
   - Because `submit_student_exam_attempt` (`036:L1160-1183`) strips grading fields and rebuilds `v_q_results` in Postgres anyway when `v_is_exam_mode = TRUE`, omit duplicated static `questionText`, `options`, and `misconceptions` from `questionResults` sent over the wire in strict exam mode (preserving `questionId`, `questionNumber`, `topic`, `maxMarks`, `studentAnswer`, `subQuestionResults` answers, `rawAnswers`, and `forensics`).
   - Confirm `QuizResultsModal.tsx` (`L598-774`) and `quizReportPdfService.ts` (`L1478`, `L1502`) hydrate missing `questionText`/`options` from the test's `questions` array so teacher grading and PDF export remain 100% identical.

**Verification for Step 5:**
- Run `npx tsc --noEmit` and existing Vitest unit tests covering `quizSubmissionService`, `examSubmissionGuards`, and PDF/results rendering.

---

### Step 6: End-to-End Dry Run Verification
**Actions:**
1. Run `npm run build` and existing unit test suite (`npx vitest run`).
2. After deploying Migration `037`, run an updated dry-run benchmark modeled on `scripts/stress-test-realistic-exam-sitting.mjs`:
   - Call `prewarm_exam_paper_cache` for `ICM-1..ICM-13` (including scheduled + active scenarios).
   - Simulate 200 students entering via `enter_student_exam_session` + `get_student_exam_paper` + 200 concurrent submissions with widened jitter.
   - Verify `0` HTTP 5xx/timeouts, `< 500 ms` p95 join & submit latency, and unchanged security rejection tests.
