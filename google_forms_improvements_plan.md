# Google Forms Export Improvements: Layout, Chemical Symbols & Teacher Experience Plan

## Executive Summary
This plan outlines a complete set of enhancements for the **Google Forms Export Subsystem** (`src/services/googleForms/`, `src/components/GoogleFormsExportModal.tsx`, and `src/lib/tableImageRenderer.ts`). 

Based on analysis of Cambridge IGCSE / O-Level / A-Level Chemistry exams and current export outputs, this upgrade resolves 4 core pain points:
1. **Chemical & Math Symbol Fidelity**: Converts chemistry state symbols (`(aq)`, `(s)`, `(l)`, `(g)`), ionic charges, reaction arrows, equilibrium symbols, and formulas (`\ce{...}` and plain text) into clean, standard Unicode without broken subscript artifacts like `_((aq))`.
2. **Layout & Stem De-duplication**: Prevents multi-line prompts and experimental procedures from flattening into run-on walls of text, and eliminates repeating 20-line parent contexts across every sub-question by introducing shared parent context headers.
3. **Assessment Integrity & Mark Scheme Repair**: Fixes the `[object Object]` mark scheme bug, stops Apps Script from leaking mark schemes to students in question help text, and cleanly strips hardcoded `A.`, `B.`, `C.`, `D.` prefixes when option shuffling is enabled.
4. **Classroom Readiness**: Adds an optional "Student Identification" section (Name, Class, Candidate Number) and specialized "By Parent Question" section breaks for Cambridge structured papers.

---

## 1. Current State vs. Target State

| Feature / Issue | Current Behavior | Target Behavior |
| :--- | :--- | :--- |
| **State Symbols** | `_{(aq)}` converts to `_((aq))` because `q` has no Unicode subscript character. | Normalized directly to standard text: `(aq)`, `(s)`, `(l)`, `(g)`. |
| **Chemical Formulas** | `\ce{CaCO3}` strips wrapper leaving `CaCO3`; numbers are not subscripted. | Converted cleanly to `CaCO₃`, `H₂SO₄`, `Fe₂(SO₄)₃`. |
| **Reaction Arrows** | Basic arrows handled; equilibrium `\rightleftharpoons`, `\leftrightharpoons`, and `-->` can leave raw LaTeX. | All arrows normalized: `→`, `⇌`, `↔`, `⇒`. |
| **Thermodynamic Symbols** | `\Delta H^\ominus` or `\Delta H^\circ` can output raw `\ominus` or `\circ`. | Clean Unicode: `ΔH⦵` or `ΔH°`. |
| **Parent Stem Duplication** | Repeating `Context: <20 lines of parent text>` in every single sub-question (a, b, c, d, e, f). | Single shared **Parent Context Item**; sub-questions only contain their local prompt. |
| **Multi-line Prompts** | `splitQuestionPromptAndDetails` collapses newlines in titles, creating unreadable run-ons. | Multi-line lists, observation cues, and steps are cleanly structured in the item description. |
| **Shuffled Choices** | Enabling `shuffleOptions` keeps hardcoded `A.`, `B.`, `C.` prefixes, causing randomized order: `C. ...`, `A. ...`. | Automatically strips `A.`, `B.`, `C.`, `D.` prefixes when shuffled, preserving clean option text. |
| **Mark Scheme in Sub-questions** | `typeof sq.mark_scheme === 'string' ? sq.mark_scheme : String(sq.mark_scheme)` outputs `"[object Object]"`. | Robust object unwrapping: formats `marking_points` and `acceptable_answers` as clean bullet points. |
| **Apps Script Answer Leak** | In `googleAppsScriptService.ts`, text items put mark schemes in `setHelpText()`, visible to students during the quiz! | Mark scheme is placed in teacher script comments or gated by a teacher-only toggle. |
| **Student Identification** | Quizzes export with questions immediately, requiring teachers to manually add Name/Class in Google Forms. | One-click toggle in export modal prepends required 0-point Name & Class fields. |

