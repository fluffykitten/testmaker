# Fillable Data Tables & Inline Term-Selection Implementation Plan

## Diagnosis Summary

Two question formats shown in Test Builder fail during Formal Exam ([`StudentQuizRunner.tsx`](../src/pages/StudentQuizRunner.tsx)):

1. **Fillable Data Tables (`data_tables` with `{ is_blank: true }`, e.g., Q6 `pilot-q6-econ`)**:
   - `StudentQuizRunner.tsx` never imports [`ExamDataTable`](../src/components/ExamDataTable.tsx) and never reads `currentQuestion.data_tables` or `sub.data_tables`, so structured tables disappear completely in Formal Exam.
   - `currentTable` in `StudentQuizRunner.tsx` only parses Markdown pipe tables inside `question_text` and only renders classification column-choice buttons (e.g., True/False), not blank-cell `<input>` boxes.
   - Neither `StudentQuizRunner.tsx`, [`examSubmissionGuards.ts`](../src/lib/examSubmissionGuards.ts), nor [`deterministicGradingService.ts`](../src/services/deterministicGradingService.ts) captures, strips (`expected_answer`), or grades `data_tables` cell answers.

2. **Inline Term Selection (`[opt1|opt2|...]`, e.g., Q8 `pilot-q8-cloze`)**:
   - [`hasInlineGaps`](../src/components/InlineGapText.tsx) and `parseGapSegments` do not recognize pipe-delimited choice tokens (`[released|absorbed]`), causing `isCurrentInlineGap` to be `false`, rendering raw bracket text and falling back to an empty multi-line `<textarea>`.
   - `InlineGapText` only renders `<input type="text">` and lacks an inline `<select>` term-picker UI.
   - [`extractGapExpectedMap`](../src/services/deterministicGradingService.ts) only matches numeric prefixes (`^\[?\s*(\d+)`) and misses `'Gap 1: released'`, collapsing all answers into `map['1']` and skipping Gaps 2 and 3.

---

## Small Executable Steps (Test After Each Step)

### Step 1: Extract & Extend Pure Gap/Choice Parser
- **Files**:
  - Create `src/lib/inlineGapParser.ts` (dependency-free pure TypeScript so both browser React and Node test/service runners can import it without JSX/CSS)
  - Create `scripts/test-inline-choice-gaps.mjs`
- **Changes**:
  1. Move `GapSegment`, `hasInlineGaps`, and `parseGapSegments` into `src/lib/inlineGapParser.ts` (and re-export them from `src/components/InlineGapText.tsx` for backward compatibility).
  2. Add optional `choices?: string[]` to `GapSegment`.
  3. Match inline pipe-choice tokens `[opt1|opt2|...]` (>= 2 non-empty single-line options separated by `|`) while preserving all existing formats (`[1]`, `[blank]`, `[gap]`, `{{1}}`, `___`, `[___]`, `[1: answer]`), still ignoring trailing mark tags like `. [2]` and avoiding splitting inside `$...$` math blocks.
  4. Number each choice gap sequentially (`gap_1`, `gap_2`, ...) with `choices: ['released', 'absorbed']`.
- **Verification**:
  - Run `node --import ./scripts/register-ts.mjs scripts/test-inline-choice-gaps.mjs`:
    - Verify `hasInlineGaps` returns `true` for Q8's prompt (`[released|absorbed]`, `[increase|decrease]`, `[negative|positive]`), `true` for `[1]`/`____`/`{{1}}`, and `false` for trailing mark allocations (`State why. [2]`).
    - Verify `parseGapSegments` produces 3 numbered `gap` segments (`gap_1`, `gap_2`, `gap_3`) with the expected `choices` arrays and untouched surrounding text/math chunks.

---

### Step 2: Add Inline Choice Selector UI to `InlineGapText`
- **Files**:
  - Update `src/components/InlineGapText.tsx`
  - Update `src/components/InlineGapText.css`
  - Update `src/pages/StudentQuizRunner.tsx` (verify `sub_questions` inline gaps + pinned bar / `hasValidStudentResponse` work with choice JSON values)
