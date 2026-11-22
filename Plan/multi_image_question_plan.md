# Multi-Image Questions & MC Option Diagrams Plan

## Goal
Support **multiple images/diagrams per question stem and sub-question** as well as **per-option images/diagrams on Multiple Choice (`Multiple Choice`) and Multiple Select (`Multiple Select`) choices (`A`, `B`, `C`, `D`, `E`, …)** end-to-end across extraction, editing, question bank storage, student exam delivery (including live pre-warmed student RPCs), grading, and PDF/DOCX export.

## Architecture & Zero-Migration Persistence
1. **Types (`src/types/database.ts`)**
   - Add `diagram_urls?: string[] | null` and `option_diagrams?: (string | null)[] | null` to `Question`, `SubQuestion`, and `ExtractedQuestion`.
   - Extend `normalizeQuestionStyle(style, options, optionDiagrams)` so image-only MC choices (where option text is blank and `option_diagrams[idx]` is populated) are recognized accurately.
2. **Centralized Diagram Serialization & Resolution (`src/utils/questionDiagramUtils.ts`)**
   - `parseDiagramColumnValue(raw)`: unpacks plain URL strings (single legacy image), JSON string arrays, or structured JSON envelopes (`{"urls": [...], "optUrls": [...]}`).
   - `serializeQuestionDiagramsForColumn(diagramUrls, optionDiagrams)`:
     - Single stem image with no option images -> plain URL string (100% backward compatible).
     - `2+` stem images or any `option_diagrams` -> compact JSON string stored in `public.questions.diagram_url` (`TEXT`), which passes untouched through Postgres `sanitize_question_json_for_student` even when `mark_scheme` is stripped to `null`.
   - `resolveQuestionDiagramUrls(q)` / `resolveOptionDiagramUrls(q)` / `resolveOptionDiagramUrl(q, idx, optText)`: merges explicit arrays, packed `diagram_url` envelopes, `_diagram_urls` / `_option_diagrams` in `mark_scheme`, and optional inline Markdown `![alt](url)` image tokens.
3. **Database Service & PDF Pipeline (`src/services/questionBankService.ts`, `src/lib/pdfProcessor.ts`)**
   - `normalizeQuestionRecord(raw)` unpacks `diagram_url` (always plain primary URL string in memory), `diagram_urls`, and `option_diagrams` on both parent questions and `sub_questions`.
   - `createQuestion`, `updateQuestion`, and `saveExtractedQuestions` serialize stem + MC option diagrams into `diagram_url` and mirror `_diagram_urls` / `_option_diagrams` in `mark_scheme` JSONB.

## UI, Exam Delivery, Grading & Exports
1. **Question Editor (`src/components/QuestionEditorModal.tsx`)**
   - Multi-image gallery (`Figure 1`, `Figure 2`, …) with upload/crop, reorder (`←` / `→`), fine-tune crop, URL editing, and delete.
   - Per-option diagram upload/crop/URL/paste/preview/remove controls on every MC choice row (`A`, `B`, …), with synchronized `options` and `optionDiagrams` arrays supporting image-only choices.
   - Multi-image & per-option controls for structured sub-questions.
2. **Extraction Review (`src/components/ExtractionReview.tsx`)**
   - `+ 📸 Add Another Diagram` on parent stems and sub-questions.
   - `+ 📸 Crop Option Diagram` on MC choices (`A`, `B`, …) cropping directly from QP / Insert PDFs into `diagramData` keys `${qNum}__opt_${oi}` and `${qNum}__img_${i}`.
3. **Student Quiz Runner (`src/pages/StudentQuizRunner.tsx` & `.css`)**
   - Render all stem and sub-question diagrams in vertical stacks with candidate watermark and click-to-zoom lightbox.
   - Render per-option diagrams inside `.sq-choice-btn` (switching `.sq-choices-list` to a responsive 2-column grid when choices carry images, with dedicated corner zoom button `🔍` that stops click propagation).
   - Render multi-images and option images in post-submit review and quick sidebar choices.
4. **Deterministic Grading (`src/services/deterministicGradingService.ts`)**
   - Ensure image-only MC choices grade cleanly by option index/letter (`A`–`Z`) and format model answers gracefully without empty-text artifacts.
5. **Question Bank Cards, Modals & Exports**
   - Update `QuestionCard.tsx`, `QuestionDetailModal.tsx`, `pdfExportService.ts`, `docxExportService.ts`, `htmlQuizExportService.ts`, `backupService.ts`, and `restoreService.ts`.

## Verification
- Automated script `scripts/test-multi-image-questions.mjs` covering serialization round-trips, RPC `mark_scheme: null` survival, image-only MC option preservation, and deterministic MC grading.
- `npm run lint` and `npm run build`.
