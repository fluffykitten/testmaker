# Implementation Plan: Disable Post-Submission Result PIN & Guide

**Date:** 2026-11-18  
**Goal:** Disable generating and displaying the post-submission Personal Access PIN (`resultPin`) ticket and `"write down or screenshot this ... PIN"` guide after a student submits an exam, while keeping portal result lookup and legacy PIN-protected submissions working cleanly.

---

## 1. Design Approach: Reversible Feature Flag (Default Off)

Because the requirement is to disable the post-submission Result PIN **"for now"** without breaking older submissions that already stored a `result_pin` in Supabase, the cleanest approach is to keep `resultPin` infrastructure intact behind a single switch (disabled by default) rather than deleting database columns or breaking legacy lookup RPCs.

- **Single source-of-truth flag (e.g. `ENABLE_POST_SUBMIT_RESULT_PIN = false` in `src/services/quizSubmissionService.ts` or an optional per-quiz config defaulting to `false`):**
  - When **`false` (new default):**
    - No `resultPin` is generated on exam submit or emergency Save & Exit.
    - No `resultPin` is written into `DeviceExamReceipt`.
    - The `"🔐 YOUR PERSONAL ACCESS PIN"` dark card and screenshot/copy guide do not render on the post-submit screen.
    - The Portal `"Check Exam Results"` lookup works **without** requiring the candidate to enter an Access PIN.
  - **Backward compatibility:**
    - If an older submission in Supabase still has a non-empty `result_pin`, `lookup_student_exam_result` still verifies it (`IF v_stored_pin IS NOT NULL AND v_stored_pin <> v_pin`), and if `pinMismatch` occurs, `StudentResultModal` / `PortalLandingPage` can handle it cleanly.
  - **Reversibility:** Re-enabling later is a single flag flip (and also gives us the opportunity to fix the existing 6-digit `generateResultPin()` vs. 3-digit `maxLength={3}` portal input mismatch if re-enabled).

---

## 2. File-by-File Changes

### Step 1 — Submission Creation & Receipt Screen (`src/pages/StudentQuizRunner.tsx`)

1. **Gate `generateResultPin()` on submission & emergency exit:**
   - **Normal Exam Mode submit (`L2700`, `L2710`):**
     - Only attach `resultPin: generateResultPin()` when `ENABLE_POST_SUBMIT_RESULT_PIN` is `true` (otherwise omit / set `undefined`).
     - Omit `resultPin` from `saveDeviceReceipt({ ... })` when disabled.
   - **Emergency Save & Exit (`L3208`, `L3227`):**
     - Same conditional assignment on `emergencySubmission.resultPin` and `saveDeviceReceipt(...)`.
2. **Receipt screen card (`L5714-5792`):**
   - Already guarded by `{completedSubmission.resultPin && (...)}`, and additionally guard with `ENABLE_POST_SUBMIT_RESULT_PIN && completedSubmission.resultPin` so neither the PIN ticket nor the `"Please write down or screenshot this 3-digit PIN..."` guide appears.
   - Keep the `"Examiner Delivery Verified"` card (`L5909-5950`), which only instructs students to use the **Exam Code** when results are published (no PIN text).
3. **Note on Invigilator Overrides card (`L5953-6042`):**
   - Leave the Teacher `"Invigilator & Examiner Options"` (`Force Re-Submit` / `Unlock Exam`) card intact — that uses the **Teacher Unlock PIN**, not the student Result Access PIN.

---

### Step 2 — Portal "Check Exam Results" Form (`src/pages/PortalLandingPage.tsx`)

If new submissions no longer issue a `resultPin`, the landing page lookup form must not demand one:

1. **Remove mandatory Access PIN validation (`L515-518`):**
   - Remove the early return blocking submission when `!resultPinInput.trim()`, so `handleLookupResults` submits `{ quizCode: cleanCode, candidateId: cleanId, pin: resultPinInput.trim() }` even when `pin` is `''`.
2. **Hide or make optional the Access PIN field (`L753-771`):**
   - **Recommended when `ENABLE_POST_SUBMIT_RESULT_PIN === false`:** Hide the `Access PIN (3-digit)` input field and its `"Found on your examination submission receipt."` hint on the default form, so students simply enter **Exam Code** + **Candidate Name or Seat #** and click **Retrieve Marked Paper →**.
   - Avoid pre-populating stale `resultPinInput` when disabled (`L413`), and clean `L761`/`L765` (`maxLength` / `"3-digit"` copy) so if the field is shown for legacy exams or re-enabled later, it accepts up to 6 digits (`slice(0, 6)`, `maxLength={6}`).

---

### Step 3 — Result Retrieval Modal (`src/components/StudentResultModal.tsx`)

