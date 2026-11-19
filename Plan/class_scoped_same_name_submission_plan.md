# Plan: Class-Scoped Duplicate Attempt & Draft Lock Identity (Same Name in Different Classes)

## Problem Summary
Currently, when `limitOneAttempt = TRUE` and students take an exam without distinct `candidate_number` values (or without personal 4-digit PINs), two students who share the same `student_name` in **different classes** (e.g., `Ahmad` in `X IPA 1` vs. `Ahmad` in `X IPA 2`) collide in three places:

1. **Final Submission RPC (`submit_student_exam_attempt`)** — `supabase/migrations/025_personal_exam_pin_hardening.sql:313-328`
   - Checks only `(quiz_code, student_name, candidate_number)` and **ignores `student_class`**.
   - As a result, Student 2 (`X IPA 2`) passes the lobby check (because `check_student_attempt_submitted` *does* inspect `student_class`), finishes the entire exam, and then gets silently rejected (`RETURN FALSE`) at submit time → stuck on **`Responses Stored Locally — Pending Cloud Upload ⚠️`**.
2. **Draft Key & Device Lock (`buildStudentDraftIdentifier` & `exam_draft_locks`)** — `src/services/examDraftService.ts:37-105`, `025:272-310`
   - When `studentPin` is empty, both `Ahmad`s map to the exact same `draftKey` (`draft_<CODE>_ahmad`).
   - Whichever student saves a draft first locks `exam_draft_locks` to their browser's `dev:<uuid>` token, causing the other student on a different device/browser to receive **`42501: Active exam session belongs to another device`** when submitting.
3. **Shared-Device Session & Offline Receipt Checks** — `src/lib/examSubmissionGuards.ts:70-107`, `src/services/examDraftService.ts:448-468`, `src/services/quizSubmissionService.ts:2233`
   - `isSameCandidateSession()` and `saveDeviceReceipt()` / `fluffykitten_device_exam_receipts` do not compare `candidateClass`, so homonyms across different classes on a shared school PC can inherit the previous student's session or trigger a false single-attempt block offline.
4. **Hidden Rejection Diagnostics** — `src/services/quizSubmissionService.ts:1535-1600`
   - `saveQuizSubmissionWithVerification()` discards `writeError.message` from `saveQuizSubmissionCloud()` and reports generic `'Cloud database returned non-success response'`.

### Desired Rule
- **Same name + Same class** (when `candidate_number` is blank or matches) → treated as the **same candidate** (existing draft/session resumes; duplicate submission rejected under `limitOneAttempt = TRUE`).
- **Same name + Different classes** (e.g. `X IPA 1` vs `X IPA 2`) → treated as **distinct candidates** across lobby check, draft autosave, `exam_draft_locks`, submission RPC, and shared-device receipts.
- **Class label normalization equivalence:** Variations like `"X IPA3"` vs `"X IPA 3"` normalize to the same canonical class (`'x ipa 3'`), matching existing `normalize_roster_class_label()` in Migration `025`.

---

## Implementation Steps

### Step 1: New Database Migration (`supabase/migrations/027_class_scoped_attempt_identity.sql`)
1. **Update `public.submit_student_exam_attempt(p_row JSONB)`:**
   - Normalize `v_norm_class := public.normalize_roster_class_label(v_student_class)`.
   - Compute `v_slug_class` cleanly (`REGEXP_REPLACE(REGEXP_REPLACE(v_norm_class, '[^a-z0-9]+', '_', 'g'), '^_+|_+$', '', 'g')`).
   - Update fallback `v_draft_key` derivation when `p_row->>'draft_key'` is omitted:
     - When `v_student_pin <> ''` and `v_slug_name <> ''` → `'draft_' || v_quiz_code || '_' || v_slug_name || '__' || clean_pin` (existing Migration `025` format).
     - Else when `v_slug_name <> ''` and `v_slug_class <> ''` → `'draft_' || v_quiz_code || '_' || v_slug_name || '__cls_' || v_slug_class`.
     - Else → legacy `'draft_' || v_quiz_code || '_' || v_slug_name`.
   - Update single-attempt duplicate check (`IF v_limit_one_attempt AND v_norm_name <> ''`):
     - Require normalized class match when both rows specify a class:
       ```sql
       AND (
           v_norm_class = ''
           OR COALESCE(TRIM(s.student_class), '') = ''
           OR public.normalize_roster_class_label(s.student_class) = v_norm_class
       )
       ```
     - Preserves `RETURNS BOOLEAN` and `42501` exception semantics so existing security tests remain 100% compatible.
