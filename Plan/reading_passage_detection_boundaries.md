# Reading Passage Detection & Boundary Rules

This document records how the ICM Exam Platform automatically identifies reading passages, defines where a passage starts and ends, propagates shared passages across questions, and splits them in `StudentQuizRunner.tsx` (both Formal Exam Mode and Practice Mode), along with known boundary bugs identified against the current implementation.

> **Short Answer:** Yes, reading passage detection is **automatic** and runs in two stages: (1) **during PDF extraction/import** and (2) **at runtime in `StudentQuizRunner.tsx`**.

---

## 1. Runtime Separation in `StudentQuizRunner.tsx` (Formal Exam & Practice Modes)

When a student views a question, `splitPassageAndPrompt(text, options, { allowParagraphHeuristic })` (`src/pages/StudentQuizRunner.tsx:333-383`) receives `rawStem` (`currentTable ? currentTable.preTableText : currentQuestion.question_text || ''`, line `4250`) and splits it into:
- `passageText` -> rendered in the **📖 Reference Reading Passage** card (`sq-stimulus-card`)
- `promptText` -> rendered in the main question stem / pinned question bar

### Split Rules & Start/End Boundaries
1. **Normalization & Minimum Length Guard (`clean.length < 180`):**
   - First runs `cleanQuestionStem(text, options)` to strip trailing duplicated MCQ options (`src/pages/StudentQuizRunner.tsx:339-344`).
   - If the cleaned stem is shorter than `180` characters, no split happens (`passageText = null`).

2. **Rule 1 — Explicit `###` Markdown Header Split (`src/pages/StudentQuizRunner.tsx:348-358`):**
   - **Headers matched:**
     - When `allowParagraphHeuristic` is enabled (Language questions without sub-questions): `### Text`, `### Passage`, `### Reading`, `### Stimulus`, `### Wacana`, `### Bacaan` (with optional number `\d*`).
     - Otherwise (STEM/other or multi-part questions): `### Reading Passage`, `### Wacana`, `### Bacaan` (with optional number `\d*`).
   - **Start boundary:** Start of `clean` up through the matching `###` header.
   - **End boundary:** The **first blank line (`\n\s*\n`)** after that header (`*?\n\s*\n`). Everything following that blank line becomes `promptText`.

3. **Rule 2 — Multi-Paragraph Heuristic (Fallback when Rule 1 does not match):**
   - **Enabled only when:** `allowParagraphHeuristic` is `true` — specifically `Boolean(isLanguageExam && !hasSubQuestions)` (`src/pages/StudentQuizRunner.tsx:4253`). Multi-part questions (`sub_questions.length > 0`) and STEM/Math questions never run this heuristic.
   - Splits `clean` on blank lines (`\n\s*\n`) into paragraphs:
     - **Start / Passage (`passageText`):** All paragraphs **except the last one**, provided their combined length is **`>= 220` characters** and they contain **no `$$` block math** and **no Markdown tables** (`/^\s*\|.*\|/m`).
     - **End / Prompt (`promptText`):** The **final paragraph**, provided it looks like a question prompt — i.e., contains `?`, starts with a question/command word (`which`, `what`, `how`, `why`, `where`, `when`, `who`, `explain`, `state`, `describe`, `determine`, `identify`, `suggest`, `compare`, `evaluate`, `discuss`, `complete`, `select`, `choose`, `berdasarkan`, `mengapa`, `apakah`, `bagaimana`, `jelaskan`), OR is `< 200` characters.

4. **Split View vs. Stacked View Layout (`isReadingSplitActive`):**
   - When `activeReadingPassage` (`activeStimulusPassage || passageText`) exists and its length is **`>= 600` characters**, `StudentQuizRunner.tsx` defaults to a side-by-side **Split View** (`sq-reading-split-grid`), with a toggle button to switch to **Stacked View** (`src/pages/StudentQuizRunner.tsx:4257-4262`, `6855-6875`).

---

## 2. Cross-Question Passage Inheritance (`activeStimulusPassage`)

