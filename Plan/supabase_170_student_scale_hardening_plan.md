# Plan: Preventing Supabase `544 DatabaseTimeout` Under 170+ Concurrent Students

## 1. Forensic Diff — What Changed Since Last Week's 100-Student Test (`v2.4.8` → `v2.5.5`)

Last week's 100-student live test ran on **`v2.4.8` (Nov 12)**, before Migrations **`020`–`026`** and the **`v2.5.0`–`v2.5.5`** security/autosave releases landed (Nov 14–17). Comparing `v2.4.8` (`e0dc514`) against `HEAD` reveals **five concrete database load multipliers** introduced since last week:

| Area | Last Week (`v2.4.8`) | Current (`v2.5.0`–`v2.5.5`) | Impact at 170 Students |
| :--- | :--- | :--- | :--- |
| **Cloud Draft Write Cadence** (`src/pages/StudentQuizRunner.tsx:3538-3573`) | **Once every 50s** (`setInterval(performSync, 50000)`). No per-edit cloud debounce. | **`2.5s` debounce on EVERY answer edit, question turn (`currentIndex`), flag, or violation** + **unconditional `25s` interval** (even when idle) + **`visibilitychange` / `pagehide` / `beforeunload` flushes** (`lines 3439-3450`). | **~10×–20× more Postgres writes/sec** continuously across the entire exam. |
| **Tables Written per Draft Save** (`supabase/migrations/022_exam_anti_tamper_and_rate_guards.sql:267-322`) | Single-row `app_config` UPSERT. | `save_student_exam_draft` hashes token (`SHA256`), reads & writes **`exam_draft_locks`** AND writes **`app_config`** on **every** tick. | **2× table updates, 2× index writes, 2× MVCC dead tuples & Disk IO** per save (tens of thousands of updates per 60-min exam → drains Supabase burst Disk IO balance). |
| **Retry & Fallback Amplification** (`src/services/examDraftService.ts:201-225`, `src/services/quizSubmissionService.ts:1502-1524`) | Direct table upserts only. | On **any** RPC error (including timeouts/5xx), client immediately fires a **second** RLS-blocked fallback (`app_config.upsert` / `quiz_submissions.upsert`), and submission retries 3× at tight `400ms / 720ms` intervals. | **2×–6× request storm** right when Postgres begins slowing down. |
| **Student-Direct Audit Inserts + Trigger Seq Scan** (`StudentQuizRunner.tsx:1036`, `022:776-819`, `018:24-28`) | Violations went over Realtime WebSocket only (not direct student DB inserts). | Every student violation inserts into `proctor_audit_events`. Trigger `enforce_proctor_audit_guard` runs `is_authenticated_teacher()` + `SELECT COUNT(*) ... WHERE UPPER(TRIM(quiz_code)) = ... AND LOWER(TRIM(student_id)) = ...` — wrapping columns in functions prevents using `idx_proctor_audit_student`. | Unindexed table scan on every student violation/blur event. |
| **Server-Side JSONB Assembly & Lobby Fan-In** (`021`/`024`/`025`, `StudentQuizRunner.tsx:443-448`) | Lightweight direct reads of raw tables. | Every student runs PL/pgSQL `get_student_exam_paper()` (strips keys/tables in SQL), `verify_student_pin()` + `verify_roster_pin_if_enrolled()` (parses entire `school_roster` JSON blob on every login & submit + writes `security_rate_limits`), plus simultaneous `loadAndSyncSchoolClasses()` + `fetchPublicRosterDirectory()` on lobby mount. | Sharp CPU/connection spikes at exam start and simultaneous timer-expiry submit. |

> **Why the short 200-student benchmark passed while real sittings hit `544 DatabaseTimeout`:** Short synthetic runs stay inside Supabase's burst Disk IO / CPU credit buffer, whereas a sustained 45–90 minute exam with 10×–20× higher continuous MVCC `UPDATE`s on `app_config` + `exam_draft_locks` drains Disk IO credits and triggers autovacuum/connection-pool saturation (`HTTP 544`).

---

## 2. Prevention Plan (5 Phased Steps)

### Step 1: Cut Cloud Draft Write Traffic by ~85–90% (`StudentQuizRunner.tsx` + `examDraftService.ts`)
*(Preserves crash safety because `localStorage` + `sessionStorage` still persist every edit in `400ms`.)*
1. **Dirty-check before writing to Supabase (`StudentQuizRunner.tsx:3500-3573`):**
   - Track a lightweight fingerprint of durable exam state (`answers`, `flaggedIndices`, `audioProgress`, `violations.length`, `strikeCount`, `isLockedByProctor`, `totalPenaltySeconds`).
   - Skip cloud `saveExamDraft` completely when the fingerprint matches the last successfully synced cloud draft — eliminating idle writes on the periodic timer and on repeated `visibilitychange` triggers.
2. **Relax cloud draft cadence + add per-student jitter:**
   - Remove pure navigation (`currentIndex`) from the fast cloud debounce trigger (keep it in the 400ms local save).
   - Increase answer-edit cloud debounce from `2.5s` → **`12s`** (with a `30s` max-wait cap so active typing still syncs regularly).
   - Increase periodic safety sync interval from `25s` → **`90s` + random `0–20s` per-student jitter** (firing only when dirty or >3 minutes since last cloud heartbeat).
   - Throttle `visibilitychange` hidden-tab flushes (skip if already synced cleanly within the last `10s` and not dirty).