---

## 2. Architecture & Data Flow

```mermaid
flowchart TD
    A[Question Bank / Exam Header] --> B[GoogleFormsExportModal]
    B -->|Export Options: Student Info, Shuffle, Breaks| C[flattenQuestionsForForms]
    
    subgraph Sanitization Engine ["Text & Chemistry Sanitizer"]
        C --> D[cleanTextForGoogleForms]
        D --> D1[1. Repair Corrupted Escapes]
        D1 --> D2[2. State Symbols: _(aq) -> (aq)]
        D2 --> D3[3. ce Formula Parser: H2O -> H₂O]
        D3 --> D4[4. Reaction & Equilibrium Arrows]
        D4 --> D5[5. Math, Greek & Thermodynamic: ΔH⦵]
        D5 --> D6[6. Subscripts & Superscripts]
    end

    subgraph Hierarchy & Layout ["Hierarchy & Layout Restructuring"]
        C --> E{Has Sub-Questions?}
        E -->|Yes| F[Create Parent Context Item]
        E -->|Yes| G[Format Sub-Parts Q1a, Q1b without repetitive stem]
        E -->|No| H[Format Standalone Question]
        F & G & H --> I[splitQuestionPromptAndDetails: Preserves Lists in Description]
        I --> J[Option Prefix Cleaner: Remove A., B. on shuffle]
    end

    subgraph Output Generation ["API & Script Generators"]
        J --> K[googleFormsApiService: REST API v1]
        J --> L[googleAppsScriptService: .gs Script]
        K --> M[(Google Forms in Google Drive)]
        L --> N[(Clipboard Apps Script)]
    end
```

---

## 3. Detailed Implementation Plan by Phase

### Phase 1: Chemical & Math Symbol Sanitization Engine
**Primary File**: `src/services/googleForms/googleFormsTextSanitizer.ts`  
**Secondary File**: `src/lib/tableImageRenderer.ts`

#### 1.1 State Symbol Normalization
Convert LaTeX chemical state subscripts into regular parentheses with standard letter cases before general subscript processing:
```typescript
// Chemical state symbols: normalize _{ (aq) }, _{(s)}, etc. to regular text
.replace(/_\{?\s*\(\s*(aq|s|l|g)\s*\)\s*\}?/gi, ' ($1)')
.replace(/_\{?\s*(aq|s|l|g)\s*\}?/gi, ' ($1)')
```

#### 1.2 `\ce{...}` and Chemical Formula Subscripting
Implement a dedicated chemical formula transformer:
- Inside `\ce{...}`:
  - Numbers following element symbols (e.g. `H2`, `O4`, `(SO4)3`) become Unicode subscripts: `₂`, `₄`, `₃`.
  - Charges (e.g. `^2+`, `^{2+}`, `^+`, `^-`) become Unicode superscripts: `²⁺`, `⁺`, `⁻`.
  - Reaction arrows `->`, `<=>`, `<->`, `v`, `^` become `→`, `⇌`, `↓`, `↑`.
- In general text:
  - Add safe heuristic regex for common chemical formulas: `/(?<=[A-Z][a-z]?)\d+(?=[A-Z\s;,.)\]\+\-]|$)/g` to turn `CaCO3` $\to$ `CaCO₃`, `H2O` $\to$ `H₂O`, `CO2` $\to$ `CO₂`.
  - Handle crystal hydrate dot notation: `CuSO4 \cdot 5H2O` or `CuSO4.5H2O` $\to$ `CuSO₄·5H₂O`.

#### 1.3 Reaction Arrows & Thermodynamic Symbols
Expand arrow and thermodynamic symbol coverage:
```typescript
.replace(/\\(rightleftharpoons|leftrightharpoons)/g, ' ⇌ ')
.replace(/\\longrightarrow/g, ' → ')
.replace(/-->|->/g, ' → ')
.replace(/<=>|<-->/g, ' ⇌ ')
.replace(/\\(ominus|circ)\b/g, '⦵') // e.g. \Delta H^\ominus -> ΔH⦵
```

