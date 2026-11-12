# Diagnosis & Execution Plan: Fixing Manual Grading Revert Bugs in Published Exams

## 1. Root Cause Summary

When a teacher manually grades or adjusts marks in `src/components/QuizResultsModal.tsx` (`handleSaveMarkOverride` or `handleSaveTotalScoreOverride`), three interacting flaws cause the UI, `localStorage`, and Supabase record to revert back to the pre-edit marks:

1. **Pre-upsert `'submissions_updated'` dispatch + timestamp-blind merge (`saveQuizSubmissionCloud` & `fetchSubmissionsFromSupabase`)**
   - `saveQuizSubmissionCloud()` (`src/services/quizSubmissionService.ts`) dispatches `window.dispatchEvent(new Event('submissions_updated'))` synchronously at line 1184 **before** executing `await supabase.from('quiz_submissions').upsert(row)`.
   - `QuizResultsModal` listens to `'submissions_updated'` and immediately triggers `refreshSubmissions()` -> `fetchSubmissionsFromSupabase()`.
   - Because the cloud `SELECT` returns the old pre-upsert row and `fetchSubmissionsFromSupabase()` merges strictly via `if (!map.has(s.id))` without checking `updatedAt` or in-flight/pending outbox status, the stale cloud row overwrites both `localStorage` and React state (`setSubmissions` / `setSelectedSubmission`).

2. **Background auto-regrading overwrites manual marks and total-score overrides (`QuizResultsModal` & `gradeSubmissionDeterministically`)**
   - Inside `refreshSubmissions()`, whenever any submission on the exam still contains an item with `aiFeedback === 'Awaiting examiner AI evaluation'` or missing/`'See mark scheme'` model answers, `gradeSubmissionDeterministically(..., { onlyUnresolved: true })` runs across all submissions and writes results back via `updateSubmission()`.
   - `handleSaveTotalScoreOverride()` modifies `score`, `percentage`, `teacherAdjustedMarks`, and `topicBreakdown` without changing `questionResults`; the next deterministic pass recomputes `score` from `questionResults` and overwrites the manual total score.
   - `handleSaveMarkOverride()` does not mark edited items (`manualOverride: true`, `gradingMethod: 'teacher'`), so manually graded questions/sub-questions that lack a resolved model answer (or unchanged `0` sub-questions still carrying `'Awaiting examiner AI evaluation'`) get overwritten by deterministic grading or manual Re-Grade All (`chooseRegradeMarks`).

3. **`app_config` fallback isolation & unguarded out-of-order refreshes**
   - When a `quiz_submissions` table `upsert` fails and falls back to `app_config`, `fetchSubmissionsFromSupabase()` still returns stale table rows as long as the table returns `> 0` rows, ignoring pending/failed outbox items and newer local edits.
   - Unfiltered `postgres_changes` subscriptions and overlapping `refreshSubmissions()` calls can resolve out of order against optimistic state.

---

## 2. Step-by-Step Execution Plan

### Step 1: Extend Submission & Regrade Types (`quizSubmissionService.ts`, `examSubmissionGuards.ts`)
- Add `manualOverride?: boolean` and `'teacher'` to `QuestionSubmissionResult.gradingMethod` and `manualOverride?: boolean` to sub-question result items in `src/services/quizSubmissionService.ts`.
- Add `manualTotalScoreOverride?: boolean` to `ExamForensics` (stored inside `raw_answers._forensics` in Postgres `quiz_submissions`, requiring no DB schema migration).
- Update `PreviousMarkLike` and `chooseRegradeMarks()` in `src/lib/examSubmissionGuards.ts` so items with `manualOverride === true` or `gradingMethod === 'teacher'` are always preserved.

### Step 2: Protect Manual Question & Total Score Edits During Grading (`deterministicGradingService.ts`, `QuizResultsModal.tsx`)
- In `QuizResultsModal.tsx`:
  - `handleSaveMarkOverride`: tag edited questions/sub-questions with `manualOverride: true` and `gradingMethod: 'teacher'`, clear stale `'Awaiting examiner AI evaluation'` feedback on sub-questions saved by the teacher, clear `forensics.manualTotalScoreOverride` (since score now tracks per-question sum), and set an explicit ISO `updatedAt`.
  - `handleSaveTotalScoreOverride`: record `forensics.manualTotalScoreOverride = true` and an explicit ISO `updatedAt`.
  - `handleRunBatchAI`: preserve `manualOverride` / `gradingMethod === 'teacher'` questions and sub-questions when running AI/deterministic evaluation.
