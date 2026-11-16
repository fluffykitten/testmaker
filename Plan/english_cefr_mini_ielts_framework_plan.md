# Mini-IELTS & CEFR English Exam Framework Plan

**Location:** `Plan/english_cefr_mini_ielts_framework_plan.md`  
**Status:** Proposed for review (`isIeltsCefr` option inside `Languages` domain)  
**Scope:** End-to-end support for multi-skill English proficiency papers (Listening, Reading, Writing; Speaking excluded) modeled on the ICM CEFR / Mini-IELTS test paper (`media_1794809850170_44dac862.pdf`).

---

## 1. Architecture Decision: `IELTS / CEFR` Option Inside `Languages`

Instead of adding a 4th top-level domain button, `domain` stays `'stem' | 'humanities' | 'languages'`, and **`Languages` gets a dedicated `isIeltsCefr` processing-profile toggle** (mirroring how `Save My Exams / PMA` works inside `STEM` at [`PdfUpload.tsx:525-544`](file:///c:/testmaker/src/components/PdfUpload.tsx#L525-L544)):

- **Zero regression risk:** `STEM` (`getStemExtractionPrompt`), `Humanities` (`getHumanitiesExtractionPrompt`), and default `Languages` (`getLanguageExtractionPrompt`, used for Indonesian TKA / AKM / Bahasa & standard single-skill English) stay **100% unchanged**.
- **Auto-activated or manual:** Dropping a CEFR / IELTS PDF switches `domain` to `'languages'` and automatically enables `isIeltsCefr` (with a clear toggle switch under `Processing Profile` so the teacher can turn it on/off manually).
- **Minimal plumbing:** `isIeltsCefr?: boolean` flows alongside `isSaveMyExams?: boolean` through `PdfUpload.tsx` -> `UploadPage.tsx` -> `pdfProcessor.ts` -> `gemini.ts` -> `src/lib/ieltsPrompt.ts`.

---

## 2. Summary of Empirical Findings on the Sample Paper

Running the 23-page CEFR English PDF (`media_1794809850170_44dac862.pdf`) through `extractQuestionsFromPdf` (`domain: 'languages'`, `gemini-3.5-flash-lite` via `VITE_GEMINI_FREE_API_KEY`) and inspecting the runner/grading code identified six concrete gaps:

1. **No Auto-Detection for English / CEFR / IELTS Papers (`src/lib/subjectClassifier.ts`):** Only Humanities and STEM syllabus codes are registered. Dropping an IELTS/CEFR PDF keeps `domain = 'stem'` unless manually switched.
2. **Cross-Section Question Number Collision (`src/lib/pdfProcessor.ts:812-855`):** The paper numbers Listening `1–20` and then restarts Reading at `1–22`. Because chunk merging keys `questionMap` by bare question number (`"1"`, `"11"`..`"20"`), 12 Reading questions collided with Listening questions (`35` extracted items collapsed into `23`).
3. **T/F/NG and Section Matching (`A–G`) Extracted Without Options (`src/lib/gemini.ts:1068-1299`):** `getLanguageExtractionPrompt` has no rule converting `TRUE / FALSE / NOT GIVEN` (Reading Q7–13) or `Write the correct letter, A–G` (Reading Q14–17) into `Multiple Choice` options. Both extracted as `Structured` (`options: null`), rendering as a 5-row `<textarea>` in the exam runner instead of clickable choice buttons.
4. **Paired "Choose TWO letters, A–E" Split & All-or-Nothing Grading (`src/services/deterministicGradingService.ts:1275-1300`):** Listening Q15–16, Q17–18, and Q19–20 were split into a `2-mark` question plus a duplicate `0-mark` placeholder, and `Multiple Select` grading awards `0/2` if a student selects 1 correct letter out of 2.
5. **Summary Completion Snippet Bleed & Stacked Reading Layout (`src/pages/StudentQuizRunner.tsx:6800-6845`):** Reading Q18–22 extracted as 5 separate items where Q21 leaked `[22]` into its stem (`inlineGaps=2`), and the 5,463-character Reading Passage renders stacked above every question instead of in a side-by-side scrollable split pane.
6. **Writing UX & Missing IELTS Band / CEFR Scoring (`src/pages/StudentQuizRunner.tsx:7344-7413`, `src/utils/gradeThresholdUtils.ts`):** The Writing task renders a small `rows={5}` textarea with STEM LaTeX footer hints (`"LaTeX math supported with $...$"`), and final results only compute a raw percentage + `A*–U` grade rather than per-skill IELTS Bands (`4.0–9.0`), `0.25`/`0.75` band rounding, and CEFR levels (`A1–C2`).

---

## 3. Step-by-Step Implementation Plan

Each step is small, self-contained, and independently verifiable.

---

### Step 1: Add `isIeltsCefr` Option in `Languages`, Cover Auto-Detection & Page Trimming

**Goal:** Add the `IELTS / CEFR Multi-Skill` toggle inside `Processing Profile` when `domain === 'languages'`, auto-detect English / CEFR / IELTS covers in `subjectClassifier`, and trim trailing Speaking/Rubric appendix pages (`pp. 17–23`) before chunking.

**Files to Modify:**
- [`src/lib/subjectClassifier.ts`](file:///c:/testmaker/src/lib/subjectClassifier.ts)
- [`src/components/PdfUpload.tsx`](file:///c:/testmaker/src/components/PdfUpload.tsx#L525-L545)
- [`src/pages/UploadPage.tsx`](file:///c:/testmaker/src/pages/UploadPage.tsx#L142-L156)
- [`src/lib/pdfChunker.ts`](file:///c:/testmaker/src/lib/pdfChunker.ts#L194-L230)

**Changes:**
1. In `subjectClassifier.ts`:
   - Register English syllabi (`0500`, `0510`, `0511`, `1123`, `9093`) under `domain: 'languages'`.
   - Add an IELTS / CEFR multi-skill detector (`/\b(?:CEFR\s+Test|IELTS|Listening\s+Scoring\s+Rubrics|Reading\s+Passage\s+1)\b/i`) returning `{ syllabusCode: 'IELTS', subjectName: 'English (IELTS / CEFR)', domain: 'languages' }` (with `isIeltsCefr` flag / check).
2. In `PdfUpload.tsx`:
   - Add `const [isIeltsCefr, setIsIeltsCefr] = useState(false);` and pass `isIeltsCefr` in `onFilesSelected` options when `domain === 'languages'`.
   - Inside `detectSubject`, when `match?.syllabusCode === 'IELTS'` (or cover matches CEFR/IELTS), switch `domain` to `'languages'` and set `isIeltsCefr(true)`.
   - Inside `Processing Profile` (`{domain === 'languages' && (...)}`), render a toggle card **`IELTS / CEFR Multi-Skill`** (*"Separate Listening, Reading & Writing sections, T/F/NG buttons & band rubrics"*), keeping `domain` segmented control cleanly at 3 buttons (`STEM | Humanities | Languages`).
3. In `UploadPage.tsx` & `pdfProcessor.ts`:
   - Forward `isIeltsCefr?: boolean` inside `UploadPage.handleFilesSelected` and `ExtractionPipelineOptions`.
4. In `pdfChunker.ts:194-230` (`detectEffectiveQuestionPageCount`):
   - Exclude trailing rubric/scoring appendix pages (`Listening Scoring Rubrics`, `Reading Scoring Rubrics`, `Writing Rubrics`, `Speaking rubrics`, `CEFR Description`) and `SPEAKING`-only end pages so pages 17–23 are trimmed before chunking.

**Verification:**
- Run `tsc -b` to confirm types compile cleanly.
- Unit test verifying `classifySubject` on the CEFR cover text returns `domain: 'languages'` + IELTS detection, and `detectEffectiveQuestionPageCount` trims pages 17–23 (`effectiveEnd = 16`).

---

### Step 2: Dedicated `src/lib/ieltsPrompt.ts` & Section-Scoped Merge Keys

**Goal:** Create an isolated IELTS / CEFR extraction prompt used only when `domain === 'languages' && isIeltsCefr` (leaving `getLanguageExtractionPrompt` untouched for TKA / Bahasa / general English), and namespace question keys by skill section (`L`, `R`, `W`) during multi-chunk merging.

**Files to Create / Modify:**
- `src/lib/ieltsPrompt.ts` (new pure prompt builder, mirroring `src/lib/humanitiesPrompt.ts`)
- [`src/lib/gemini.ts`](file:///c:/testmaker/src/lib/gemini.ts#L1304-L1329)
- [`src/lib/pdfProcessor.ts`](file:///c:/testmaker/src/lib/pdfProcessor.ts#L781-L855)

**Changes:**
1. Create `src/lib/ieltsPrompt.ts` exporting `getIeltsCefrExtractionPrompt(includeGuidance: boolean = true): string`:
   - **Listening Section (`topic` starts with `"Listening - ..."`):**
     - Prefix `question_number` with `"L"` (e.g., `"L1-10"` for boxed Note/Form Completion, `"L11"`..`"L14"` for MCQ, `"L15-16"`, `"L17-18"`, `"L19-20"` for paired 2-mark `Choose TWO letters, A–E` `Multiple Select` items — never duplicating a 0-mark pair).
     - Keep boxed Note/Form completions as a cohesive `Fill in the Blank` block preserving verbatim word-limit instructions (*"Write ONE WORD AND/OR A NUMBER for each answer."*) and numbered inline blanks `[1]`..`[10]`.
   - **Reading Section (`topic` starts with `"Reading - ..."`):**
     - Prefix `question_number` with `"R"` (e.g., `"R1-6"` for Note Completion, `"R7"`..`"R13"` for T/F/NG, `"R14"`..`"R17"` for Paragraph Matching, `"R18-22"` for boxed Summary Completion).
     - Extract full Passages into root `passages[]` (`"Passage 1"`, `"Passage 2"`) verbatim including section labels `A`–`G`, and link via `passage_ref`.
     - Extract **`TRUE / FALSE / NOT GIVEN`** (and `YES / NO / NOT GIVEN`) as `question_style: "Multiple Choice"` with `options: ["A. TRUE", "B. FALSE", "C. NOT GIVEN"]`.
     - Extract **Paragraph Matching (`A–G`)** as `question_style: "Multiple Choice"` with `options: ["A. Section A", ..., "G. Section G"]`.
     - Keep **Summary Completion** (`R18-22`) as one cohesive `Fill in the Blank` card containing only gaps `[18]..[22]` (eliminating cross-question snippet bleed).
   - **Writing Section (`topic` starts with `"Writing - ..."`):**
     - Extract Writing Task prompt verbatim as `"W1"`, `question_style: "Structured"`, `total_marks: 40` (or `9`), preserving word-count instruction (*"Write at least 250 words."*) and attaching the 4 IELTS criteria (`Task Achievement [10]`, `Coherence and Cohesion [10]`, `Lexical Resource [10]`, `Grammatical Range and Accuracy [10]`) in `mark_scheme.marking_points`.
   - **Exclusion Rules:** Strictly skip `SPEAKING` sections and scoring rubric / CEFR band conversion pages.
2. Wire `if (domain === 'languages' && isIeltsCefr) return getIeltsCefrExtractionPrompt(includeGuidance);` inside `getExtractionPrompt` (`gemini.ts:1304-1329`, matching how `isSaveMyExams` dispatches inside `domain === 'stem'`).
3. In [`src/lib/pdfProcessor.ts:812-855`](file:///c:/testmaker/src/lib/pdfProcessor.ts#L812-L855), when `isIeltsCefr` (or whenever skill prefixes `L`/`R`/`W` are present), key `questionMap` by `${skillPrefix}::${qNumClean}` so Listening `1–20` and Reading `1–22` never collide across parallel chunks.

**Verification:**
- Run the Node extraction harness with `domain: 'languages', isIeltsCefr: true` and `VITE_GEMINI_FREE_API_KEY` on `media_1794809850170_44dac862.pdf` and verify:
  - 0 collisions across chunks.
  - Listening (`L1-10`, `L11..L14`, `L15-16`, `L17-18`, `L19-20` = 20 marks), Reading (`R1-6`, `R7..R13` T/F/NG MCQ, `R14..R17` `A–G` MCQ, `R18-22` summary = 22 marks), and Writing (`W1`) all extract cleanly, with Speaking skipped.
  - Default `Languages` (`isIeltsCefr: false`), `Humanities`, and `STEM` prompts are unchanged.

---

### Step 3: Deterministic Grader Enhancements for IELTS Rules

**Goal:** Grade multi-gap summaries (`[18]..[22]`), word-limit constraints (`ONE WORD ONLY`), and 2-mark `Choose TWO letters` questions accurately.

**Files to Modify:**
- [`src/services/deterministicGradingService.ts`](file:///c:/testmaker/src/services/deterministicGradingService.ts)
- [`src/lib/inlineGapParser.ts`](file:///c:/testmaker/src/lib/inlineGapParser.ts)

**Changes:**
1. **Partial Credit for Paired Multi-Select (`Choose TWO letters`):**
   - In [`deterministicGradingService.ts:1275-1312`](file:///c:/testmaker/src/services/deterministicGradingService.ts#L1275-L1312), when `multiTargetLetters.length === 2` and `maxMarks === 2` (and the student selects at most 2 options), award `1 mark` per correct letter selected (`correctSelected.length`), rather than forcing `0/2` when 1 of 2 is right. Selecting >2 options still scores `0` to prevent ticking all 5 letters.
2. **Word-Count & Exact Spelling Enforcement on IELTS Gap Fills:**
   - Parse word-limit rules from `question.question_text`:
     - `ONE WORD ONLY` -> reject student gap answers containing `> 1` word or digits.
     - `ONE WORD AND/OR A NUMBER` -> allow 1 word, 1 number, or 1 word + 1 number (`<= 2` tokens).
   - For `Fill in the Blank` items that explicitly carry an IELTS word-limit rule, require exact match against `expectedList` (case-insensitive) instead of allowing 1-char Levenshtein typo tolerance or multi-word substring matches.
3. **Preserve Explicit Gap Numbers (`[18]`..`[22]`):**
   - Confirm `parseGapSegments` ([`src/lib/inlineGapParser.ts:119-145`](file:///c:/testmaker/src/lib/inlineGapParser.ts#L119-L145)) and `extractGapExpectedMap` resolve explicit bracket numbers `[18]..[22]` against `[18] fortress` in `mark_scheme`.

**Verification:**
- Unit test `scripts/test-ielts-deterministic-grading.mjs`:
  - `Choose TWO letters` (`A, E` target): `A, C` -> `1/2`; `A, E` -> `2/2`; `A, B, C, D, E` -> `0/2`.
  - `ONE WORD ONLY` (`[1] population`): `"population"` -> `1/1`; `"the population"` -> `0/1`; `"populashun"` -> `0/1`.
  - Non-1-based gaps `[18]..[22]` -> `5/5`.

---

### Step 4: Exam Runner UX for Reading Split-Pane, Writing Editor & Audio Limit

**Goal:** Give students an authentic computer-delivered IELTS experience inside `StudentQuizRunner`.

**Files to Modify:**
- [`src/pages/StudentQuizRunner.tsx`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx)
- [`src/pages/StudentQuizRunner.css`](file:///c:/testmaker/src/pages/StudentQuizRunner.css)
- [`src/components/BatchAudioModal.tsx`](file:///c:/testmaker/src/components/BatchAudioModal.tsx)

**Changes:**
1. **Side-by-Side Reading Passage Split Pane (`StudentQuizRunner.tsx` & `.css`):**
   - When `activeReadingPassage` is present on desktop (`> 1024px`), add a view toggle in the `.sq-stimulus-card` header (`Split View` / `Stacked View`, defaulting to **Split View** for passages `>= 800` chars).
   - In Split View, `.sq-question-card` renders a 2-column grid (`minmax(380px, 1.05fr) minmax(360px, 0.95fr)`):
     - **Left Pane:** Independently scrollable sticky `Reference Reading Passage` (`max-height: calc(100vh - 210px)`, `overflow-y: auto`).
     - **Right Pane:** Independently scrollable Question Prompt + Inputs (`InlineGapText`, `MCQ`, etc.).
   - Automatically stacks back to single column below `1024px`.
2. **Writing Task Editor Mode (`StudentQuizRunner.tsx:7344-7415`):**
   - Detect minimum word-count instructions in `promptText` (e.g., `/write\s+at\s+least\s+(\d+)\s+words/i` -> `minWords = 250`).
   - When `minWords` is present (or it is an extended Language Writing task):
     - Render `<textarea rows={14}>`.
     - Display target progress badge: `142 / 250+ words • 810 chars` (amber below `minWords`, green at/above `minWords`).
     - Hide `"LaTeX math supported with $...$"` and hide the duplicate `Live Response & Formula Preview` card.
3. **1-Play Official IELTS Preset (`BatchAudioModal.tsx`):**
   - Set `handleAutoDivideIelts` in [`src/components/BatchAudioModal.tsx:186-215`](file:///c:/testmaker/src/components/BatchAudioModal.tsx#L186-L215) to default `play_limit: 1` (while keeping `2 Plays` selectable in Audio Settings).

**Verification:**
- Browser / DOM check confirming Split View renders side-by-side >1024px and stacks <=1024px, and Writing shows `X / 250+ words` without LaTeX hints.

---

### Step 5: AI Writing Rubric Breakdown & IELTS Band / CEFR Scoring Engine

**Goal:** Compute Listening Band + Reading Band + Writing 4-Criterion Band -> Rounded Overall IELTS Band (`0.0–9.0`) + CEFR Level (`A1–C2`) matching pages 18–23 of the paper.

**Files to Create / Modify:**
- `src/utils/ieltsScoringUtils.ts` (new pure module)
- [`src/services/aiGradingService.ts`](file:///c:/testmaker/src/services/aiGradingService.ts)
- [`src/components/QuizResultsModal.tsx`](file:///c:/testmaker/src/components/QuizResultsModal.tsx)
- [`src/components/StudentResultModal.tsx`](file:///c:/testmaker/src/components/StudentResultModal.tsx)

**Changes:**
1. **Create `src/utils/ieltsScoringUtils.ts`:**
   - **Listening & Reading Band Lookup (PDF p. 18):** Converts raw score (`Skor Mentah`) to IELTS Band `4.0–9.0` (scaling proportionally when a mini-IELTS test uses `< 40` questions per skill, e.g., `20` Listening marks or `22` Reading marks -> `raw / max * 40`, plus exact Band `1.0–3.5` lower-end fallbacks).
   - **Writing Band Calculation (PDF p. 19):** Converts the 4 criteria (`Task Achievement`, `Coherence and Cohesion`, `Lexical Resource`, `Grammatical Range and Accuracy`, 25% each) to `0.0–9.0` rounded to `0.5`.
   - **Overall Band Rounding (PDF p. 20):** Averages active skill bands and rounds to nearest `0.5` (`6.25 -> 6.5`, `6.75 -> 7.0`, `7.375 -> 7.5`).
   - **CEFR Mapping (PDF pp. 21–23):** `8.5–9.0 -> C2`, `7.0–8.0 -> C1`, `5.5–6.5 -> B2`, `4.0–5.0 -> B1`, `3.0–3.5 -> A2`, `1.0–2.5 -> A1`.
2. **Enhance AI Writing Examiner Prompt (`src/services/aiGradingService.ts`):**
   - Include actual student word count (`getWordCount`) when evaluating Writing prompts with `at least N words`, instructing the examiner to enforce `Task Achievement` penalties when under length and return per-criterion breakdowns.
3. **IELTS & CEFR Results Summary (`QuizResultsModal.tsx` & `StudentResultModal.tsx`):**
   - When a quiz contains Listening/Reading/Writing sections (`topic` prefixes `Listening`/`Reading`/`Writing`), display an **IELTS & CEFR Proficiency Summary** card showing Listening Band, Reading Band, Writing Band, Rounded Overall Band, and CEFR Level + descriptor alongside raw marks.

**Verification:**
- Unit test `scripts/test-ielts-cefr-scoring.mjs` verifying all rounding examples from PDF p. 20 (`6.25 -> 6.5`, `6.75 -> 7.0`, `7.375 -> 7.5`), CEFR boundaries (`A1–C2`), and 3-skill mini-IELTS aggregation without Speaking.
