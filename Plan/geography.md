# Blueprint & Implementation Plan: Cambridge AS & A Level Geography (`9696`) Support (`Plan/geography.md`)

## 1. Executive Summary

An architectural audit was performed on the Cambridge International AS & A Level Geography papers located in [`geography paper/`](file:///c:/testmaker/geography%20paper):
- **May/June 2025 (`9696/11`)**: Question Paper (4 pages), Mark Scheme (19 pages), Insert Booklet (4 pages).
- **Oct/Nov 2024 (`9696/13`)**: Question Paper (4 pages), Mark Scheme (17 pages), Insert Booklet (4 pages).

### Overall Assessment
The current pipeline provides **strong baseline support (~90% compatibility)**. The Insert cropping engine, cloud storage bridge, mark scheme trimmer, and multimodal extraction handle AS & A Level documents effectively. Two specific fixes are required to achieve 100% fidelity:
1. Registering syllabus `9696` in [`src/lib/subjectClassifier.ts`](file:///c:/testmaker/src/lib/subjectClassifier.ts) to prevent misidentification as IGCSE `0460`.
2. Resolving a line-packing edge case in [`src/lib/paperOutlineParse.ts`](file:///c:/testmaker/src/lib/paperOutlineParse.ts) where the question number and first sub-part share the same line (e.g. `4 (a) (i) Define... [4]`).

---

## 2. Detailed Diagnostic Findings

### Finding A: Syllabus Classification Fallback (`9696` -> `0460`)
- **Observation**:
  In [`src/lib/subjectClassifier.ts`](file:///c:/testmaker/src/lib/subjectClassifier.ts#L34-L73), `SYLLABUS_REGISTRY` contains `0460` (IGCSE Geography), `0470` (History), `0455` (Economics), `0495` (Sociology), and STEM codes (`0620`, `0625`, `0610`). Syllabus `9696` is currently unlisted.
- **Root Cause**:
  When inspecting `paper1_question paper_11_june25.pdf`, regex `CODE_IN_TEXT_RE` matches `9696/11`. Because `SYLLABUS_REGISTRY['9696']` does not exist, line 123 falls back to subject title matching on `"GEOGRAPHY"`. It matches `0460` and erroneously assigns the IGCSE Geography profile.
- **Impact**:
  - Sets `subject_code: "0460"` instead of `"9696"`.
  - Labels the curriculum as IGCSE instead of Cambridge International AS & A Level.

---

### Finding B: Deterministic Outline Line-Packing Bug on Section B
- **Observation**:
  Running `scripts/debug-outline.mjs` on `paper1_question paper_11_june25.pdf` shows:
  ```
  Q1: (a)(stem) (a)(i)[1] (a)(ii)[1] (b)[3] (c)[5] => 10
  Q2: (a)[3] (b)[4] (c)[3] => 10
  Q3: (a)[4] (b)[3] (c)[3] => 10
  Q4: (a)(ii)[3] (b)[8] (c)[15] => 26   <-- Missing (a)(i) [4m]
  Q5: (a)(ii)[3] (b)[8] (c)[15] => 26   <-- Missing (a)(i) [4m]
  Q6: (a)(ii)[3] (b)[8] (c)[15] => 30
  ```
- **Root Cause**:
  In Cambridge AS & A Level papers, Section B prints question numbers and their first sub-part on the exact same visual horizontal line:
  ```
  y=691: [x=50] "4"  [x=72] "(a)"  [x=96] "(i)"  [x=118] "Define the fluvial terms..."  [x=533] "[4]"
  ```
  In [`src/lib/paperOutlineParse.ts:294-308`](file:///c:/testmaker/src/lib/paperOutlineParse.ts#L294-L308):
  ```ts
  const questionMatch = line.text.match(QUESTION_RE);
  if (questionMatch && near(line.x, questionCol)) {
    current = { number: Number(questionMatch[1]), ... };
    questions.push(current);
    continue; // <-- Skips checking the rest of the line for sub-parts!
  }
  ```
  The line clusterer recognizes question `4`, but the `continue;` statement bypasses the part/roman/marks detection for that line. Consequently, `(a)(i) [4]` is dropped from the outline tree.
- **Impact**:
  Q4 and Q5 show 26 marks instead of 30 in the outline. While multimodal vision extraction catches the sub-part, the deterministic outline gate loses precision.

---

### Finding C: Mark Scheme Trimming is 100% Safe & Rubric-Preserving
- **Observation**:
  `paper1_mark scheme_11_june25.pdf` has 19 pages. [`detectMarkSchemeTableStart`](file:///c:/testmaker/src/lib/markSchemeDetect.ts#L22) detects the answer table header on **Page 5**.
- **Analysis**:
  - Pages 1–4 contain generic administrative principles and annotation tables.
  - The answer tables begin on Page 5 with Section A.
  - **Rubric Structure**: Unlike Sociology (where Levels of Response were grouped in the preamble), AS Geography prints Level 1 to Level 4 marking criteria **directly inside each question's answer table** (e.g. Page 10 for Q4b [8m], Page 11–12 for Q4c [15m]).
- **Impact**:
  Dropping Pages 1–4 is completely safe; 100% of the mark scheme content, indicative points, and essay rubrics are retained.

---

### Finding D: Optional-Choice Mark Arithmetic (60 vs 120 marks)
- **Exam Structure**:
  - Cover states: `"The total mark for this paper is 60"`.
  - Section A (Core Physical Geography): Q1 (10m) + Q2 (10m) + Q3 (10m) = **30 marks (all compulsory)**.
  - Section B (Extended Physical Geography): Q4 (30m), Q5 (30m), Q6 (30m) = **Answer 1 of 3 (30 marks)**.
  - Total marks printed in paper: $30 + 90 = \mathbf{120\text{ marks}}$.
- **Support in Question Bank**:
  The framework extracts all 6 questions ($120\text{ marks}$) so teachers have access to the complete question repository. Section B questions must be tagged with an optional group indicator (`"Section B: Answer 1 of 3"`) so test generation tools recognize them as alternative variants.

---

## 3. How Inserts are Stored & Linked in the Question Bank

Cambridge AS Geography Papers 1 and 2 rely heavily on external Resource Booklets / Inserts:
- `Fig. 1.1` (River Ray hydrograph: precipitation & discharge chart)
- `Fig. 2.1` (Landscape photograph showing snow cover distribution)
- `Fig. 3.1` (Text extract describing a $2000\text{ m}^3$ rockfall event)

### Storage & Linking Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                         1. INGESTION & CROPPING PIPELINE                         │
│                                                                                  │
│   User stages:                                                                   │
│   - Slot 1: QP (paper1_question paper_11_june25.pdf)                             │
│   - Slot 3: Insert (paper1_insert_11_june25.pdf)                                 │
│                                                                                  │
│   Gemini Extraction Payload:                                                     │
│   - Receives both PDFs.                                                          │
│   - Tags visual questions with:                                                  │
│       has_diagram: true                                                          │
│       diagram_source: "insert"                                                   │
│       resource_ref: "Fig. 1.1"                                                   │
│       insert_page_number: 2                                                      │
│       bounding_box: [115, 60, 580, 930]                                          │
│                                                                                  │
│   diagramCropper.ts:                                                             │
│   - Renders Insert Booklet at 4x resolution.                                     │
│   - Crops the exact bounding box around Fig. 1.1 on Insert Page 2.               │
│   - Converts canvas to WebP image blob.                                          │
│   - Uploads to Cloudflare R2 bucket:                                             │
│       URL: https://pub-...r2.dev/9696_2025_p11_Q1_Fig_1_1.webp                   │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                      2. DATABASE SCHEMA (Supabase "questions")                   │
│                                                                                  │
│   Column Name          Stored Value                                              │
│   ───────────────────  ────────────────────────────────────────────────────────  │
│   question_number      "1"                                                       │
│   question_text        "1 Fig. 1.1 shows a hydrograph for the River Ray, UK..."  │
│   has_diagram          true                                                      │
│   diagram_url          "https://pub-...r2.dev/9696_2025_p11_Q1_Fig_1_1.webp"    │
│   diagram_source       "insert"                                                  │
│   resource_ref         "Fig. 1.1"                                                │
│   insert_page_number   2                                                         │
│   bounding_box         [115, 60, 580, 930]                                       │
│                                                                                  │
│   Assessment Paper Root Object:                                                  │
│   "insert_resources": [                                                          │
│     { "id": "Fig. 1.1", "title": "A hydrograph for the River Ray", "page": 2 }, │
│     { "id": "Fig. 2.1", "title": "An area after snowfall", "page": 3 },         │
│     { "id": "Fig. 3.1", "title": "Written extract about a rockfall", "page": 4 } │
│   ]                                                                              │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                        3. USER INTERFACE & EXAM PRESENTATION                     │
│                                                                                  │
│   A. Question Bank & Cards:                                                      │
│      - Displays the cropped diagram image directly above the sub-questions.      │
│      - Renders an authentic badge: [Insert: Fig. 1.1].                           │
│                                                                                  │
│   B. Online Exam Runner (Student Mode):                                          │
│      - Shows the cropped figure inline.                                          │
│      - Activates the "Resource Booklet" drawer (ResourceBookletDrawer.tsx)       │
│        allowing students to inspect the full multi-page insert side-by-side.     │
│                                                                                  │
│   C. Word / PDF Test Export:                                                     │
│      - docxExportService embeds the cropped WebP diagram directly into the Word  │
│        document above sub-part (a).                                              │
└──────────────────────────────────────────────────────────────────────────────────┘
```

#### Dual Representation for Text Extracts (`Fig. 3.1`)
In Cambridge Geography, `Fig. 3.1` is a formatted text case study in the Insert Booklet:
- **Visual Capture**: `diagramCropper.ts` crops the text box as an image, preserving the original Cambridge typography, borders, and layout.
- **Semantic Capture**: The prompt extracts the text into `question_text` and the root `passages` array. Teachers can edit the text or display the visual crop.

---

## 4. Implementation & Fix Plan

### Phase 1: Register AS & A Level Geography (`9696`)
In [`src/lib/subjectClassifier.ts`](file:///c:/testmaker/src/lib/subjectClassifier.ts#L34):
```ts
export const SYLLABUS_REGISTRY: Record<string, SubjectProfile> = {
  // ... existing profiles ...
  '9696': {
    syllabusCode: '9696',
    subjectName: 'Geography (AS/A Level)',
    domain: 'humanities',
    hasInsertByDefault: true,
    hasInPaperStimulus: false,
    isOptionalChoicePaper: true,
    standardTotalMarks: 60,
  },
};
```

### Phase 2: Resolve Same-Line Sub-part Parsing
In [`src/lib/paperOutlineParse.ts:294`](file:///c:/testmaker/src/lib/paperOutlineParse.ts#L294):
- When `line.text` matches `QUESTION_RE` (e.g. `4 (a) (i) Define... [4]`), do not unconditionally execute `continue;`.
- Check if `questionMatch[2]` contains an inline sub-part pattern `PART_RE` or `ROMAN_RE`.
- Extract `(a)(i)` and its mark bracket `[4]` on that initial question line.

### Phase 3: Section A / Section B Option Groups
In [`src/lib/paperOutlineParse.ts`](file:///c:/testmaker/src/lib/paperOutlineParse.ts):
- Add recognition for two-tier instructions:
  - `"Section A: answer all questions"` -> Q1, Q2, Q3 marked as compulsory.
  - `"Section B: answer one question"` -> Q4, Q5, Q6 marked with `option_group: "Section B (Choose 1)"`.

### Phase 4: Verification Test Suite
- Create [`scripts/verify-as-geography.mjs`](file:///c:/testmaker/scripts/verify-as-geography.mjs) testing:
  - Subject detection: `9696`, `Geography (AS/A Level)`.
  - Outline verification: Q1 (10), Q2 (10), Q3 (10), Q4 (30), Q5 (30), Q6 (30).
  - Mark scheme trimming: Starts at Page 5, retaining 100% of question tables and Level 1–4 rubrics.
  - Insert catalog: `Fig. 1.1`, `Fig. 2.1`, `Fig. 3.1`.

### Phase 5: Build Verification
- Execute `npm.cmd run build` (`tsc -b && vite build`) to ensure zero regressions across the codebase.

---

## 6. Review & Implementation Record (2026-11-06)

### 6.1 Audit — findings confirmed

| Claim | Measured result |
|---|---|
| A — `9696` falls back to `0460` | Before the fix: `classifySubject` returned **`Geography 0460/11 via title`** for `paper1_question paper_11_june25.pdf` — the IGCSE profile, as reported |
| B — packed question line drops `(a)(i)` | Before the fix: `Q4 … => 26`, `Q5 … => 26`, and Q6 showed 30 but still had no `(a)(i)` — see nuance below |
| C — trim is rubric-safe | MS 19 pages, header on **p5**, start `header`, `rubricPage: null`; real bands (`Level 3 (6 – 8)`) live on p10+ inside question tables |
| D — 120 printed vs 60 credited | Cover prints "The total mark for this paper is 60"; six questions print 10+10+10+30+30+30 = 120 |

**Nuance on Finding B:** the plan listed `Q6 … => 30`, which looks like Q6 was unaffected. It was not — Q6's `[4]` is printed on the *following* line, so it was absorbed as `stemMarks` and the question still lost its `(a)(i)`. After the fix all three read `30` with `(a)(i)[4]` present and `stemMarks = 0`.

**Nuance on Finding C:** page 3 of the mark scheme *does* contain the string "Level 3/4" — but only in the annotation legend ("Level 4 → Levels-marked questions only"). It is not marking criteria. The trim is safe exactly as the plan states, provided the verification looks for a mark band (`Level 3 (6 – 8)`) rather than the bare word.

### 6.2 Corrections / decisions

1. **Same-line fix narrowed deliberately.** The plan proposed checking `questionMatch[2]` for `PART_RE` *or* `ROMAN_RE`. Only the part+roman form (`4 (a) (i) …`) is captured inline; a bare inline `(a)` keeps the previous behaviour. That fixes 9696 while leaving the other corpora's outlines byte-identical (verified below).
2. **Section membership comes from the body, not the cover.** `Section A`/`Section B` headings are tracked while walking the paper and stored on `OutlineQuestion.section`; the cover only supplies the rule ("answer all" / "answer one"). Guessing the boundary from the cover would break on any paper that prints sections differently.
3. **A pre-existing bug surfaced while fixing D.** The generic optional-choice fallback ("Answer four questions") had tagged **all six** questions with `Optional: answer 4 of 6` — visible in the pre-fix debug output. Section-aware grouping replaces that: only Q4–Q6 carry `Section B: choose 1 of 3 (Q4–Q6)`.
4. **Option group storage.** The plan asked for an `option_group` tag but no column exists for it; it is stored as a `mark_scheme._option_group` JSONB sidecar (same convention as the Sociology work), so no migration was needed.
5. **Registry ordering.** `9696` is inserted before `0460` so that a code-less AS Geography cover cannot match the IGCSE profile by title first.

### 6.3 Files changed

| File | Change |
|---|---|
| `src/lib/subjectClassifier.ts` | `9696` profile (AS/A Level Geography, insert by default, optional choice, 60 marks) |
| `src/lib/paperOutlineParse.ts` | inline `(a)(i)` on the question line; `section` tracking; section-aware option groups |
| `src/lib/gemini.ts` | Raised client timeout from 35s to 150s for multi-document payloads (preventing `AbortError` on `gemini-3.8-flash`); increased `maxOutputTokens` to 32,768 |
| `scripts/verify-as-geography.mjs` | **new** — offline harness over the geography corpus |
| `scripts/simulate-geography-extraction.mjs` | **new** — live multimodal simulation & model benchmark harness |

### 6.4 Verification

| Check | Result |
|---|---|
| `scripts/verify-as-geography.mjs "geography paper"` | **6/6 pass** — classification, per-question totals `10/10/10/30/30/30`, packed `(a)(i)` present, Section B groups only, trim keeps every rubric page, insert holds Figs 1.1–3.1 |
| `verify-sociology.mjs sociology` | **24/24** — unchanged |
| `verify-paper5.mjs` (practical corpus) | **18/18**, 357 leaves — unchanged |
| `verify-phase4.mjs` (practical mark schemes) | **18/18**, all still `header` — unchanged |
| `tsc -b` / `vite build` | exit 0 / built in 2.39 s |

Post-fix outline for both papers:

```
Q1 10 · Q2 10 · Q3 10 · Q4 30 · Q5 30 · Q6 30   (usable: true)
Q4 (a)(i)[4] (a)(ii)[3] (b)[8] (c)[15]
optionGroups: { 4,5,6: "Section B: choose 1 of 3 (Q4–Q6)" }
```

### 6.5 Resolved Status

- **Live Gemini extraction verified**: Full multimodal extraction tested against both `gemini-3.5-flash-lite` and `gemini-3.8-flash` using `scripts/simulate-geography-extraction.mjs`. (Detailed findings in §7).
- **Insert figure binding verified**: Figs 1.1, 2.1, and 3.1 cleanly bound with precise bounding boxes excluding copyright boilerplate.
- **Section B packed question line verified**: Sub-part `(a)(i)` is captured completely in both outline and multimodal extraction.

---

## 7. Live Multimodal Simulation & Model Comparison (2026-11-06)

A live end-to-end simulation was executed on `geography paper/` (`9696/11` May/June 2025: Question Paper, trimmed Mark Scheme, and Insert Booklet) using `scripts/simulate-geography-extraction.mjs`.

### 7.1 Quantitative Run Comparison

| Metric / Dimension | `gemini-3.5-flash-lite` | `gemini-3.8-flash` | Assessment |
|---|---|---|---|
| **Latency** | **36.2s** | 72.1s | `flash-lite` is 2x faster |
| **Output JSON Size** | 24,096 bytes (~5.5k tokens) | **40,055 bytes** (~9.5k tokens) | `3.8-flash` provides 66% richer content |
| **HTTP Status / Exit** | 200 / 0 | 200 / 0 | 100% stable execution |
| **Paper Metadata** | `9696`, May/June 2025, p11 | `9696`, May/June 2025, p11 | Both 100% accurate (no `0460` fallback) |
| **Insert Resource Catalog** | 3 resources (Figs 1.1, 2.1, 3.1) | 3 resources (Figs 1.1, 2.1, 3.1) | Both 100% complete with correct page mapping |
| **Fig. 3.1 Text Extract Crop** | `[100, 100, 500, 900]` | `[75, 170, 335, 830]` | Both isolate top extract and exclude bottom legal disclaimer |
| **Section A Marks (Q1–Q3)** | $10 + 10 + 10 = \mathbf{30}$ | $10 + 10 + 10 = \mathbf{30}$ | Perfect match to syllabus total |
| **Section B Marks (Q4–Q6)** | $30 + 30 + 30 = \mathbf{90}$ | $30 + 30 + 30 = \mathbf{90}$ | Packed line `(a)(i) [4m]` captured on Q4, Q5, Q6 |
| **Total Printed Marks** | $\mathbf{120\text{ marks}}$ | $\mathbf{120\text{ marks}}$ | Expected printed total achieved |
| **Standard Candidate Total** | $\mathbf{60\text{ marks}}$ ($30 + 30$) | $\mathbf{60\text{ marks}}$ ($30 + 30$) | Correctly governed by option groups |
| **Rubric Levels (8m & 15m)** | Concise summary of Levels 1–4 | Verbatim criteria, indicative points & benchmarks | `3.8-flash` captures complete examiner grading rules |

### 7.2 Detailed Qualitative Findings

#### 1. Insert Resource Isolation & Bounding Boxes
- **Fig. 1.1 (Hydrograph, p. 2)**: Bound to Question 1 stem as `diagram_source: "insert"`. Both models accurately encompass the precipitation bar chart and discharge hydrograph.
- **Fig. 2.1 (Snow Cover Photograph, p. 3)**: Bound to Question 2 stem as `diagram_source: "insert"`. `3.8-flash` provides an edge-to-edge box `[100, 150, 915, 920]` capturing the entire landscape view.
- **Fig. 3.1 (Mass Movement Text Extract, p. 4)**: On Insert Page 4, the top half is the rockfall case study, while the bottom half contains publisher copyright notices. `3.8-flash` clamped `ymin: 75, ymax: 335`, cleanly cropping the text story while ignoring legal boilerplate.

#### 2. Section B First Sub-part Preservation
Section B questions print the question number, part, roman numeral, and prompt on one visual line:
`4 (a) (i) Define the fluvial terms ‘laminar flow’ and ‘thalweg’. [4]`
Both models successfully extracted:
- `(a)(i)` [4m]: Definition of laminar flow and thalweg (2 marks each).
- `(a)(ii)` [3m]: Braiding conditions.
- `(b)` [8m]: Hjulström curve deposition/erosion.
- `(c)` [15m]: Land-use changes vs channel flow essay.

#### 3. Mark Scheme Level Descriptors Fidelity
- **`gemini-3.5-flash-lite`**: Summarizes levels into single sentences (e.g. `Level 4 (12-15): Thorough assessment with integrated examples and strong conceptual understanding.`).
- **`gemini-3.8-flash`**: Extracted the full multi-paragraph rubric, including:
  - Technical background on entrainment velocities, clay cohesion, gravel mass, and helicoidal flow.
  - Verbatim Level 0 through Level 4 bands.
  - Strict examiner cap rules: *"General responses without the use of example(s) will not get above the middle of Level 2 (6 marks)"*.



