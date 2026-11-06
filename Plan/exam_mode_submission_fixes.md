# Exam Mode Submission & Grading Pipeline: Findings, Remediation & Testing Plan

> **Audit Reference**: [`Plan/exam_mode_submission_review.md`](file:///c:/testmaker/Plan/exam_mode_submission_review.md)
> **Primary Targets**:
> - [`src/pages/StudentQuizRunner.tsx`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx)
> - [`src/components/QuizResultsModal.tsx`](file:///c:/testmaker/src/components/QuizResultsModal.tsx)
> - [`src/services/quizSubmissionService.ts`](file:///c:/testmaker/src/services/quizSubmissionService.ts)
> - [`src/services/examDraftService.ts`](file:///c:/testmaker/src/services/examDraftService.ts)
> - [`src/services/quizCodeService.ts`](file:///c:/testmaker/src/services/quizCodeService.ts)
> - [`supabase/migrations/019_exam_submission_security_rpcs.sql`](file:///c:/testmaker/supabase/migrations/019_exam_submission_security_rpcs.sql) *(Proposed)*

---

## 1. Executive Summary & Architectural Fit

An audit of the Exam Mode submission, draft recovery, grading, and result-lookup pipeline confirmed **16 active functional and security defects** across the student runner, teacher grading modal, and Supabase persistence layer.

### Architectural Adaptation for TestMaker
Section 8 of [`Plan/exam_mode_submission_review.md`](file:///c:/testmaker/Plan/exam_mode_submission_review.md) proposes moving grading to a server-side worker / Supabase Edge Function. However, TestMaker is deployed as a **static Vite SPA on Cloudflare Pages backed by Supabase Free Tier** with:
1. **Zero Edge Functions** currently in the repository.
2. **2,100+ lines of browser-native TypeScript grading logic** ([`deterministicGradingService.ts`](file:///c:/testmaker/src/services/deterministicGradingService.ts) + [`studentEvaluationService.ts`](file:///c:/testmaker/src/services/studentEvaluationService.ts)) that relies on the teacher's browser-configured Gemini API keys.

Therefore, the remediation architecture separates **Candidate Boundary Security** from **Teacher-Side Evaluation**:
- **Candidate Boundary Security (`SECURITY DEFINER` Postgres RPCs)**: All candidate-facing trust boundaries—PIN verification, single-attempt enforcement, exam payload sanitization, and result lookup—move behind narrow `SECURITY DEFINER` Postgres RPCs (following the established pattern in [`010_verify_student_pin.sql`](file:///c:/testmaker/supabase/migrations/010_verify_student_pin.sql)).
- **Teacher-Browser Grading Engine**: Deterministic and Gemini AI grading remain in [`QuizResultsModal.tsx`](file:///c:/testmaker/src/components/QuizResultsModal.tsx), hardened so deterministic re-grading never overwrites AI/manual scores on structured questions, and candidate submissions are stored with stable question-ID maps and grading provenance.

---

## 2. Verified Findings Matrix

| ID | Severity | Location | Verified Root Cause | Impact |
| :--- | :--- | :--- | :--- | :--- |
| **H1** | **P0 Blocker** | [`StudentQuizRunner.tsx:2516-2527`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L2516-L2527) | `checkStudentAttemptSubmitted()` returns `{ submitted: boolean }`, an object that is **always truthy**. Line 2522 checks `if (alreadySubmitted)` instead of `if (alreadySubmitted.submitted)`. | Every student attempting to resume a crashed/reloaded exam is blocked (`"You have already submitted..."`) and their draft is wiped. |
| **C5** | **P0 Data Loss** | [`QuizResultsModal.tsx:530-585`](file:///c:/testmaker/src/components/QuizResultsModal.tsx#L530-L585) | `handleRegradeAllDeterministic()` calls `gradeDeterministicAnswer()`, which returns `{ isHandled: false, earnedMarks: 0 }` for multi-mark structured/essay questions. Lines 547 & 570 ignore `det.isHandled` and unconditionally overwrite `earnedMarks` with `0`. | Clicking **"Re-grade All"** destroys all AI-graded and manually adjusted marks on non-deterministic questions in both `localStorage` and Supabase. |
| **H2** | **P1 High** | [`StudentQuizRunner.tsx:2547-2555`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L2547-L2555) | `handleResumeDraft()` ignores `detectedDraft.targetEndTime` and sets `targetEndTime = Date.now() + remaining * 1000` using a snapshot up to 50s stale. | Candidates can extend/rewind their exam timer by reloading or keeping the tab closed between 50s cloud draft snapshots. |
| **M3** | **P1 High** | [`StudentQuizRunner.tsx:2323, 2650`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L2323) & [`examDraftService.ts:98-101`](file:///c:/testmaker/src/services/examDraftService.ts#L98-L101) | Initial draft save uses `quizId: resolvedTestId` (`:2650`), while periodic 50s saves use `resolvedPublishedId \|\| resolvedTestId \|\| testIdOrCode` (`:2323`). `fetchExamDraft` returns `null` immediately on local `quizId` mismatch without checking the cloud fallback. | Local draft recovery fails when `resolvedPublishedId !== resolvedTestId`, and cloud fallback is skipped. |
| **H4** | **P1 High** | [`quizSubmissionService.ts:48-50, 213-237, 692`](file:///c:/testmaker/src/services/quizSubmissionService.ts#L48-L50) | After 3 inline retries fail on submit, outbox status is set to `'failed'` (`:692`). `getPendingOutboxSubmissions()` (`:49`) only queries `status === 'pending'`. | Submissions that fail during an exam-end Wi-Fi drop are permanently orphaned in `localStorage` and never retried on reconnect. |
| **H5** | **P1 High** | [`quizSubmissionService.ts:640-652`](file:///c:/testmaker/src/services/quizSubmissionService.ts#L640-L652) | Every student submission reads, modifies, and writes the entire `app_config['quiz_submissions']` JSON array and calls `markOutboxSynced()` (`:648`) even if `quiz_submissions` table insert (`tableSuccess`) failed. | Concurrent end-of-exam submissions overwrite each other in `app_config`, and a failed table insert is prematurely marked synced. |
| **C2** | **P1 Security** | [`quizCodeService.ts:178-206, 347-387`](file:///c:/testmaker/src/services/quizCodeService.ts#L178-L206) | `resolveStudentQuiz()` sends full `Question` objects (`mark_scheme`, `acceptable_answers`, `guidance`) and `teacherPin` (defaulting to `'1234'`) to the student client during active Exam Mode. | Any student opening DevTools can read the full mark scheme and the teacher unlock PIN. |
| **C3** | **P1 Privacy** | [`quizSubmissionService.ts:1098-1192`](file:///c:/testmaker/src/services/quizSubmissionService.ts#L1098-L1192) | `lookupStudentResults()` queries `.select('*').eq('quiz_code', cleanCode)` (all cohort rows + `result_pin`s) and filters client-side; fallback at `:1168` calls `loadAndSyncAllSubmissions()`, downloading **all school submissions** into student `localStorage`. | Exposes classmates' grades, answers, forensics, and result PINs to any student looking up results. |
| **C1 / H6** | **P2 Security** | [`StudentQuizRunner.tsx:1770-1859`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L1770-L1859) & [`examDraftService.ts:186-195`](file:///c:/testmaker/src/services/examDraftService.ts#L186-L195) | Exam Mode sets `score: 0` at submit, but direct table `INSERT` allows custom `status`/`score`. `checkStudentAttemptSubmitted` fetches `.limit(100)` rows and matches names in JS. | In classes >100 attempts, single-attempt checks truncate; direct PostgREST inserts can spoof scores or duplicate attempts. |
| **H7** | **P2 Data Integrity** | [`StudentQuizRunner.tsx:1671-1755`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L1671-L1755) & [`QuizResultsModal.tsx:534-580`](file:///c:/testmaker/src/components/QuizResultsModal.tsx#L534-L580) | `rawAnswers` and `answers` key responses by positional index (`0`, `1`, `0_0`). | Reordering or deleting a question in a published test shifts answer alignment during re-grade. |
| **H8** | **P2 Privacy** | [`StudentQuizRunner.tsx:347, 2245-2316`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L347) | `sessionKey = exam_sess_${testIdOrCode}` is not scoped by student name/ID, and is not cleared when a new student starts on the same browser. | On shared school laptops, Student B can inherit Student A's answers, timer, or violation counter. |
| **M1** | **P2 Analytics** | [`QuizResultsModal.tsx:655-681`](file:///c:/testmaker/src/components/QuizResultsModal.tsx#L655-L681) | `analytics` computes `avgScore`, `highest`, `lowest`, and `gradeDist` across all `filteredSubmissions` regardless of `sub.status`. | Un-graded Exam Mode submissions (`status === 'submitted'`, provisional `0` marks on structured questions) drag down class averages and skew grade distributions. |
| **M2** | **P2 Crash** | [`StudentQuizRunner.tsx:1863-1867, 3962`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L1863-L1867) | If `handleSubmitExam` catches an unexpected error before `setCompletedSubmission`, `setIsSubmitted(true)` still fires while `completedSubmission` is `null`. | Results view crashes with `TypeError: Cannot read properties of null (reading 'submittedAt')` at line 3962. |
| **M4** | **P3 Perf** | [`StudentQuizRunner.tsx:2245-2316`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L2245-L2316) | `useEffect` serializes `answers`, `questionTimings`, and `confidenceLevels` to `localStorage` synchronously on every keystroke. | Causes main-thread input lag on long essay responses and low-end school Chromebooks. |
| **M7 / M8** | **P3 Integrity** | [`StudentQuizRunner.tsx:1671`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L1671) & [`quizSubmissionService.ts:624`](file:///c:/testmaker/src/services/quizSubmissionService.ts#L624) | `totalMarks` is client-computed and `gradingPending` is derived solely from `status === 'submitted' && score === 0`. | An exam where a candidate scores `0` on MCQs and has no structured questions appears `gradingPending`, while mixed MCQ + structured papers with `score > 0` do not flag ungraded structured items clearly. |

---

## 3. Phased Implementation Plan

### Pass 1: Immediate Client Bug, Data-Loss & Resilience Fixes (Zero Schema Dependencies)

#### 1.1 Fix Broken Exam Resume (`H1`) & Timer Rewind / Draft Key Mismatch (`H2`, `M3`)
- **File**: [`src/pages/StudentQuizRunner.tsx`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx) & [`src/services/examDraftService.ts`](file:///c:/testmaker/src/services/examDraftService.ts)
- **Changes**:
  1. In [`StudentQuizRunner.tsx:2522`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L2522), change `if (alreadySubmitted)` to `if (alreadySubmitted.submitted)`.
  2. Define a single canonical helper `const effectiveDraftQuizId = resolvedPublishedId || resolvedTestId || testIdOrCode || '';` and use it consistently in:
     - `handleStart()` initial draft creation (`:2650`)
     - Periodic 50s cloud draft sync (`:2323`)
     - `fetchExamDraft()` and `clearExamDraft()` (`:1844, :2532`)
  3. In [`examDraftService.ts:98-105`](file:///c:/testmaker/src/services/examDraftService.ts#L98-L105), if the local storage draft has a mismatched `quizId`, log a warning and **fall through to the Supabase cloud draft lookup** instead of returning `null`.
  4. In `handleResumeDraft()` ([`StudentQuizRunner.tsx:2547-2555`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L2547-L2555)), compute the remaining time authoritatively from `detectedDraft.targetEndTime` when present:
     ```ts
     const now = Date.now();
     const remainingFromDeadline = detectedDraft.targetEndTime
       ? Math.max(0, Math.floor((detectedDraft.targetEndTime - now) / 1000))
       : (detectedDraft.timeLeftSeconds ?? ((quizConfig?.timerMinutes || 30) * 60));
     const effectiveEndTime = detectedDraft.targetEndTime || (now + remainingFromDeadline * 1000);
     setTimeLeft(remainingFromDeadline);
     setTargetEndTime(effectiveEndTime);
     ```
     If `remainingFromDeadline <= 0` when resuming, immediately transition to auto-submit (`handleSubmitExam(true)`).

#### 1.2 Preserve AI & Teacher Marks During Deterministic Re-Grade (`C5`, `H7`)
- **File**: [`src/components/QuizResultsModal.tsx`](file:///c:/testmaker/src/components/QuizResultsModal.tsx) & [`src/pages/StudentQuizRunner.tsx`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx)
- **Changes**:
  1. In [`QuizResultsModal.tsx:530-585`](file:///c:/testmaker/src/components/QuizResultsModal.tsx#L530-L585) (`handleRegradeAllDeterministic`):
     - Check `det.isHandled` before updating `earnedMarks` and `isCorrect`.
     - When `det.isHandled === false` (structured, essay, or AI-evaluated sub-questions), **preserve the existing `ans.earnedMarks`, `ans.isCorrect`, `ans.aiFeedback`, and `ans.gradingSource`** (`'ai' | 'manual' | 'pending'`).
     - Only recalculate `newScore` as the sum of updated deterministic `earnedMarks` + preserved non-deterministic `earnedMarks`.
  2. In [`StudentQuizRunner.tsx:1671-1755`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L1671-L1755), populate `questionId: q.id` and `subQuestionId: sq.id` on every `StudentQuestionAnswer` entry and store an ID-keyed lookup inside `_forensics.answersByQuestionId` so `handleRegradeAllDeterministic` matches by `(questionId, subQuestionId)` first and falls back to positional index only for legacy rows.

#### 1.3 Harden Submission Outbox & Eliminate `app_config` Race Condition (`H4`, `H5`, `C3` Client Fallback)
- **File**: [`src/services/quizSubmissionService.ts`](file:///c:/testmaker/src/services/quizSubmissionService.ts)
- **Changes**:
  1. **Outbox Recovery (`H4`)**:
     - Update `getPendingOutboxSubmissions()` (`:48-50`) to return entries where `status === 'pending' || (status === 'failed' && attempts < 10)`.
     - Add exponential backoff check in `flushSubmissionOutbox()` (`:213-237`) so `'failed'` items retry automatically on browser `online` events,runner mount, and teacher dashboard sync.
  2. **Stop Student-Side `app_config` Clobbering (`H5`)**:
     - In `submitQuizAttempt()` (`:640-652`), remove the student-side read-modify-write of `app_config['quiz_submissions']` when `tableSuccess === true` (the `quiz_submissions` table is already the primary store).
     - Only call `markOutboxSynced(submission.id)` when `tableSuccess === true`. If `tableSuccess === false`, keep the item in the outbox as `'pending'` so it retries cleanly into `quiz_submissions`.
  3. **Remove Whole-School Download from Student Result Lookup (`C3` Immediate Fix)**:
     - In `lookupStudentResults()` (`:1168`), remove the call to `loadAndSyncAllSubmissions()` so a student browser never downloads school-wide submissions into `localStorage`.

#### 1.4 Shared-Device Session Isolation (`H8`), Analytics Filtering (`M1`), Crash Guard (`M2`), and Debounced Autosave (`M4`)
- **Files**: [`src/pages/StudentQuizRunner.tsx`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx), [`src/components/QuizResultsModal.tsx`](file:///c:/testmaker/src/components/QuizResultsModal.tsx)
- **Changes**:
  1. **Candidate-Scoped Session Storage (`H8`)**:
     - When `handleStart()` begins a new attempt (`:2560`), if an existing `localStorage.getItem(sessionKey)` belongs to a different `(studentName, studentNumber)`, overwrite and reset `answers`, `flagged`, `questionTimings`, `confidenceLevels`, and `violations` before starting.
  2. **Separate Ungraded Attempts from Finalized Analytics (`M1`)**:
     - In [`QuizResultsModal.tsx:655-681`](file:///c:/testmaker/src/components/QuizResultsModal.tsx#L655-L681), compute `avgScore`, `highest`, `lowest`, and `gradeDist` over `gradedSubmissions` (`status === 'graded' || status === 'published'`), while surfacing a separate `pendingGradingCount` badge when ungraded `status === 'submitted'` rows exist. Let it fall back to all submissions only if zero rows are graded yet, with a visible `"Provisional (Pending AI/Teacher Grading)"` indicator.
  3. **Null-Safe Result Screen (`M2`)**:
     - In `handleSubmitExam()` (`:1863-1867`), construct a local fallback `QuizSubmission` object if `submitQuizAttempt` throws unexpectedly so `completedSubmission` is always populated when `isSubmitted` becomes `true`, and guard `completedSubmission?.submittedAt` at `:3962`.
  4. **Debounced `localStorage` Autosave (`M4`)**:
     - Debounce the `localStorage.setItem(sessionKey, ...)` effect in [`StudentQuizRunner.tsx:2245-2316`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L2245-L2316) by `400ms`, paired with an immediate synchronous flush on `visibilitychange` (`hidden`) and `pagehide`.

---

### Pass 2: Server-Side Trust Boundaries via `SECURITY DEFINER` RPCs

To resolve **C1, C2, C3, and H6** without introducing Edge Functions, we will add migration [`supabase/migrations/019_exam_submission_security_rpcs.sql`](file:///c:/testmaker/supabase/migrations/019_exam_submission_security_rpcs.sql):

#### 2.1 Strip Answer Keys & `teacherPin` from Candidate Payload (`C2`)
- **File**: [`src/services/quizCodeService.ts`](file:///c:/testmaker/src/services/quizCodeService.ts)
- **Changes**:
  1. Create a sanitizer `sanitizeQuestionsForStudent(questions: Question[], isExamMode: boolean, showInstantSolutions: boolean): Question[]` in `quizCodeService.ts`.
  2. When `isExamMode && !showInstantSolutions`, strip `mark_scheme`, `guidance`, `acceptable_answers`, and sub-question `mark_scheme` / `acceptable_answers` before returning the `StudentQuizConfig` to the runner.
  3. Remove `teacherPin` from the candidate-side `StudentQuizConfig` payload (or replace with `hasTeacherPin: boolean`), and verify unlock PINs via RPC `verify_teacher_unlock_pin(p_quiz_code text, p_pin text) RETURNS boolean` (with offline fallback to a SHA-256 salted digest rather than plaintext).

#### 2.2 Isolated Student Result Lookup RPC (`C3`)
- **Migration**: `lookup_student_exam_result(p_quiz_code text, p_student_query text, p_result_pin text)`
- **Behavior**:
  - `SECURITY DEFINER` Postgres function that queries `public.quiz_submissions` where `UPPER(quiz_code) = UPPER(p_quiz_code)`, matches `LOWER(student_name) = LOWER(p_student_query)` or `LOWER(student_number) = LOWER(p_student_query)`, verifies `result_pin = UPPER(TRIM(p_result_pin))`, and requires `status = 'published'` (or non-exam mode).
  - Returns **only** the single matched submission row—never exposing classmates' rows or `result_pin` values over the wire.
  - Update `lookupStudentResults()` in [`src/services/quizSubmissionService.ts:1098`](file:///c:/testmaker/src/services/quizSubmissionService.ts#L1098) to call `supabase.rpc('lookup_student_exam_result', ...)` first.

#### 2.3 Exact Single-Attempt Check & Server Timestamp / Duplicate Guard (`C1`, `H6`)
- **Migration & Service**:
  - Replace the `.limit(100)` client-filtered query in [`examDraftService.ts:186-195`](file:///c:/testmaker/src/services/examDraftService.ts#L186-L195) with an exact server-side query / RPC `check_student_attempt_submitted(p_quiz_code text, p_student_name text, p_student_number text)` using case-insensitive indexed predicates (`ILIKE` / `LOWER(TRIM(...))`) with no 100-row cap.
  - Add a partial unique index or RPC check preventing duplicate `quiz_submissions` rows for the same `(UPPER(quiz_code), LOWER(TRIM(student_name)), COALESCE(LOWER(TRIM(student_number)), ''))` when `limit_one_attempt` is active on the parent `published_quizzes` row.

---

## 4. Testing & Verification Plan

We will create an automated verification suite at [`scripts/test-exam-submission-fixes.mjs`](file:///c:/testmaker/scripts/test-exam-submission-fixes.mjs) and run all existing regression suites before and after implementation.

### 4.1 Automated Test Suite (`scripts/test-exam-submission-fixes.mjs`)

| Test ID | Target Defect | Assertion / Scenario |
| :--- | :--- | :--- |
| **T1** | **H1** — Resume Check Object Unwrap | Simulate `checkStudentAttemptSubmitted()` returning `{ submitted: false }`. Assert that `StudentQuizRunner` preserves `detectedDraft` and opens the Resume modal instead of blocking with `"already submitted"`. |
| **T2** | **H1** — Legitimate Block When Submitted | Simulate `checkStudentAttemptSubmitted()` returning `{ submitted: true, submissionId: 'sub-1' }`. Assert that `StudentQuizRunner` blocks re-entry and clears the draft. |
| **T3** | **H2 & M3** — Deadline Preservation & Draft Key Unification | Save a draft with `targetEndTime = now + 600_000` and `timeLeftSeconds = 600`. Advance simulated clock by `120_000ms` (2 min). Resume draft and assert `timeLeft === 480` (not `600`) and `effectiveDraftQuizId` matches across initial and periodic saves. |
| **T4** | **C5** — Deterministic Re-Grade Preserves AI/Manual Marks | Create a mixed submission with 1 MCQ (`1/1` mark) and 1 structured 6-mark question graded by AI (`5/6` marks, `isHandled: false` in `gradeDeterministicAnswer`). Run the `handleRegradeAllDeterministic` logic and assert total score remains `6/7` (`5/6` preserved on structured question) instead of dropping to `1/7`. |
| **T5** | **H7** — Question-ID Keyed Re-Grade Resilience | Reorder the questions array `[Q2, Q1]` after a student submits answers keyed with `questionId`. Run deterministic re-grading and assert answers match `Q1` and `Q2` by `questionId` rather than mismatched array indices. |
| **T6** | **H4 & H5** — Failed Outbox Retry & Synced Flag Accuracy | Simulate a submission where all 3 inline retries fail (`status: 'failed'`). Trigger `flushSubmissionOutbox()` when connection restores and assert the `'failed'` entry is picked up, synced to `quiz_submissions`, and never marked synced while `tableSuccess === false`. |
| **T7** | **C2** — Exam Mode Payload Sanitization | Call `sanitizeQuestionsForStudent(questions, true, false)` on questions containing `mark_scheme`, `guidance`, and `acceptable_answers`. Assert all answer-key fields and plaintext `teacherPin` are stripped from the returned student config, while preserved when `isExamMode === false`. |
| **T8** | **C3** — Isolated Student Result Lookup | Verify `lookupStudentResults()` calls the scoped RPC / filtered query and never invokes `loadAndSyncAllSubmissions()` or writes cohort submissions into `localStorage`. |
| **T9** | **H8** — Shared-Device Session Isolation | Populate `exam_sess_CODE` for Student A (`Alice`, `001`). Start an exam on the same browser as Student B (`Bob`, `002`) and assert Alice's answers, timings, and violations are purged before Bob's runner mounts. |
| **T10** | **M1 & M2** — Analytics Status Filter & Null Submission Guard | Pass 2 graded submissions (`80%`, `90%`) and 2 ungraded `submitted` Exam Mode submissions (`0%` provisional) into the analytics reducer; assert class average reports `85%` with `pendingGradingCount === 2`. Verify result screen renders safely when `completedSubmission` uses fallback metadata. |

### 4.2 Build & Regression Commands
1. `node scripts/test-exam-submission-fixes.mjs` — **10/10 PASS** required.
2. `node scripts/test-proctor-p1-p2-p3.mjs` — Verify zero regressions in proctoring security & reconciliation.
3. `npm.cmd run build` (`tsc -b && vite build`) — Verify zero TypeScript compilation or bundle errors.

---

## 5. Implementation Status (2026-11-06)

### Pass 1 — complete
- **H1** — resume now unwraps the attempt result via `didSubmitAttempt()`; `if (alreadySubmitted)` is gone.
- **H2/M3** — `resolveResumeClock()` derives the deadline from `targetEndTime` (or `startTime + duration` for legacy drafts); one `effectiveDraftQuizId` is used by the initial save, the 50 s sync, resume lookup and clear; a local quiz-id mismatch now falls through to the cloud draft.
- **C5** — `chooseRegradeMarks()` preserves AI/manual marks for `isHandled: false` answers; the re-grade summary reports how many marks were preserved and does not mark a paper `graded` while descriptive parts are still pending.
- **H7** — submissions carry `_forensics.answersByQuestionId`; both batch AI and deterministic re-grade resolve answers by `questionId`/`subId` first and positional keys only for legacy rows.
- **H4** — failed outbox items are retried with exponential backoff (15 s → 30 min, max 10 attempts); pruning never drops unsynced papers.
- **H5** — the `app_config` mirror is only written when the table write failed; only a table success marks the outbox synced.
- **C3 (client)** — the student result path no longer calls `loadAndSyncAllSubmissions()`; the fallback is scoped to the candidate's rows and then to local storage.
- **H8** — a foreign sitting on a shared device is purged (answers, timings, forensics, strikes, receipt) before the next candidate starts.
- **M1** — class KPIs average graded/published rows only, with a separate pending count and a provisional label when nothing is graded yet.
- **M2** — a null `completedSubmission` renders a safe "Attempt Closed" receipt; the submit catch now builds a local fallback submission.
- **M4** — session persistence is debounced by 400 ms with an immediate `pagehide` / `visibilitychange` flush.

### Pass 2 — complete (client + migration 019)
- **C2** — `sanitizeQuestionsForStudent()` strips `mark_scheme`, `guidance`, `acceptable_answers`, `common_misconceptions`, `scratchpad` and metadata from exam-mode question payloads; the plaintext `teacherPin` and `questionOverrides` are removed from `headerConfig`. Candidates receive a salted `teacherPinHash` for offline unlock verification, and `verifyTeacherUnlockPin()` prefers the server RPC.
- **C3** — `lookup_student_exam_result()` returns only the named candidate's published rows (PIN checked and `result_pin` stripped server-side). The client uses it first and falls back to two candidate-scoped `ilike` queries.
- **C1/H6 (partial)** — `check_student_attempt_submitted()` removes the 100-row client scan; candidate identity is normalised and matched by name + class + number. Full server-side score/deadline authority still requires moving teacher writes behind RPCs and enabling RLS (tracked in the review, not in this pass).
- **Migration** — `supabase/migrations/019_exam_submission_security_rpcs.sql` adds the three `SECURITY DEFINER` functions and lookup indexes. It must be applied to the deployed project; the client degrades to the legacy paths if it is absent.

### Verification
- `node scripts/test-exam-submission-fixes.mjs` — **60/60 passed**.
- `tsc --noEmit -p tsconfig.app.json` — **0 errors**.
- `npm.cmd run build` — **success** (with sandbox escalation for `tsc -b` build-info writes and Vite's Windows path helper).
- `node scripts/test-exam-gestures.mjs` — **PASS**.
- `node scripts/test-proctor-p1-p2-p3.mjs` and `node scripts/verify-exam-key-lock.mjs` remain red for a pre-existing reason: the canonical-proctor-id and keyboard-lock hardening they target are not present in the current `StudentQuizRunner.tsx` at HEAD (verified with `git show HEAD`). They are unrelated to this submission diff and were left untouched.

### Residual risks (documented, not fixed in this pass)
- `published_quizzes` is still read directly from `app_config` by the candidate client during quiz resolution, so a determined student can still obtain `teacherPin`/`questionOverrides` from that raw read. Closing that requires an RLS-protected published-quiz RPC/view (the runner payload is sanitized, but the transport is not).
- `quiz_submissions`/`app_config` RLS remain disabled to keep the teacher dashboard working; score/status/deadline spoofing is therefore still possible until teacher writes move behind RPCs.
- The one-attempt rule is enforced by the RPC check at start/resume, not by a database constraint at submit time.