- In `gradeSubmissionDeterministically()` (`src/services/deterministicGradingService.ts`):
  - Never overwrite `earnedMarks`, `isCorrect`, `aiFeedback`, or `gradingMethod` on manually overridden questions or sub-questions (still populate missing `correctAnswer` for display).
  - Respect `sub.forensics?.manualTotalScoreOverride` so manually overridden `score` and `topicBreakdown` are preserved rather than reset to `earnedMarks`.

### Step 3: Make Cloud Submission Saves & Fetches Timestamp-Safe (`quizSubmissionService.ts`)
- Track in-flight saves (`inFlightSubmissionSaves` map keyed by `submission.id`) and introduce a shared `mergeSubmissionsPreferNewest()` helper checking:
  1. Active in-flight saves
  2. Pending/failed entries in `fluffykitten_submission_outbox`
  3. Newer `updatedAt` (falling back to `submittedAt`) timestamps
- Update `saveQuizSubmissionCloud()`:
  - Normalize a single `updatedAt` ISO timestamp written identically to `localStorage`, outbox, `inFlightSubmissionSaves`, and the Supabase payload.
  - Perform the cloud `upsert` (and `app_config` fallback if `!tableSuccess`) **before** clearing `inFlightSubmissionSaves` and dispatching `'submissions_updated'`.
- Update `fetchSubmissionsFromSupabase()`, `loadAndSyncAllSubmissions()`, and `setQuizSubmissionsStatus()`:
  - Use `mergeSubmissionsPreferNewest()` so stale cloud rows never overwrite newer local/outbox/in-flight manual grades.
  - Guard Supabase calls with `isSupabaseConfigured()` when running offline/in Node tests.
  - Stamp `updatedAt` in `setQuizSubmissionsStatus()` and mirror status changes cleanly.

### Step 4: Guard `QuizResultsModal.tsx` Refresh Ordering & Realtime Filtering
- Maintain a monotonic `refreshSeqRef` and `latestManualEditAtRef` in `QuizResultsModal.tsx` so stale in-flight `refreshSubmissions()` responses started before a manual edit do not overwrite newer React state.
- Await `updateSubmission(updatedSubmission)` inside `handleSaveMarkOverride` and `handleSaveTotalScoreOverride` with saving error visibility/warnings rather than silent fire-and-forget.
- Filter `postgres_changes` callbacks on `quiz_submissions` to the current quiz (`quizId` / `quizCode`) so activity on unrelated exams does not interrupt grading.

### Step 5: Add Regression Test Suite (`scripts/test-manual-grading-persistence.mjs`, `package.json`)
- Cover:
  1. Stale cloud response returning older `updatedAt` during an in-flight / recent manual mark override preserves the manual grade in both returned submissions and `localStorage`.
  2. Failed `quiz_submissions` table write (`app_config`/outbox fallback) preserves manual grade when stale table read runs afterward.
  3. `gradeSubmissionDeterministically` (`onlyUnresolved: true` and `false`) preserves per-question `manualOverride`, sub-question `manualOverride`, and `forensics.manualTotalScoreOverride` even when another question still awaits AI.
  4. `chooseRegradeMarks` preserves `manualOverride: true` / `gradingMethod: 'teacher'`.
  5. Structural wiring checks verifying `'submissions_updated'` fires after cloud `upsert` settles and `QuizResultsModal.tsx` sets override flags and guards refresh races.
- Register `"test:manual-grading"` in `package.json`.

### Step 6: Verification
- Run `test:manual-grading`, `test-exam-submission-fixes.mjs`, `test-mcq-grading-flow.mjs`, `test:saved-test-source`, `test:pilot-exam`, and `test:resource-booklet`.
- Run `oxlint` on all modified files (0 errors) and `npm.cmd run build`.