#### 1.4 Corrupted Escape Sequences
Fix common JSON serialization artifacts:
- `\t`ext $\to$ `\text`
- `\t`imes $\to$ `\times`
- `\t`o $\to$ `\to`

---

### Phase 2: Question Layout & Stem Restructuring
**Primary File**: `src/services/googleForms/googleFormsFlattenService.ts`  
**Secondary Files**: `src/services/googleForms/googleFormsApiService.ts`, `src/services/googleForms/googleAppsScriptService.ts`

#### 2.1 Deduplicate Cambridge Parent Question Context
- For questions with `sub_questions`:
  - If the parent stem has significant context (e.g. $>40$ characters, procedure instructions, or stimulus table/diagram), emit a single **Parent Context Header Item** (type: `textItem` in Google Forms API or section header in Apps Script) at the start of Question $N$:
    - Title: `Question N: Context & Scenario` (or `Question N`)
    - Description: The complete experimental procedure, instructions, and apparatus notes.
    - Image: Parent diagram or stimulus table (attached once!).
  - In sub-questions $N(a), N(b), N(c)$:
    - Remove the repetitive `Context: ${stemContext}` prefix.
    - Set the item title to `Q1(a) ...` and only include sub-question-specific notes in the description.
  - *Result*: Instead of reading the same 20 lines 6 times, students see the scenario once at the top of the question group, followed by compact sub-parts.

#### 2.2 Multi-line Prompt Preservation in `splitQuestionPromptAndDetails`
- Update `splitQuestionPromptAndDetails`:
  - If the prompt contains numbered steps (`1. ...\n2. ...`), bullet points, observation tables, or dual instructions (`State: ...\nExplain: ...`):
    - First line/sentence becomes the clear item title: `Q1(a) Complete the table of results.`
    - Subsequent structured lines/steps are placed in `description` with `preserveNewlines: true`, rendering with full line breaks in Google Forms.

#### 2.3 Option Prefix Cleaner on Shuffle
- In `flattenQuestionsForForms`:
  - When `shuffleOptions` is enabled (or option text starts with standard letter labels `^[A-Ea-e][.:\)]\s*`):
    - Strip the static prefix: `"A. Hydrochloric acid"` $\to$ `"Hydrochloric acid"`.
    - This prevents scrambled quizzes from displaying options out of alphabetical sequence (e.g., `C. ...`, `A. ...`, `D. ...`).

#### 2.4 Multiple Choice Grid Diagram Deduplication
- In `googleFormsApiService.ts`:
  - Avoid creating a separate image item with duplicate title `"Diagram for Q1(a)"` when the grid item itself already has the title and can hold or be immediately preceded by the diagram cleanly.

---

### Phase 3: Grading & Mark Scheme Feedback Repair
**Primary Files**: `src/services/googleForms/googleFormsFlattenService.ts`, `src/services/googleForms/googleAppsScriptService.ts`

#### 3.1 Object Mark Scheme Serialization
- Create a dedicated helper `extractMarkSchemeText(markScheme: any): string`:
  - If string: return cleaned string.
  - If object:
    - If `marking_points` array: join with `• ` bullet points or `; `.
    - If `acceptable_answers` array: join as acceptable answers.
    - If `guidance` / `steps`: format concisely.
  - Completely eliminates `[object Object]` in both parent questions and sub-questions.

#### 3.2 Google Apps Script Help Text Leak Protection
- In `googleAppsScriptService.ts`:
  - For `SHORT_ANSWER` and `PARAGRAPH` items:
    - **Issue**: Google Apps Script's `setHelpText()` is displayed to students while taking the test. Putting `Mark Scheme: ...` there leaks the answers!
    - **Solution**: Do not put the mark scheme in `setHelpText()`. Instead, put the mark scheme in the generated Apps Script code comments (`// Mark Scheme: ...`) so teachers have it in their Apps Script project without exposing it on the student exam form.

