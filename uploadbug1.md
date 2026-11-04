# Bug Report: Question 1(a) Truncation & Missing Tables in Paper 53 Extraction

- **Target Paper:** Cambridge IGCSE Chemistry `0620/53/O/N/24` (October/November 2024, Paper 53)
- **Report File:** `uploadbug1.md`
- **Status:** Diagnosis complete · No code modifications made yet

---

## 1. Executive Summary

When extracting Cambridge IGCSE Chemistry Paper 53 (`0620/53/O/N/24`), Question 1(a) failed to extract the experimental procedure text and both data tables (`Table 1.1` and `Table 1.2`). 

Instead of extracting the 8 detailed experiment procedure steps, volumes, reagent amounts, calculation formula, and data tables, sub-part `(a)` only contained a single summarized sentence:
```text
"Record results in Table 1.1 and Table 1.2 and calculate temperature decreases. [5]"
```

The parent question stem only captured the first 4 lines:
```text
"You are going to investigate the temperature change when solid P dissolves in water.
Read all of the instructions carefully before starting the experiments.

Instructions
You are going to do two experiments."
```

All actual experimental steps (Experiment 1, Experiment 2) and both recording tables were completely lost from the extracted question and from the structured tables.

---

## 2. Root Cause Analysis

### 2.1 Exam Paper Layout Variance (`0620/53` vs `0620/51` & `52`)

In standard Cambridge Chemistry Paper 5 variants (such as 51 or 52), the exam layout places all experimental procedures **in the introductory stem before sub-part `(a)`**:
```text
[Standard Layout - Variants 51/52]
1 You are going to investigate...
  Instructions: You are going to do two experiments.
  Experiment 1: • [steps...]
  Experiment 2: • [steps...]
(a) Complete Table 1.1... [5]
    [Table 1.1]
```
In this layout, the procedure is physically in the stem preceding `(a)`, and `(a)` is just the instruction to fill Table 1.1.

**However, on Page 2 of `0620/53/O/N/24`, Cambridge printed `(a)` directly before `Experiment 1`:**
```text
[Actual Layout in 0620/53/O/N/24 - Page 2]
1   You are going to investigate the temperature change when solid P dissolves in water.
    Read all of the instructions carefully before starting the experiments.
    Instructions
    You are going to do two experiments.

(a) Experiment 1
    ● Use the 25 cm3 measuring cylinder to pour 20 cm3 of distilled water into a boiling tube.
    ● Use the thermometer to measure the temperature of the distilled water. Record this temperature in Table 1.1 at time = 0 seconds.
    ● Add a 5 g sample of solid P to the distilled water in the boiling tube. At the same time start the stop-watch.
    ● Continually stir the contents of the boiling tube using the thermometer.
    ● Measure the temperature of the mixture in the boiling tube every 20 seconds for 120 seconds. Record each temperature measured in Table 1.1.
    ● Rinse the boiling tube with distilled water.
    Complete Table 1.1 by calculating the temperature decreases from the temperature at 0 seconds.
    For example, at 60 seconds:
    temperature decrease = temperature at 0 s – temperature at 60 s
    Table 1.1
    time / s                   0   20   40   60   80   100   120
    temperature / °C
    temperature decrease / °C  0.0

    Experiment 2
    ● Repeat Experiment 1 using 10 cm3 of distilled water instead of the 20 cm3 of distilled water.
    ● Record your results for Experiment 2 in Table 1.2.
    Complete Table 1.2 by calculating the temperature decreases from the temperature at 0 seconds.
    Table 1.2
    time / s                   0   20   40   60   80   100   120
    temperature / °C
    temperature decrease / °C  0.0
    [5]
```
The entire experimental procedure across both experiments and both tables is grouped under `(a)` with mark allocation `[5]` at the bottom.

---

### 2.2 Conflicting Rules in `src/lib/practicalPrompt.ts`

Lines 45–46 of `src/lib/practicalPrompt.ts` state:
```text
- "question_text" = the printed stem that appears BEFORE the first sub-part, verbatim. For Question 1 this includes every "Experiment 1"…"Experiment n" block, every bullet, every volume and reagent. Do not summarise or shorten.
- Each sub-part's "question_text" = its printed text from its label up to the next label.
```

