# Blueprint & Implementation Plan: Cambridge IGCSE Economics (`0455`) Support (`Plan/economics.md`)

## 1. Executive Summary

An architectural audit was performed on the Cambridge IGCSE Economics past paper corpus located in [`economics paper/`](file:///c:/testmaker/economics%20paper):
- **Paper 2 (Structured / Theory)**: e.g. `0455/22` (June 2024, March 2025, Nov 2025, June 2022).
  - 8 pages QP, 26–29 pages MS.
  - Section A: Compulsory Question 1 (In-paper Case Study, Fact File, Fig. 1.1 chart) = **30 marks**.
  - Section B: Choice of 3 out of 4 questions (Q2, Q3, Q4, Q5), each 20 marks = **60 marks**.
  - Total candidate marks = **90 marks**; total printed marks = **110 marks** ($30 + 80$).
- **Paper 1 (Multiple Choice)**: e.g. `0455/12` (June 2023, March 2023, June 2025).
  - 12 pages QP, 3 pages MS.
  - 30 standalone MCQ questions with 4 options (A, B, C, D) = **30 marks**.

### Baseline Compatibility Assessment
The pipeline currently provides **~80% baseline compatibility**. Four concrete gaps must be addressed to achieve 100% extraction precision:
1. **Sub-part line packing on Question 1**: `1 (a) Calculate... [1]` drops `(a)` because the regex only checked for `(part)(roman)` compound patterns.
2. **Two-tier option grouping**: Cover instruction `"Section A: answer Question 1. Section B: answer three questions"` currently falls back to `"Optional: answer 4 of 5"` across all questions instead of isolating Section B.
3. **Paper 1 Multiple Choice family classification**: `paperFamily` forces non-science syllabi to `'structured'`, causing Paper 12 outline to fail validation (`marks sum 0 != printed total 30`).
4. **Filename paper code extraction**: Long file names like `0455 Economics March 2023 Question paper  12.pdf` exceed the 12-character distance limit in `CODE_IN_NAME_RE`.

---

## 2. Detailed Diagnostic Findings

### Finding A: Sub-part Line Packing on Question 1 (`1 (a) Calculate... [1]`)
- **Observation**:
  Running outline extraction on `0455/22` June 2024 yields:
  ```
  Q1 (sec A): 7 subs, sum=29, declared=null
    subs: (b)[2], (c)[2], (d)[4], (e)[4], (f)[5], (g)[6], (h)[6]
  ```
  Question 1 drops sub-part `(a) [1m]`, giving 29 marks instead of 30.
- **Root Cause**:
  In [`src/lib/paperOutlineParse.ts:342-352`](file:///c:/testmaker/src/lib/paperOutlineParse.ts#L342-L352), the inline sub-part handler matches:
  ```ts
  const inline = questionMatch[2].match(/^\(([a-h])\)\s*\(\s*(i{1,3}|iv|v|vi{1,3})\s*\)/);
  ```
  This specifically targets compound `(part)(roman)` identifiers (e.g. `4 (a) (i)` in AS Geography). In Economics Paper 2, Question 1 starts directly with `1 (a) Calculate... [1]`. The regex fails to match, and the `continue;` statement consumes the line without recording `(a)`.
- **Fix**:
  Extend inline detection to support single-letter sub-parts `^\(([a-h])\)\s+(?!\()` when no roman numeral follows.

---

### Finding B: Section-Aware Option Groups (`Choose 3 of 4 in Section B`)
- **Observation**:
  `paperOutlineParse.ts` tags all five questions with `Optional: answer 4 of 5`:
  ```json
  "optionGroups": {
    "1": "Optional: answer 4 of 5",
    "2": "Optional: answer 4 of 5",
    "3": "Optional: answer 4 of 5",
    "4": "Optional: answer 4 of 5",
    "5": "Optional: answer 4 of 5"
  }
  ```
- **Root Cause**:
  Economics Paper 2 prints:
  `"Answer four questions in total: Section A: answer Question 1. Section B: answer three questions."`
  The current regexes only check:
  - `sectionACompulsory = /Section\s+A\s*:?\s*(?:answer\s+)?all\s+questions/i`
  - `sectionBOptional = /Section\s+B\s*:?\s*(?:answer\s+)?(?:one|1)\s+question/i`
  Because neither matches, the parser falls back to generic counting (`Answer four questions`), tagging Q1 as optional.
- **Fix**:
  Add pattern matching for Economics-style section rules:
  - Section A: `"Section A: answer Question 1"` $\rightarrow$ compulsory.
  - Section B: `"Section B: answer three questions"` $\rightarrow$ tags Section B questions (Q2–Q5) with `"Section B: choose 3 of 4 (Q2–Q5)"`.

---

### Finding C: Paper 1 (Multiple Choice) Family Classification
- **Observation**:
  On `0455/12` June 2023:
  ```
  OUTLINE usable: false
  Reasons: [ 'marks sum 0 != printed total 30' ]
  Questions found: 30
  ```
- **Root Cause**:
  In [`src/lib/paperOutlineParse.ts:241-249`](file:///c:/testmaker/src/lib/paperOutlineParse.ts#L241-L249):
  ```ts
  function paperFamily(syllabus: string, paperCode: string): PaperFamily {
    const isScience = /^(0620|0625|0610|0653|0654|9701|9702|9700)/.test(syllabus);
    if (!isScience && syllabus) return 'structured';
    ...
  ```
  Non-science syllabi are unconditionally routed to `'structured'`. Multiple choice papers do not print mark brackets `[1]` next to individual questions. In a structured paper, missing marks cause `sum = 0`, triggering validation rejection.
- **Fix**:
  Recognize that in Economics (`0455`), Business Studies (`0450`), and Accounting (`0452`), papers with `paperCode` starting with `1` are Multiple Choice (`'mcq'`). For `'mcq'`, each question defaults to 1 mark, producing a valid 30-question / 30-mark outline.

---

### Finding D: Mark Scheme Trimming is 100% Reliable & Rubric-Safe
- **Observation**:
  All 11 mark schemes in `economics paper/` trigger `detectMarkSchemeTableStart` with `method: 'header'`:
  - **Paper 22 (Structured)**: Starts at Page 7 or 8 (drops pages 1–6 generic administrative principles, keeps pages 7–29).
  - **Paper 12 (MCQ)**: Starts at Page 2 (drops page 1 cover, keeps pages 2–3 answer table).
- **Rubric Structure**:
  - In Paper 22, 8-mark "Discuss" questions (`1(g)`, `1(h)`, `2(d)`, `3(d)`, `4(d)`, `5(d)`) embed Level 1 to Level 3 descriptors and "Why it might / Why it might not" points **directly inside each question's table** (e.g. Page 16–17 for 2d).
  - Trimming is completely safe; 100% of question tables and rubric levels are preserved.

---

### Finding E: In-Paper Stimulus ("Source Material")
- **Structure**:
  - Question 1 is preceded by: `"Source material: The challenges facing the Tunisian government"`.
  - Includes a fact file summary box, 4 paragraphs of economic context, and an in-paper data chart (`Fig. 1.1`).
  - Handled cleanly via `hasInPaperStimulus: true` on syllabus `0455`.

---

## 3. Implementation Plan

```
┌────────────────────────────────────────────────────────────────────────┐
│                   PHASED IMPLEMENTATION ROADMAP                        │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Sub-part line packing (`paperOutlineParse.ts`)                      │
│    - Support inline `(a)` without roman numerals on Question 1 line.   │
│                                                                        │
│ 2. Section B option grouping (`paperOutlineParse.ts`)                  │
│    - Match "Section A: answer Question 1. Section B: answer three"     │
│    - Tag Q2–Q5 with "Section B: choose 3 of 4 (Q2–Q5)".                │
│                                                                        │
│ 3. Paper 1 Multiple Choice family recognition (`paperOutlineParse.ts`) │
│    - Route 0455 Paper 1x to 'mcq' family with 1 mark per question.     │
│                                                                        │
│ 4. Filename paper code regex update (`subjectClassifier.ts`)           │
│    - Allow looser spacing between syllabus code and paper code.        │
│                                                                        │
│ 5. Offline Verification Test Suite (`scripts/verify-economics.mjs`)   │
│    - Validate all 9 question papers and 11 mark schemes.               │
│                                                                        │
│ 6. Live Multimodal Simulation (`scripts/simulate-economics.mjs`)       │
│    - Benchmark Paper 22 and Paper 12 extraction against Gemini.        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Verification Checkpoints

1. **Paper 22 Outline Validation**:
   - `Q1`: 8 sub-parts (`(a)[1], (b)[2], (c)[2], (d)[4], (e)[4], (f)[5], (g)[6], (h)[6]`) $\rightarrow$ sum = 30 marks.
   - `Q2–Q5`: 4 sub-parts each (`(a)[2], (b)[4], (c)[6], (d)[8]`) $\rightarrow$ sum = 20 marks each.
   - Option group: Q1 compulsory, Q2–Q5 carrying `"Section B: choose 3 of 4 (Q2–Q5)"`.
2. **Paper 12 Outline Validation**:
   - 30 questions, 30 marks total, `family: 'mcq'`, `usable: true`.
3. **Mark Scheme Trim Safety**:
   - 11/11 mark schemes trimmed at valid table headers without dropping Level 1–3 criteria.
4. **Production Build**:
   - `npm.cmd run build` passing with 0 TypeScript/Vite errors.

