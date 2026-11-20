# Plan: Dedicated `Table Choice` Question Category

## Goal
Promote AKM / TKA / Cambridge statement-matrix questions (e.g., *Tepat / Tidak Tepat*, *Benar / Salah*, *Sesuai / Tidak Sesuai*, *Setuju / Tidak Setuju*, *Fakta / Opini*) from an implicit Markdown-table trick inside `Structured` into a first-class **`Table Choice`** `QuestionStyle`, complete with a visual row-by-row editor, reliable PDF/AI extraction, deterministic per-row auto-grading, and Question Bank filtering.

> **Database Note:** `public.questions.question_style` is `VARCHAR(50)` with no Postgres `CHECK` constraint or enum (`supabase/migrations/001_initial_schema.sql:31`). **No Supabase SQL migration is required.**

---

## Architecture Decision: Canonical Storage Format
To keep 100% compatibility with existing PDF/DOCX exports, `ExamMathText`, `QuestionBankPage` cards, and `QuizResultsModal`:
- `question_style`: `'Table Choice'`
- `options`: `null` (cleared automatically on save and import so it never collides with `Multiple Choice` or `Multiple Select`)
- `question_text`: Stimulus prose + canonical Markdown pipe table (`| No. | <Item Header> | <Col 1> | <Col 2> | ...`)
- `mark_scheme.marking_points`: One line per row in deterministic format: `1. <Row Label>: <Correct Column>` (e.g., `1. Mengembangkan program padat karya...: Tepat`)

---

## Executable Steps

### Step 1: Core Type & Style Normalization
**Files:** `src/types/database.ts`, `src/utils/testSortingUtils.ts`
- Add `'Table Choice'` to the `QuestionStyle` union in `src/types/database.ts`.
- Update `normalizeQuestionStyle(style, options)` to normalize `'table choice'`, `'table_choice'`, `'table matrix'`, `'true false table'`, and `'statement matrix'` to `'Table Choice'` **before** the `options.length >= 2` MCQ fallback.
- Check `src/utils/testSortingUtils.ts` so `'Table Choice'` sorts cleanly alongside `'Structured'` / `'Multiple Select'` as expected.
- **Verify:** `npx tsc --noEmit` passes.

### Step 2: Shared Table-Choice Parser & Helper (`src/lib/tableChoiceUtils.ts`)
**File:** `src/lib/tableChoiceUtils.ts` (new helper)
- Extract/create pure helpers so `QuestionEditorModal`, `StudentQuizRunner`, `pdfProcessor`, and `deterministicGradingService` share one source of truth:
  - `BINARY_AND_MATRIX_HEADERS` regex including `tepat`, `tidak tepat`, `benar`, `salah`, `true`, `false`, `sesuai`, `tidak sesuai`, `setuju`, `tidak setuju`, `ya`, `tidak`, `yes`, `no`, `fakta`, `opini`, `b`, `s`, `t`, `f`.
  - `parseTableChoiceFromQuestion(questionText, markScheme)`: parses stem text before the table, item column header (e.g. `Pernyataan`, `Upaya`, `Statement`), choice column headers, rows, and per-row expected answers from `mark_scheme.marking_points`.
  - `serializeTableChoiceToQuestion({ stemText, itemHeader, columns, rows })`: generates clean Markdown table `question_text` (`| No. | <itemHeader> | <col1> | <col2> | ...`) and deterministic `marking_points`.
- **Verify:** Unit assertions on `No. | Upaya | Tepat | Tidak Tepat` and `No. | Pernyataan | Benar | Salah` round-trip cleanly.

### Step 3: Student Exam Runner & Deterministic Grading Parity
**Files:** `src/pages/StudentQuizRunner.tsx`, `src/services/deterministicGradingService.ts`, `src/services/offlineGradingService.ts`
- In `StudentQuizRunner.tsx`:
  - Update `currentTable` so when `currentQuestion.question_style === 'Table Choice'`, it always parses the table regardless of stale `options` and merges column 0 (`No.` / `#` / `Nomor`) with **any** non-empty column 1 header (e.g., `Upaya`, `Masalah`, `Kebijakan`, `Pernyataan`), not only a fixed 5-word allowlist.
  - Ensure `isCurrentMcq`, `isMultiSelect`, and `isMcq` guards treat `'Table Choice'` as a table-grid question (never A/B/C/D options or sub-question textareas).
  - Add a clear `'Table Choice'` badge/instruction banner above the interactive grid.
