# Plan: Fix `quiz_submissions` Pagination (#2) & Upsert (#3) Statement Timeouts

## Context & Verified Root Causes
Analysis of `2026-11-23` Supabase logs for `jtxmlmexvfvrkhfavwdr` showed two additional `SQLSTATE 57014` (`statement timeout`) patterns on `public.quiz_submissions`:
- **#2:** `GET /rest/v1/quiz_submissions?select=*&order=submitted_at.desc,id.desc&offset=250|750&limit=250` (4× `500`, up to `117.8 s`)
- **#3:** `POST /rest/v1/quiz_submissions` (`ON CONFLICT (id) DO UPDATE`, 2× `500` at `6.5 s` and `7.4 s`)

Live DB inspection on `jtxmlmexvfvrkhfavwdr` (882 rows, `16 MB` total) established:
1. `raw_answers` totals **`18 MB`**, of which **`15.9 MB` (88%)** is `_forensics.answerChangeLogs` (actual student answers + remaining forensics total **`2,129 kB`**).
2. **57 rows** (`> 50 KB` each, mostly `CEFR` essay exams and `COVALENT`) hold **`15.0 MB`** of `raw_answers` (**`14.6 MB`** in `answerChangeLogs`) because `StudentQuizRunner.tsx` pushed full `previousAnswer`/`newAnswer` essay snapshots on every 700 ms typing pause (up to `699` revisions = `853,913 bytes` in a single student row).
3. Baseline `EXPLAIN (ANALYZE, BUFFERS)` on `LIMIT 250 OFFSET 250` took **`700.189 ms`** (`2,453` shared buffers) even when idle, saturating TOAST I/O during exam peaks.
4. `saveBatchQuizSubmissionsCloud` used `chunkSize = 100`, `QuizResultsModal` awaited sequential per-row `updateSubmission()` calls in auto-grade/re-grade loops, and `quiz_submissions` maintained 3 unused indexes (`0` scans per `get_advisors`).

## Execution Steps
1. **Create this plan document** in `Plan/`.
2. **Cap `_forensics.answerChangeLogs` at source & before cloud upserts:**
   - Truncate `previousAnswer`/`newAnswer` preview strings to 240 chars and cap revision history (`30`/question, `250` total) in [StudentQuizRunner.tsx](file:///e:/VibeCoding/testmaker/src/pages/StudentQuizRunner.tsx).
   - Export `compactForensicsForStorage()` in [quizSubmissionService.ts](file:///e:/VibeCoding/testmaker/src/services/quizSubmissionService.ts) and apply it in `saveQuizSubmissionCloud` and `saveBatchQuizSubmissionsCloud`.
3. **Compact the 57 bloated rows in live DB (`jtxmlmexvfvrkhfavwdr`):**
   - Truncate `answerChangeLogs` string previews (`> 240` chars) and keep the latest 60 revision entries on rows `> 50 KB`, preserving all student answers, `question_results`, `score`, `proctoring_logs`, `questionTimeAnalytics`, and `answersByQuestionId`.
4. **Optimize #2 (`fetchAllSubmissionsFromSupabase`):**
   - Reduce `pageSize` from `250` to `100` in [quizSubmissionService.ts](file:///e:/VibeCoding/testmaker/src/services/quizSubmissionService.ts) and add 1 retry (`400 ms` delay) per page.
5. **Optimize #3 (`saveBatchQuizSubmissionsCloud` & `QuizResultsModal`):**
   - Reduce `chunkSize` from `100` to `20` in `saveBatchQuizSubmissionsCloud`.
   - Batch auto-grading and deterministic re-grade saves in [QuizResultsModal.tsx](file:///e:/VibeCoding/testmaker/src/components/QuizResultsModal.tsx) via `saveBatchQuizSubmissionsCloud` when >1 submission changes.
6. **Drop 3 unused indexes & verify:**
   - Add [040_quiz_submissions_timeout_and_index_cleanup.sql](file:///e:/VibeCoding/testmaker/supabase/migrations/040_quiz_submissions_timeout_and_index_cleanup.sql) and apply on `jtxmlmexvfvrkhfavwdr`, then verify with `ANALYZE`, `EXPLAIN (ANALYZE, BUFFERS)`, and `git diff`.
