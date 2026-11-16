# Reading Passage Detection & Boundary Rules

This document records how the ICM Exam Platform automatically identifies reading passages, defines where a passage starts and ends, propagates shared passages across questions, and splits them in Formal Exam Mode.

> **Short Answer:** Yes, reading passage detection is **automatic** and runs in two stages: (1) **during PDF extraction/import** and (2) **at runtime in Formal Exam Mode**.

---

## 1. Runtime Separation in Formal Exam Mode (`src/pages/StudentQuizRunner.tsx`)

When a student views a question, `splitPassageAndPrompt(text, options, { allowParagraphHeuristic })` (`src/pages/StudentQuizRunner.tsx:333-383`) splits a question's `question_text` into:
- `passageText` -> rendered in the **📖 Reference Reading Passage** card (`sq-stimulus-card`)
- `promptText` -> rendered in the main question stem / pinned question bar

### Split Rules & Start/End Boundaries
1. **Minimum Length Guard (`< 180` chars):**
   - If the cleaned `question_text` is shorter than `180` characters, no split happens (`passageText = null`).

2. **Rule 1 — Explicit `###` Markdown Header Split:**
   - **Headers matched:**
     - When `allowParagraphHeuristic` is enabled (Language questions without sub-questions): `### Text`, `### Passage`, `### Reading`, `### Stimulus`, `### Wacana`, `### Bacaan` (with optional number).
     - Otherwise (STEM/other questions): `### Reading Passage`, `### Wacana`, `### Bacaan` (with optional number).
   - **Start boundary:** Start of `question_text` up through the matching `###` header.
   - **End boundary:** The **first blank line (`\n\s*\n`)** after that header (`*?\n\s*\n`). Everything following that blank line becomes `promptText`.
   - **Important edge-case behavior:** Because the regex match before `\n\s*\n` is lazy (`[\s\S]*?\n\s*\n`), if a stitched question places a blank line immediately after `### Heading` (`### Heading\n\nParagraph 1...\n\nQuestion?`), Rule 1 ends right after `### Heading`, leaving the body paragraphs inside `promptText` instead of `passageText`.

3. **Rule 2 — Multi-Paragraph Heuristic (Fallback when Rule 1 does not match):**
   - **Enabled only when:** `allowParagraphHeuristic` is `true` — specifically `isLanguageExam && !hasSubQuestions` (`src/pages/StudentQuizRunner.tsx:4251`). Multi-part questions (`sub_questions.length > 0`) and STEM/Math questions never run this heuristic.
   - Splits `question_text` on blank lines (`\n\s*\n`) into paragraphs:
     - **Start / Passage (`passageText`):** All paragraphs **except the last one**, provided their combined length is **`>= 220` characters** and they contain **no `$$` block math** and **no Markdown tables** (`/^\s*\|.*\|/m`).
     - **End / Prompt (`promptText`):** The **final paragraph**, provided it looks like a question prompt — i.e., contains `?`, starts with a question/command word (`which`, `what`, `how`, `why`, `where`, `when`, `who`, `explain`, `state`, `describe`, `determine`, `identify`, `suggest`, `compare`, `evaluate`, `discuss`, `complete`, `select`, `choose`, `berdasarkan`, `mengapa`, `apakah`, `bagaimana`, `jelaskan`), OR is `< 200` characters.

4. **Split View vs. Stacked View Layout (`isReadingSplitActive`):**
   - When `activeReadingPassage` exists and its length is **`>= 600` characters**, Formal Exam Mode defaults to a side-by-side **Split View** (`sq-reading-split-grid`), with a toggle button to switch to **Stacked View** (`src/pages/StudentQuizRunner.tsx:4259`, `6855-6875`).

---

## 2. Cross-Question Passage Inheritance (`activeStimulusPassage`)

If the current question has no `### Text|Passage|Reading|Stimulus|Wacana|Bacaan <N>` header in its own stem (`src/pages/StudentQuizRunner.tsx:4000-4021`):
- Formal Exam Mode checks if the current question is a Language question (never inheriting on STEM/Math questions).
- It scans **backwards** through earlier questions (`currentIndex - 1` down to `0`), stopping immediately if it encounters a STEM/Math boundary (`prevDomain.isStemOrMath`).
- From the first earlier question containing a `### <Header> <N>` block, it extracts:
  - **Start:** `### (Text|Passage|Reading|Stimulus|Wacana|Bacaan) <N>`
  - **End:** Immediately before the first `\n 1.`, `\n **Question`, `\n Question <N>`, or end of string.

---

## 3. PDF Extraction & Import Stage

1. **AI Passages Catalog Stitching (`src/lib/passageExtractor.ts:225-326`):**
   - During Gemini PDF extraction, shared reading passages are extracted into a top-level `passages` array (`id`, `heading`, `body`, `target_questions`).
   - `stitchPassagesToQuestions` links each question by `passage_ref`, `target_questions`, or heading mention (skipping non-reading Listening/Writing skills) and prepends `### <Heading>\n\n<body>\n\n<question_prompt>` directly into `question_text`.

2. **Fallback Text Detector & Propagator (`src/lib/pdfProcessor.ts:378-518`):**
   - When a passage is embedded directly in an extracted question stem instead of the `passages` catalog, `detectPassageContent` requires `>= 150` total chars and `>= 100` chars of non-header body prose.
   - **Start:** Beginning of the stem (including natural intros such as `"The following text is for questions..."` or `"Read the following text/passage..."`).
   - **End:** Stops right before the first matching prompt boundary (`\n 1.`, `\n Question <N>`, `[Matching|Multiple|Table|Fill|...]`, or a line starting with `Which`, `What`, `How`, `Explain`, `According to`, `Based on`, etc.), or before the final paragraph if it ends in a question.
   - `propagateReadingPassages` then copies that detected passage onto consecutive subsequent questions matching the declared question range (e.g. `1 to 5`) or passage title/phrase references.