If the current question has no `### (Text|Passage|Reading|Stimulus|Wacana|Bacaan) <N>` header (`\s*\d+` required) in its own stem (`src/pages/StudentQuizRunner.tsx:4000-4022`):
- Checks `isLanguageExam && !currentQuestionDomain.isStemOrMath` (never runs on STEM/Math questions or non-language exams).
- Scans **backwards** through earlier questions (`currentIndex - 1` down to `0`), stopping immediately if it encounters a STEM/Math boundary (`prevDomain.isStemOrMath`).
- From the first earlier question matching `### (Text|Passage|Reading|Stimulus|Wacana|Bacaan) \d+`, extracts:
  - **Start:** `### (Text|Passage|Reading|Stimulus|Wacana|Bacaan) <N>`
  - **End:** Immediately before the first `\n 1.`, `\n **Question`, `\n Question <N>`, or end of string.

---

## 3. PDF Extraction & Import Stage

1. **AI Passages Catalog Stitching (`src/lib/passageExtractor.ts:225-326`):**
   - During Gemini PDF extraction, shared reading passages are extracted into a top-level `passages` array (`id`, `heading`, `body`, `target_questions`).
   - `stitchPassagesToQuestions` links each question by `passage_ref`, `target_questions` (or Skill+Number for `R...`), or heading mention (skipping non-reading Listening/Writing skills), deduplicates against the first 80 chars of `targetPassage.body`, and formats `### <Heading>\n\n<body>\n\n<cleanStem>` directly into `question_text`.

2. **Fallback Text Detector & Propagator (`src/lib/pdfProcessor.ts:378-518`):**
   - When a passage is embedded directly in an extracted question stem instead of the `passages` catalog, `detectPassageContent` requires `>= 150` trimmed chars overall and `>= 100` chars of substantive non-header lines (filtering out header lines and short lines `<= 20` chars).
   - **Start:** Beginning of the stem (or `promptIntroMatch` intros like `"The following text is for questions..."` / `"Read the following text/passage..."`, requiring `> 150` chars).
   - **End:** Stops at the **first** match of `promptSplitRegex` (`\n 1.`, `\n Question <N>`, `[Matching|Multiple|Table|Fill|Pilihan|Menjodohkan]`, or a line starting with `Which`, `What`, `How`, `Explain`, `According to`, `Based on`, `In the text`, `The author`, etc.), or before the final paragraph if multi-paragraph ending in a question.
   - `propagateReadingPassages` then copies that detected passage onto subsequent questions matching the declared question range, heading reference, or reading-reference keywords (e.g. `Based on the passage`, `According to the text`, `Paragraph 2`).

---

## 4. Known Boundary Bugs (Code Audit Findings)

1. **Rule 1 (`splitPassageAndPrompt`) breaks on every passage stitched by `stitchPassagesToQuestions`:**
   - `stitchPassagesToQuestions` (`src/lib/passageExtractor.ts:318`) always inserts `\n\n` immediately after `### <Heading>` (`### Text 1\n\n<body>\n\n<prompt>`).
   - Because Rule 1 (`src/pages/StudentQuizRunner.tsx:349-350`) uses a lazy `[\s\S]*?\n\s*\n`, it stops at the **first** blank line right after `### <Heading>`, placing only the short title in `passageText` (preventing Split View `>= 600` chars) and leaving the entire passage body mixed inside `promptText`.
2. **Cross-question inheritance (`activeStimulusPassage`) misses non-numbered headings and can copy Q1's question prompt:**
   - Lines `4007` and `4016` require at least one digit (`\s*\d+`), whereas Rule 1 uses `\s*\d*` — unnumbered headers (`### Passage`, `### Text A`, `### Stimulus`) never inherit backward to Q2+.
   - When Q1 uses prose prompts instead of `\n 1.` / `\n Question <N>`, `activeStimulusPassage` captures Q1's question stem along with the passage and displays it inside Q2+'s passage card.
3. **Mid-passage truncation in `detectPassageContent` (`src/lib/pdfProcessor.ts:384-391`):**
   - Matching the **first** occurrence of `promptSplitRegex` cuts a passage short if the body prose itself contains a numbered list (`\n 1.`) or starts a paragraph with `"The author..."`, `"In the text..."`, `"According to..."`, or `"What..."`.
   - Short dialogue or poetry lines (`<= 20` chars) are excluded from the `100`-character body prose check (`line 422`).
4. **Table pre-split cutoff (`src/pages/StudentQuizRunner.tsx:4250`):**
   - For questions containing Markdown tables (`currentTable`), only `currentTable.preTableText` is passed into `splitPassageAndPrompt`, so any prose paragraphs located after a table are not evaluated for passage splitting.
