# Plan: Fix Proctor `quiz_submissions` Statement Timeouts (#1)

## Context & Verified Root Causes
Analysis of today's (`2026-11-23`) Supabase logs for `jtxmlmexvfvrkhfavwdr` revealed 12 `500`/`504` responses (`SQLSTATE 57014: canceling statement due to statement timeout`), including 6 failures on `GET /rest/v1/quiz_submissions?...raw_answers...&limit=1000`.

1. **Unneeded 844 KB `raw_answers` TOAST Reads in `fetchProctorMonitoredSubmissions`**
   - [src/services/quizSubmissionService.ts](file:///e:/VibeCoding/testmaker/src/services/quizSubmissionService.ts) selected `raw_answers` across up to 1,000 rows for all monitored quiz codes.
   - Live DB inspection showed `raw_answers._forensics.answerChangeLogs` reaches **853,913 bytes** (total `raw_answers` up to **863,884 bytes** / ~844 KB on a single row).
   - `LiveInvigilatorModal` does not inspect `rawAnswers` at all (only `proctorStudentId`, which is deterministic from `quizCode`, `studentName`, `candidateNumber`, and `studentClass`).
   - Live `EXPLAIN (ANALYZE, BUFFERS)` comparison on `jtxmlmexvfvrkhfavwdr`:
     - With `raw_answers`: **329.312 ms**, `420` shared buffers (TOAST decompression + multi-MB JSON payload).
     - Without `raw_answers`: **1.370 ms**, `61` shared buffers (**~240× faster**, 0 TOAST reads).

2. **15-Second Parent Timer Causing Repeated Backfill & WebSocket Reconnect Loops**
   - [src/pages/QuizManagerPage.tsx](file:///e:/VibeCoding/testmaker/src/pages/QuizManagerPage.tsx) updates `nowMs` every 15 seconds, recomputing `activeExamQuizzes` as a new array reference (and passed `[selectedQuizForProctor, ...activeExamQuizzes]` inline).
   - [src/components/LiveInvigilatorModal.tsx](file:///e:/VibeCoding/testmaker/src/components/LiveInvigilatorModal.tsx) derived `monitoredQuizzes` and `quizByCode` from `quizzes`, and used `[monitoredCodesKey, monitoredQuizzes]` / `[monitoredCodesKey, monitoredQuizzes, quizByCode]` as `useEffect` dependencies—re-running `fetchProctorMonitoredSubmissions`, re-connecting Realtime WebSockets, re-loading 1,000 `proctor_audit_events`, and re-warming exam papers every 15 seconds.

## Implementation Steps
1. **[src/services/quizSubmissionService.ts](file:///e:/VibeCoding/testmaker/src/services/quizSubmissionService.ts)**:
   - Remove `raw_answers` from `.select(...)` in `fetchProctorMonitoredSubmissions`.
   - Keep defensive extraction of `row.raw_answers?._forensics` if provided by test mocks, and synthesize `forensics: { proctorStudentId: getCanonicalProctorStudentId(...) }` when absent.
2. **[src/components/LiveInvigilatorModal.tsx](file:///e:/VibeCoding/testmaker/src/components/LiveInvigilatorModal.tsx)**:
   - Keep `monitoredQuizzesRef` and `quizByCodeRef` up-to-date on render and key both Effect #1 (submissions backfill) and Effect #2 (Realtime + audit log + pre-warm) strictly on `[monitoredCodesKey]`.
   - When cloud summary rows lack `questionResults`, default `answeredCount` and `totalQuestions` to `quiz.questionCount || 1` for submitted candidates instead of `0 / totalQuestions`, preserving any richer live/local counts when merging.
3. **[src/pages/QuizManagerPage.tsx](file:///e:/VibeCoding/testmaker/src/pages/QuizManagerPage.tsx)**:
   - Stabilize `activeExamQuizzes` across 15-second `nowMs` ticks when the active exam list hasn't changed, and memoize `proctorModalQuizzes`.

## Verification
- Run `npm run test:multi-exam-scale`, `npm run test:proctor-alerts`, `npm run lint`, and `npm run build` (if Node/npm is available in the execution environment; otherwise verify modified files and diffs directly).
