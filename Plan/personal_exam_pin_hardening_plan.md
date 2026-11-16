# Personal Exam PIN Review & Hardening Plan

## 1. Summary of Issues Found in Simulation
1. **Missing UI Toggle (`SIM 1`)**: `PublishedQuiz.requireStudentPin` exists in types and `StudentQuizRunner.tsx`, but `createDraftFromTest` leaves it `undefined` (`false`) and `QuizManagerPage.tsx` has no toggle in the *Security & Integrity* panel to enable it.
2. **Cross-Class 4-Digit PIN & Draft Key Collision (`SIM 2`)**: `assignMissingPins` and `regenerateAllPins` only enforce uniqueness per class (`${classKey}_${pin}`). Across 166 students, 85% (`17/20`) of simulated runs produced cross-class duplicate PINs. Because `getDraftLockCredentials` and `saveExamDraft` key drafts by `studentPin || studentName`, two students in different classes with the same PIN share `draft_<CODE>_<PIN>` and `ownerToken`, leaking drafts in the lobby and causing `42501` lock conflicts on submit.
3. **Class Spacing & Direct-RPC Submit Bypass (`SIM 3`)**:
   - `verify_student_pin` fails if a student's class has spacing differences (`"X IPA3"` vs `"X IPA 3"`).
   - `verify_roster_pin_if_enrolled` returns `TRUE` when `v_matched IS NULL`, allowing direct RPC calls to `submit_student_exam_attempt` with an unregistered student name to bypass `requireStudentPin = TRUE`.
   - `StudentQuizRunner.tsx` auto-fetches drafts as soon as 4 digits are typed, without verifying that the returned draft's `studentName` matches the lobby `candidateName`.
4. **Masked Input Mid-Cursor Edit (`SIM 4`)**: `applyMaskedPinInput` counts total `•` bullets (`keptBullets = 4`) before slicing to `maxLen = 4`, silently dropping any digit typed or replaced in the middle of an existing 4-digit PIN.

---

## 2. Small Executable Steps & Per-Step Verification

