# Implementation & Testing Plan: Reading Passage Boundary Markers & Question Editor Context Menu

## 1. Problem Statement & Goals

1. **False-Positive & Broken Reading Passage Splits**:
   - **False Positives (e.g., English CEFR Test G12 Q1)**: In `StudentQuizRunner.tsx` (`lines 362-380`), Rule 2 (`allowParagraphHeuristic`) splits *any* 2+ paragraph language question without sub-questions whenever the preceding paragraph(s) total `>= 220` characters and the final paragraph is `< 200` chars or contains `?`. Multi-paragraph instructions, email prompts, or grammar scenarios on Question 1 get falsely split into a **📖 Reference Reading Passage** card.
   - **Broken `###` Header Splits (Rule 1)**: `stitchPassagesToQuestions` (`src/lib/passageExtractor.ts:318`) outputs `### <Heading>\n\n<body>\n\n<prompt>`, but Rule 1 (`StudentQuizRunner.tsx:349-350`) uses a lazy `[\s\S]*?\n\s*\n` match that stops at the first blank line right after `### <Heading>`, putting only the title in the passage card and leaving the passage body inside `promptText`.
   - **Cross-Question Inheritance (`activeStimulusPassage`)**: Requires a digit (`\s*\d+`), missing `### Passage` / `### Text A`, and can copy Q1's question prompt into Q2+'s passage card.

2. **Teacher Override & Right-Click Formatting Context Menu in `QuestionEditorModal.tsx`**:
   - Teachers need an explicit way in the Question Editor to mark where a reading passage **starts and ends** (`[passage]...[/passage]`) or mark a question as **No Reading Passage** (`[no_passage]`).
   - Teachers also need a **right-click context menu** (plus `Ctrl+B` / `Ctrl+I` / `Ctrl+U` shortcuts and toolbar chips) when selecting text in the Question Stem or Sub-question textareas to apply **Bold** (`**...**`), **Italic** (`*...*`), **Underline** (`[u]...[/u]`), **Superscript** (`^{...}`), **Subscript** (`_{...}`), **Inline/Block LaTeX** (`$...$`, `$$...$$`), **Cloze Gaps** (`[1]`, `[ans|distractor]`), and **Passage Markers**.

---

## 2. Architecture & Token Specification

### A. Explicit Reading Passage Tokens
| Token | Purpose | Behavior in `StudentQuizRunner` | Behavior in Renderers / Exporters (`ExamMathText`, `InlineGapText`, PDF, Word) |
| :--- | :--- | :--- | :--- |
| `[passage]...[/passage]` | Explicitly defines reading passage start & end boundaries | Extracted as `passageText`; remaining text outside the block becomes `promptText` (overrides heuristics and `< 180` char limit) | Tags `[passage]` and `[/passage]` are stripped cleanly; inner text is preserved |
| `[no_passage]` | Explicitly disables reading passage split & cross-question inheritance | Forces `passageText = null`, `activeStimulusPassage = null`, and keeps the entire stem in `promptText` | Tag `[no_passage]` is stripped cleanly |