- **Changes**:
  1. In `InlineGapText.tsx`, when `seg.choices && seg.choices.length >= 2` and `!isReadOnly`, render an accessible inline `<select className="sq-gap-select sq-cloze-input-${compId}">` inside `.sq-gap-input-wrap` with:
     - Initial empty placeholder option `<option value="">Select…</option>` so unanswered gaps remain `""`.
     - Options for each item in `seg.choices`, Keyboard arrow + Tab/Enter focus advancing.
  2. Style `.sq-gap-select` in `InlineGapText.css` cleanly alongside `.sq-gap-badge` and `.sq-gap-input` (light-mode crisp contrast, focus ring, selected state highlight).
  3. In `isReadOnly` review mode (e.g., results/preview), render the student's selected option in `.sq-gap-review-pill` with expected answer fallback when available.
  4. Ensure `StudentQuizRunner.tsx` also treats inline-choice sub-questions (`hasInlineGaps(sub.question_text)`) identically without showing a fallback textarea.
- **Verification**:
  - Run `npx tsc -b` (or `npm run build`) and `npx oxlint src/lib/inlineGapParser.ts src/components/InlineGapText.tsx` to verify clean compilation and zero lint issues.
  - Extend `scripts/test-inline-choice-gaps.mjs` to assert `StudentQuizRunner.tsx` renders `<InlineGapText>` cleanly when `isCurrentInlineGap` is triggered on `[opt1|opt2]` prompts.

---

### Step 3: Fix Deterministic Grading for Inline Choices & `Gap N:` Mark Schemes
- **Files**:
  - Update `src/services/deterministicGradingService.ts`
  - Update `scripts/test-inline-choice-gaps.mjs`
- **Changes**:
  1. Import `hasInlineGaps` and `parseGapSegments` from `../lib/inlineGapParser` inside `deterministicGradingService.ts`.
  2. Update `isGapFillStyle` in `gradeDeterministicAnswer` to use `hasInlineGaps(qText)` in addition to `question.question_style === 'Fill in the Blank'`.
  3. Update `extractGapExpectedMap`:
     - Match `Gap 1: ...`, `Blank 1: ...`, `[1] ...`, `1. ...`, `1: ...`, `(1) ...` via `/^(?:(?:gap|blank)\s+)?\[?\s*(\d+)\s*\]?[\s:.-]+(.+)$/i`.
     - If explicitly numbered gaps were extracted (e.g., `Gap 1`, `Gap 2`, `Gap 3`), do **not** collapse unnumbered `acceptable_answers` (`['released', 'increase', 'negative']`) into `map['1']`.
     - Only fall back to positional mapping across parsed gap segments when no explicit gap labels exist and `acceptable_answers` matches multi-gap entries, or `map['1']` for single-gap answers.
- **Verification**:
  - Run `node --import ./scripts/register-ts.mjs scripts/test-inline-choice-gaps.mjs` covering Q8 (`pilot-q8-cloze`) directly against `gradeDeterministicAnswer`:
    - All 3 correct (`{"gap_1":"released","gap_2":"increase","gap_3":"negative"}`) -> `3 / 3` marks (`isCorrect: true`).
    - 2 of 3 correct (`{"gap_1":"released","gap_2":"decrease","gap_3":"negative"}`) -> `2 / 3` partial marks (`isCorrect: false`), accurate feedback per `[1]`, `[2]`, `[3]`.
    - Swapped answer (`{"gap_1":"negative","gap_2":"increase","gap_3":"released"}`) -> only `1 / 3` (`gap_2`), **no** false credit on `gap_1` or `gap_3`.

---

### Step 4: Secure Sanitization, Storage Helpers & Deterministic Grading for Fillable `data_tables`
- **Files**:
  - Update `src/lib/examSubmissionGuards.ts`
  - Update `src/services/deterministicGradingService.ts`
  - Create `scripts/test-fillable-data-tables.mjs`
- **Changes**:
  1. **Sanitization (`sanitizeQuestionsForStudent`)**:
     - Preserve `data_tables` from `q.data_tables ?? (q.mark_scheme as any)?._data_tables` before setting `mark_scheme: null`.
     - When `stripAnswerKeys === true`, deep-clone `q.data_tables` and `sq.data_tables` and strip `expected_answer` from every cell object so answer keys never leak to student browsers.
  2. **Table Answer Key Helpers (`examSubmissionGuards.ts`)**:
     - Support saving/resolving table cell maps in `buildAnswersByQuestionId` and `resolveStoredAnswer`:
       - Standalone questions store table JSON in `answers[idx]` -> `answersByQuestionId[q.id]`.
       - Questions with `sub_questions` also support table cell JSON under `"${idx}_table"` -> `answersByQuestionId["${q.id}::table"]`.
     - Export pure helper `hasBlankDataTableCells(tables)` and `extractDataTableBlankTargets(question, subIndex?)` / `parseTableCellAnswers(raw)`.
  3. **Deterministic Grading (`deterministicGradingService.ts`)**:
     - When grading a question (or sub-question) with blank `data_tables` cells:
       - Match each blank cell key (`${tableId}-r${rIdx}-c${cIdx}`) against `cell.expected_answer` using existing normalization + `isNumericEquivalent` + `isChemicalEquivalent` + `isKeywordMatch`.
       - When a question has both a fillable blank cell in `data_tables` AND `sub_questions` referencing that table completion (like Q6 `(a)`), allow table cell answers to supply/merge with the sub-question response when the sub-question textarea is empty, so students who type directly into the table still receive marks in `gradeDeterministicAnswer` / `gradeSubmissionDeterministically`.