2. **Update `public.check_student_attempt_submitted(p_quiz_code, p_student_name, p_student_class, p_student_number)`:**
   - Upgrade class comparison from plain whitespace collapse to `public.normalize_roster_class_label(s.student_class) = public.normalize_roster_class_label(p_student_class)` so lobby pre-checks match submit-time checks identically (`"X IPA3"` = `"X IPA 3"`, `"X IPA 1"` ≠ `"X IPA 2"`).
   - Add functional index `idx_quiz_submissions_attempt_class_lookup` on `(UPPER(TRIM(quiz_code)), LOWER(TRIM(student_name)), public.normalize_roster_class_label(student_class))`.

---

### Step 2: Class-Scoped Draft Keys & Locks (`src/services/examDraftService.ts`, `src/lib/examSubmissionGuards.ts`)
1. Add pure shared `normalizeClassIdentityPart(raw?: string | null): string` in `src/lib/examSubmissionGuards.ts` mirroring SQL `normalize_roster_class_label` (`x ipa 3`, `xi ips 2`, fallback trimmed/lowercase collapsed spaces).
2. Update `buildStudentDraftIdentifier(studentName?, studentPin?, studentClass?)` in `src/services/examDraftService.ts`:
   - Priority:
     1. If `cleanName && cleanPin` → `${cleanName}__${cleanPin}` (4-digit PINs are already globally unique per Migration `025`).
     2. Else if `cleanName && cleanClassSlug` → `${cleanName}__cls_${cleanClassSlug}`.
     3. Else fallback to `cleanPin || cleanName || String(studentName || '').trim()`.
3. Thread optional `studentClass` into:
   - `getDraftLockCredentials(quizCode, studentName, studentPin, studentClass)`
   - `getActiveStudentHeartbeatProof(quizCode, studentName, studentPin, studentClass)`
   - `saveExamDraft` (reads `draft.candidateClass`)
   - `fetchExamDraft` (validates `expectedStudentClass` cleanly if provided)
   - `clearExamDraft` (`studentClass` parameter)
4. Update `StudentQuizRunner.tsx` callers (`getActiveStudentHeartbeatProof`, `fetchExamDraft`, `clearExamDraft`, `saveExamDraft`, and `heartbeatProofRef` dependencies) and `quizSubmissionService.ts:1491` (`getDraftLockCredentials(..., studentPin, stampedSubmission.studentClass)`).

---

### Step 3: Shared-Device Session, Receipts & Server Error Visibility
1. **Shared-device reset (`src/lib/examSubmissionGuards.ts:70-107`, `StudentQuizRunner.tsx:3880`):**
   - Add optional `candidateClass?: string` to `SessionIdentityLike`.
   - In `isSameCandidateSession(saved, current)`: when both `saved.candidateClass` and `current.candidateClass` normalize to non-empty strings, require equality (`normalizeClassIdentityPart(saved.candidateClass) === normalizeClassIdentityPart(current.candidateClass)`).
2. **Offline device receipts (`src/services/quizSubmissionService.ts:2233`, `src/services/examDraftService.ts:448-468`, `StudentQuizRunner.tsx:2642, 3159`):**
   - Store optional `studentClass?: string` on `DeviceExamReceipt`.
   - Check normalized class match (when both present) in both table fallback (`examDraftService.ts:430`) and `localStorage` device-receipt fallback (`examDraftService.ts:452-461`).
3. **Preserve real cloud rejection errors (`src/services/quizSubmissionService.ts:1535-1600`):**
   - Track the real `writeError.message` from `saveQuizSubmissionCloud()` so `saveQuizSubmissionWithVerification()` returns the actual SQL/RPC rejection reason (e.g., `"Active exam session belongs to another device..."` or `"Submission blocked by duplicate attempt or validation check."`) instead of generic `'Cloud database returned non-success response'`.

---

### Step 4: Verification & Rollout
1. Add unit + SQL contract tests in `scripts/test-class-scoped-attempt-identity.mjs` covering:
   - Draft identifier & `draft_key` isolation for `Ahmad` in `X IPA 1` vs `X IPA 2` (with and without PIN, and spacing variants like `X IPA3` vs `X IPA 3`).
   - `isSameCandidateSession` resetting across different classes on shared devices while keeping same-class resumes intact.
   - `027_class_scoped_attempt_identity.sql` contract checks (`submit_student_exam_attempt` and `check_student_attempt_submitted` class normalization + `GRANT EXECUTE`).
2. Re-run `npm run test:student-pin`, `npm run test:phase2-security`, `npm run test:phase25-security`, `npm run test:phase3b-security`, and `npm run build`.
3. Note for deployment: apply [`supabase/migrations/027_class_scoped_attempt_identity.sql`](supabase/migrations/027_class_scoped_attempt_identity.sql) in the **Supabase SQL Editor** alongside deploying the frontend build.