- In `deterministicGradingService.ts`:
  - Add `'Tepat'` / `'Tidak Tepat'` to the binary equivalence keyword list (`line 527` parity with `line 341`/`346`).
  - Handle `question.question_style === 'Table Choice'` explicitly in deterministic grading (per-row exact/equivalent column matching + proportional partial marks out of `question.marks`).
- In `offlineGradingService.ts`:
  - Ensure `'Table Choice'` is recognized as deterministically auto-gradable row-by-row rather than treated as ungraded essay text.
- **Verify:** Run `npm run test:multi-select` and deterministic table-choice grading assertions.

### Step 4: Visual Row-by-Row Editor in `QuestionEditorModal.tsx`
**File:** `src/components/QuestionEditorModal.tsx`
- Add `'Table Choice'` to the `QuestionStyle` selector pills (`line 1753`).
- When `questionStyle === 'Table Choice'` (or switching into it):
  - Hide the MCQ `options` editor and `sub_questions` editor; clear `options` on save (`finalQuestionStyle === 'Table Choice'`).
  - Render a **Table Choice Builder** panel:
    - **Presets:** `Tepat / Tidak Tepat`, `Benar / Salah`, `Sesuai / Tidak Sesuai`, `Setuju / Tidak Setuju`, `Fakta / Opini`, or custom column headers (2–4 columns).
    - **Item Column Header** input (e.g. `Pernyataan`, `Upaya`, `Kebijakan`).
    - **Rows List:** Each row has statement text input, radio buttons for each choice column to set the answer key, and `+ Add Row` / remove row buttons.
    - **"Sync Marks to Rows"** convenience button (sets `marks` = row count).
  - Keep `question_text` stimulus/table and `mark_scheme.marking_points` synchronized when saving (while still allowing editing the stimulus paragraph above the table).
- **Verify:** Visual build & manual/scripted save payload verification (`options: null`, `question_style: 'Table Choice'`, valid Markdown table & `marking_points`).

### Step 5: PDF Importer, Gemini Prompt, Filters & Extraction Review
**Files:** `src/lib/pdfProcessor.ts`, `src/lib/gemini.ts`, `src/components/ExtractionReview.tsx`, `src/components/QuestionFilters.tsx`
- Update `normalizeQuestionStyles()` in `src/lib/pdfProcessor.ts`:
  - Detect `Tepat | Tidak Tepat`, `Benar | Salah`, `Sesuai | Tidak Sesuai`, `Setuju | Tidak Setuju`, `Fakta | Opini`, etc. (regardless of whether col 2 is `Pernyataan`, `Upaya`, or anything else when col 1 is `No.` / `#`).
  - Normalize those questions to `question_style: 'Table Choice'` and `options: null` (clearing false-positive combo options like `A. Tepat, Tepat, Tidak Tepat` when the question stem already contains the Markdown matrix table).
- Update `src/lib/gemini.ts` extraction prompt instructions to emit `question_style: "Table Choice"` and `options: null` for statement-matrix questions.
- Add `<option value="Table Choice">Table Choice</option>` to `src/components/ExtractionReview.tsx` and `src/components/QuestionFilters.tsx`.
- **Verify:** Import sample payload with `No. | Upaya | Tepat | Tidak Tepat` + `A. Tepat, Tepat, Tidak Tepat` normalizes cleanly to `Table Choice` with `options: null`.

### Step 6: Automated Test Suite & Production Build
**Files:** `scripts/test-table-choice.mjs` (new), `package.json` (`test:table-choice`)
- Add `scripts/test-table-choice.mjs` testing:
  1. `normalizeQuestionStyle('table_choice')` and `Table Choice` precedence over `options`.
  2. `tableChoiceUtils` round-trip parse & serialize (`Upaya` + `Tepat / Tidak Tepat`).
  3. `pdfProcessor.normalizeQuestionStyles` fixing `Tepat | Tidak Tepat` matrix tables with leftover `A. Tepat, ...` options.
  4. `deterministicGradingService` full credit (`3/3`), partial credit (`2/3`), and `0/3` on `Table Choice` submissions.
- Run `npm run test:table-choice` and `npm run build` (`tsc -b && vite build`).