#### 3.3 Enhanced Short-Answer Auto-Grading
- Automatically extract numbers, units, and chemical formulas from `mark_scheme.acceptable_answers` or `marking_points` for 1-mark calculation and identification questions, registering them in `questionItem.question.grading.correctAnswers`.

---

### Phase 4: Student Identification & Section Break Modes
**Primary File**: `src/components/GoogleFormsExportModal.tsx`  
**Secondary File**: `src/services/googleForms/googleFormsTypes.ts`

#### 4.1 Student Identification Fields
- Add a new option in `GoogleFormsExportOptions`: `includeStudentInfo?: boolean` (default: `true`).
- In `GoogleFormsExportModal.tsx`:
  - Add a checkbox toggle:  
    `[x] Include Student Identification (Full Name, Class, Candidate Number)`
  - When enabled:
    - Automatically prepends 3 standard 0-point, required `SHORT_ANSWER` items at index 0 of the quiz:
      1. **Full Name** (Required, Short Answer, 0 marks)
      2. **Class / Section** (Required, Short Answer, 0 marks)
      3. **Candidate Number / Student ID** (Optional/Required, Short Answer, 0 marks)
    - If section breaks are used, places these in "Section 1: Student Information", with the questions starting in "Section 2: Examination Questions".

#### 4.2 Cambridge Section Break Mode: "By Parent Question"
- Add `'by_parent_question'` to `SectionBreakMode`:
  - When selected, creates a new Google Forms Section for each parent question:
    - Section 1: Question 1 (e.g. Investigation of rate of reaction - 12 marks)
    - Section 2: Question 2 (e.g. Qualitative analysis - 10 marks)
    - Section 3: Question 3 (e.g. Planning investigation - 6 marks)
  - Matches authentic Cambridge paper layout where each question is an independent section.

---

## 4. Before & After Showcase

````carousel
```text
BEFORE (Current Export):
--------------------------------------------------
Title: Q1(a) A student investigates the reaction...
Description: Context: A student investigates the reaction between dilute hydrochloric acid and calcium carbonate. Apparatus was set up as shown in the diagram. 25 cm3 of acid was added.
The temperature was recorded at 1 minute intervals.
1. Measure acid 2. Add carbonate 3. Record temp.
Options:
  C. 35 cm³
  A. 15 cm³
  D. 45 cm³
  B. 25 cm³
Mark Scheme: [object Object]
Chemicals: CuSO4_((aq)) + 2NaOH_((aq)) -> Cu(OH)2_((s)) + Na2SO4_((aq))
```
<!-- slide -->
```text
AFTER (Improved Export):
--------------------------------------------------
[Context Item]
Title: Question 1: Reaction Rate Investigation
Description:
A student investigates the reaction between dilute hydrochloric acid and calcium carbonate.
Apparatus was set up as shown in the diagram. 25 cm³ of acid was added.

[Sub-Question Item]
Title: Q1(a) Which volume of acid was used?
Description:
1. Measure acid using a measuring cylinder.
2. Add carbonate into the conical flask.
3. Record temperature every 60 s.
Options (Shuffled cleanly without out-of-order prefixes):
  15 cm³
  25 cm³
  35 cm³
  45 cm³
Chemicals: CuSO₄ (aq) + 2NaOH (aq) → Cu(OH)₂ (s) + Na₂SO₄ (aq)
Mark Scheme: • Blue precipitate forms; • Insoluble in excess sodium hydroxide
```
````

---

## 5. File Change Matrix

