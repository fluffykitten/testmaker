# Remediation Plan: Exam Mode MCQ Auto-Grading & Results Modal State Synchronization

> **Target Problem**: After an Exam Mode submission (e.g. *Electrolysis TU Grade 11*), MCQ questions in the teacher results page initially show `0` marks and `"Expected: See mark scheme"` (graded wrong). Clicking **"🔄 Re-Grade MCQ"** calculates the correct grades, but the user is forced to refresh the entire browser page before the detail pane updates.
> **Files to Modify**:
> - [`src/components/QuizResultsModal.tsx`](file:///c:/testmaker/src/components/QuizResultsModal.tsx)
> - [`src/pages/StudentQuizRunner.tsx`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx)
> - [`src/services/deterministicGradingService.ts`](file:///c:/testmaker/src/services/deterministicGradingService.ts)
> **Verification Script**:
> - [`scripts/test-mcq-grading-flow.mjs`](file:///c:/testmaker/scripts/test-mcq-grading-flow.mjs)

---

## 1. Executive Summary & Root Cause Analysis

### Finding A: Candidate Payload Sanitization Leaves MCQs with Null Mark Schemes
- **Location**: [`src/lib/examSubmissionGuards.ts:331-358`](file:///c:/testmaker/src/lib/examSubmissionGuards.ts#L331-L358) & [`src/services/quizCodeService.ts:199-203`](file:///c:/testmaker/src/services/quizCodeService.ts#L199-L203)
- **Root Cause**:
  To prevent candidate cheating via browser DevTools (P1 security finding `C2`), `sanitizeQuestionsForStudent()` strips `mark_scheme`, `acceptable_answers`, and metadata from all questions when `isExamMode && !showInstantSolutions`.
- **Impact on Submission**:
  When the candidate submits the exam in [`StudentQuizRunner.tsx:1674-1768`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L1674-L1768):
  ```ts
  const hasAnswerKey = Boolean(
    q.mark_scheme || (q.sub_questions || []).some((sq) => Boolean(sq.mark_scheme))
  );
  ```
  Because `q.mark_scheme` is `null`, `hasAnswerKey` is `false`. The runner sets:
  - `qEarned = 0`
  - `isCorrect = false`
  - `aiFeedback = 'Awaiting examiner AI evaluation'`
  - `correctAnswer = resolveQuestionModelAnswer(q)` $\to$ returns `'See mark scheme'` because `q.mark_scheme` is null.
  - The submission is saved to Supabase with `score: 0` and `status: 'submitted'`.

---

### Finding B: Missing Auto-Grading on Ingestion in `QuizResultsModal`
- **Location**: [`src/components/QuizResultsModal.tsx:172-219`](file:///c:/testmaker/src/components/QuizResultsModal.tsx#L172-L219)
- **Root Cause**:
  When a teacher opens [`QuizResultsModal.tsx`](file:///c:/testmaker/src/components/QuizResultsModal.tsx), it fetches the submission rows directly from Supabase and renders them as-is.
  Although the teacher's browser **has the full master test with all answer keys** (via `loadQuizQuestionsWithOverrides()`), the modal never automatically triggered deterministic evaluation for pending submissions.
- **Impact**:
  The teacher sees newly submitted attempts marked with `0` score, red boxes, and `"Expected: See mark scheme"`, requiring them to notice and manually click the **"🔄 Re-Grade MCQ"** button.

---

### Finding C: Stale `selectedSubmission` State Requiring Full Page Refresh
- **Location**: [`src/components/QuizResultsModal.tsx:750-768`](file:///c:/testmaker/src/components/QuizResultsModal.tsx#L750-L768)
- **Root Cause**:
  In `handleRegradeAllDeterministic()`:
  ```ts
  for (let sIdx = 0; sIdx < submissions.length; sIdx++) {
    const updatedSub = ...;
    await updateSubmission(updatedSub);
  }
  await refreshSubmissions();
  ```
  `refreshSubmissions()` calls `setSubmissions(subs)`, updating the top-level submissions list.
  **However, it NEVER updates `selectedSubmission`** (the candidate currently displayed on the right-hand inspection drawer).
- **Impact**:
  The right pane continues rendering the old, stale in-memory `selectedSubmission` object (with `0` marks and `"See mark scheme"`). The teacher sees the success alert, but the UI on screen does not change until they hit **F5 / browser refresh**, which forces the modal to re-mount and reload `selectedSubmission`.

---

## 2. Proposed Architecture & Fix Strategy

```
[Student Submits Exam]
        │
        ▼ (Payload has no answer key -> Anti-Cheat Guard)
Stored in Supabase (status: 'submitted', rawAnswers preserved, score: 0)
        │
        ▼
[Teacher Opens Results Modal OR Live Realtime Event Arrives]
        │
        ├─► 1. Load submissions from Supabase
        │
        ├─► 2. Detect submissions with status === 'submitted' OR un-graded MCQs
        │
        ├─► 3. SILENT AUTO-GRADE:
        │      Run deterministic grading against Teacher's Master Answer Key
        │      - Correctly award MCQ and Gap-Fill marks
        │      - Update questionResults with exact option letters & text
        │      - Persist updated rows to Supabase (status: 'graded' if no descriptive parts pending)
        │
        └─► 4. INSTANT REACT STATE SYNC:
               - Update `submissions` state
               - Automatically update `selectedSubmission` to match the freshly graded data
               - NO MANUAL BUTTON CLICK & NO PAGE REFRESH REQUIRED
```

---

## 3. Step-by-Step Implementation Plan

### Step 1: Instant React State Sync for `selectedSubmission`
- **File**: [`src/components/QuizResultsModal.tsx`](file:///c:/testmaker/src/components/QuizResultsModal.tsx)
- **Changes**:
  1. In `handleRegradeAllDeterministic()`:
     - Collect all `updatedSub` objects in an array `const updatedList: StudentSubmission[] = [];`.
     - After all updates complete, immediately sync `selectedSubmission`:
       ```ts
       setSubmissions(updatedList);
       setSelectedSubmission((prev) => {
         if (!prev) return null;
         return updatedList.find((s) => s.id === prev.id) || prev;
       });
       ```
  2. Add an automatic synchronization effect:
     ```ts
     useEffect(() => {
       if (selectedSubmission) {
         const fresh = submissions.find((s) => s.id === selectedSubmission.id);
         if (fresh && fresh.updatedAt !== selectedSubmission.updatedAt) {
           setSelectedSubmission(fresh);
         }
       }
     }, [submissions]);
     ```
     This ensures that whenever submissions are refreshed (via button, auto-grade, or Realtime event), the currently open candidate drawer updates immediately on screen.

---

### Step 2: Auto-Grade Deterministic Questions on Ingestion
- **File**: [`src/components/QuizResultsModal.tsx`](file:///c:/testmaker/src/components/QuizResultsModal.tsx)
- **Changes**:
  1. Extract the core deterministic grading routine from `handleRegradeAllDeterministic` into a reusable, non-interactive helper:
     ```ts
     async function runSilentDeterministicGrading(
       subsToGrade: StudentSubmission[],
       masterQuestions: Question[]
     ): Promise<StudentSubmission[]>
     ```
  2. In `refreshSubmissions()`, after fetching submissions from Supabase:
     - Check if any submission has un-evaluated deterministic questions:
       ```ts
       const needsGrading = subs.filter((s) =>
         s.status === 'submitted' ||
         s.questionResults?.some((qr) =>
           qr.correctAnswer === 'See mark scheme' ||
           qr.aiFeedback === 'Awaiting examiner AI evaluation'
         )
       );
       ```
     - If `needsGrading.length > 0`, load the master questions and run `runSilentDeterministicGrading(needsGrading, masterQuestions)`.
     - Persist the newly graded submissions to Supabase and update state seamlessly.
  3. Keep the manual **"🔄 Re-Grade MCQ"** button as an explicit tool for teachers who edit the answer key or adjust test questions after submissions have already been received.

---

### Step 3: Teacher-Side Fallback for Question Model Answers
- **File**: [`src/components/QuizResultsModal.tsx`](file:///c:/testmaker/src/components/QuizResultsModal.tsx)
- **Changes**:
  - In the question detail view ([`QuizResultsModal.tsx:2141-2300`](file:///c:/testmaker/src/components/QuizResultsModal.tsx#L2141-L2300)), when rendering the expected answer:
    ```tsx
    const masterQuestion = questions.find((q) => q.id === qr.questionId) || questions[qIdx];
    const displayExpected = (qr.correctAnswer && qr.correctAnswer !== 'See mark scheme')
      ? qr.correctAnswer
      : (masterQuestion ? resolveQuestionModelAnswer(masterQuestion) : 'See mark scheme');
    ```
  - This guarantees that the teacher will **never see `"See mark scheme"`** in the modal even during the split-second before the auto-grader finishes.

---

## 4. Verification & Testing Plan

### Automated Test Suite: [`scripts/test-mcq-grading-flow.mjs`](file:///c:/testmaker/scripts/test-mcq-grading-flow.mjs)

We will create a Node test harness covering:
1. **Test 1: Candidate Sanitization Contract**:
   - Verify that `sanitizeQuestionsForStudent()` removes `mark_scheme` from MCQs during Exam Mode.
2. **Test 2: Initial Submission Representation**:
   - Verify that a student submission with null `mark_scheme` correctly stores the candidate's chosen option in `rawAnswers` while marking `status: 'submitted'` and `aiFeedback: 'Awaiting examiner AI evaluation'`.
3. **Test 3: Teacher-Side Deterministic Evaluation**:
   - Pass the sanitized submission and the teacher's master question set through `gradeDeterministicAnswer()`.
   - Assert that correct options receive `earnedMarks: 1`, `isCorrect: true`, and proper model answer strings (e.g. `"Option B: Molten lead(II) bromide"`).
4. **Test 4: State Synchronization Guard**:
   - Assert that `setSelectedSubmission` updates the candidate object reference when re-grading finishes.

### Manual Verification Flow:
1. Run `node scripts/test-mcq-grading-flow.mjs` $\to$ **4/4 PASS**.
2. Run `npm.cmd run build` $\to$ Zero TypeScript compilation or bundling errors.
3. Test locally in UI:
   - Open a quiz results modal with pending/un-graded submissions.
   - Confirm all MCQs display their correct grades and model answers automatically without manual button clicks or page reloads.

