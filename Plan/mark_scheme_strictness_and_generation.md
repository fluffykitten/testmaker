# Mark Scheme Extraction Strictness & Vision-Aware Mark Scheme Generation

## Problem Statement
1. **Mark Scheme Misalignment During Extraction:**
   - `callGeminiModel` sent multiple PDFs (`pdfBase64`, `insertBase64`, `markSchemeBase64`) as unlabeled raw blobs without explicit document boundary markers.
   - `extractQuestionsFromPdf` only threaded `hasMarkScheme` into `getCambridgePracticalExtractionPrompt`, while `getExtractionPrompt` (STEM, Languages, Humanities, IELTS/CEFR, Save My Exams) ignored whether an official Mark Scheme PDF was present and still permitted Gemini to invent/blend its own solved answers.
   - Post-extraction merge across overlapping 8-page chunks blindly replaced `existing.mark_scheme` with `adjustedQ.mark_scheme` when non-empty and picked sub-question mark schemes by string length alone.
   - `detectMarkSchemeTableStart` used the `\b\d\s*\(\s*[a-h]\s*\)` fallback unconditionally, which could drop Page 1 of a custom multi-page mark scheme if Page 1 contained MCQ keys and Page 2 introduced `1(a)`. `inspectInDocumentAnswerKey` matched `"mark scheme for"` even mid-prose on question pages and lacked Indonesian rubric headers such as `Pedoman Penskoran` / `Rubrik Penilaian`.
   - Zero post-extraction verification checked for missing mark schemes, `[1]` mark-tag sum parity, MCQ/Multi-Select answer letters, or `Table Choice` row alignment.

2. **Mark Scheme Generation & Enrichment Gaps:**
   - Single-pass extraction could leave missing/incomplete mark schemes on hard diagram questions.
   - `enrichQuestionWithGuidance` only generated `guidance` and `common_misconceptions`, never `marking_points` / `acceptable_answers`, was blind to `diagram_url`, matched sub-questions strictly with `pSq.sub_id === sq.sub_id`, and lacked multi-key failover or `AbortController` timeouts.

## Architecture & Changes Implemented
- **`src/lib/markSchemeDetect.ts` & `src/lib/pdfChunker.ts`:**
  - Guard `part-label` preamble trimming against non-Cambridge documents and early MCQ answer keys while preserving 100% compatibility with `scripts/verify-phase4.mjs`.
  - Add `isAnswerKeyStartPageText()` to inspect the page heading zone with broader Indonesian/English rubric headings and prose negative guards.
- **`src/lib/markSchemeAudit.ts` (Pure Module):**
  - `normalizeSubIdKey`, `isPlaceholderMarkSchemeText`, `hasAiFallbackTag`, `sumBracketedMarks`, `extractOptionLettersFromMarkScheme`
  - `auditQuestionMarkScheme` & `auditExtractionMarkSchemes` (style-aware verification across parent and sub-questions)
  - `chooseBetterMarkScheme` & `chooseBetterSubMarkScheme` (smart chunk merge preserving underscore metadata keys)
  - `buildMarkSchemeStrictnessBlock` (shared strict extraction vs autonomous synthesis prompt rules)
- **`src/lib/gemini.ts`, `src/lib/humanitiesPrompt.ts`, `src/lib/ieltsPrompt.ts`, `src/lib/practicalPrompt.ts`, `src/lib/pdfProcessor.ts`:**
  - Label PDF parts explicitly in `buildGeminiMultimodalParts` (`DOCUMENT 1: QUESTION PAPER`, `DOCUMENT 2: INSERT`, `DOCUMENT 3: OFFICIAL MARK SCHEME`).
  - Thread `hasMarkScheme` into all prompt builders with explicit non-override rules and `[NOT IN MARK SCHEME — AI SOLVED]` fallback tagging.
  - Upgrade `pdfProcessor.ts` chunk merge to use `chooseBetterMarkScheme` / `chooseBetterSubMarkScheme` and expose `{ msBase64, hasMarkScheme }`.
  - Add vision-aware `generateQuestionMarkScheme()` (Official MS Re-Align mode + AI Generate mode) and upgrade `enrichQuestionWithGuidance()` with vision support, normalized `sub_id` matching, key rotation, and timeouts.
- **UI (`UploadPage.tsx`, `ExtractionReview.tsx` + `.css`, `QuestionEditorModal.tsx`, `QuestionDetailModal.tsx`):**
  - Surface Mark Scheme QA summary and per-card warnings in `ExtractionReview`, plus 1-click **Re-align from MS** / **Generate MS** actions.
  - Add QA audit pill + AI Generate / Re-align Mark Scheme toolbar in `QuestionEditorModal` (Mark Scheme tab).
  - Add inline MS Audit badge + two-click overwrite-guarded **Generate / Regenerate Mark Scheme** button in `QuestionDetailModal`.
- **Verification (`scripts/test-mark-scheme-strictness.mjs`):**
  - Automated checks for multimodal part labeling, prompt strictness across all domains, preamble/answer-key guards, `markSchemeAudit`, and chunk-merge preservation.
