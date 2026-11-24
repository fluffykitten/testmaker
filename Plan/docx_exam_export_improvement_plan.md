# DOCX Exam Export Improvement Plan

> **Audit Target**: `c:\Users\itsaf\Downloads\Grade_10_Essay_Only_Student_Paper.docx`
> **Primary Source Module**: [docxExportService.ts](file:///c:/testmaker/src/services/docxExportService.ts)
> **Goal**: Make every exported Word assessment (`exportStudentPaperDocx`, `exportAnswerBookletDocx`, `exportTeacherMarkSchemeDocx`, `exportMcqAnswerSheetDocx`, `exportInsertBookletDocx`) print-faithful in Microsoft Word, LibreOffice Writer, and Google Docs with zero image distortion, zero raw Markdown/LaTeX/newline leaks, and properly formatted OOXML tables & Word OMML math.

---

## 1. Empirical Audit Summary (`Grade_10_Essay_Only_Student_Paper.docx`)

Inspecting `word/document.xml`, `word/_rels/document.xml.rels`, and all 10 `word/media/*` binaries directly exposed four categories of defects:

### 1.1 Pictures & Embedded Media (`10` drawings audited)
`loadImageData()` ([docxExportService.ts:53-79](file:///c:/testmaker/src/services/docxExportService.ts#L53-L79)) ignores true pixel dimensions and returns fixed `width: 380, height: 220` (`340×180` for sub-questions, `170×42` / `190×42` for cover logos), while tagging all binary payloads as `type: 'png'`:

| Rel ID | Rendered (`px`) | Rendered Ratio | Actual Pixels | Binary Format | Actual Ratio | Aspect Distortion |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `rId10` (School logo) | `170×42` | `4.048` | `222×71` | `png` | `3.127` | `1.29×` stretched |
| `rId11` (Cambridge logo) | `190×42` | `4.524` | `215×64` | `png` | `3.359` | `1.35×` stretched |
| `rId12` (Q4 diagram) | `380×220` | `1.727` | `628×412` | **`webp`** | `1.524` | `1.13×` (+ WebP-in-PNG) |
| `rId13` (Q5a i diagram) | `340×180` | `1.889` | `734×368` | **`webp`** | `1.995` | `0.95×` (+ WebP-in-PNG) |
| `rId14` (Q5c iii diagram) | `340×180` | `1.889` | `722×863` | **`webp`** | `0.837` | **`2.26×` vertically squashed** |
| `rId15` (Q6a diagram) | `340×180` | `1.889` | `551×316` | **`webp`** | `1.744` | `1.08×` (+ WebP-in-PNG) |
| `rId16` (Q7 diagram) | `380×220` | `1.727` | `1034×404` | **`webp`** | `2.559` | **`0.67×` horizontally squished** |
| `rId17` (Q7b i diagram) | `340×180` | `1.889` | `1034×549` | **`webp`** | `1.883` | `1.00×` (+ WebP-in-PNG) |
| `rId18` (Q9 diagram) | `380×220` | `1.727` | `37×78` | **`webp`** | `0.474` | **`3.64×` stretched + `10×` blurry upscale** |
| `rId19` (Q10 diagram) | `380×220` | `1.727` | `931×473` | **`webp`** | `1.968` | `0.88×` (+ WebP-in-PNG) |

- **8 of 10 images** are raw `RIFF...WEBP` files saved as `.png` with `ImageRun({ type: 'png' })`, which fails to render in older Microsoft Word / LibreOffice builds.

### 1.2 Tables (`4` OOXML tables + `4` unparsed raw Markdown tables)
- **Sub-question tables dumped as raw pipe strings**: [docxExportService.ts:1075-1088](file:///c:/testmaker/src/services/docxExportService.ts#L1075-L1088) calls `parseFormattedTextToDocxRuns()` directly inside a single `Paragraph` instead of calling `convertTextAndTablesToDocxElements()`, leaving raw `| ... |` pipe syntax in **Q2(a)** (`[P72]`), **Q7(b)(ii)** (`[P171]`), **Q8(a)(i)** (`[P178]`), and **Q9(b)(i)** (`[P209]`).
- **Degenerate OOXML table grids**: All `4` generated `<w:tbl>` tables emit `<w:gridCol w:w="100"/>` (100 twips ≈ 1.7 mm) with missing `tblLayout` (`NONE`), no cell padding inside content tables, and checkbox glyphs `☐` in empty answer cells (instead of blank writable boxes).
- **Redundant writing lines**: Printed ruled writing lines (`.....`) still appear directly under table-completion questions (e.g., Q1, Q2a, Q8ai, Q9bi).

### 1.3 LaTeX / KaTeX, Newlines, and Paragraph Structure
- **Literal `\n\n` leaked in visible text**: Sub-questions bypass `.replace(/\\n/g, '\n')` and never split lines into separate paragraphs—visible `\n\n` appeared in Q3(b)(i), Q5(a)(i), Q5(c)(iii), Q6(a), Q7(a)(i), Q7(b)(i), Q7(b)(ii), and Q8(a)(i).
- **Paragraph & list flattening**: `currentTextLines.join(' ')` ([docxExportService.ts:341](file:///c:/testmaker/src/services/docxExportService.ts#L341)) collapses bullet lists (Q2b `- the temperature...`) and structured prompt lines (Q2c `particle separation .......`) into single run-on paragraphs.
- **Regex-only math fragility**: `parseFormattedTextToDocxRuns()` ([docxExportService.ts:85-318](file:///c:/testmaker/src/services/docxExportService.ts#L85-L318)) flattens `\frac{a}{b}` to `(a / b)`, lacks `\ce{...}` / `\sqrt{...}` support, breaks on nested braces, and emits nuclides (`^{37}_{17}Cl`) sequentially rather than native stacked Word OMML math.

### 1.4 Content Hygiene & Metadata Parity
- **Duplicate sub-question prefixes**: e.g., `(a)(i)  (iv) kills microbes...`, `(b)(i)  (b) Isotopes... (i) Explain...`, `(a)(ii)  (ii) Explain...`.
- **Leaked AI diagram placeholders**: `[Figure 3.1: Dot-and-cross diagr...]`, `[Figure 3.2: Two overlapping circles...]`, `[Diagram: Displayed formula of compound A...]` in student text.
- **Numbering drift**: Stem references `Table 1.2. Table 2.1`, caption `Fig. 4.1` vs stem `Fig. 2.1`, `Fig. 6.1` vs `Fig. 3.1`, and missing space `Table 7.1to explain`.
- **Hardcoded cover page count**: Cover page writes static `This document has 7 pages` regardless of actual rendered pagination.

---

## 2. Small Executable Implementation Steps

### Phase 1 — Image Pipeline & Aspect Ratio Fidelity

#### Step 1.1: Binary Header Inspector & WebP/SVG → PNG Transcoder (`loadImageData`)
- **Target**: [docxExportService.ts](file:///c:/testmaker/src/services/docxExportService.ts#L53-L79)
- **Changes**:
  - Add a lightweight binary dimension reader (`getImageDimensionsFromBytes(bytes)`) parsing PNG (`IHDR`), JPEG (`SOF0/SOF2`), and WebP (`VP8`/`VP8L`/`VP8X`) headers.
  - Detect actual MIME/format from magic bytes rather than assuming PNG:
    - If PNG (`89 50 4E 47`) or JPEG (`FF D8`): preserve bytes, record exact `(naturalWidth, naturalHeight)`, and return `imageType: 'png' | 'jpg'`.
    - If WebP (`RIFF...WEBP`) or SVG (`<svg`): decode in browser via `createImageBitmap` / `HTMLImageElement` + offscreen `<canvas>` `.toBlob('image/png')` so Word receives valid PNG bytes with exact pixel dimensions.
    - Never discard natural aspect ratio; return `LoadedImageData = { data, width, height, naturalWidth, naturalHeight, type: 'png' | 'jpg' } | null`.

#### Step 1.2: Aspect-Ratio Bounding-Box Scaler (`fitImageDimensions`) Across All 14 `ImageRun` Sites
- **Target**: [docxExportService.ts](file:///c:/testmaker/src/services/docxExportService.ts) (`L578`, `L594`, `L1001`, `L1057`, `L1104`, `L1293`, `L1350`, `L1682`, `L1720`, `L1968`, `L1988`, `L2166`, `L2194`, `L2355`, `L2416`)
- **Changes**:
  - Extract a single shared helper:
    ```ts
    function fitImageDimensions(
      naturalW: number,
      naturalH: number,
      maxW: number,
      maxH: number,
      allowUpscale = false
    ): { width: number; height: number }
    ```
    computing `const scale = Math.min(maxW / naturalW, maxH / naturalH, allowUpscale ? Infinity : 1)` and rounding proportionally so `renderedRatio === naturalRatio` (within `±1%`) and small images (`37×78`) are never stretched blurry.
  - Apply tier presets:
    - Cover & Header Logos: `fitImageDimensions(w, h, 175, 48)` (`~150×48` / `161×48` matching natural `3.13:1` and `3.36:1`)
    - Main Stem Diagrams & Insert Figures: `fitImageDimensions(w, h, 440, 300)`
    - Sub-question Diagrams: `fitImageDimensions(w, h, 360, 240)`
    - MCQ Option Diagrams: `fitImageDimensions(w, h, 220, 140)`
  - Pass `type: imgData.type` dynamically on every `ImageRun` and wrap cover logo loading through a shared `loadLogoImageData()` helper so SVG/WebP school logos also transcode cleanly.

---

### Phase 2 — Unified Block, Newline & OOXML Table Renderer

#### Step 2.1: Multi-Line Paragraph & Bullet List Preserving Block Parser
- **Target**: [docxExportService.ts](file:///c:/testmaker/src/services/docxExportService.ts#L323-L463) (`convertTextAndTablesToDocxElements` → `convertMarkdownBlocksToDocxElements`)
- **Changes**:
  - Normalize escaped `\\n` (`rawText.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n')`) and real `\r\n`.
  - Split text blocks on **blank lines** (`\n\s*\n`), **bullet lines** (`^\s*[-*•]\s+`), **dotted label/prompt lines** (e.g. lines containing `....` or `____`), and **table boundaries**, instead of blindly calling `currentTextLines.join(' ')`.
  - Accept layout options `{ prefix, textSize, fontName, baseIndentTwips, hangingTwips, rightMarksTab, trailingMarks, blankFillableCells }` so the exact same block renderer serves:
    - Main question stems (`qNum.  `, `indent: 450`, `hanging: 450`)
    - Sub-questions (`sq.sub_id  `, `indent: 800`, `hanging: 380`, right-aligned `[marks]` tab stop on the final text/block paragraph)
    - Teacher Mark Schemes and Answer Booklets.

#### Step 2.2: Fix OOXML Table Column Grids (`dxa`), Borders, Padding & Blank Writable Cells
- **Target**: [docxExportService.ts](file:///c:/testmaker/src/services/docxExportService.ts#L358-L440), `buildCambridgeCandidateTable` (`L468-L537`), `buildWorksheetHeaderTable` (`L773-L835`)
- **Changes**:
  - Calculate available content width in twips (`A4` width `11906 dxa` minus margins minus `baseIndentTwips`, default `9026 - baseIndentTwips`).
  - Normalize each data row's cell count to match `colCount` (padding missing cells or trimming overflow) and emit explicit integer `columnWidths: colWidthsDxa` on `new Table({ width: { size: totalTableDxa, type: WidthType.DXA }, layout: TableLayoutType.FIXED, columnWidths: colWidthsDxa, ... })` and matching `WidthType.DXA` on each `TableCell`.
  - Add comfortable cell `margins: { top: 80, bottom: 80, left: 120, right: 120 }` on all Markdown content tables.
  - When `blankFillableCells: true` (student paper & answer booklet), transform standalone checkbox markers (`☐`, `[ ]`) inside table cells into clean empty cells (`""`) with minimum row height (`height: { value: 420, rule: HeightRule.ATLEAST }`) so students have room to write inside printed table cells.
  - Upgrade `buildCambridgeCandidateTable` and `buildWorksheetHeaderTable` to also emit explicit `dxa` `columnWidths` so LibreOffice/Google Docs match Microsoft Word spacing.

#### Step 2.3: Route Sub-Questions Through `convertMarkdownBlocksToDocxElements`
- **Target**: `exportStudentPaperDocx` ([L1075-L1088](file:///c:/testmaker/src/services/docxExportService.ts#L1075-L1088)), `exportAnswerBookletDocx`, `exportTeacherMarkSchemeDocx`
- **Changes**:
  - Replace the single-paragraph `parseFormattedTextToDocxRuns(...)` call on `sq.question_text` with `convertMarkdownBlocksToDocxElements(...)`.
  - Attach the right-aligned `[${sq.marks || 1}]` tab stop on the last non-table paragraph of the sub-question (or a trailing right-aligned paragraph if the sub-question ends with a table).
  - Verify Q2(a), Q7(b)(ii), Q8(a)(i), and Q9(b)(i) render as real `<w:tbl>` Word tables.

#### Step 2.4: Smart Answer-Line Suppression Beneath Completion Tables
- **Target**: [docxExportService.ts](file:///c:/testmaker/src/services/docxExportService.ts#L1138-L1165)
- **Changes**:
  - Detect whether a question or sub-question contains a fillable completion table (e.g., blank / `☐` / `[ ]` cells or `"Complete Table"` stem without a separate explanation prompt like `"Explain"` / `"Describe"` / `"Deduce"`).
  - Suppress redundant ruled answer lines directly beneath pure table-completion questions (while keeping answer lines when there *is* an open-ended prompt after the table, such as Q7(b)(ii)).

---

### Phase 3 — Balanced LaTeX/mhchem Parser & Native Word OMML Math

#### Step 3.1: Create `src/utils/docxMathUtils.ts` with Balanced-Brace LaTeX & `\ce{...}` Converter
- **Target**: New module `src/utils/docxMathUtils.ts`
- **Changes**:
  - Replace fragile regex `\frac{(.*?)}{(.*?)}` with a balanced-brace scanner `readBalancedGroup(str, startIdx)` supporting nested braces (`\frac{1}{2}\left(\frac{a+b}{c}\right)`, `\sqrt{b^2 - 4ac}`).
  - Add `\ce{...}` (mhchem Chemistry) translator converting `\ce{H2SO4}`, `\ce{Cu^2+}`, `\ce{Fe^{3+}}`, `\ce{2H2 + O2 -> 2H2O}`, `\ce{N2 + 3H2 <=> 2NH3}`, and `(aq)` / `(s)` / `(l)` / `(g)` into normalized math/formula tokens before Word serialization.
  - Handle `\text{...}`, `\mathrm{...}`, `\mathbf{...}`, `\overline{...}`, `\vec{...}`, spacing commands, and missing-space fixes cleanly.

#### Step 3.2: Native `docx` OMML `Math` Elements for Complex Math & Stacked Nuclides
- **Target**: `src/utils/docxMathUtils.ts`
- **Changes**:
  - Import `docx` native OMML classes (`Math`, `MathRun`, `MathFraction`, `MathRadical`, `MathSuperScript`, `MathSubScript`, `MathSubSuperScript`).
  - Emit native `<m:oMath>` nodes for:
    - Fractions (`\frac{num}{den}` → `new MathFraction(...)`)
    - Radicals (`\sqrt{expr}` → `new MathRadical(...)`)
    - Stacked atomic isotopes / nuclides (`^{37}_{17}Cl`, `^{63}_{29}Cu^{+}` → `MathSubSuperScript` so mass number `37` stacks cleanly directly above atomic number `17`!)
    - Complex parenthesized / display math expressions containing nested sub/superscripts.
  - Keep simple inline chemical formulas (`H_{2}O`, `Cl_{2}`, `MgF_{2}`, `Cu^{2+}`) as crisp native `TextRun` with `subScript: true` / `superScript: true` matching surrounding paragraph font.

#### Step 3.3: Wire `(TextRun | Math)[]` Children Across All Exporters
- **Target**: [docxExportService.ts](file:///c:/testmaker/src/services/docxExportService.ts#L85-L318) (`parseFormattedTextToDocxRuns`)
- **Changes**:
  - Update paragraph builders in `docxExportService.ts` to accept `(TextRun | Math)[]` (`parseFormattedTextToDocxChildren`) while preserving backward-compatible export signature of `parseFormattedTextToDocxRuns` if any external helper expects `TextRun[]`.

---

### Phase 4 — Content Hygiene, Dynamic Cover Fields & Automated Fidelity Verification

#### Step 4.1: Deduplicate Sub-Question Prefixes & Strip Leaked AI Placeholder Tags
- **Target**: [docxExportService.ts](file:///c:/testmaker/src/services/docxExportService.ts#L978-L1088) and [src/lib/gemini.ts](file:///c:/testmaker/src/lib/gemini.ts) (`stripDuplicateSubQuestionsFromStem` / new `stripDuplicateSubQuestionPrefix`)
- **Changes**:
  - Strip redundant leading prefixes on `sq.question_text` when `sq.sub_id` is already rendered (e.g., `(a)(i)  (iv) ...` → preserve meaningful item label only or deduplicate exact `(b)` / `(i)` / `(ii)` prefixes so `(a)(i)  (i) Explain...` never occurs).
  - Strip leaked bracketed AI diagram generation annotations from student papers (`\[(Figure|Diagram)\s*[\d.]*\s*:[^\]]+\]` when an actual `ImageRun` is embedded, or normalize clean captions).
  - Strip redundant inline `"Table X.Y"` / `"Fig. X.Y"` mismatch artifacts where the AI/resource renumberer leaves two adjacent labels (`Table 1.2. Table 2.1`) or merges `"7.1to"` without a space.

#### Step 4.2: Dynamic Word `NUMPAGES` Field & Safe Unicode Cleanups
- **Target**: [docxExportService.ts](file:///c:/testmaker/src/services/docxExportService.ts) (cover page section `~L715-L760`)
- **Changes**:
  - Replace static estimated page count (`This document has 7 pages`) with native `docx` `[new TextRun('This document has '), new TextRun({ children: [PageNumber.TOTAL_PAGES] }), new TextRun(' pages. Any blank pages are indicated.')]`, so Word displays the true dynamic page count automatically on open/print.

#### Step 4.3: Automated `.docx` Fidelity Verification Suite (`scripts/test-docx-export-fidelity.mjs`)
- **Target**: New `scripts/test-docx-export-fidelity.mjs` + `package.json` (`"test:docx-export"`)
- **Changes**:
  - Construct representative fixtures covering all failure modes seen in `Grade_10_Essay_Only_Student_Paper.docx`:
    1. Tall portrait (`37×78`), wide (`1034×404`), and medium WebP-encoded images
    2. Sub-question Markdown tables (Q2a/Q8ai style with `☐` cells and chemical formulas)
    3. Multi-line stems with bullets (`- item`) and escaped `\\n\\n`
    4. Nested `\frac{2\Delta H}{\sqrt{T_1 + T_2}}`, `\ce{CuSO4.5H2O}`, and stacked isotopes `^{37}_{17}\text{Cl}`, `^{63}_{29}\text{Cu}^{+}`
    5. Duplicate leading `(b)(i) (b) ... (i)` sub-question text and `[Figure 3.1: ...]` placeholder tags
  - Run `Packer.toBuffer(...)`, unzip with `jszip`, inspect `word/document.xml` + `word/media/*`, and assert:
    - **0** WebP binaries masquerading as `.png`
    - **<= 2%** aspect-ratio error on every `<wp:extent>` vs image pixel header & **0** upscaled tiny images
    - **0** raw `|---|` pipe strings in `<w:t>` elements
    - **0** literal `\n` strings in `<w:t>` elements
    - Every `<w:tbl>` has positive `dxa` `gridCol` widths summing to page/container width
    - Native `<m:oMath>` nodes emitted for fractions/roots/isotopes, **0** duplicate `(i) (i)` prefixes, and `<w:fldSimple>/<w:instrText>` `NUMPAGES` present on cover.

---

## 3. Recommended Execution Sequence

| Order | Step | Files Modified | Risk |
| :---: | :--- | :--- | :---: |
| 1 | Steps 1.1 – 1.2 (Image dimensions, WebP→PNG, aspect scaling) | `src/services/docxExportService.ts` | Low |
| 2 | Steps 2.1 – 2.4 (Block parser, `dxa` tables, sub-question tables, line suppression) | `src/services/docxExportService.ts` | Medium |
| 3 | Steps 3.1 – 3.3 (Balanced LaTeX / `\ce{}` + native OMML `Math`) | `src/utils/docxMathUtils.ts`, `src/services/docxExportService.ts` | Medium |
| 4 | Steps 4.1 – 4.3 (Content cleanup, dynamic `NUMPAGES`, automated test suite) | `src/services/docxExportService.ts`, `scripts/test-docx-export-fidelity.mjs`, `package.json` | Low |