1. **Legacy PIN-protected attempt fallback (`L167-184`):**
   - For all new submissions (`result_pin = ''`), `lookup_student_exam_result` returns `status: 'ok'` with `pinMismatch = false` (`024_phase3_deep_rls_ratelimit_and_game_security.sql`, `L675`).
   - If a student looks up an **older** exam that does have a `result_pin` while the PIN field was hidden/blank (`pinMismatch === true`):
     - Update the `pinMismatch` state inside `StudentResultModal` to render a clean inline PIN prompt (`maxLength={6}`, numeric input + `"Verify PIN"` button) instead of a dead-end `"3-digit PIN"` error message (`L179`), re-calling `fetchStudentResultsCloud(quizCode, candidateIdentifier, enteredPin)` on submit.

---

### Step 4 — Teacher View & Service Cleanup (`src/components/QuizResultsModal.tsx` & `src/services/quizSubmissionService.ts`)

1. **`QuizResultsModal.tsx` (`L2067-2083`):**
   - Already checks `{selectedSubmission.resultPin && (...)}`, so new submissions won't render a PIN badge. Update the tooltip copy `"Candidate 3-digit Personal Access PIN"` to `"Candidate Personal Access PIN"` for accuracy on legacy rows.
2. **`quizSubmissionService.ts` (`L1004`, `L1484`, `L1666`, `L2080-2194`):**
   - Export `ENABLE_POST_SUBMIT_RESULT_PIN = false`.
   - Fix stale comment `"3-digit personal PIN"` (`L1004`) since `generateResultPin()` generates 6-digit PINs.
   - Verify `fetchStudentResultsCloud` (`L2080-2194`): already handles `storedPin === ''` cleanly in both RPC (`L2096`) and fallback paths (`L2151`, `L2182`).

---

### Step 5 — Database Retry / Force Re-Submit Safety Check (`supabase/migrations/030_optional_result_pin.sql`)

**Why this matters:**  
In `025_personal_exam_pin_hardening.sql` (`L402-426`), `submit_student_exam_attempt` handles `ON CONFLICT (id) DO UPDATE` with:

```sql
WHERE public.quiz_submissions.status = 'submitted'
  AND NULLIF(TRIM(public.quiz_submissions.result_pin), '') IS NOT NULL
  AND TRIM(public.quiz_submissions.result_pin) = v_result_pin;
```

- **Fresh first-time submission:** `INSERT` works cleanly with `result_pin = ''`.
- **Edge case (duplicate retry or student-device Force Re-Submit):** If an anonymous retry or Force Re-Submit sends the same submission `id` after row #1 was already inserted with `result_pin = ''`, `ON CONFLICT DO UPDATE` matches 0 rows and returns `FALSE`, causing `quizSubmissionService.ts` (`L1523`) to flag `'Submission RPC rejected row payload.'` and keep the submission marked failed in the local outbox.
- **Migration fix (`030_optional_result_pin.sql`):**
  Update `submit_student_exam_attempt` so when a row with the same `id` already exists with `status = 'submitted'` and blank `result_pin` (`NULLIF(TRIM(result_pin), '') IS NULL`):
  - If the caller proved active draft lock ownership (`v_lock_hash IS NOT NULL` matched earlier in the RPC) **or** it is an identical `(id, quiz_code, v_norm_name)` retry on a `'submitted'` row, either allow the update (when locked/same candidate) or return `TRUE` idempotently so retries and Force Re-Submit don't fail silently. *(Keep the strict `result_pin` check whenever `NULLIF(TRIM(result_pin), '') IS NOT NULL` on legacy rows.)*

---

## 3. Verification Plan (When Implementing)

1. **Exam Mode Submit Test:**
   - Start and submit a Formal Exam Mode attempt.
   - Verify the post-submit screen shows the submission confirmation, **Examiner Delivery Verified** card, and **Invigilator & Examiner Options**, with **zero** `YOUR PERSONAL ACCESS PIN` box and **zero** `"write down or screenshot this ... PIN"` copy.
   - Verify `DeviceExamReceipt` in `localStorage` and the `quiz_submissions` row have no `resultPin` / `''`.
2. **Emergency Save & Exit Test:**
   - Trigger Emergency Save & Exit and verify `resultPin` is omitted from both the UI and `DeviceExamReceipt`.
3. **Portal Result Lookup Test (New & Legacy):**
   - Publish results for the PIN-less submission, open **Check Exam Results** on `PortalLandingPage`, enter only **Exam Code** + **Candidate Name/Seat #**, and verify the marked script opens in `StudentResultModal`.
   - Test an older submission with a stored `result_pin` and verify `StudentResultModal` prompts for the legacy PIN (supporting up to 6 digits) and unlocks when entered.
4. **Retry / Force Re-Submit Test:**
   - Re-trigger `saveQuizSubmissionWithVerification` for the same submission `id` and verify `submit_student_exam_attempt` returns `true` rather than failing the outbox.
5. **Build & Typecheck:**
   - Run `npm run build` and relevant security/submission checks with zero errors.
