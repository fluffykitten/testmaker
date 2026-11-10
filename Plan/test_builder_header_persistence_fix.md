# Architecture Plan: Permanent Lock for User-Customized Exam Header in Test Builder

## 1. Problem Diagnosis
In the **Test Builder Workspace** (`src/pages/TestBuilderPage.tsx`), teachers can customize the exam header configuration (`ExamHeaderConfig`):
1. **Subject** (e.g., `Chemistry`, `Geography`, `English`)
2. **Syllabus Code** (e.g., `0620 / 41`, `0460 / 12`)
3. **Candidate Instructions** (e.g., custom exam rules)
4. **Additional Materials** (e.g., `Periodic Table (enclosed)`, `Ruler, Calculator`)
5. **Total Marks** (dynamically computed as $\sum \text{marks}$)

### The Root Cause of Unexpected Overwrites:
In `src/pages/TestBuilderPage.tsx:334-362`, there is an automatic subject-inference hook:
```typescript
useEffect(() => {
  if (questions.length === 0) return;
  const detected = inferSubjectFromQuestions(questions, syllabuses);

  setHeaderConfig((prev) => {
    const prevSubject = (prev.subject || '').trim().toLowerCase();
    const detectedSubject = detected.subject.trim().toLowerCase();

    const isDefaultTitle =
      !prev.title ||
      (prev.title.startsWith('IGCSE ') && prev.title.endsWith('Practice Assessment'));

    const isSubjectMismatch =
      prevSubject !== detectedSubject &&
      (prevSubject === 'chemistry' || !prevSubject || isDefaultTitle);

    if (isSubjectMismatch) {
      return {
        ...prev,
        subject: detected.subject,
        subjectCode: detected.subjectCode,
        title: isDefaultTitle ? detected.defaultTitle : prev.title.replace(new RegExp(prev.subject || 'Chemistry', 'i'), detected.subject),
        additionalMaterials: detected.additionalMaterials,
        instructions: detected.instructions || prev.instructions,
      };
    }
    return prev;
  });
}, [questions, syllabuses]);
```

### Why It Resets:
1. When a user navigates from **Test Builder** to another tab (**Paper Upload** or **Question Bank**) and returns:
   - `<TestBuilderPage />` unmounts and remounts.
   - If the user had not changed the default generated title (or if the title matches `"IGCSE ... Practice Assessment"` or the subject was `"Chemistry"`):
     - `isSubjectMismatch` evaluates to `true`.
     - The hook triggers and **silently overwrites** the teacher's customized Subject, Syllabus Code, Candidate Instructions, and Additional Materials with whatever keyword pattern matched the questions (e.g. flipping to Physics, Biology, or Geography).
2. Furthermore, even if a user explicitly changes any of the fields (such as typing custom instructions or changing the syllabus code), there is no flag recording that the teacher has manually authored these settings.

---

## 2. Solution Architecture

We will implement an explicit, tamper-proof user customization lock in `ExamHeaderConfig`:

```typescript
export interface ExamHeaderConfig {
  title: string;
  schoolName: string;
  subject: string;
  subjectCode: string;
  durationMinutes: number;
  instructions: string;
  examDate?: string;
  additionalMaterials?: string;
  layoutTemplate?: 'cambridge' | 'standard';
  teacherPin?: string;
  teacherPinHash?: string;
  questionOverrides?: Record<string, Question>;
  /**
   * Tracks whether the teacher has manually edited any header field
   * (subject, code, instructions, materials, title, duration).
   * When true, automatic question-based subject inference is strictly disabled.
   */
  isUserCustomized?: boolean;
}
```

### Key Behaviors:

1. **Explicit Customization Tracking (`isUserCustomized`)**:
   - In `src/components/TestHeaderEditor.tsx`, whenever a teacher edits *any* field (`subject`, `subjectCode`, `instructions`, `additionalMaterials`, `title`, `durationMinutes`, `schoolName`):
     - `handleFieldChange` sets `isUserCustomized: true`.
2. **Auto-Inference Guard (`TestBuilderPage.tsx`)**:
   - The auto-detection `useEffect` will check:
     ```typescript
     if (prev.isUserCustomized) {
       return prev; // Never overwrite manually edited header settings!
     }
     ```
   - Only when `isUserCustomized` is `false` (e.g., initial creation when questions are first added from Question Bank without manual edits) will it provide helpful smart defaults.
3. **Reset to Smart Defaults Option**:
   - Inside `TestHeaderEditor.tsx`, provide an unobtrusive **"↺ Auto-Detect from Questions"** button that lets the teacher intentionally re-sync header defaults with the current question bank selection if they choose to.
4. **Persistence in `sessionStorage` and Database**:
   - The `isUserCustomized` flag will be preserved in `sessionStorage` (`testmaker_builder_header_config`) and saved in Supabase `custom_tests.header_config` so that reloads, navigation changes, and saved tests permanently retain user customizations.

---

## 3. Implementation Steps

1. **Step 1 — Update Types (`src/services/testBuilderService.ts`)**:
   - Add `isUserCustomized?: boolean;` to `ExamHeaderConfig`.

2. **Step 2 — Flag User Edits (`src/components/TestHeaderEditor.tsx`)**:
   - Update `handleFieldChange` to set `isUserCustomized: true`.
   - Add a subtle *"↺ Auto-Detect"* button in the editor header for when the teacher *wants* automatic detection.

3. **Step 3 — Guard Auto-Detection Effect (`src/pages/TestBuilderPage.tsx`)**:
   - Update `inferSubjectFromQuestions` hook to abort immediately if `prev.isUserCustomized === true`.
   - Update initialization logic to respect `isUserCustomized`.

4. **Step 4 — Automated Verification Suite (`scripts/test-test-builder-header-persistence.mjs`)**:
   - **Test 1**: Verify that custom `subject`, `subjectCode`, `instructions`, and `additionalMaterials` retain `isUserCustomized: true`.
   - **Test 2**: Verify that navigating away and simulating a remount with `sessionStorage` does not overwrite custom values even if questions match another subject (e.g. Physics questions with Geography header).
   - **Test 3**: Verify total marks dynamic calculation is preserved and unaffected by navigation.
   - **Test 4**: Verify that clicking "Auto-Detect" resets `isUserCustomized` and updates fields to the detected subject.

5. **Step 5 — Run Build & Regressions**:
   - Execute verification script.
   - Run existing regression suites.
   - Run `npm run build` (`tsc -b && vite build`).

