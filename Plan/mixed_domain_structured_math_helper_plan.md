# Plan: Per-Question Domain Detection & Math Text Helper for Mixed Exams (Admission Tests)

## Problem Summary
In Formal Exam Mode (`src/pages/StudentQuizRunner.tsx`), subject detection (`isLanguageExam`, `isChemistryExam`, `isStemOrMathExam`) currently evaluates **once for the entire exam** using `headerConfig.subject`, `headerConfig.subjectCode`, `headerConfig.additionalMaterials`, `title`, and `questions[0]?.topic` only. Additionally, `isLanguageExam` forces both `isChemistryExam` and `isStemOrMathExam` to `false`.

For mixed-subject exams such as an **Admission Test** (containing both English and Math structured questions):
1. If Q1 or the exam title/subject is Language-like or generic (e.g. `"Admission Test"`), **none** of the Math structured questions show the symbol toolbar, `$...$` hint, or single-part `Live Response & Formula Preview`.
2. If the exam is flagged STEM, English structured questions show Chemistry symbols (`mol/dm³`, `(aq)`, `⇌`).
3. The current student toolbar (`QUICK_CHEM_SYMBOLS`) lacks core Math tools—subscripts (`x₂` / `_{}`), exponents (`xⁿ` / `^{}`), fractions (`\frac{}{}`), roots (`\sqrt{}`), Greek/variable symbols (`π`, `θ`, `Δ`), and math operators (`±`, `×`, `÷`, `≤`, `≥`, `≠`, `≈`)—and `handleInsertSymbol` appends to the end of the text instead of inserting at the textarea cursor.

---

## Implementation Plan

### Step 1: Per-Question & Per-Sub-Question Domain Classifier
- **New utility:** `src/utils/questionDomainDetector.ts`
- Export `classifyQuestionDomain(question, subQuestion?, examContext?)` returning `'math' | 'chemistry' | 'science' | 'language' | 'general'` plus `hasMathSignals` / `hasLanguageSignals`.
- **Priority order:**
  1. **Question / Sub-question text, `topic`, `sub_topic`, and `mark_scheme` first:**
     - **Math signals:** topic/sub-topic keywords (`math`, `algebra`, `geometry`, `calculus`, `trigonometry`, `probability`, `statistics`, `arithmetic`, `number`, `mensuration`, `vector`, `matrix`, `coordinate`, `logarithm`, `quadratic`, `inequality`, `ratio`, `fraction`, `function`, `numeracy`, `quantitative`) or LaTeX/math syntax in prompt/mark scheme (`$...$`, `\frac`, `\sqrt`, `^{`, `_{`, `\le`, `\ge`, `\pi`, `\theta`, `\times`, `\div`, `\pm`, `solve for`, `simplify`, `factorize`, `evaluate`, `find the value of`).
     - **Chemistry / Science signals:** chemistry/physics/bio keywords (`chem`, `phys`, `bio`, `stoichiometry`, `titration`, `mole`, `enthalpy`, `ion`, `isotope`, `circuit`, `velocity`, `force`, `voltage`, `dm³`, `mol`, `⇌`, `(aq)`).
     - **Language signals:** topic/sub-topic keywords (`reading`, `listening`, `writing`, `grammar`, `vocabulary`, `comprehension`, `english`, `bahasa`, `literature`, `cefr`, `ielts`, `speaking`) or explicit writing-essay cues (`write at least N words`, passage headers like `### Passage` / `### Text`).
  2. **Exam metadata (`headerConfig.subject`, `headerConfig.subjectCode`, `title`) only as a fallback** when the individual question has no clear domain signals—ignoring neutral/mixed titles such as `admission`, `entrance`, `placement`, or `assessment`.
- **Reading passage bleed guard in `StudentQuizRunner.tsx`:**
  - Restrict `activeStimulusPassage` and `allowParagraphHeuristic` in `splitPassageAndPrompt` using the **current question's** classification (`currentDomain === 'language'`) instead of an exam-wide `isLanguageExam` boolean, preventing an earlier English reading passage from attaching to a subsequent Math question.