3. **Eliminate double-write fallback storms & add 5xx circuit breaker (`examDraftService.ts:201-227`):**
   - Only fall back to legacy `app_config.upsert` when Postgres explicitly returns `42883` (*function does not exist*), **never** on timeouts, network errors, `544`, `502`/`503`/`504`, or `42501`.
   - Add per-tab exponential backoff on `saveExamDraft` after consecutive cloud failures (`30s` → `60s` → `120s`, resetting on first success) so 170 tabs back off cleanly when Postgres is under load.

---

### Step 2: Smooth Thundering-Herd Spikes on Start & Submit (`StudentQuizRunner.tsx` + `quizSubmissionService.ts`)
1. **Jittered Timer-Expiry Auto-Submit (`StudentQuizRunner.tsx:3584`):**
   - At `timeLeft <= 0`, lock student inputs and save locally immediately (showing *"Time's Up — Finalizing & Uploading..."*), then wait a random **`0–8s` upload jitter** before calling `saveQuizSubmissionWithVerification` so 170 auto-submits spread smoothly instead of hitting Postgres in the same second.
2. **Stop RLS-blocked fallback & jitter submission retries (`quizSubmissionService.ts:1506-1610`):**
   - In `saveQuizSubmissionCloud`, only fall back from `submit_student_exam_attempt` to `quiz_submissions.upsert` on `42883` (missing RPC), never on `544`/timeout/network errors.
   - Increase retry backoff with random jitter (`1.5s`, `4s`, `8s` ± 30%) and stop retrying deterministic rejections (`42501` / duplicate-attempt).
3. **Cache lobby metadata (`StudentQuizRunner.tsx:443-448`, `studentRosterService.ts`):**
   - Cache `school_classes` and `public_roster_directory` in `sessionStorage`/`localStorage` with a short TTL (`10 minutes`) so page reloads or 170 concurrent lobby opens don't hammer `app_config` simultaneously.
   - Add small jitter (`0–1.5s`) on automatic lobby draft recovery fetches.

---

### Step 3: Database Hot-Path & Table Bloat Optimization (`supabase/migrations/028_high_concurrency_db_optimization.sql`)
1. **Cut `exam_draft_locks` writes by ~95% inside `save_student_exam_draft` (`022:308-312`):**
   - Once `v_existing_hash = v_hash` matches, only update `exam_draft_locks.updated_at` if `v_existing_ts < NOW() - INTERVAL '10 minutes'` (instead of writing `exam_draft_locks` on every draft tick).
2. **Enable PostgreSQL HOT updates (`fillfactor = 70`) on hot tables:**
   - `ALTER TABLE public.app_config SET (fillfactor = 70);`
   - `ALTER TABLE public.exam_draft_locks SET (fillfactor = 70);`
   - Allows repeated key `UPDATE`s to reuse heap page space with zero index rewrites, drastically cutting Disk IO and autovacuum pressure.
3. **Fix `proctor_audit_events` trigger sequential scan (`022:808-812`):**
   - Add matching functional index:
     ```sql
     CREATE INDEX IF NOT EXISTS idx_proctor_audit_guard_lookup
       ON public.proctor_audit_events (UPPER(TRIM(quiz_code)), LOWER(TRIM(student_id)), created_at DESC);
     ```
   - Debounce rapid duplicate student violation DB writes client-side (`StudentQuizRunner.tsx:1036`, e.g. max 1 DB write per 3s per event type while Realtime stays instant).
4. **Add stale draft cleanup RPC (`cleanup_stale_exam_drafts`):**
   - Purges `app_config` rows (`key LIKE 'draft_%'`) and `exam_draft_locks` rows older than `48 hours` so dead draft rows don't bloat `app_config` across weeks of exams.

---

### Step 4: Infrastructure & Edge Caching Recommendations (Supabase + Cloudflare)
1. **Immediate Recovery & Compute Sizing for 170-Student Exam Days:**
   - Check **Supabase Dashboard → Reports → Database** (`Disk IO Budget`, `CPU`, `Connections`) and run **Restart database** if currently wedged.
   - Once healthy, run `VACUUM ANALYZE public.app_config; VACUUM ANALYZE public.exam_draft_locks; VACUUM ANALYZE public.quiz_submissions;`.
   - If on Supabase **Free / Nano**, consider upgrading temporarily to **Micro or Small Compute** during 170-student exam weeks so sustained Disk IO budget isn't throttled.
2. **Optional Phase-2 Edge Caching (Cloudflare Worker):**
   - Cache sanitized `get_student_exam_paper(p_code)` responses for `30–60s` at the Cloudflare Worker edge so 170 simultaneous exam loads collapse to **1 DB call per exam**.

---

### Step 5: Verification Plan
1. **Unit & Regression Tests (`scripts/test-concurrency-hardening.mjs`):**
   - Verify draft dirty-checking skips unchanged periodic ticks.
   - Verify `saveExamDraft` and `saveQuizSubmissionCloud` do not fire RLS-blocked table fallbacks on `544`/timeout errors and engage exponential circuit-breaker backoff cleanly.
   - Verify Migration `028` SQL contracts (conditional `exam_draft_locks` touch, `fillfactor = 70`, `idx_proctor_audit_guard_lookup`, `cleanup_stale_exam_drafts`).
2. **Sustained Load Test (once Supabase Postgres recovers):**
   - Run an extended 170-student simulation mimicking real multi-minute exam traffic (jittered drafts + simultaneous timer-expiry submit) and monitor Supabase Dashboard **Disk IO & CPU** to confirm flat utilization with zero `544` errors.
3. Pair cleanly with [`Plan/class_scoped_same_name_submission_plan.md`](class_scoped_same_name_submission_plan.md) (`Migration 027` + `028`) before the 170-student exam.
