# Blueprint & Implementation Report: Cambridge IGCSE Geography (`0460`) Support

> **Status**: Completed & Verified  
> **Target Syllabus**: Cambridge IGCSE Geography (`0460`)  
> **Source Directory**: [`igcse geography paper/`](file:///c:/testmaker/igcse%20geography%20paper)  
> **Verification Suites**:
> - [`scripts/verify-igcse-geography.mjs`](file:///c:/testmaker/scripts/verify-igcse-geography.mjs) (**7/7 PASS**)
> - [`scripts/verify-as-geography.mjs`](file:///c:/testmaker/scripts/verify-as-geography.mjs) (**6/6 PASS**)
> - [`scripts/verify-economics.mjs`](file:///c:/testmaker/scripts/verify-economics.mjs) (**20/20 PASS**)
> - [`scripts/verify-sociology.mjs`](file:///c:/testmaker/scripts/verify-sociology.mjs) (**24/24 PASS**)

---

## 1. Executive Summary

An architectural audit and end-to-end integration were performed on the Cambridge IGCSE Geography (`0460`) papers located in [`igcse geography paper/`](file:///c:/testmaker/igcse%20geography%20paper):

1. **Paper 1 (Geographical Themes — `0460/11`, May/June 2023)**:
   - Question Paper: 24 pages, 6 questions ($25\text{ marks}$ each = $150\text{ printed marks}$), 3 Sections (A, B, C), candidate answers 1 per section ($75\text{ paper total}$).
   - Mark Scheme: 19 pages, table begins on Page 3 (trimmed 2 preamble pages).
   - Insert Booklet: 8 pages, containing resource figures `Fig. 2.1`, `Fig. 2.2`, `Fig. 2.3`, `Fig. 2.4`, `Fig. 3.1`, `Fig. 4.1`, `Fig. 4.2`, `Fig. 4.3`.
2. **Paper 1 (Geographical Themes — `0460/12`, Feb/March 2024)**:
   - Question Paper: 28 pages, 6 questions ($25\text{ marks}$ each = $150\text{ printed marks}$), 3 Sections (A, B, C), candidate answers 1 per section ($75\text{ paper total}$).
   - Mark Scheme: 25 pages, table begins on Page 6 (trimmed 5 preamble pages).
3. **Paper 2 (Geographical Skills — `0460/22`, May/June 2024)**:
   - Question Paper: 20 pages, 6 compulsory questions ($20, 8, 8, 8, 8, 8\text{ marks} = 60\text{ marks total}$).
   - Mark Scheme: 8 pages, table begins on Page 4 (trimmed 3 preamble pages).

---

## 2. Diagnostic Findings & Implemented Fixes

### Finding 1: Column Inference Failure Due to Packed Question Lines
- **Problem**:
  In IGCSE Geography Paper 1 and Paper 2, every question packs the question number and part `(a)` stem on the same line:
  ```
  y=717: [x=50] "1"   [x=72] "(a)"   [x=95] "Study Fig. 1.1, which shows..."
  ```
  In [`src/lib/paperOutlineParse.ts`](file:///c:/testmaker/src/lib/paperOutlineParse.ts), column inference previously inspected only `line.items[0]` for `PART_RE`. Because `line.items[0]` was `"1"`, none of the 6 `(a)` parts were counted in `partXs`.
  Consequently:
  - `partXs` only contained `(b)` and `(c)` at $X=72$ ($12\text{ occurrences}$).
  - `partXs` also matched `(i)` at $X=96$ ($12\text{ occurrences}$) because `(i)` matched `PART_RE = /^\(([a-z])\)$/`.
  - In a tie, `mode(partXs)` resolved to $X=96$, and `romanCol` resolved to $X=118$.
  - All subsequent sub-parts failed monotonic checks and were marked duplicate/unattributed.
- **Remediation**:
  In [`src/lib/paperOutlineParse.ts`](file:///c:/testmaker/src/lib/paperOutlineParse.ts), when `QUESTION_RE.test(line.text)`, check if `line.items[1]` matches `PART_RE` and record its X position into `partXs`:
  ```ts
  if (QUESTION_RE.test(line.text) && line.x < 130) {
    qXs.push(line.x);
    const second = line.items[1]?.s.trim() ?? '';
    if (PART_RE.test(second)) partXs.push(line.items[1].x);
  }
  ```
  With this fix:
  - $X=72$ receives $18\text{ counts}$ (6 from `(a)`, 6 from `(b)`, 6 from `(c)`).
  - $X=96$ receives $12\text{ counts}$.
  - $X=72$ unambiguously wins `partCol`, and $X=96$ cleanly becomes `romanCol`.
  - All questions parse with **0 duplicate IDs, 0 unattributed marks, and 100% accurate sub-part trees**.

---

### Finding 2: Three-Tier Section Option Grouping ("one from each section")
- **Problem**:
  Paper 1 instructions specify:
  > *"Answer three questions in total, one from each section."*
  Sections are organized as:
  - Section A: Theme 1 — Population and Settlement (Q1, Q2)
  - Section B: Theme 2 — The Natural Environment (Q3, Q4)
  - Section C: Theme 3 — Economic Development (Q5, Q6)
  Previously, `paperOutlineParse.ts` only recognized two-tier compulsory Section A + optional Section B, falling back to a flat `"Optional: answer 3 of 6"` pool for all questions.
- **Remediation**:
  In [`src/lib/paperOutlineParse.ts`](file:///c:/testmaker/src/lib/paperOutlineParse.ts), added multi-section option group recognition:
  ```ts
  const oneFromEachSection = /one\s+(?:question\s+)?from\s+each\s+section/i.test(coverText);

  if (oneFromEachSection) {
    const groups: Record<number, string> = {};
    const sections = [...new Set(questions.map((q) => q.section).filter(Boolean))];
    for (const sec of sections) {
      const secQuestions = questions.filter((q) => q.section === sec);
      if (secQuestions.length > 1) {
        const label = `Section ${sec}: choose 1 of ${secQuestions.length} (Q${secQuestions[0].number}–Q${secQuestions[secQuestions.length - 1].number})`;
        for (const q of secQuestions) {
          groups[q.number] = label;
        }
      }
    }
    profile.optionGroups = groups;
  }
  ```
  Resulting option groups:
  - `Q1`, `Q2`: `"Section A: choose 1 of 2 (Q1–Q2)"`
  - `Q3`, `Q4`: `"Section B: choose 1 of 2 (Q3–Q4)"`
  - `Q5`, `Q6`: `"Section C: choose 1 of 2 (Q5–Q6)"`
  Meanwhile, Paper 2 is recognized as 100% compulsory ($60\text{ marks}$, no option groups).

---

### Finding 3: Syllabus Registry Alignment
- **Problem**:
  In [`src/lib/subjectClassifier.ts`](file:///c:/testmaker/src/lib/subjectClassifier.ts), the entry for `0460` had `hasInsertByDefault: false`, `isOptionalChoicePaper: false`, and no `standardTotalMarks`.
- **Remediation**:
  Updated the profile to match verified exam specifications:
  ```ts
  '0460': {
    syllabusCode: '0460',
    subjectName: 'Geography',
    domain: 'humanities',
    hasInsertByDefault: true,
    hasInPaperStimulus: false,
    isOptionalChoicePaper: true,
    // Paper 1 total mark is 75 (answers 3 of 6, each 25 marks); Paper 2 total mark is 60 (all compulsory).
    standardTotalMarks: 75,
  },
  ```

---

## 3. Verification & Test Results

### 3.1 Offline Test Suite ([`scripts/verify-igcse-geography.mjs`](file:///c:/testmaker/scripts/verify-igcse-geography.mjs))
```
PASS  Paper 1-Insert-0460-11-May_June2023-pdf.pdf          pages=8
PASS  Paper 1-Mark Scheme-0460-May_June-2023.pdf           pages=19 start=3/header kept=17
PASS  Paper 1-Mark Scheme-0460_12-Feb_March-2024.pdf       pages=25 start=6/header kept=20
PASS  Paper 1-Questions-0460_11-May_June-2023.pdf          Q:25/25/25/25/25/25
PASS  Paper 1-Questions-0460_12-Feb_March-2024.pdf         Q:25/25/25/25/25/25
PASS  Paper 2-Mark Scheme-0460_22-May_June-2024pdf.pdf     pages=8 start=4/header kept=5
PASS  Paper 2-Questions-0460_22-May_June-2024.pdf          Q:20/8/8/8/8/8

7 passed, 0 failed
```

### 3.2 Regression Suites (All Green)
- `scripts/verify-as-geography.mjs` (**6/6 PASS**)
- `scripts/verify-economics.mjs` (**20/20 PASS**)
- `scripts/verify-sociology.mjs` (**24/24 PASS**)

---

## 4. End-to-End Extraction Results

### 4.1 Paper 1 (`0460/11`, May/June 2023)
- Model: `gemini-3.5-flash-lite` (latency: $34.6\text{s}$)
- Questions extracted: 6/6 ($25\text{ marks}$ each)
- Sub-questions extracted: 42 sub-parts ($7\text{ sub-parts}$ per question: `(a)(i)`, `(a)(ii)`, `(a)(iii)`, `(a)(iv)`, `(b)(i)`, `(b)(ii)`, `(c)`)
- Total printed marks sum: **150 / 150 marks (100% exact match)**
- Insert Resources catalog: 5 items extracted and linked:
  - `[Figs. 2.1, 2.2 and 2.3]` -> Target: `2(a)`
  - `[Fig. 2.4]` -> Target: `2(b)`
  - `[Fig. 3.1]` -> Target: `3(a)`
  - `[Figs. 4.1, 4.2 and 4.3]` -> Target: `4(a)`
  - `[Fig. 5.2]` -> Target: `5(b)`
- Full parsed artifact: `scripts/extraction-igcse-geography-gemini-3.5-flash-lite.json`

### 4.2 Paper 2 (`0460/22`, May/June 2024)
- Model: `gemini-3.5-flash-lite` (latency: $22.5\text{s}$)
- Questions extracted: 6/6 ($20, 8, 8, 8, 8, 8\text{ marks}$)
- Sub-questions extracted: 34 sub-parts across Q1–Q6
- Total printed marks sum: **60 / 60 marks (100% exact match)**
- Full parsed artifact: `scripts/extraction-igcse-geography-paper2.json`
