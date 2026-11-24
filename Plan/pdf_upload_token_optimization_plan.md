# PDF Upload Token Optimization & Extraction Accuracy Plan (#1 + #2)

## Goal
Reduce Gemini input token consumption during PDF upload/extraction and improve question-to-mark-scheme alignment by:
1. **Per-chunk Mark Scheme slicing & text-first routing** (eliminating `N×` full-MS duplication across parallel chunks).
2. **Stripping zero-value Question Paper pages** (blank pages, additional lined pages, periodic tables / formula sheets, and optional cover sheets) before chunking — while strictly preserving original 1-indexed PDF page numbers for diagram cropping.

---

## Part 1: Per-Chunk Mark Scheme Slicing & Text-First Routing

### Current Bottleneck
In `src/lib/pdfProcessor.ts`, `chunks.map(...)` passes the entire `msBase64` PDF to every parallel `extractQuestionsFromPdf(...)` call. A 15-page Mark Scheme across 5 Question Paper chunks bills `75` PDF pages and forces Gemini to scan unrelated questions on every chunk.

### Implementation Steps

1. **Create `src/lib/markSchemeSlice.ts` (pure logic + PDF/text slicer)**
   - **Page-to-question-number index:** Given `msPageTexts: string[]` (read once via `pdfjs-dist`), scan each MS page for leading question numbers (e.g., `^(\d{1,2})(?:\s*\([a-z]\)|\s*[.)]|\s+)`) to build `Map<number, number[]>` (question number → 1-indexed MS page numbers) plus detect any shared rubric/level-of-response pages (`rubricPage` from `trimMarkSchemePreamble`).
   - **Chunk question-range resolution:** For each QP chunk (`startPage..endPage`), determine its expected question numbers from:
     - `outline` (from `tryBuildPaperOutline`) when available, or
     - fallback regex scan of the chunk's own `qpPageTexts[startPage - 1 .. endPage - 1]`.
   - **Safe slice selection (`selectMarkSchemePagesForChunk`):**
     - Collect all MS pages matching the chunk's question numbers, plus ±1 neighbor buffer page if a question straddles a page boundary, plus any `rubricPage` (required for Humanities level-of-response grids).
     - **Safety fallback:** If fewer than 1 MS page matches (e.g., scanned image-only MS with no selectable text, or ambiguous numbering), fall back cleanly to the full trimmed `msBase64` so accuracy is never degraded.
   - **Text-first vs. PDF/Image decision (`canUseTextMarkScheme`):**
     - Check whether the selected MS pages have:
       - sufficient selectable text density (e.g., `>= 80` chars/page average),
       - **no** Arabic script (`!containsArabicScript(text)` — Arabic keeps visual PNG routing),
       - **no** embedded images/diagrams (via `page.getOperatorList()` checking `OPS.paintImageXObject` / `OPS.paintInlineImageXObject`).
     - If all checks pass: serialize the sliced MS pages into clean structured plain text (`--- Mark Scheme Page N ---\n...`) — ~70–90% fewer tokens than PDF vision tokens.
     - Otherwise: slice only the selected MS pages into a smaller `chunkMsBase64` PDF via `pdf-lib` (or sliced `msPageImages` for Arabic).

2. **Extend `buildGeminiMultimodalParts` in `src/lib/gemini.ts`**
   - Add optional `markSchemeText?: string` parameter (and pass-through in `extractQuestionsFromPdf` options).
   - Priority order for `DOCUMENT 3: OFFICIAL MARK SCHEME`:
     1. `msPageImages` (Arabic visual PNGs)
     2. `markSchemeText` (clean sliced text/Markdown — zero PDF vision tokens)
     3. `markSchemeBase64` (sliced or full PDF fallback)

3. **Wire per-chunk MS slicing in `src/lib/pdfProcessor.ts`**
   - Compute MS page texts and image-presence flags **once** per upload (after `trimMarkSchemePreamble`).
   - Inside `chunks.map(...)`, resolve `{ chunkMsBase64, chunkMsText, chunkMsPageImages }` for each chunk instead of passing the full `msBase64` to every chunk.
   - Log token-saving telemetry in console (`e.g. [MS Slice] Chunk 2 (Q5–Q8): 3/15 pages as text`).