1. **Stem Cut-Off:** The prompt instructed Gemini that the parent question's `question_text` is whatever appears **BEFORE** the first sub-part. Because `(a)` was placed right above `Experiment 1`, Gemini truncated the parent stem before `Experiment 1`.
2. **Procedural Omission from `(a)`:** Line 45 explicitly stated that `Experiment 1…Experiment n` blocks belong to `question_text` (the parent question stem). Gemini therefore considered the experiment procedure blocks to be setup instructions rather than sub-question text.
3. **Model Summarization:** When Gemini saw that `(a)` ended at `[5]` after Table 1.2, instead of copying the bullet points and tables verbatim, it summarized what the candidate had to do based on the text inside the page:
   > `"Record results in Table 1.1 and Table 1.2 and calculate temperature decreases. [5]"`

---

### 2.3 Prompt Output Schema Missing `data_tables` in `sub_questions`

In `src/lib/practicalPrompt.ts` (lines 97–100), the output JSON schema only provides `data_tables` on the parent question:
```json
{
  "question_number": "1",
  "question_text": "...",
  "data_tables": [ { "title": "Table 1.1", "columns": ["..."], "rows": [["..."]] } ],
  "sub_questions": [
    {
      "sub_id": "(a)",
      "question_text": "...",
      "marks": 5,
      "page_number": 2,
      "has_diagram": false,
      "diagram_type": null
    }
  ]
}
```

Notice that:
- `data_tables` is defined on `questions[]`, but **not** inside `sub_questions[]`.
- Gemini did not attach `Table 1.1` and `Table 1.2` to the parent question because they were physically under `(a)`.
- Gemini could not attach them to `sub_questions[0]` because the sub-question schema had no `data_tables` property.
- Because Gemini summarized the text of `(a)` into one sentence, it also omitted the Markdown tables from `question_text`.

*(Note: The database types in `src/types/database.ts` and the UI renderer in `src/components/QuestionCard.tsx` already support `sub.data_tables`, so this limitation was purely within the extraction prompt schema.)*

---

## 3. Comparison: Target vs. Extracted Output

| Element | Printed Exam Paper (0620/53/O/N/24) | Extracted Preview (Bugged) |
| :--- | :--- | :--- |
| **Parent Q1 Stem** | Intro + instructions (4 lines) | Intro + instructions (Extracted correctly) |
| **Experiment 1 Bullets** | 6 procedural bullets ($20\text{ cm}^3$, $5\text{ g}$, $120\text{ s}$) | **Missing** |
| **Formula** | $\text{temperature decrease} = \text{temp at } 0\text{s} - \text{temp at } 60\text{s}$ | **Missing** |
| **Table 1.1** | Results table ($0, 20, 40, 60, 80, 100, 120\text{ s}$) | **Missing** |
| **Experiment 2 Bullets** | 2 procedural bullets ($10\text{ cm}^3$, repeat Experiment 1) | **Missing** |
| **Table 1.2** | Results table ($0, 20, 40, 60, 80, 100, 120\text{ s}$) | **Missing** |
| **Sub-part (a) Text** | Verbatim text from `(a) Experiment 1` through `[5]` | Summarized to `"Record results in Table 1.1 and Table 1.2 and calculate temperature decreases."` |

---

## 4. Proposed Fix Plan (Pending Approval)

When approved to apply fixes, the following changes will be made:

1. **Update Output Schema in `src/lib/practicalPrompt.ts`:**
   Add `data_tables?: [ { "title": "Table 1.1", "columns": [...], "rows": [[...]] } ]` inside `sub_questions` so that tables printed within sub-parts are captured in structured form.

2. **Refine Transcription Rules for Layout Variations in `src/lib/practicalPrompt.ts`:**
   - Add explicit guidance for papers where `(a)` appears before `Experiment 1` (e.g. `0620/53`):
     > *If label `(a)` is printed directly before `Experiment 1`, sub-question `(a)` must contain the complete verbatim text from `(a)` up to the next sub-part label `(b)`. This includes every `Experiment 1` and `Experiment 2` bullet point, all volumes, masses, apparatus instructions, temperature formulas, and Markdown tables. NEVER summarize or condense this into a short description.*

3. **Enforce Markdown + JSON Table Preservation:**
   - Clarify that student recording/results tables with blank rows (e.g. Table 1.1 and Table 1.2 with time intervals $0, 20, 40\dots 120\text{ s}$) must be preserved in full:
     - As Markdown tables inside `question_text`.
     - In the `data_tables` array (at the sub-question level or parent level as appropriate).

4. **Verification:**
   Test extraction with `0620 Chemistry November 2024 Question paper 53.pdf` to verify that Q1(a) extracts the full text, formulas, and both tables.