---

### Step 2: Math + Chemistry Quick-Insert Toolbars (Subscripts, Exponents, Fractions, Variables)
- Define focused student symbol presets (reusing compatible LaTeX/`ExamMathText` tokens so live KaTeX preview renders immediately):
  - **Math Toolbar (`math` questions):**
    - Structural templates (cursor placed inside first `{}`):
      - `xₙ` (Subscript): `_{}`
      - `xⁿ` (Superscript / Power): `^{}`
      - `a/b` (Fraction): `\frac{}{}`
      - `√` (Square Root): `\sqrt{}`
    - Variables / Constants / Math Symbols: `π`, `θ`, `Δ`, `±`, `×`, `÷`, `≤`, `≥`, `≠`, `≈`, `°`, `∞`
  - **Chemistry / Science Toolbar (`chemistry` / `science` questions):**
    - Subscript `xₙ` (`_{}`) and Superscript `xⁿ` (`^{}`) alongside existing `QUICK_CHEM_SYMBOLS` (`→`, `⇌`, `Δ`, `°C`, `mol/dm³`, `g/cm³`, `kJ/mol`, `(s)`, `(l)`, `(g)`, `(aq)`, `⁺`, `⁻`, `²`, `³`, `⁴`).
- Verify `ExamMathText.tsx` (`renderTextWithSubSuper` + `ensureInlineMathDelimiters`) renders both raw `x_{1}` / `\frac{a}{b}` and `$...$`-delimited math cleanly in the live preview card.

---

### Step 3: Cursor-Aware Insertion & Adaptive Structured Textboxes in `StudentQuizRunner.tsx`
1. **Cursor-aware insertion helper:**
   - Maintain a map of active `<textarea>` refs (`structuredTextareaRefs`, keyed by `currentIndex` or `${currentIndex}_${sIdx}`).
   - Upgrade `handleInsertSymbol` (or replace with `handleInsertMathTemplate`) so clicking any pill:
     - Inserts at `selectionStart..selectionEnd` instead of appending to the end.
     - Wraps selected text when applicable (e.g., selecting `2` and clicking `xₙ` produces `_{2}`; selecting `x+1` and clicking `√` produces `\sqrt{x+1}`).
     - Moves focus back to that `<textarea>` with the cursor positioned inside `{}` (or right after an inserted symbol).
2. **Adaptive Structured Boxes (both Single-Part and Multi-Part Sub-Questions):**
   - **Single-part structured box:** Drive label (`Your Response / Math & Formula:` vs `Your Response / Written Answer:` vs `Your Academic Writing Response:`), helper toolbar visibility, footer hint (`LaTeX math supported with $...$` vs `Plain academic English`), and `Live Response & Formula Preview` (`<ExamMathText />`) from the **current question's** resolved domain (and `!isWritingEssayTask`).
   - **Multi-part sub-question boxes:** Resolve domain per `(currentQuestion, sub)` so a Math sub-part shows the Math helper bar + live preview, while an English sub-part stays clean.
   - **Manual fallback toggle:** Add a subtle compact toggle button (e.g., `Σ Math Symbols`) on structured textboxes when the helper bar is hidden (for `'language'` / `'general'` questions), allowing a student to reveal or hide the Math toolbar on any mixed/ambiguous prompt without cluttering pure English tasks by default.

---

### Step 4: Verification
1. Add unit tests (`scripts/test-question-domain-detector.mjs`) covering:
   - Mixed Admission Test question array (English Reading + English Writing + Algebra + Geometry + Chemistry + multi-part sub-questions + generic `"Admission Test"` title).
   - Cursor-aware text/template insertion & selection wrapping helper.
   - Render check confirming `ExamMathText` renders inserted subscript (`x_{2}`), exponent (`x^{2}`), fraction (`\frac{3}{4}`), and root (`\sqrt{x}`).
2. Run `npm.cmd run test:inline-gaps`, the new test script, and `npm.cmd run build` (`tsc -b && vite build`).
