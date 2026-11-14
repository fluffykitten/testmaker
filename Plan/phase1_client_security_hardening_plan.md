# Phase 1 Plan: Client, PIN, Export & Attachment Hardening

> **Parent Plan:** [`Plan/exam_paper_download_security_plan.md`](file:///e:/VibeCoding/testmaker/Plan/exam_paper_download_security_plan.md)  
> **Scope:** Phase 1 Quick Wins (zero breaking workflow changes for teachers; closes client-side PIN leaks, idle question-bank prefetches, student cache leaks, post-exam script exports, print-to-PDF bypasses, and native PDF viewer downloads).  
> **Status:** Draft for Review

---

## Goals of Phase 1
1. Ensure a student visiting the Portal or opening an exam link **never downloads** the Question Bank or Teacher Access PIN silently in the background.
2. Eliminate the **offline fail-open bypass** and client-side PIN exposure in `PinGate`.
3. Prevent students from pulling saved `published_quizzes` / `source_pdf_url` / `teacherPin` out of `localStorage` or the sanitized quiz payload.
4. Block **`📄 Full Script PDF`** downloads, full question-stem review (unless explicitly enabled by the teacher), and **`Ctrl+P` / Print-to-PDF** on student runner and result screens.
5. Remove Chrome's native PDF toolbar (**Download** / **Print**) from `ExamAttachmentModal`.

> **Important Note on Scope:** Phase 1 hardens the browser/UI surface and removes trivial leaks. Because Supabase RLS is still open until **Phase 2**, a technically advanced student manually crafting raw REST requests with the public `anon` key would still require Phase 2 (Auth + RLS + RPCs) and Phase 3 (private R2 signed URLs) to close completely. Phase 1 immediately stops all casual/DevTools/UI-based paper downloads and lays clean groundwork for Phase 2.

---

## Step 1.1 — Stop Portal Pre-Warm, PIN Prefetch & Student Cache Leaks

### Target Files
- [`src/App.tsx`](file:///e:/VibeCoding/testmaker/src/App.tsx)
- [`src/pages/PortalLandingPage.tsx`](file:///e:/VibeCoding/testmaker/src/pages/PortalLandingPage.tsx)
- [`src/components/PinGate.tsx`](file:///e:/VibeCoding/testmaker/src/components/PinGate.tsx)
- [`src/services/quizCodeService.ts`](file:///e:/VibeCoding/testmaker/src/services/quizCodeService.ts)
- [`src/lib/examSubmissionGuards.ts`](file:///e:/VibeCoding/testmaker/src/lib/examSubmissionGuards.ts)
- [`public/pilot_exam_170_package.json`](file:///e:/VibeCoding/testmaker/public/pilot_exam_170_package.json)

### Planned Changes
1. **Remove unauthenticated Question Bank pre-warm in `App.tsx` (`153-160`):**
   - Remove the unconditional `setTimeout(() => { import('./pages/QuestionBankPage'); prewarmQuestionBankData(); }, 1200)` on initial mount.
   - `App.tsx` already triggers `prewarmQuestionBankData()` inside `<PinGate>` (`402`, `725`, `790`) once the user is actually inside the Teacher Suite. Optionally run a prewarm only inside an effect when `appMode === 'teacher' && sessionStorage.getItem('testmaker_pin_verified') === 'true'`.
2. **Remove `prefetchAccessPin()` from `PortalLandingPage.tsx` (`15`, `404`):**
   - Stop calling `prefetchAccessPin()` on landing page load so `app_config?key=eq.access_pin` is never fetched or stored during student visits.
3. **Purge PIN `localStorage` caching from `PinGate.tsx` (`11`, `76-122`, `165-169`):**
   - Delete `LOCAL_PIN_CACHE_KEY` (`testmaker_cached_access_pin`), `inMemoryPin`, and `prefetchAccessPin()`. Clear any leftover `localStorage.removeItem('testmaker_cached_access_pin')` on mount so existing student browsers are scrubbed automatically.
4. **Stop caching resolved quizzes into `localStorage` on student browsers (`quizCodeService.ts:235-261`):**
   - In `resolveStudentQuiz()`, remove both `localStorage.setItem('fluffykitten_published_quizzes', ...)` blocks (`239`, `256`). Students resolve live into React state / encrypted draft persistence only; Teacher Suite's `quizManagerService.ts` retains `fluffykitten_published_quizzes` for teacher authoring until Phase 2.
5. **Strip PDF source paths & static PINs (`examSubmissionGuards.ts`, `pilot_exam_170_package.json`):**
   - In `sanitizeQuestionsForStudent()` (`examSubmissionGuards.ts:353-399`), explicitly strip `source_pdf_url` (and internal marking/examiner metadata fields) unconditionally across student sessions so neither Formal Exams nor Practice Quizzes expose past-paper PDF URLs.
   - Remove `"teacherPin": "2026"` from `public/pilot_exam_170_package.json` (`29`, `45`) so static JSON assets don't broadcast an invigilator PIN.

### Step 1.1 Verification
- Open Portal (`http://localhost:5173`) in clean Incognito with Network tab open:
  - Confirm **zero** requests to `/rest/v1/questions`, `/rest/v1/syllabuses`, or `access_pin`.
  - Enter an exam code and launch student view -> confirm `localStorage` has **no** `testmaker_cached_access_pin` and **no** `fluffykitten_published_quizzes`, and `StudentQuizData.questions` has **no** `source_pdf_url` or `mark_scheme`.

---

## Step 1.2 — Server-Side `PinGate` Verification & Remove Fail-Open Bypass

### Target Files
- **New Migration:** `supabase/migrations/020_verify_teacher_access_pin_rpc.sql`
- [`src/components/PinGate.tsx`](file:///e:/VibeCoding/testmaker/src/components/PinGate.tsx)
- *(Check before implementing)* Any settings screen that updates `access_pin` (we verified earlier only `PinGate.tsx` reads `access_pin`, so let's also double check where teachers *set/change* `access_pin` if anywhere, to ensure compatibility).

### Planned Changes
1. **Create Postgres RPC `verify_teacher_access_pin(p_pin TEXT) RETURNS BOOLEAN` (`SECURITY DEFINER`):**
   - Matches the pattern in [`019_exam_submission_security_rpcs.sql`](file:///e:/VibeCoding/testmaker/supabase/migrations/019_exam_submission_security_rpcs.sql).
   - Reads `value` from `public.app_config WHERE key = 'access_pin' LIMIT 1`.
   - Supports **both** stored formats identically to [`cryptoUtils.ts`](file:///e:/VibeCoding/testmaker/src/utils/cryptoUtils.ts):
     - If stored value is 64-char hex (`^[0-9a-fA-F]{64}$`): compares `LOWER(ENCODE(SHA256(CONVERT_TO(TRIM(p_pin), 'UTF8')), 'hex')) = LOWER(TRIM(v_stored))`.
     - Else (legacy plaintext like `'404354'`): compares `TRIM(p_pin) = TRIM(v_stored)` OR hash equality.
   - Returns `FALSE` on empty input, missing config, or errors. Grants `EXECUTE` to `anon, authenticated`.
2. **Update `PinGate.tsx` (`255-315`) to validate via RPC & fail closed:**
   - Keep existing Turnstile anti-bot check (`verifyTurnstileToken(turnstileToken, 'pin_gate')`) and client lockout cooldown.
   - Replace `prefetchAccessPin()` + `verifyPinAgainstHashOrPlain(pin, targetPin)` with:
     ```ts
     const { data, error } = await supabase.rpc('verify_teacher_access_pin', { p_pin: pin });
     ```
     (with a clean timeout using `Promise.race` so UI never hangs indefinitely).
   - **Remove the fail-open block (`if (!targetPin) { ... sessionStorage.setItem(SESSION_KEY, 'true'); ... }`)**:
     - If the RPC errors, times out, or returns `false`, **deny access**! Show a clear error message when network/server verification is unreachable (`"Unable to verify PIN with server. Check your internet connection and try again."`) without burning lockout attempts on a genuine offline failure (or keep strict denial without setting `SESSION_KEY`).

### Step 1.2 Verification
- **Online valid PIN:** Enter valid Teacher PIN -> RPC returns `true` -> enters Teacher Suite; Network response shows only `true` boolean, never the stored PIN.
- **Online wrong PIN:** Enter wrong PIN -> RPC returns `false` -> decrements attempts / triggers cooldown.
- **Offline / blocked Supabase test:** Toggle DevTools Offline or block `*.supabase.co` -> enter any 6 digits -> **must NOT unlock** Teacher Suite (must show connection verification error and stay locked).

---

## Step 1.3 — Gate `Full Script PDF`, Question Review & Add `@media print` Suppression

### Target Files
- [`src/services/quizManagerService.ts`](file:///e:/VibeCoding/testmaker/src/services/quizManagerService.ts)
- [`src/services/quizCodeService.ts`](file:///e:/VibeCoding/testmaker/src/services/quizCodeService.ts)
- [`src/pages/QuizManagerPage.tsx`](file:///e:/VibeCoding/testmaker/src/pages/QuizManagerPage.tsx)
- [`src/pages/StudentQuizRunner.tsx`](file:///e:/VibeCoding/testmaker/src/pages/StudentQuizRunner.tsx)
- [`src/pages/StudentQuizRunner.css`](file:///e:/VibeCoding/testmaker/src/pages/StudentQuizRunner.css)
- [`src/components/StudentResultModal.tsx`](file:///e:/VibeCoding/testmaker/src/components/StudentResultModal.tsx)
- [`src/components/StudentResultModal.css`](file:///e:/VibeCoding/testmaker/src/components/StudentResultModal.css)

### Planned Changes
1. **Add explicit policy flag `allowStudentScriptDownload?: boolean` on `PublishedQuiz` and `StudentQuizData`:**
   - Default `false` for all Formal Exams (`isExamMode: true`) and undefined/legacy quizzes (safe-by-default!).
   - In `QuizManagerPage.tsx` (near `showInstantSolutions` around `2236-2253`), add a teacher checkbox: *"Allow students to view/download full question script & marking breakdown after results release"* (disabled/unchecked by default for Formal Exams; teachers can opt-in per quiz if desired).
2. **Gate post-submit runner screen (`StudentQuizRunner.tsx:5835-6260`):**
   - Currently, when `completedSubmission.status !== 'submitted'` (e.g., Practice Mode or after grading), `StudentQuizRunner` renders **`📄 Full Script PDF`** (`6203-6260`) and the full **`results-solutions-box`** (`5903+`).
   - Change gating so:
     - **`📄 Full Script PDF`** button is rendered **only** when `allowStudentScriptDownload === true` (while **`🎓 1-Page Report Card (PDF)`** remains available as it summarizes candidate scores & topic mastery without printing the exam paper).
     - The full question-by-question stems/diagrams (`results-solutions-box`) only render when `!isExamMode && (showInstantSolutions || allowStudentScriptDownload)`.
3. **Gate `StudentResultModal.tsx` (`297-321`, `358-445`):**
   - Keep **`🎓 1-Page Report Card`** (`299-308`) and **Competency Framework** (`324-355`) always available when results are released.
   - Hide **`📄 Full Script PDF`** (`310-320`) and the **`Detailed Response Analysis`** full question stems/mark references (`358-445`) unless `matchingQuiz?.allowStudentScriptDownload === true` (and in Phase 2, enforce this in Postgres inside `lookup_student_exam_result`). When disabled, show a clean note: *"Detailed question script download is disabled by your examiner for this assessment."*
4. **Add `@media print` lockdown CSS (`StudentQuizRunner.css`, `StudentResultModal.css`):**
   - Add `@media print { .student-runner-root, .student-results-wrap, .sq-lockdown-overlay, .srm-overlay, .exam-att-backdrop, .rb-drawer-backdrop { display: none !important; visibility: hidden !important; } }` plus a small `@media print` body fallback message so pressing `Ctrl+P` or choosing **Browser Menu → Print → Save as PDF** produces a blocked notice instead of the exam paper.

### Step 1.3 Verification
- Take a Formal Exam (or released quiz with `allowStudentScriptDownload = false`):
  - Confirm post-submit receipt and released `StudentResultModal` show score/report card only — **no** `📄 Full Script PDF` button and **no** question text/mark scheme.
  - Press `Ctrl+P` / browser Print Preview on active exam screen and results screen -> confirm preview shows no exam content.
- Toggle `allowStudentScriptDownload = true` on a Practice Quiz -> confirm teacher-permitted Full Script review still works when intended.

---

## Step 1.4 — Replace Raw PDF `<iframe>` with Non-Downloadable PDF.js Canvas Viewer

### Target Files
- [`src/components/ExamAttachmentModal.tsx`](file:///e:/VibeCoding/testmaker/src/components/ExamAttachmentModal.tsx)
- [`src/components/ExamAttachmentModal.css`](file:///e:/VibeCoding/testmaker/src/components/ExamAttachmentModal.css)
- *(Check)* [`src/components/ResourceBookletDrawer.tsx`](file:///e:/VibeCoding/testmaker/src/components/ResourceBookletDrawer.tsx) (verify `onContextMenu` / `draggable={false}` / `user-select: none` parity on visual media)

### Planned Changes
1. **Replace `<iframe src={currentAttachment.url} />` (`ExamAttachmentModal.tsx:126-131`):**
   - Use `pdfjs-dist` (`^6.2.108`, already installed and configured with `pdfjs-dist/build/pdf.worker.mjs?url` across `diagramCropper.ts`, `pdfChunker.ts`, etc.) inside a dedicated PDF page renderer in `ExamAttachmentModal.tsx`.
   - Load PDF bytes via `pdfjsLib.getDocument({ url: currentAttachment.url })` (with cleanup `doc.destroy()` on close/switch) and render pages to `<canvas>` elements at high DPI (`devicePixelRatio` scaled, respecting the existing `zoomLevel` state `50%–250%`).
   - Show page count (`Page 1 of N`), loading spinner, and error fallback message (never expose raw browser PDF toolbar with Download/Print buttons!).
2. **Harden image & canvas interactions inside `ExamAttachmentModal` & `ResourceBookletDrawer`:**
   - Add `draggable={false}`, `onContextMenu={(e) => e.preventDefault()}`, and CSS `user-select: none; -webkit-user-drag: none;` on canvases and `<img>` tags inside the attachment modal and booklet drawer.
   - Handle `fileType === 'doc'` / non-PDF fallback links safely without raw open-in-new-tab/download chrome if unsupported, or show clean preview message.

### Step 1.4 Verification
- Attach a multi-page PDF insert to a quiz and open `📎 Attachments` as a student:
  - Verify all pages render clearly at crisp resolution and respond to `−` / `+` / `1:1` zoom controls.
  - Confirm Chrome's PDF viewer toolbar (**Download** / **Print** / **Pop-out** buttons) is **completely gone** and right-click context menu on canvas/images is blocked.

---

## Automated & Manual Verification Checklist After Phase 1
- Run `npm run build` (`tsc -b && vite build`) and `npm run lint` (`oxlint`).
- Run existing exam security/runner unit test scripts in `package.json`:
  - `npm run test:pilot-exam`
  - `npm run test:fillable-tables`
  - `npm run test:inline-gaps`
  - `npm run test:resource-booklet`
- Add a focused unit/smoke test (e.g. checking `sanitizeQuestionsForStudent` strips `source_pdf_url` & `mark_scheme`, and `allowStudentScriptDownload` defaults) before moving to **Phase 2**.