### B. Rich-Text Formatting Tokens (Safe with HTML Escaping & KaTeX)
| Action | Shortcut | Wrapper Syntax | Web (`ExamMathText`) | PDF (`pdfExportService`) | Word (`docxExportService`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Bold** | `Ctrl+B` | `**text**` | `<strong>text</strong>` | `<strong>text</strong>` | `TextRun({ bold: true })` |
| **Italic** | `Ctrl+I` | `*text*` | `<em>text</em>` | `<em>text</em>` | `TextRun({ italics: true })` |
| **Underline** | `Ctrl+U` | `[u]text[/u]` | `<u>text</u>` | `<u>text</u>` | `TextRun({ underline: {} })` |
| **Superscript** | — | `^{text}` | `<sup>text</sup>` | `<sup>text</sup>` | `TextRun({ superScript: true })` |
| **Subscript** | — | `_{text}` | `<sub>text</sub>` | `<sub>text</sub>` | `TextRun({ subScript: true })` |
| **Inline Math** | `Ctrl+M` | `$text$` | KaTeX inline | KaTeX inline | Normalized math run |
| **Block Math** | — | `\n$$\ntext\n$$\n` | KaTeX display | KaTeX display | Normalized math block |

*(Note: `[u]...[/u]` is used instead of raw `<u>...</u>` so `escapeHtml()` in `pdfExportService.ts` never escapes underline formatting.)*

---

## 3. Small Executable & Testable Steps

### Step 1 — Pure Passage Boundary & Text-Formatting Engine (`src/lib/readingPassageUtils.ts`)
- **Files to create/update**:
  - Create `src/lib/readingPassageUtils.ts`
  - Update `src/pages/StudentQuizRunner.tsx` (`lines 328-383`, `4000-4022`, `4248-4262`) to use `readingPassageUtils.ts`
- **Exact changes**:
  1. Export `stripPassageControlTags(text: string): string` — removes `[passage]`, `[/passage]`, and `[no_passage]` markers cleanly.
  2. Export `hasNoPassageDirective(text: string): boolean` — detects `[no_passage]`.
  3. Export `wrapSelectionWithToken(text: string, selStart: number, selEnd: number, openTag: string, closeTag: string, placeholder?: string)` — pure selection transform helper for the editor context menu (with toggle-off support when selection is already wrapped).
  4. Export `splitPassageAndPrompt(text, options, opts)` with 4 deterministic priority tiers:
     - **Tier 0 (`[no_passage]`)**: Returns `{ passageText: null, promptText: stripPassageControlTags(clean) }`.
     - **Tier 1 (`[passage]...[/passage]`)**: Extracts the exact enclosed block as `passageText` and the remaining text as `promptText`.
     - **Tier 2 (Fixed Rule 1 — `###` Header Split)**: Splits paragraphs after `### (Text|Passage|Reading|Stimulus|Wacana|Bacaan)\s*[A-Za-z0-9]*` so all passage body paragraphs stay in `passageText` and only the trailing question prompt paragraph(s) go into `promptText` (fixing the lazy `\n\s*\n` title-only bug).
     - **Tier 3 (Tightened Rule 2 — Multi-Paragraph Fallback)**: Requires `allowParagraphHeuristic === true`, no task-instruction opener (`Write an email/letter/essay`, `Complete the`, `Choose the`, `Fill in`, `Listen to`), and either `>= 3` paragraphs (`>= 260` chars) or a `>= 350`-char prose body before a clear question prompt — eliminating false positives on 2-paragraph questions like English CEFR G12 Q1.
  5. Export `resolveInheritedStimulusPassage(questions, currentIndex, isLanguageExam, isCurrentStemOrMath, isPrevStemOrMath)`:
     - Returns `null` if current question has `[no_passage]` or its own passage.
     - Scans backwards, supporting both `[passage]...[/passage]` and numbered/lettered/unnumbered `### (Text|Passage|Reading|Stimulus|Wacana|Bacaan)` headers, and strips Q1's trailing question prompt so Q2+ inherits *only* the passage.
- **Verification (`scripts/test-reading-passage-and-editor-format.mjs`)**:
  - Unit tests verifying:
    - `[no_passage]` prevents split and inheritance on multi-paragraph English CEFR G12 Q1 stems.
    - `[passage]...[/passage]` splits exact boundaries even on short texts or texts with internal numbered lists.
    - Stitched `### Text 1\n\n<Paragraph 1>\n\n<Paragraph 2>\n\nWhich statement is correct?` keeps both paragraphs in `passageText` (fixing Rule 1).
    - Cross-question inheritance (`Q1` -> `Q2`) strips Q1's prompt and supports `### Passage A`.

---

### Step 2 — Tag Stripping & Italic / Underline Parity Across Renderers and Exporters
- **Files to update**:
  - `src/components/ExamMathText.tsx` (`renderMathSnippet`, lines `358-450`)
  - `src/components/InlineGapText.tsx`
  - `src/services/pdfExportService.ts` (`formatPlainTextForPrint`, lines `95-115`)
  - `src/services/docxExportService.ts` (`parseFormattedTextToDocxRuns`, lines `78-265`)
- **Exact changes**:
  1. Call `stripPassageControlTags` in `ExamMathText.tsx`, `InlineGapText.tsx`, `pdfExportService.ts`, and `docxExportService.ts` so `[passage]`, `[/passage]`, and `[no_passage]` never appear as literal text in previews, live exams, PDFs, or Word exports.
  2. Add `*italic*` (`<em>`) and `[u]underline[/u]` (`<u>`) rendering to `ExamMathText.tsx` (alongside existing `**bold**`).
  3. Add `[u]underline[/u]` -> `<u>$1</u>` in `pdfExportService.ts` (`formatPlainTextForPrint`).
  4. Extend `tokenRegex` in `docxExportService.ts` (`parseFormattedTextToDocxRuns`) to tokenize `*italic*` (`italics: true`) and `[u]underline[/u]` (`underline: {}`) in addition to `**bold**`, `_{sub}`, and `^{sup}`.
- **Verification**:
  - Add renderer/exporter assertions to `scripts/test-reading-passage-and-editor-format.mjs` verifying `formatLatexForHtml` and `parseFormattedTextToDocxRuns` strip `[passage]`/`[no_passage]` and output bold, italic, and underline runs cleanly.

---

### Step 3 — Question Editor Right-Click Context Menu, Keyboard Shortcuts & Passage Controls (`src/components/QuestionEditorModal.tsx`)
- **Files to update**:
  - `src/components/QuestionEditorModal.tsx` (`lines 61-78`, `463-482`, `1126-1179`, `1705-1715`)
  - `src/components/QuestionEditorModal.css`
- **Exact changes**:
  1. **Unified Selection Formatting Handler**:
     - Track the active textarea target (`'main'` or `{ subIndex: number }`) and selection range (`selectionStart`, `selectionEnd`).
     - Support wrapping/toggling selected text in either the main Question Stem textarea or any Sub-question textarea.
  2. **Right-Click Context Menu (`onContextMenu`)**:
     - When right-clicking inside the main stem `<textarea>` or a sub-question `<textarea>`, open a custom floating context menu positioned at `(clientX, clientY)` (clamped to viewport) with:
       - **Formatting**: `Bold (**B**)` (`Ctrl+B`), `Italic (*I*)` (`Ctrl+I`), `Underline ([u]U[/u])` (`Ctrl+U`), `Superscript (x²)`, `Subscript (x₂)`
       - **Math & Gaps**: `Inline Math ($...$)`, `Block Equation ($$...$$)`, `Blank Gap ([1])`, `Dropdown Gap ([correct|distractor])`
       - **Reading Passage (Main Stem)**:
         - `📖 Mark Selection as Reading Passage` (`[passage]...[/passage]`)
         - `🚫 Toggle "No Reading Passage"` (`[no_passage]`)
         - `🧹 Clear Passage Markers`
  3. **Keyboard Shortcuts (`onKeyDown`) & Toolbar Chips**:
     - Bind `Ctrl/Cmd + B` (Bold), `Ctrl/Cmd + I` (Italic), `Ctrl/Cmd + U` (Underline), and `Ctrl/Cmd + M` (Inline Math) on the editor textareas.
     - Add toolbar buttons in `q-math-toolbar` for **Bold**, **Italic**, **Underline**, **📖 Mark Passage**, and **🚫 No Passage**.
  4. **Live Preview Passage Badge**:
     - In the Question Editor's **Live Formatted Preview** pane, display a clear status pill when `[passage]...[/passage]` (`📖 Explicit Reading Passage Marked`) or `[no_passage]` (`🚫 Auto-Passage Split Disabled`) is active, and preview the separated passage box vs. question prompt so the teacher can verify the exact split before saving.
- **Verification**:
  - Extend `scripts/test-reading-passage-and-editor-format.mjs` + add `"test:passage-editor"` script in `package.json`.
  - Run `npm run test:passage-editor`, `npm run test:inline-gaps`, `npm run test:fillable-tables`, and `npm run build` (`tsc -b && vite build`).
