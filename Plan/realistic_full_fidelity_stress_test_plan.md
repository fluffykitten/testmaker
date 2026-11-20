# Plan: Production-Grounded Full-Fidelity Stress Test (170–200 Students + Live Invigilators)

## 1. Post-Mortem: Why Our Previous Stress Test Scripts Failed to Predict "Supabase Unhealthy"

Comparing our earlier scripts ([`scripts/simulate-200-students-stress-and-redteam.mjs`](../scripts/simulate-200-students-stress-and-redteam.mjs) and [`scripts/stress_test_simulation.mjs`](../scripts/stress_test_simulation.mjs)) against the actual browser execution path in [`src/App.tsx`](../src/App.tsx), [`src/pages/StudentQuizRunner.tsx`](../src/pages/StudentQuizRunner.tsx), [`src/components/LiveInvigilatorModal.tsx`](../src/components/LiveInvigilatorModal.tsx), and [`src/components/QuizResultsModal.tsx`](../src/components/QuizResultsModal.tsx) reveals **7 critical reality gaps**:

| # | Reality Gap | What the Old Script Did | What Real Browsers & Teachers Actually Do | Load Multiplier Missed |
| :- | :--- | :--- | :--- | :--- |
| **1** | **Page Boot & Lobby Fan-Out** | Called only 2 RPCs per student (`get_student_exam_paper` + `check_student_attempt_submitted`). | Every student opening `/#/student?code=ICM170` triggers: <br>1. `TeacherProfileProvider` at root (`App.tsx:1073`) → `SELECT * FROM teacher_profiles`<br>2. `PortalLandingPage` → `app_config` (`hide_creative_mode_landing`)<br>3. `resolveStudentQuiz` → `rpc('get_student_exam_paper')` + `app_config` (`security_tiers`)<br>4. `StudentQuizRunner` mount → `app_config` (`school_classes`), `rpc('get_public_roster_directory')`, `app_config` (`hide_emergency_exam_button`)<br>5. Typing name/class in lobby (`StudentQuizRunner.tsx:3805`) → 600ms debounced `rpc('get_student_exam_draft')` (2–4 calls per student while filling form)<br>6. Clicking **Begin Exam** (`line 4123`) → `verify_student_pin` + `check_student_attempt_submitted` + **immediate unconditional `save_student_exam_draft` write** (`exam_draft_locks` + `app_config`). | **5×–6× more queries** at exam start + **170 immediate DB writes** on click of "Begin Exam". |
| **2** | **Zero Teacher / Invigilator Dashboards Simulated** | Simulated 0 teacher clients. | In a live test, 1–5 teachers have **Live Invigilator** (`LiveInvigilatorModal.tsx`) and/or **Results Modal** (`QuizResultsModal.tsx`) open: <br>• **Duplicate Audit Storm (`LiveInvigilatorModal.tsx:682`)**: Every student violation AND every student submission (`StudentQuizRunner.tsx:2545`) broadcasts a `proctor_log` event. Every open Invigilator dashboard receives it and fires `POST /rest/v1/proctor_audit_events` — multiplying audit DB writes by $1 + M_{\text{teachers}}$ right during submission!<br>• **$O(N^2)$ `postgres_changes` Read/Re-Upsert Storm (`QuizResultsModal.tsx:269-407`)**: `QuizResultsModal` subscribes to `postgres_changes` (`*`) on `quiz_submissions`. Each student submission triggers `refreshSubmissions()` (`SELECT * FROM quiz_submissions`), which sees Exam Mode `'Awaiting examiner AI evaluation'`, grades deterministically in the teacher browser, and calls `updateSubmission()` (`UPSERT` back to `quiz_submissions`), triggering *another* `postgres_changes` event! | **Up to $170 \times M$ extra `SELECT *` + $170$ `UPSERT`s + $170 \times M$ audit inserts** during the submission window. |
| **3** | **`visibilitychange` Keepalive Bypassing Circuit Breaker** | Tested normal `save_student_exam_draft` calls only. | When students switch tabs, hit a lock screen, or exit fullscreen, `visibilitychange` calls `flushCloudDraftRef.current(true)` (`StudentQuizRunner.tsx:3550`). In `examDraftService.ts:209`, `if (!options?.keepalive)` **bypasses the `544` circuit-breaker backoff** and bypasses the 12s debounce (using a 15s window). | Unthrottled `keepalive` POSTs continue hammering Postgres even after a `544` timeout occurs. |
| **4** | **Toy Submission Payloads vs. Real Forensics & Question Results** | Sent `question_results: []` (~500 bytes per submission). | Real `StudentQuizRunner.tsx:2670-2724` sends full `question_results` (with `questionText`, `options`, `subQuestionResults`), `proctoring_logs`, and `raw_answers._forensics` (`answerChangeLogs`, `questionTimeAnalytics`, `answersByQuestionId`, `tierHistory`) — **15 KB to 60 KB of JSONB per student**, which `submit_student_exam_attempt` re-aggregates in PL/pgSQL (`jsonb_agg`), followed immediately by `clearExamDraft` (`delete_student_exam_draft`). | **30×–100× larger JSONB/TOAST write volume** per submission + immediate dual-table delete (`app_config` + `exam_draft_locks`). |
| **5** | **Wave 3 Failure Masked as Pass** | Exited with code `0` even when Wave 3 degraded. | Look at [`Plan/student_200_stress_test_report.md`](student_200_stress_test_report.md#L23): Wave 3 (`submit_student_exam_attempt` × 200) actually took **73.4 seconds wall time (`p50 = 57.3s`, `max = 65.4s`) and only 131/200 succeeded (69 failed!)**, plus 187 draft locks failed to clean up. | The script itself *already* wedged Postgres on Wave 3, but didn't fail the test run! |
| **6** | **WebSockets Closed Before DB Waves** | `stress_test_simulation.mjs` closed all 200 WebSockets before running DB writes; `simulate-200-students` opened 0 WebSockets. | In reality, all 170 student WebSockets + teacher WebSockets stay connected and emit heartbeats/broadcasts **simultaneously** with Postgres REST/RPC reads and writes. | Missed concurrent Supabase Realtime + PostgREST + Supavisor resource contention. |
| **7** | **Burst Duration vs. Sustained Sitting** | Ran for ~90 seconds total. | Real exams run for 15–60 minutes, accumulating dead MVCC tuples in `app_config`, `exam_draft_locks`, `proctor_audit_events`, and `security_rate_limits`, triggering autovacuum and draining Disk IO burst credits. | Missed sustained Disk IO / autovacuum / connection-pool exhaustion. |

---

## 2. Architecture of the Reality-Grounded Stress Test Harness

To test **like in reality**, we will build a two-layer stress test suite (`scripts/stress-test-realistic-exam-sitting.mjs` + optional Playwright multi-browser runner) that executes the **exact code paths, payload shapes, concurrency overlap, and teacher dashboard listeners** of a live 170–200 student exam sitting.

```mermaid
flowchart TD
    subgraph Actors["Concurrent Actors (Running Simultaneously)"]
        S["170–200 Virtual Student Runners\n(Exact StudentQuizRunner Lifecycle + Active WebSocket)"]
        T1["3 Live Invigilator Cockpits\n(LiveInvigilatorModal WebSocket + Audit Sync + Polling)"]
        T2["2 Teacher Gradebook / Results Watchers\n(QuizResultsModal postgres_changes + Auto-Grading)"]
    end

    subgraph Timeline["Realistic Exam Timeline (Configurable: 5-Min Fast Soak or 20-Min Full Soak)"]
        P1["Phase 1: Staggered & Burst Lobby Arrival\n(Boot queries + Name/Class typing draft probes + PIN verify + Begin Exam initial draft write)"]
        P2["Phase 2: Active Exam Sitting\n(12-18s WebSocket heartbeats + Answer edits + 12s/90s dirty-checked drafts + Tab-blur keepalive flushes + Proctor commands)"]
        P3["Phase 3: Mixed Submission Wave\n(30% early manual submitters + 70% timer-expiry 0-6s jittered auto-submit + clearExamDraft + Teacher live grading)"]
    end

    subgraphMonitor["Live Supabase Health & SLO Monitor"]
        M1["Continuous Health Probe every 2s\n(REST latency, RPC latency, HTTP 544/5xx/429 detector, Connection timeouts)"]
        M2["Strict Pass/Fail SLO Gate\n(Zero HTTP 544/5xx, 100% submission delivery, p95 submit < 5s, p95 draft < 1.5s)"]
    end

    Actors --> Timeline --> subgraphMonitor
```

---

## 3. Detailed Design of the Realistic Stress Test Plan

### 3.1 Actor Fidelity: Exact Network Signatures per Role

#### A. Student Virtual Client (`170` to `200` concurrent instances)
Each virtual student maintains its own isolated state, storage, draft lock token, and live Supabase Realtime WebSocket channel (`exam_proctor:<QUIZ_CODE>`), executing the **exact sequence of requests** triggered by [`src/App.tsx`](../src/App.tsx) and [`src/pages/StudentQuizRunner.tsx`](../src/pages/StudentQuizRunner.tsx):

1. **Boot & Lobby Mount (`T + 0..15s` arrival window, with a 80-student same-second classroom burst):**
   - `GET /rest/v1/teacher_profiles?select=*` (mirrors `TeacherProfileProvider` root mount — *until we gate it off student routes*)
   - `GET /rest/v1/app_config?select=value&key=eq.hide_creative_mode_landing`
   - `POST /rest/v1/rpc/get_student_exam_paper` (`{ p_code }`)
   - `GET /rest/v1/app_config?select=value&key=eq.security_tiers`
   - `GET /rest/v1/app_config?select=value&key=eq.school_classes`
   - `POST /rest/v1/rpc/get_public_roster_directory`
   - `GET /rest/v1/app_config?select=value&key=eq.hide_emergency_exam_button`
2. **Lobby Form Interaction (`2–3s` after mount):**
   - Simulates typing name & selecting class → fires `2` debounced `POST /rest/v1/rpc/get_student_exam_draft` calls (`600ms` apart) as in `StudentQuizRunner.tsx:3814-3829`.
3. **Click "Begin Exam Now":**
   - `POST /rest/v1/rpc/verify_student_pin` (when PIN mode is enabled or tested)
   - `POST /rest/v1/rpc/check_student_attempt_submitted`
   - **Immediate initial draft save**: `POST /rest/v1/rpc/save_student_exam_draft` (`StudentQuizRunner.tsx:4123`)
   - **WebSocket Connect**: Subscribes to `exam_proctor:<QUIZ_CODE>` and emits initial `student_heartbeat`.
4. **Mid-Exam Sitting Loop (Continuous while WebSocket stays open):**
   - **WebSocket Heartbeat**: Every `12–18s` (jittered) + reactive heartbeat (`400ms` after question navigation or answer change).
   - **Answer & Forensic Accumulation**: Every `20–45s`, student answers a question (MCQ, multi-select, data table, inline gap, or structured sub-question), appending realistic entries to `answerChangeLogs` and `questionTimeAnalytics`, and triggering the `12s` debounced `save_student_exam_draft` (with realistic **15 KB–35 KB** draft JSON payloads) plus the `90–110s` periodic check.
   - **Realistic Student Behaviors Across Cohorts**:
     - **70% Normal Students**: Answer questions steadily, navigate across Q1–Q10, open drawers.
     - **15% Tab-Switch / Blur / Fullscreen-Exit Students**: Trigger `visibilitychange` (`hidden`), firing **both** `keepalive` `save_student_exam_draft` (`StudentQuizRunner.tsx:3550`), WebSocket `proctor_log`, `POST /rest/v1/proctor_audit_events`, and after lock screen, `POST /rest/v1/rpc/verify_teacher_unlock_pin`.
     - **10% Unstable Wi-Fi / Page Reload Students**: Mid-exam browser refresh — re-runs the full Boot & Lobby Mount sequence, recovers draft via `get_student_exam_draft`, and reconnects WebSocket.
     - **5% Shared-Device / Homonym Students**: Same name in different classes (`X IPA 1` vs `X IPA 2`) and consecutive sittings on the same device.
5. **Exam Submission Wave (Realistic Full Payload + Post-Submit Cleanup):**
   - **30% Early Finishers**: Submit organically across the final 2 minutes of the exam.
   - **70% Timer-Expiry Auto-Submitters**: Hit `timeLeft <= 0` simultaneously, triggering the `0–6s` client jitter (`StudentQuizRunner.tsx:3728`), then executing:
     1. WebSocket `student_heartbeat` (`status: 'submitted'`) + WebSocket `proctor_log` (`type: 'submitted'`)
     2. `POST /rest/v1/rpc/submit_student_exam_attempt` with **full-size realistic payload** (complete 10-question `question_results` with sub-questions, `raw_answers._forensics` with 20+ `answerChangeLogs` & `questionTimeAnalytics`, `proctoring_logs`, `draft_key`, `draft_owner_token`)
     3. Retry loop matching `saveQuizSubmissionWithVerification` (`3` attempts with `1.2s / 2.2s / 3.9s` backoff if transient failure)
     4. Immediate `POST /rest/v1/rpc/delete_student_exam_draft` (`clearExamDraft` in `StudentQuizRunner.tsx:2750`).

#### B. Concurrent Teacher / Invigilator Virtual Clients (`3` Invigilators + `2` Results Watchers)
Running **at the same time** as the 200 students:
1. **3 Live Invigilator Cockpits (`LiveInvigilatorModal.tsx` simulation):**
   - Subscribed to `exam_proctor:<QUIZ_CODE>`.
   - On mount: calls `loadAndSyncSchoolClasses`, `loadAndSyncSchoolRoster`, `fetchProctorMonitoredSubmissions`, `loadProctorAuditEvents`, and `rpc('is_authenticated_teacher')` every `60s`.
   - On every incoming student `proctor_log` broadcast (violations AND `'submitted'` events): executes `recordProctorAuditEvent` (`POST /rest/v1/proctor_audit_events`) — **exposing the exact duplicate audit-insert storm that happens in production**.
   - Periodically sends `proctor_cmd` (`announcement`, `unlock`, `add_time`) over the channel.
2. **2 Live Gradebook / Results Modal Watchers (`QuizResultsModal.tsx` simulation):**
   - Subscribed to Supabase Realtime `postgres_changes` (`event: '*', schema: 'public', table: 'quiz_submissions'`).
   - On every `postgres_changes` notification: triggers `fetchSubmissionsFromSupabase` (`SELECT * FROM quiz_submissions WHERE quiz_code = ...`) and deterministic auto-grading `UPSERT`s — **reproducing the exact $O(N^2)$ cascading query storm when a teacher watches results come in live**.

---

### 3.2 Continuous Supabase Health & Bottleneck Telemetry Probe

During the entire test run, an independent **Health Probe** runs every **2.0 seconds** and records:
1. **Ping / Pooler Latency**: Lightweight RPC (`check_student_attempt_submitted`) & REST read latency (`p50`, `p95`, `p99`, `max`).
2. **Unhealthy Signal Detection**:
   - Any `HTTP 544` (`DatabaseTimeout`)
   - Any `HTTP 500 / 502 / 503 / 504` or Cloudflare `520–524`
   - Any `PGRST` pool acquisition timeout or client `AbortError` / `12s` timeout
   - Latency degradation curve over time (detecting when Disk IO burst credits or connection pool queue starts climbing *before* hard `544`s hit).
3. **Per-Phase Attribution**: Logs exact request concurrency in-flight (`inFlightByEndpoint`) at the exact second latency crosses `1,000 ms`, `3,000 ms`, or `10,000 ms`, so we see *which* query combination caused the bottleneck.

---

### 3.3 Strict Pass / Fail SLO Gates (No False "All Good" Reports)

The new stress test script will **fail with a non-zero exit code (`exit 1`)** if ANY of the following production SLOs are breached:

| Metric | Strict Production Target (170–200 Students + 5 Teachers) | Earlier Wave 3 Actual (Why It Was Unhealthy) |
| :--- | :--- | :--- |
| **HTTP `544` / `5xx` / Timeout Rate** | **`0.0%`** (Zero `544` or `5xx` across all phases) | Timed out / failed 69 rows |
| **First-Wave Submission Success (within 3 retries)** | **`100.0%`** (`200/200` verified in `quiz_submissions`) | `131/200` (`65.5%`) |
| **`submit_student_exam_attempt` Latency** | **`p50 < 1,200 ms`, `p95 < 4,500 ms`, `max < 8,000 ms`** | `p50 = 57,328 ms`, `max = 65,453 ms` |
| **`get_student_exam_paper` Lobby Latency** | **`p50 < 600 ms`, `p95 < 2,000 ms`** | `p50 = 2,176 ms`, `max = 2,360 ms` |
| **`save_student_exam_draft` Latency** | **`p50 < 400 ms`, `p95 < 1,500 ms`** | `p50 = 168 ms` (with tiny payload, no teachers) |
| **Health Probe Max Ping During Storm** | **`< 3,000 ms`** at all times | Spiked `> 60,000 ms` during Wave 3 |
| **Post-Submit Draft Cleanup** | **`100%` of submitted drafts removed** | `187` draft locks left behind |

---

## 4. Newly Discovered Bottlenecks We Must Fix Alongside the Stress Test

By auditing the real browser code path to design this stress test, we uncovered **5 additional production bottlenecks** that were NOT fixed in Migrations `031`–`032` and directly explain why your live stress test still made Supabase unhealthy:

1. **Bottleneck A — `submit_student_exam_attempt` + Immediate `delete_student_exam_draft` Double-Transaction & Full Table Scans (`Migration 031`):**
   - Look at [`Plan/student_200_stress_test_report.md`](student_200_stress_test_report.md#L23): 200 concurrent submissions took **65 seconds**!
   - Why?
     1. Every student calls `submit_student_exam_attempt` **and then immediately fires a second RPC** `delete_student_exam_draft` (`StudentQuizRunner.tsx:2750`), doubling the RPC connection count during the submission stampede (400 RPCs for 200 students!). **Fix**: Delete the draft (`app_config` + `exam_draft_locks`) **inside** `submit_student_exam_attempt` in the same transaction so the client doesn't need a second cloud RPC call after a successful submit!
     2. Inside `submit_student_exam_attempt` (`Migration 031:208-235`), if `quiz_by_code_<CODE>` isn't matched (or for synthetic/legacy codes), it falls back to `SELECT value FROM app_config WHERE key = 'published_quizzes'` and runs `jsonb_array_elements` on the entire school's published quizzes blob on every submission! **Fix**: Read quiz metadata from `exam_paper_cache` first (already parsed JSONB, tiny 1-row PK lookup), then `quiz_by_code_<CODE>`.
     3. Inside `submit_student_exam_attempt` (`Migration 031:300-318`) and `check_student_attempt_submitted` (`Migration 031:129-145`), the query uses `LOWER(REGEXP_REPLACE(TRIM(COALESCE(s.student_name, '')), '\s+', ' ', 'g')) = v_name`, whereas `idx_quiz_submissions_attempt_class_lookup` (`Migration 031:33-38`) was indexed on `LOWER(TRIM(student_name))` **without** `REGEXP_REPLACE`! Because the SQL `WHERE` clause wraps `student_name` in `REGEXP_REPLACE(...)`, **Postgres CANNOT use `idx_quiz_submissions_attempt_class_lookup` and performs a sequential scan of `quiz_submissions` on every single lobby check and every single submission!**

2. **Bottleneck B — `LiveInvigilatorModal` Duplicate Audit DB Insert Storm (`LiveInvigilatorModal.tsx:682` + `StudentQuizRunner.tsx:2545`):**
   - When a student logs a violation (`StudentQuizRunner.tsx:1107`), the student already inserts into `proctor_audit_events`. When `LiveInvigilatorModal.tsx:682` receives that broadcast over WebSocket, it *also* calls `recordProctorAuditEvent()`!
   - Worse: when 170 students submit at the end of the exam, `StudentQuizRunner.tsx:2545` calls `sendStudentViolation(..., { type: 'submitted', ... })`, causing every open `LiveInvigilatorModal` to fire **170 `POST /rest/v1/proctor_audit_events` DB writes** right in the middle of the submission wave!
   - **Fix**: Remove duplicate student-event DB writes from `LiveInvigilatorModal.tsx:682` (the student client already persists its own violation audit events, and submissions are already stored in `quiz_submissions`), and don't insert `'submitted'` broadcast notifications into `proctor_audit_events`.

3. **Bottleneck C — `QuizResultsModal` $O(N^2)$ `postgres_changes` Full-Table Fetch & Auto-Grade Re-Upsert Loop (`QuizResultsModal.tsx:262-407`):**
   - When a teacher has `QuizResultsModal` open while students are submitting, every single student `INSERT` triggers `postgres_changes` → `refreshSubmissions()` immediately (with zero debounce!) → `SELECT * FROM quiz_submissions` → auto-grades deterministic questions → `UPSERT`s back to `quiz_submissions` → triggers another `postgres_changes`!
   - **Fix**:
     1. Debounce `postgres_changes` in `QuizResultsModal.tsx` by `3,000–5,000 ms` (coalescing bursts of student submissions into a single fetch after the wave settles).
     2. During an active submission burst, compute deterministic scores in-memory for display first and batch-persist any auto-graded updates cleanly rather than firing 170 recursive `UPSERT`s per incoming row.

4. **Bottleneck D — Unnecessary Student Boot & Lobby Queries (`App.tsx:1073`, `StudentQuizRunner.tsx:471-480, 1043, 3805`):**
   - `TeacherProfileProvider` (`TeacherProfileContext.tsx:48`) runs `fetchTeacherProfiles()` (`SELECT * FROM teacher_profiles`) on page load even when `appMode === 'student_quiz'` or `'portal'` without a teacher session!
   - `StudentQuizRunner` fires 3 separate `app_config` queries on mount (`school_classes`, `security_tiers`, `hide_emergency_exam_button`) + `get_public_roster_directory` without a `sessionStorage` TTL cache, AND `get_student_exam_paper` already has access to `app_config`!
   - Lobby draft detection (`StudentQuizRunner.tsx:3814`) fires `get_student_exam_draft` to Supabase while the student is still typing their name before both `candidateName` and `candidateClass` are selected (and even on a fresh device that has never started an exam).
   - **Fix**:
     1. Skip `fetchTeacherProfiles()` when there is no active teacher session (`!hasActiveTeacherSession()`).
     2. Bundle `schoolClasses`, `securityTiers`, and `hideEmergencyExamButton` directly into the cached `get_student_exam_paper` payload (or cache them in `sessionStorage` for 10 minutes), eliminating **4 separate DB queries per student on page load**!
     3. Increase lobby draft-check debounce to `1,200 ms` + jitter, and only query cloud `get_student_exam_draft` after both `candidateName` (≥3 chars) and `candidateClass` are selected.

5. **Bottleneck E — `keepalive` Draft Flush Ignoring Circuit-Breaker Backoff (`examDraftService.ts:209`):**
   - In `examDraftService.ts:209`, `if (!options?.keepalive && !options?.force)` skips the `draftCloudBackoffByKey` check when `keepalive: true` (which fires on every `visibilitychange` hidden event).
   - **Fix**: Respect `draftCloudBackoffByKey` on `keepalive` flushes too when the database is in a `544` backoff window (local `localStorage` + `sessionStorage` are already flushed synchronously on line 203).

---

## 5. Step-by-Step Execution Roadmap

1. **Step 1 — Build the Realistic Full-Fidelity Stress Test Harness (`scripts/stress-test-realistic-exam-sitting.mjs`)**:
   - Implement the 3-role concurrent simulator (**170–200 Student Virtual Browsers** + **3 Live Invigilator Cockpits** + **2 Teacher Results Watchers** + **2s Continuous Health Probe**).
   - Include two execution modes:
     - `--mode=fast-realistic` (~3 minutes: 15s staggered/burst lobby arrival → 90s compressed realistic exam sitting with WebSockets, answer edits, tab switches, mid-exam reloads, and teacher dashboards → mixed early + 0–6s jittered timer-expiry submission wave with full 25 KB forensic payloads).
     - `--mode=soak` (~15–20 minutes: real-time cadence for full Disk IO & MVCC soak testing).
   - Enforce strict pass/fail SLO gates (`exit 1` on any `544`/`5xx` or p95 breach) and auto-clean all test artifacts in `finally`.
2. **Step 2 — Run Baseline Stress Test Against Live Supabase to Reproduce & Measure the Bottleneck**:
   - Run the new realistic harness (starting at 50 → 100 → 170–200 students) to capture the exact baseline failure telemetry.
3. **Step 3 — Apply Fixes for Bottlenecks A–E (Migration `034` + Client Hardening)**:
   - Fix the `REGEXP_REPLACE` index mismatch on `quiz_submissions`, fold draft deletion into `submit_student_exam_attempt`, read quiz metadata from `exam_paper_cache`, eliminate duplicate audit writes in `LiveInvigilatorModal`, debounce `QuizResultsModal` `postgres_changes`, and eliminate redundant student boot queries.
4. **Step 4 — Re-Run the Realistic Stress Test Harness at 170 & 200 Concurrent Students + 5 Teachers**:
   - Verify `0` HTTP `544`/`5xx` errors, `100%` submission completion, flat health-probe ping (`< 1.5s`), and `0` leftover draft locks.

---

## 6. Empirical Results: Baseline Failure Reproduction vs. Post-Fix + Migration `036` Verification

Following implementation of the client hardening fixes (`StudentQuizRunner.tsx`, `quizCodeService.ts`, `examDraftService.ts`, `studentRosterService.ts`, `settings.ts`, `proctorAuditLogService.ts`, `LiveInvigilatorModal.tsx`, `QuizResultsModal.tsx`) and live execution of `supabase/migrations/036_icm_multi_exam_scale_and_roster_cache.sql` on Supabase:

| Metric / SLO Gate | Baseline Pre-Fix (`mwol9sht`) | Post-Fix + Migration `036` (`mwoo886j`) | Verdict |
| :--- | :---: | :---: | :---: |
| **SLO-1: HTTP 544 / 5xx / Client Timeouts** | **242** timeouts (`35/220` failed paper loads) | **0 errors** across all requests | ✅ **PASS** |
| **SLO-2: Final Exam Submission Delivery** | Degraded under 544 queue | **200/200 (100.0%)** — 200 1st try, 0 retried | ✅ **PASS** |
| **SLO-3: `submit_student_exam_attempt` (~21.6 KB)** | `p50 = 5,246ms`, `p95 = 6,219ms` | **`p50 = 151.3ms`**, **`p95 = 406.1ms`**, `max = 596.5ms` | ✅ **PASS** |
| **SLO-4: `get_student_exam_paper` (`ICM-1`..`13`)** | `p50 = 7,457ms`, `p95 = 11,514ms` | **`p50 = 234.0ms`**, **`p95 = 393.2ms`**, `max = 496.1ms` | ✅ **PASS** |
| **SLO-5: Periodic `save_student_exam_draft`** | High timeout / backoff contention | **600/600 ok**, **`p50 = 117.5ms`**, **`p95 = 199.9ms`** | ✅ **PASS** |
| **SLO-6: Continuous 2s Health Probe (`> 3,000ms`)** | Sustained boot & submit degradation | **0/24 degraded ticks** (rpc `p95 = 208.1ms`, rest `p95 = 286.9ms`) | ✅ **PASS** |
| **Peak In-Flight HTTP Requests** | **1,411** | **200** (`25` during Phase 1A boot) | ✅ Reduced 86% |
| **Duplicate Invigilator Audit DB Inserts** | **250** | **0** | ✅ Eliminated |
| **Post-Submit Draft Locks Cleaned Inline** | Separate RPC storm after submit | **200/200** (`0` separate `delete_student_exam_draft` RPCs) | ✅ Atomic SQL |

Full latest run breakdown is archived in [realistic_stress_test_report.md](file:///C:/testmaker/Plan/realistic_stress_test_report.md).