---

## Part 2: Strip Zero-Value Question Paper Pages Before Chunking

### Current Bottleneck
Cambridge / IGCSE / national exam PDFs often contain 2–5 non-question pages (`BLANK PAGE`, `Additional Page`, `The Periodic Table of Elements`, `Formulae Sheet`, and cover-only instruction pages). Sending them to Gemini wastes 15–25% of QP tokens and introduces noise.

### Critical Invariant: Preserve Original PDF Page Numbers
`diagramCropper.ts` crops diagrams from the **original uploaded PDF** using `question.page_number` (1-indexed). If we drop pages from a chunk PDF without mapping back, `page_number` would shift and diagrams would crop the wrong page.

### Implementation Steps

1. **Create `src/lib/pdfPageFilter.ts` (pure classifier)**
   - Classify each page from its `pdfjs-dist` text (and optional image count) as `keep` or `drop` with a reason:
     - `blank`: matches `/\bblank\s+page\b/i` or `< 25` non-whitespace chars and 0 images.
     - `additional_page`: matches `/\badditional\s+page\b/i` with no question prompts.
     - `reference_sheet`: matches Periodic Table (`/\bperiodic\s+table\s+of\s+elements\b/i` or `/\bgroup\b.*\blanthanoids\b/i`) or standalone formula/data sheet at the back of the paper (only on trailing pages with no numbered question prompts).
     - `cover_only`: Page 1 **only** when it contains exam instructions/cover boilerplate (`READ THESE INSTRUCTIONS FIRST`, `INSTRUCTIONS`, `INFORMATION`, `Candidate Name`, `Centre Number`) **and** contains zero numbered questions (`1.`, `1 (a)`, etc.).
       - **Important:** Keep Page 1 metadata extraction intact — read paper metadata (subject code, year, session, total marks) from Page 1 text *before* dropping it, and inject that short metadata header into Chunk 0's prompt (or keep Page 1 if it's a SaveMyExams cover or has `< 3` total pages).
   - **Conservative guard:** Never drop a page if it has embedded images/diagrams (unless explicitly matched as `The Periodic Table of Elements` or `BLANK PAGE`) or if it contains numbered question markers.

2. **Track original page mapping in `PdfChunk` (`src/lib/pdfChunker.ts`)**
   - Add `sourcePageNumbers?: number[]` to `PdfChunk` (e.g., `[2, 3, 5, 6]` when Page 1 cover and Page 4 blank were dropped).
   - When building each chunk PDF with `pdf-lib`, copy only the kept `sourcePageNumbers` indices.
   - In `pdfProcessor.ts` post-processing, remap each extracted question's chunk-relative `page_number` (`1..chunkPages.length`) back to the **original PDF 1-indexed page number** via `chunk.sourcePageNumbers[relPage - 1]` (replacing the simple `chunk.startPage + relPage - 1` arithmetic).

---

## Verification Plan
1. **Unit test suite (`scripts/test-pdf-upload-optimization.mjs`):**
   - `markSchemeSlice`: verifies question-range matching, ±1 boundary buffer, Humanities `rubricPage` preservation, Arabic/image-MS fallback to visual/PDF, and text-only MS routing.
   - `pdfPageFilter`: verifies `BLANK PAGE`, `Additional Page`, `Periodic Table`, and cover-only Page 1 detection; verifies pages with questions or diagrams are never dropped.
   - `sourcePageNumbers` remapping: verifies chunk-relative `page_number` maps accurately back to original PDF page numbers for `diagramCropper.ts` when middle/front pages are dropped.
2. **Regression & build checks:**
   - `npm run lint` (0 errors)
   - `npm run build` (`tsc -b && vite build`)
   - Existing extraction tests (`npm run test:mark-scheme`, `npm run test:languages-bidi`, `npm run test:multi-image`).