- **Verification**:
  - Run `node --import ./scripts/register-ts.mjs scripts/test-fillable-data-tables.mjs`:
    - Verify `sanitizeQuestionsForStudent(..., true)` keeps Q6 `Table 6.1` headers/rows/blank flag while removing `expected_answer: '350'`.
    - Verify `buildAnswersByQuestionId` & `resolveStoredAnswer` round-trip `"${idx}_table"` / `q.id::table`.
    - Verify `gradeDeterministicAnswer` and `gradeSubmissionDeterministically` award `2 / 2` on Q6 `(a)` when `350` is entered in `Table 6.1-r2-c1` and `1 / 1` on `(b)` when `$4.00` is entered.

---

### Step 5: Wire `ExamDataTable` & Fillable Table State into `StudentQuizRunner.tsx` (and Results Display)
- **Files**:
  - Update `src/components/ExamDataTable.tsx` & `src/components/ExamDataTable.css` (read-only / exam polish if needed, e.g., `dir="auto"`, `spellCheck={false}`, `autoComplete="off"`, clear focus styling)
  - Update `src/pages/StudentQuizRunner.tsx`
  - Update `src/components/QuizResultsModal.tsx` (verify table-cell / inline-gap student answers render cleanly without raw JSON clutter if needed)
- **Changes**:
  1. Import `ExamDataTable` and `hasBlankDataTableCells` in `StudentQuizRunner.tsx`.
  2. When rendering the active question:
     - If `currentQuestion.data_tables?.length > 0` and `!hasMarkdownTable(promptText)`:
       - Pass `isInteractive={!isSubmitted && hasBlankDataTableCells(currentQuestion.data_tables)}`.
       - Read `userAnswers` from `answers[currentIndex]` (no `sub_questions`) or `answers["${currentIndex}_table"]` (when `sub_questions` exist).
       - Update via `onCellChange(cellKey, val)` calling `recordAnswerChange` + `setAnswers`, syncing to `"${currentIndex}_0"` if Q6-style sub-question `(a)` specifically corresponds to the table blank (or showing clear status badge *"Filled in Table above"* on Part `(a)` so the student doesn't have to answer twice).
     - Also render read-only/interactive `<ExamDataTable tables={sub.data_tables} ... />` inside any sub-question card (`sub.data_tables`) when `!hasMarkdownTable(sub.question_text)`.
  3. Update `hasValidStudentResponse` / `quizStats` / `isQuestionAnswered` so filling an interactive table cell marks standalone table questions as answered (and clears back to unanswered if emptied).
  4. Register `test:inline-gaps` and `test:fillable-tables` scripts in `package.json`.
- **Verification**:
  - Run `node --import ./scripts/register-ts.mjs scripts/test-fillable-data-tables.mjs` (extending with structural assertions on `StudentQuizRunner.tsx` importing & wiring `ExamDataTable`).
  - Run `npm run build` and `npm run lint`.

---

### Step 6: Full Regression Suite & Live Formal Exam Verification
- **Checks to Run**:
  1. `npm run test:inline-gaps` (new Step 1-3 suite)
  2. `npm run test:fillable-tables` (new Step 4-5 suite)
  3. `npm run test:pilot-exam`
  4. `npm run test:security-tiers`
  5. `npm run test:keyboard-controls`
  6. `node scripts/verify-exam-key-lock.mjs`
  7. `npm run test:submission-tombstones` & `npm run test:custom-subject`
  8. `npm run build` (`tsc -b && vite build`) & `npm run lint` (`oxlint`)
  9. **Live UI Smoke Check (Formal Exam `ICM170`)**: Open Exam Runner for `ICM170`, navigate to **Q6** (`Table 6.1` visible with typed cell `350` persisted across navigation/reload) and **Q8** (three interactive term selectors `[released | absorbed]`, `[increase | decrease]`, `[negative | positive]` selectable inline with no raw bracket text and no fallback textarea), then verify submission + grading.