### Step 1: Add Educator UI Toggle & School Default for `requireStudentPin`
- **Files**:
  - [src/lib/settings.ts](file:///e:/VibeCoding/testmaker/src/lib/settings.ts)
  - [src/services/quizManagerService.ts](file:///e:/VibeCoding/testmaker/src/services/quizManagerService.ts)
  - [src/pages/QuizManagerPage.tsx](file:///e:/VibeCoding/testmaker/src/pages/QuizManagerPage.tsx)
  - [src/pages/AdvancedSettingsPage.tsx](file:///e:/VibeCoding/testmaker/src/pages/AdvancedSettingsPage.tsx)
- **Changes**:
  - Add `defaultRequireStudentPin?: boolean` (default `false`) to `AppSettings` in `settings.ts` and a school-wide default toggle card in `AdvancedSettingsPage.tsx` (*Exam Security & Feature Controls*).
  - In `createDraftFromTest` (`quizManagerService.ts`), initialize `requireStudentPin: existing?.requireStudentPin ?? (getSavedSettings().defaultRequireStudentPin ?? false)`.
  - In `QuizManagerPage.tsx`, add a **`Require Personal Candidate PIN (4-Digit)`** switch inside the *Security & Integrity* card (and preserve `requireStudentPin` in `handleOpenEditModal` and `handleSaveQuizConfig`), plus show a `🪪 Student PIN` badge on quiz cards when enabled.
- **Step 1 Test**:
  - Verify `createDraftFromTest` initializes `requireStudentPin` from school defaults and preserves explicit `true`/`false` overrides.
  - Verify `resolveStudentQuiz` returns `requireStudentPin: true` when enabled on a published quiz.
  - Run `npx oxlint` on the 4 modified files.

---

### Step 2: Enforce School-Wide Unique 4-Digit PIN Generation
- **File**: [src/services/studentRosterService.ts](file:///e:/VibeCoding/testmaker/src/services/studentRosterService.ts)
- **Changes**:
  - Update `assignMissingPins`, `regenerateAllPins`, `parseBulkRosterText`, `parseIcmMultiSheetWorkbook`, `parseExcelRosterWorkbook`, and `planRosterExcelImport` to track `usedPins` **globally across the entire school roster** (`usedPins.has(pin)`) rather than per class (`${classKey}_${pin}`).
  - In `planRosterExcelImport`, preserve existing 4-digit PINs when globally unique, and only re-roll if a duplicate PIN exists across classes.
- **Step 2 Test**:
  - Run 100 Monte Carlo trials of `assignMissingPins` and `regenerateAllPins` on the 166-student ICM roster and assert **0 cross-class duplicate PINs in all 100 runs** (`new Set(roster.map(s => s.pin)).size === 166`).
  - Verify `planRosterExcelImport` keeps unique existing PINs intact and resolves any pre-existing cross-class duplicate PIN.

---

### Step 3: Isolate Draft Keys by `(Candidate Name + PIN)` & Guard Lobby Draft Detection
- **Files**:
  - [src/services/examDraftService.ts](file:///e:/VibeCoding/testmaker/src/services/examDraftService.ts)
  - [src/pages/StudentQuizRunner.tsx](file:///e:/VibeCoding/testmaker/src/pages/StudentQuizRunner.tsx)
- **Changes**:
  - Add helper `buildStudentDraftIdentifier(studentName, studentPin)` in `examDraftService.ts`: when both `studentName` and `studentPin` are provided, combine normalized name + PIN (`${cleanName}__${cleanPin}`) so two different candidates can never share a `draftKey` or `ownerToken` even if given identical PINs manually.
  - Update `getDraftLockCredentials`, `saveExamDraft`, and `StudentQuizRunner.tsx` (`saveExamDraft`, `fetchExamDraft`, `clearExamDraft` calls) to use `buildStudentDraftIdentifier(candidateName, studentPinInput)` (with fallback lookup to legacy `studentPin || candidateName` only when `draft.studentName` matches `candidateName`).
  - In `StudentQuizRunner.tsx` (`useEffect` draft detector at line `3637`), verify `normalizeIdentityPart(draft.studentName) === normalizeIdentityPart(candidateName)` before setting `detectedDraft`.
- **Step 3 Test**:
  - Verify `getDraftLockCredentials('CHEM101', 'Student A', '6428')` and `getDraftLockCredentials('CHEM101', 'Student B', '6428')` produce distinct `draftKey` and `ownerToken` values.
  - Verify `fetchExamDraft` / lobby draft detection never leaks Student A's draft to Student B.
  - Run `npm run test:phase3b-security` and `npm run test:phase25-security` to confirm zero regressions on existing security contracts.

---

### Step 4: Normalize Class Matching, Tighten RPC Submit Guard & Fix Masked Input Mid-Edit
- **Files**:
  - [src/services/studentRosterService.ts](file:///e:/VibeCoding/testmaker/src/services/studentRosterService.ts)
  - [src/utils/examSecurityUtils.ts](file:///e:/VibeCoding/testmaker/src/utils/examSecurityUtils.ts)
  - [supabase/functions/verify-student-pin/index.ts](file:///e:/VibeCoding/testmaker/supabase/functions/verify-student-pin/index.ts)
  - `supabase/migrations/025_personal_exam_pin_hardening.sql`
- **Changes**:
  - In `verifyStudentPin` (`studentRosterService.ts`), normalize `studentClass` via `normalizeClassLabel` before calling the RPC/Edge function, and return a clear actionable error if the cloud RPC is unreachable and local storage has no cached roster.
  - Create migration `025_personal_exam_pin_hardening.sql`:
    - Normalize class spacing (`X IPA3` ↔ `X IPA 3`) inside `public.verify_student_pin` and `public.verify_roster_pin_if_enrolled`.
    - Update `public.verify_roster_pin_if_enrolled` (and `public.submit_student_exam_attempt`) so that when `v_require_student_pin = TRUE`, an unregistered candidate (`v_matched IS NULL`) or blank PIN is **rejected (`RETURN FALSE`)**.
  - Update `applyMaskedPinInput` (`examSecurityUtils.ts`) to inspect leading and trailing `•` bullets around newly typed characters so mid-string edits/replacements update the exact digit position instead of being sliced off.
- **Step 4 Test**:
  - Verify `verifyStudentPin` matches `"X IPA3"` against `"X IPA 3"`.
  - Verify `applyMaskedPinInput` handles sequential typing, full paste, backspace from end/middle, and mid-string digit replacement (`••9•` on `'4821'` → `'4891'`).
  - Verify migration `025` SQL syntax and `verify_roster_pin_if_enrolled` strict mode (`v_require_student_pin = TRUE` rejects unknown candidates).

---

### Step 5: End-to-End Regression Suite & Production Build
- **Files**:
  - `scripts/test-personal-exam-pin.mjs`
  - [package.json](file:///e:/VibeCoding/testmaker/package.json) (`"test:student-pin"`)
- **Verification**:
  - Run `npm run test:student-pin`, `npm run test:desk-cards`, `npm run test:phase3b-security`, `npm run test:phase25-security`, `npx oxlint`, and `npm run build`.