| File Path | Changes | Risk Level |
| :--- | :--- | :--- |
| `src/services/googleForms/googleFormsTextSanitizer.ts` | Add state symbol rules, `\ce{...}` formula parser, arrows, thermodynamic symbols, escape repairs. | Low |
| `src/services/googleForms/googleFormsFlattenService.ts` | Add parent context header logic, improve prompt splitting, fix object mark scheme extraction, strip option prefixes on shuffle. | Medium |
| `src/services/googleForms/googleFormsApiService.ts` | Support parent context `textItem`, student info fields, clean grid diagram positioning. | Low |
| `src/services/googleForms/googleAppsScriptService.ts` | Prevent mark scheme leak in `setHelpText()`, support student info fields, clean option shuffling. | Low |
| `src/services/googleForms/googleFormsTypes.ts` | Add `includeStudentInfo?: boolean` and `'by_parent_question'` section break mode. | Low |
| `src/components/GoogleFormsExportModal.tsx` | Add Student Info checkbox, add "By Parent Question" section mode in dropdown. | Low |
| `src/components/GoogleFormsPreviewDrawer.tsx` | Update preview rendering to show parent context headers and student identification preview. | Low |

---

## 6. Verification & Testing Strategy

1. **Unit / String Sanitizer Testing**:
   - Verify `cleanTextForGoogleForms` on sample inputs:
     - `\ce{CuSO4(aq) + 2NaOH(aq) -> Cu(OH)2(s) + Na2SO4(aq)}` $\to$ `CuSO₄ (aq) + 2NaOH (aq) → Cu(OH)₂ (s) + Na₂SO₄ (aq)`
     - `_{(aq)}`, `_{(s)}`, `_{(g)}`, `_{(l)}` $\to$ `(aq)`, `(s)`, `(g)`, `(l)`
     - `\Delta H^\ominus = -393.5\text{ kJ/mol}` $\to$ `ΔH⦵ = -393.5 kJ/mol`
     - `25^\circ C` $\to$ `25°C`
2. **Context Deduplication Verification**:
   - Test structured multi-part question with 5 sub-parts:
     - Confirm parent scenario is placed once in header context.
     - Confirm Q1(a)–Q1(e) only contain sub-question prompts.
3. **Shuffle Verification**:
   - Confirm options with `A. 10`, `B. 20`, `C. 30` strip prefixes so students see clean choices when shuffled.
4. **Mark Scheme Object Check**:
   - Confirm questions with complex mark scheme objects do not produce `[object Object]`.
5. **TypeScript Compilation & Build**:
   - Run `npm run build` (`tsc -b && vite build`) to confirm 0 compilation or lint errors.

---

## 7. Execution Status (2026-11-05)

| Phase | Delivered | Evidence |
| :--- | :--- | :--- |
| 1. Chemistry sanitizer | state symbols (incl. nested `_{3(s)}`), `\ce{...}` parser, arrows/equilibrium, `⦵`, hydrate dots, plain-formula subscripts, `cm3 → cm³`, corrupted-escape repair | `npm run test:gforms` — 12/12 |
| 2. Layout & stems | shared `CONTEXT` item per Cambridge parent question (scenario + figure once), no `Context:` repetition in sub-parts, structured multi-line prompts preserved in descriptions, option-prefix stripping on shuffle, grid figure no longer duplicates the item title | Phase 2-4 harness |
| 3. Mark scheme | `extractMarkSchemeText()` (bullets + `Accept:` + guidance) kills `[object Object]`; Apps Script no longer writes mark schemes into `setHelpText()` (text, grid **and** paragraph items) — they are emitted as `// Mark Scheme:` comments instead | harness asserts no help-text leak |
| 4. Student info & sections | `includeStudentInfo` toggle + `by_parent_question` section mode in the export modal; 3 required 0-point fields; own "Student Information" section; preview shows context and student blocks | tsc + build green |

**Deliberately not implemented**

- **3.3 Enhanced short-answer auto-grading** from `marking_points`: deriving gradeable answers from prose marking points risks marking correct work wrong (e.g. "M1 blue precipitate" is not an answer string). Existing `acceptable_answers` wiring is kept; this needs a per-question review UI before it is safe.
- **Full CSS polish** for the new preview badges — they reuse existing pill classes, so no new styles were needed.

**Known limitation:** the Apps Script path can only carry the scenario/additional text via `addSectionHeaderItem().setHelpText()`, which is student-visible by design (it is context, not answers).

