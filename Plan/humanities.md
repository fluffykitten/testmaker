# Blueprint & Implementation Plan: Humanities & Social Sciences Pipeline (`Plan/humanities.md`)

## 1. Executive Summary

An architectural audit of the examination extraction pipeline was conducted to investigate how the system handles **Humanities and Social Sciences** papers, specifically evaluating the past papers and mark schemes in [`sociology/`](file:///c:/testmaker/sociology) (Cambridge IGCSE Sociology `0495`, May/June 2025 and Oct/Nov 2025 series).

### Core Findings
1. **No Upfront Subject Classifier**: The pipeline routes papers solely via a 3-way manual UI toggle (`STEM`, `Humanities`, `Languages`). There is no automated pre-flight detection of syllabus codes (`0495` vs `0460` vs `0470`) or title text.
2. **Geography Hardcoding**: The Humanities prompt in [`src/lib/gemini.ts`](file:///c:/testmaker/src/lib/gemini.ts#L963-L1080) is an archetype tailored specifically to **Cambridge IGCSE Geography (`0460`)**, requiring external Insert Booklets, map coordinates, and physical geography terminology (`hydraulic action`, `lateral erosion`). Fallback metadata in [`src/lib/pdfProcessor.ts`](file:///c:/testmaker/src/lib/pdfProcessor.ts#L1034-L1051) hardcodes `subject: 'Geography'`, `subject_code: '0460'`.
3. **Catastrophic Mark Scheme Trimming**: The preamble trimmer ([`src/lib/markSchemeTrim.ts`](file:///c:/testmaker/src/lib/markSchemeTrim.ts) / [`src/lib/markSchemeDetect.ts`](file:///c:/testmaker/src/lib/markSchemeDetect.ts)) discards all pages prior to the header row `Question Answer Marks`. In Sociology mark schemes, **the Levels of Response Rubric Grids (Tables A, B, C, D) are printed before this header**. In `0495_s25_ms_11.pdf`, Pages 1–13 (43% of the document) are dropped. The model is sent answer tables referencing `"Use Table A to mark answers to this question"`, but Tables A–D have been stripped.
4. **Deterministic Outline Parser Incompatibility**: [`src/lib/paperOutlineParse.ts`](file:///c:/testmaker/src/lib/paperOutlineParse.ts) misclassifies Sociology Papers 11 and 21 as `'family': 'mcq'` because the code starts with `1` or `2`. Furthermore, it rejects papers where total marks exceed the printed total ($120 \neq 80$), failing on optional/choice question papers.
5. **Prose Stimulus (`Source A`) vs. Graphical Inserts**: Sociology Paper 1 embeds an empirical reading passage (`Source A`) directly on Page 2 of the Question Paper. The current prompt provides no dedicated schema for in-paper text stimuli.
6. **High-Mark Essay Rubrics (8–14 marks)**: Current schemas expect short 1–7 mark sub-parts. Sociology papers feature 8m, 10m, 12m, and 14m evaluation essays that require 4-level mark bands (AO1 Knowledge, AO2 Application, AO3 Analysis/Evaluation).

This blueprint outlines the technical findings and provides an actionable implementation plan to upgrade the Humanities pipeline into a multi-subject, rubric-preserving assessment engine.

---

## 2. Detailed Findings & Root-Cause Audit

### Finding A: Absence of Subject Classification & Metadata Fallback Trap
- **Current State**: [`src/components/PdfUpload.tsx`](file:///c:/testmaker/src/components/PdfUpload.tsx#L426-L450) provides a 3-way toggle: `STEM`, `Humanities`, `Languages`.
- **Code Audit**:
  ```ts
  // src/lib/pdfProcessor.ts lines 1034-1051
  paper_metadata: chunkResults[0]?.paper_metadata || {
    subject: options.domain === 'languages' ? 'English'
      : options.domain === 'humanities' ? 'Geography' : 'Chemistry',
    subject_code: options.domain === 'languages' ? 'ENG'
      : options.domain === 'humanities' ? (options.isIgcse !== false ? '0460' : 'GEO')
      : (options.isIgcse !== false ? '0620' : 'CHEM'),
    // ...
  }
  ```
  If Gemini omits or truncates metadata, any Humanities paper silently becomes **Geography `0460`**.

---

### Finding B: Destructive Mark Scheme Preamble Trimming (The Rubric Loss Bug)

#### The Mechanism
In [`src/lib/markSchemeDetect.ts`](file:///c:/testmaker/src/lib/markSchemeDetect.ts#L13-L33):
```ts
const HEADER_RE = /Question\s+Answer\s+Marks/i;
export function detectMarkSchemeTableStart(pageTexts: string[]): TableStart {
  const normalised = pageTexts.map((text) => text.replace(/\s+/g, ' '));
  const headerIndex = normalised.findIndex((text) => HEADER_RE.test(text));
  if (headerIndex >= 0) return { startPage: headerIndex + 1, method: 'header' };
  // ...
}
```
In [`src/lib/pdfProcessor.ts:653-670`](file:///c:/testmaker/src/lib/pdfProcessor.ts#L653-L670), `trimMarkSchemePreamble(msBytes)` runs unconditionally on every uploaded mark scheme.

#### Impact on Cambridge Sociology (`0495`)

| Mark Scheme Document | Total Pages | Header Page (`Question Answer Marks`) | Pages Dropped | Rubric Tables Lost |
| :--- | :--- | :--- | :--- | :--- |
| `0495_s25_ms_11.pdf` | 30 pages | **Page 14** | **Pages 1–13** (43%) | **Table A** (Q1d 10m rubric)<br>**Table B** (Q1e 12m research design)<br>**Table C** (Q2e/3e 8m rubric)<br>**Table D** (Q2f/3f 14m evaluation) |
| `0495_s25_ms_21.pdf` | 24 pages | **Page 7** | **Pages 1–6** (25%) | **Table A** (Q1e/2e/3e 8m rubric)<br>**Table B** (Q1f/2f/3f 14m rubric) |
| `0495_s25_ms_12.pdf` | 29 pages | **Page 13** | **Pages 1–12** (41%) | Tables A, B, C, D |
| `0495_s25_ms_22.pdf` | 26 pages | **Page 9** | **Pages 1–8** (31%) | Tables A, B |

#### The Failure Cascade
On Page 17 of `0495_s25_ms_11.pdf`, the answer table for Q1(d) states:
> *"Use Table A to mark answers to this question."*

Because Table A was printed on Page 9 and sliced away by the trimmer, Gemini receives only the indicative bullet points without the 4-level mark scheme criteria (Levels 0–3, mark ranges 1–10). As a result:
- The model cannot output the real assessment rubric.
- Auto-grading and teacher review lose the official marking bands.

---

### Finding C: Deterministic Outline Parser Rejection

Running `scripts/debug-outline.mjs` on `0495_s25_qp_11.pdf` and `0495_s25_qp_21.pdf` shows both files fail the deterministic outline gate:

```bash
# 0495_s25_qp_11.pdf:
profile: {"key":"0495/11","syllabus":"0495","paperCode":"11","family":"mcq","totalMarks":80,"questionCount":3}
usable: false
reasons: ["non-monotonic ids in Q2", "non-monotonic ids in Q3", "marks sum 120 != printed total 80"]

# 0495_s25_qp_21.pdf:
profile: {"key":"0495/21","syllabus":"0495","paperCode":"21","family":"mcq","totalMarks":80,"questionCount":3}
usable: false
reasons: ["non-monotonic ids in Q1", "non-monotonic ids in Q2", "non-monotonic ids in Q3", "marks sum 120 != printed total 80"]
```

#### Why it Rejects Sociology:
1. **Misclassified as MCQ**: [`paperOutlineParse.ts:221`](file:///c:/testmaker/src/lib/paperOutlineParse.ts#L221) uses `/^[12]/.test(paperCode) ? 'mcq' : ...`. In Cambridge Science (0620, 0625, 0610), Paper 1 and 2 are 40-mark MCQs. In Sociology (0495), Paper 1 and 2 are 80-mark written theory papers.
2. **Optional Question Sum Discrepancy**: The cover states `"The total mark for this paper is 80"`. But the paper contains:
   - Paper 1: Q1 (40m) + Q2 (40m) + Q3 (40m) = **120 printed marks**.
   - Candidates answer Q1 + either Q2 or Q3 ($40 + 40 = 80\text{ marks}$).
   - The parser checks `sum !== totalMarks` ($120 \neq 80$), which triggers rejection.
3. **Sub-part Formatting**: In Q2 and Q3, Cambridge prints:
   ```
   Define the term: (a) 2
     (i) agencies of socialisation [2]
     (ii) hybrid identities. [2]
   Give two examples of coercion. [2] (b)
   ```
   The regex parser interprets `(i)` and `(ii)` as appearing before `(b)` without attaching them cleanly to `(a)`, flagging `non-monotonic ids`.

*Fallback: The pipeline falls back to multimodal vision extraction, which succeeds in extracting questions, but skips deterministic token optimizations.*

---

### Finding D: Question Paper Layout & Text Stimulus (`Source A`)

In `0495_s25_qp_11.pdf`:
- **Page 1**: Front cover instructions ("Answer Question 1. Answer either Question 2 or Question 3.").
- **Page 2**:
  - Top context: `Answer Question 1. Research methods`
  - Reading stimulus: `Read Source A and then answer the questions below. 1 Source A In the United States Barbara Ehrenreich used covert participant observation to research how working class people are able to live on low wages...`
  - Sub-parts:
    - `(a)(i)` From Source A, identify two conclusions... [2]
    - `(a)(ii)` Using information in Source A, explain two reasons why the research is useful... [4]
    - `(a)(iii)` Using information in Source A, explain three problems with the research... [6]
    - `(b)` State two aspects of a positivist approach... [2]
    - `(c)` Explain one strength and one limitation of semi-structured interviews. [4]
    - `(d)` Evaluate the macro approach to sociological research. [10]
- **Page 3**:
  - `(e)` Explain the research methods and evidence that you would choose to investigate views on marriage... [12]
- **Page 4**: `Answer either Question 2 or Question 3. Identity: self and society`
  - Parts: `(a)(i)` [2], `(a)(ii)` [2], `(b)` [2], `(c)` [6], `(d)` [6], `(e)` [8], `(f)` [14]. Total = 40 marks.
- **Page 5**: `Social stratification and inequality` (Question 3)
  - Parts: `(a)(i)` [2], `(a)(ii)` [2], `(b)` [2], `(c)` [6], `(d)` [6], `(e)` [8], `(f)` [14]. Total = 40 marks.
- **Pages 6–8**: Blank pages.

**Contrast with Geography**:
- Geography puts the stimulus in a separate Insert Booklet as images/maps.
- Sociology puts `Source A` as a text passage directly before Question 1 inside the Question Paper.
- `Source A` strictly applies to sub-parts `(a)(i)–(a)(iii)`. Sub-parts `(b)–(e)` are general methodology questions.

---

## 3. Architecture & Technical Fix Plan

```
┌────────────────────────────────────────────────────────────────────────┐
│                        UPLOAD & PRE-PROCESSING                         │
│                                                                        │
│  [Question Paper PDF] + [Mark Scheme PDF]                              │
│         │                                                              │
│         ▼                                                              │
│  1. Deterministic Cover Inspector (read Page 1 text)                   │
│     ├─ Detects Syllabus Code: "0495" -> Sociology                      │
│     ├─ Detects Syllabus Code: "0460" -> Geography                      │
│     └─ Detects Syllabus Code: "0470" -> History                        │
│         │                                                              │
│         ▼                                                              │
│  2. Rubric-Aware Mark Scheme Trimmer                                   │
│     ├─ Checks for "Generic levels of response grids" or "Table A"      │
│     └─ If present: trims only cover/admin pages (1-4); PRESERVES TABLES│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        EXTRACTION PROMPT ENGINE                        │
│                                                                        │
│  Domain: Humanities                                                    │
│  Subject: Sociology (0495)                                             │
│         │                                                              │
│         ▼                                                              │
│  getHumanitiesExtractionPrompt({                                       │
│    subject: 'Sociology',                                               │
│    hasTextStimulus: true,                                              │
│    levelsOfResponseRubrics: true                                       │
│  })                                                                    │
│         │                                                              │
│         ├─ Captures "Source A" in question_text or passages array      │
│         ├─ Preserves 8m, 10m, 12m, 14m Levels of Response Grids        │
│         └─ Correctly labels sub-parts: (a)(i), (a)(ii), (b)-(f)        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        POST-PROCESSING & REVIEW                        │
│                                                                        │
│  - Sets correct metadata: subject = 'Sociology', code = '0495'         │
│  - Preserves optional choice structure (Section B: Choose Q2 or Q3)    │
│  - Retains all 120 marks in Question Bank with optional tags           │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Step 1: Upfront Deterministic Subject & Syllabus Detection

Create a fast, lightweight cover page inspector in [`src/lib/subjectClassifier.ts`](file:///c:/testmaker/src/lib/subjectClassifier.ts):

1. **Extraction**: Inspect the first 1–2 pages of the Question Paper using `readPdfTextLayout` or pdfjs text extraction (runs in $<150\text{ ms}$).
2. **Syllabus Registry**:
   ```ts
   export interface SubjectProfile {
     syllabusCode: string;       // e.g. "0495"
     subjectName: string;        // e.g. "Sociology"
     domain: 'stem' | 'humanities' | 'languages';
     hasInsertByDefault: boolean;
     hasInPaperStimulus: boolean;
     isOptionalChoicePaper: boolean;
     standardTotalMarks?: number;
   }

   export const SYLLABUS_REGISTRY: Record<string, SubjectProfile> = {
     '0495': {
       syllabusCode: '0495',
       subjectName: 'Sociology',
       domain: 'humanities',
       hasInsertByDefault: false,
       hasInPaperStimulus: true,
       isOptionalChoicePaper: true,
       standardTotalMarks: 80,
     },
     '0460': {
       syllabusCode: '0460',
       subjectName: 'Geography',
       domain: 'humanities',
       hasInsertByDefault: true,
       hasInPaperStimulus: false,
       isOptionalChoicePaper: true,
       standardTotalMarks: 75,
     },
     '0470': {
       syllabusCode: '0470',
       subjectName: 'History',
       domain: 'humanities',
       hasInsertByDefault: false,
       hasInPaperStimulus: true,
       isOptionalChoicePaper: true,
       standardTotalMarks: 60,
     },
     '0455': {
       syllabusCode: '0455',
       subjectName: 'Economics',
       domain: 'humanities',
       hasInsertByDefault: false,
       hasInPaperStimulus: true,
       isOptionalChoicePaper: true,
       standardTotalMarks: 90,
     },
     '0620': {
       syllabusCode: '0620',
       subjectName: 'Chemistry',
       domain: 'stem',
       hasInsertByDefault: false,
       hasInPaperStimulus: false,
       isOptionalChoicePaper: false,
     },
     // ...
   };
   ```
3. **Cover Matching**: Match regex `/\b(0495|0460|0470|0455|0620|0625|0610)\b/` and subject title strings (`SOCIOLOGY`, `GEOGRAPHY`, `HISTORY`, `ECONOMICS`).
4. **UI Integration**:
   - In [`PdfUpload.tsx`](file:///c:/testmaker/src/components/PdfUpload.tsx), when a file is dropped in Slot 1, asynchronously detect the profile and display a subtle badge:
     `Detected: Cambridge IGCSE Sociology (0495/11) • Humanities`
   - Automatically select the correct domain radio button while allowing manual change.

---

### Step 2: Rubric-Aware Mark Scheme Preamble Trimmer

Update [`src/lib/markSchemeDetect.ts`](file:///c:/testmaker/src/lib/markSchemeDetect.ts) and [`src/lib/markSchemeTrim.ts`](file:///c:/testmaker/src/lib/markSchemeTrim.ts):

1. **Detect Levels of Response Grids in Preamble**:
   ```ts
   const RUBRIC_GRID_RE = /Generic levels of response grids|Table [A-D]\s*[-–]\s*use this table/i;
   ```
2. **Safe Boundary Calculation**:
   - Before jumping to `Question Answer Marks`, check if any page between Page 2 and the header page contains `RUBRIC_GRID_RE`.
   - If a rubric table is found (e.g., on Page 8 of MS 11, or Page 5 of MS 21):
     - Set `startPage` to the **first page containing the rubric grids**, NOT the header row!
     - Pages 1–4/7 (administrative notes, copyright, generic annotations) are dropped, but **Tables A, B, C, D are preserved**.
3. **Humanities Domain Safety Override**:
   - If `domain === 'humanities'` and no clean safe boundary can be proven, **disable trimming** and send the full mark scheme. Humanities mark schemes are compact text (usually 20–30 pages of text = ~15k tokens), which fits well within Gemini's 1M token context window.

---

### Step 3: Sociology-Tailored Extraction Prompt & Schema

Extend [`src/lib/gemini.ts`](file:///c:/testmaker/src/lib/gemini.ts):

1. **Refactor `getHumanitiesExtractionPrompt`**:
   Accept `subject?: string` (or `subjectProfile?: SubjectProfile`).
2. **Sociology Prompt Inclusions**:
   - **Text Stimulus Rule**:
     ```
     TEXT STIMULUS ("Source A") PLACEMENT:
     In Sociology Paper 1, Question 1 begins with a reading passage labeled "Source A".
     - Place the complete text of "Source A" into the parent Question 1 stem ("question_text").
     - Also populate "passages": [{ "id": "Source A", "title": "...", "text": "..." }].
     - Sub-parts (a)(i), (a)(ii), (a)(iii) depend directly on Source A.
     - Sub-parts (b), (c), (d), (e) are general research method questions.
     ```
   - **Sub-part Label Syntax**:
     Explicitly instruct how to parse definition questions:
     ```
     DEFINITION SUB-PARTS:
     When Question 2 or 3 begins with:
       Define the term: (a)
       (i) agencies of socialisation [2]
       (ii) hybrid identities [2]
     Extract them as:
       - sub_id: "(a)(i)", question_text: "Define the term: agencies of socialisation", marks: 2
       - sub_id: "(a)(ii)", question_text: "Define the term: hybrid identities", marks: 2
     ```
   - **Levels of Response Essay Schema (8–14 marks)**:
     For high-mark evaluation and discussion questions (`(d)` [10m], `(e)` [8m/12m], `(f)` [14m]), format `mark_scheme` to include both the Level Descriptors from Tables A–D and the question-specific indicative content:
     ```json
     {
       "sub_id": "(f)",
       "question_text": "Evaluate the functionalist view of socialisation... [14]",
       "marks": 14,
       "mark_scheme": "Level 4 (12–14 marks): Excellent sociological knowledge... at least three arguments for and three against with conclusion.\\nLevel 3 (8–11 marks): Good knowledge... two arguments for and two against.\\nLevel 2 (4–7 marks): Some knowledge... one or two arguments.\\nLevel 1 (1–3 marks): Limited knowledge... common sense statements.\\n\\nIndicative Content For:\\n• Durkheim value consensus...\\n• Parsons primary socialisation...\\n\\nIndicative Content Against:\\n• Marxism: socialisation reproduces class inequality...\\n• Feminism: reinforces gender roles...",
       "guidance": "Use Table D to mark this question. Must include arguments for, against, and a conclusion for Level 4."
     }
     ```

---

### Step 4: Deterministic Outline Parser Updates for Optional Papers

In [`src/lib/paperOutlineParse.ts`](file:///c:/testmaker/src/lib/paperOutlineParse.ts):

1. **Fix Profile Family**:
   ```ts
   // Check syllabus before falling back to paperCode numbers:
   const isScience = /^(0620|0625|0610|0653|0654)/.test(syllabus);
   const family = isScience
     ? (paperCode.startsWith('5') ? 'practical-5x'
       : paperCode.startsWith('6') ? 'practical-6x'
       : /^[12]/.test(paperCode) ? 'mcq'
       : /^[34]/.test(paperCode) ? 'structured'
       : 'unknown')
     : 'structured';
   ```
2. **Optional / Choice Marks Validation**:
   - Detect instructions like `"Answer two questions in total"` or `"Answer either Question 2 or Question 3"`.
   - If an optional choice rule is present, validate that the total equals either the required total (80) or the sum of all printed questions (120).

---

### Step 5: Post-Processing & Question Bank Representation

1. **Accurate Metadata Fallback**:
   In [`src/lib/pdfProcessor.ts:1034`](file:///c:/testmaker/src/lib/pdfProcessor.ts#L1034), use the detected subject profile instead of defaulting to Geography.
2. **Preserve All Questions in Question Bank**:
   Extracting all three questions (Q1, Q2, Q3) is the desired behavior for a teacher's Question Bank, giving the teacher a pool of 120 marks of questions.
3. **Optional Group Tagging**:
   Tag Q2 and Q3 with `"option_group": "Section B (Choose 1)"` so the test assembly engine and export tools understand that Q2 and Q3 are alternatives.

---

## 4. Implementation Steps & Verification Plan

### Phase 1: Diagnostics & Verification Harness
- [x] Create test script [`scripts/verify-sociology.mjs`](file:///c:/testmaker/scripts/verify-sociology.mjs) that evaluates `0495_s25_qp_11.pdf`, `0495_s25_ms_11.pdf`, `0495_s25_qp_21.pdf`, and `0495_s25_ms_21.pdf`.
- [x] Establish assertions for:
  - Subject code and name detection (`0495`, `Sociology`).
  - Mark scheme trimming preserves Tables A–D.
  - Sub-part identification: `(a)(i)`, `(a)(ii)`, `(a)(iii)`, `(b)`, `(c)`, `(d)`, `(e)`, `(f)`.

### Phase 2: Mark Scheme Trimmer Fix
- [x] Edit [`src/lib/markSchemeDetect.ts`](file:///c:/testmaker/src/lib/markSchemeDetect.ts) to detect `Generic levels of response grids` and preserve rubric tables.
- [x] Run `npm run verify:phase4` and ensure existing STEM practical mark schemes (0620/53) remain unaffected.

### Phase 3: Subject Classifier & Metadata Fallback
- [x] Implement [`src/lib/subjectClassifier.ts`](file:///c:/testmaker/src/lib/subjectClassifier.ts).
- [x] Update [`src/lib/pdfProcessor.ts`](file:///c:/testmaker/src/lib/pdfProcessor.ts) to resolve metadata dynamically from the detected profile.

### Phase 4: Sociology & Humanities Prompt Upgrades
- [x] Update `getHumanitiesExtractionPrompt` in [`src/lib/gemini.ts`](file:///c:/testmaker/src/lib/gemini.ts) to support Sociology, `Source A` stimulus text, and 8–14 mark Levels of Response rubrics.
- [x] Test live extraction using configured Gemini model.

### Phase 5: Verification & End-to-End Build
- [x] Run `npm run build` (`tsc -b && vite build`) to ensure zero TypeScript errors.
- [ ] Verify extracted Sociology questions in `ExtractionReview` UI.

---

## 5. Review & Implementation Record (2026-11-06)

### 5.1 Audit — findings confirmed against the real papers

| Claim | Measured result |
|---|---|
| Outline rejects 0495/11 | `family: "mcq"`, `usable: false`, reasons `non-monotonic ids in Q2`, `non-monotonic ids in Q3`, `marks sum 120 != printed total 80` — exactly as reported |
| Outline rejects 0495/21 | same plus `non-monotonic ids in Q1` |
| Rubric grids precede the header | `0495_s25_ms_11`: "Generic levels of response grids" on **p8**, Tables A–D on **p9–13**, `Question Answer Marks` on **p14** → trimming dropped 13 of 30 pages, including every rubric table |
| Same loss across the series | 12/12 mark schemes lost rubric pages; e.g. ms_21 dropped p1–6 with Table A on p5 |
| Source A is in-paper | QP p2 prints the Ehrenreich passage above `(a)(i)`; cover says "Answer Question 1. Answer either Question 2 or Question 3." and "The total mark for this paper is 80" |

### 5.2 Corrections to the plan

1. **`passages` schema — the plan's keys are wrong.** `ExtractedPassage` is
   `{ id, heading?, body, page_number?, target_questions? }` (`types/database.ts:132`). The plan proposed
   `{ id, title, text }`, which no consumer reads; the prompt now specifies `heading`/`body`, and the live
   run returned exactly those keys.
2. **`hasInsertByDefault` for 0460 is false, not true.** Geography 0460 P1/P2 print their figures in the
   paper; the insert belongs to Paper 4. The flag is advisory, so no behaviour depends on it.
3. **Registry totals are asserted only where measured.** 0495 = 80 is verified from the cover; 0460/0470/0455
   totals from the plan are left unset rather than guessed.
4. **Optional-choice detection needed a wider cover match.** 0495/21 says only "Answer two questions." —
   the plan's `Answer either …` / `… in total` patterns missed it. Acceptance still requires `sum > total`,
   so a compulsory paper can never be misread as optional.
5. **Orphan roman numerals were the second half of the rejection.** Sociology prints "Define the term: (a)"
   above `(i)`/`(ii)`; the parser emitted bare `(i)`, which broke monotonicity. They now attach to `(a)`.
6. **The outline was only built for single-chunk uploads** (`chunks.length === 1`). A Sociology QP has
   5 active pages → 2 chunks, so the metadata fix would never have run on the target papers. The outline is
   now built for every non-SME upload and used for subject/metadata; only *prompt constraint* stays
   single-chunk.
7. **Humanities trimming is now proof-based.** `trimMarkSchemePreamble` only trims a humanities mark scheme
   when a rubric page was actually found; otherwise it sends the full document rather than risk stripping
   the grid again.
8. **Prompt builder moved to `src/lib/humanitiesPrompt.ts`** (pure, no React/KaTeX/supabase) so the harness
   can build the exact prompt. `gemini.ts` re-exports it, so existing imports keep working.

### 5.3 Files changed

| File | Change |
|---|---|
| `src/lib/subjectClassifier.ts` | **new** — registry + `classifySubject()` from cover text / filename |
| `src/lib/humanitiesPrompt.ts` | **new** — pure humanities prompt, subject-aware metadata, Sociology rules |
| `src/lib/markSchemeDetect.ts` | rubric-grid detection, `method: 'rubric'`, `rubricPage` |
| `src/lib/markSchemeTrim.ts` | domain-aware override; only trim humanities on a proven rubric boundary |
| `src/lib/paperOutlineParse.ts` | syllabus-aware family, orphan-roman attachment, optional-choice marks + `optionGroups` |
| `src/lib/pdfProcessor.ts` | outline built for all non-SME uploads; detected profile used for metadata + prompt; option groups recorded as `mark_scheme._option_group` |
| `src/lib/paperOutline.ts` | `readPdfTextLayout(bytes, maxPages?)` |
| `src/components/PdfUpload.tsx` | detects the syllabus on drop, shows "• Sociology (0495/11)", selects the matching domain |
| `scripts/verify-sociology.mjs` | **new** — offline harness over the 24 sociology PDFs |

### 5.4 Verification

| Check | Result |
|---|---|
| `scripts/verify-sociology.mjs sociology` | **24/24 pass** — subject, family, optional-choice, sub-ids, rubric preservation |
| `verify:phase4` on the practical corpus | **18/18 unchanged**, all still `method: header` |
| `verify:paper5` on the practical corpus | **18/18 pass**, 357 sub-question leaves |
| `tsc -b` / `vite build` | exit 0 / built in 3.04 s |
| Live extraction, 0495_s25_qp_11 + ms_11 | metadata `Sociology/0495/11 · May/June`; Q1 ids `(a)(i) (a)(ii) (a)(iii) (b) (c) (d) (e)`; `passages[0] = {id: "Source A", body: 1131 chars}`; `(f)` 14 marks with `Level 1–4` bands; Q3 kept; 10,921 output tokens |

### 5.5 Still open

- **`ExtractionReview` UI check** — the manual end-to-end look, not covered by the harnesses.
- **0495/21 live run** — the two "Answer two questions" papers have not been through the model yet.
- **`_option_group` is a JSONB sidecar** (`mark_scheme._option_group`); the test builder does not yet read it.
  Wiring it into assembly/export is a separate decision.
- **Chunking for 6–9 page structured papers** still splits into 2 chunks (unchanged behaviour, but Sociology
  QPs are in that band; a single pass would be safer now that their outline verifies).


