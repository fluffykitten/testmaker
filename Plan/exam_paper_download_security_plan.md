# Exam Paper Download Security Diagnosis & Upgrade Plan

> **Status:** Planning (Not Yet Implemented)  
> **Scope:** Prevent students from downloading, scraping, caching, or printing confidential exam papers, question banks, past-paper PDFs, attachments, and mark schemes.

---

## Part 1 — Root-Cause Diagnosis (Observed Exploit Vectors)

An audit of the client SPA, database migrations, and Cloudflare R2 media worker reveals **five concrete mechanisms** that currently allow students to download exam papers (and answer keys):

### 1. Disabled RLS + Public Supabase Anon Key (Critical — Direct Full-DB Dump)
- `src/lib/supabase.ts` ships `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the public browser bundle (expected for a static SPA on Netlify via `netlify.toml`).
- However, Row Level Security is explicitly **disabled** across core tables:
  - `supabase/migrations/001_initial_schema.sql` & `003_fix_all_rls_policies.sql`: `ALTER TABLE syllabuses DISABLE ROW LEVEL SECURITY;`, `ALTER TABLE questions DISABLE ROW LEVEL SECURITY;`, `ALTER TABLE custom_tests DISABLE ROW LEVEL SECURITY;`
  - `supabase/migrations/004_app_config.sql`: `ALTER TABLE app_config DISABLE ROW LEVEL SECURITY;`
  - `supabase/migrations/007_quiz_submissions.sql`: `ALTER TABLE quiz_submissions DISABLE ROW LEVEL SECURITY;`
  - `supabase/migrations/019_exam_submission_security_rpcs.sql` intentionally leaves RLS unchanged because the Teacher Dashboard still reads/writes those tables directly with the `anon` key.
- **Exploit:** Any student can copy the `apikey`/`Authorization` header from the browser Network tab and call the Supabase REST API (`GET /rest/v1/questions`, `/custom_tests`, `/app_config`, `/quiz_submissions`) to download the entire question bank (including `mark_scheme` and `source_pdf_url`), `published_quizzes`, `quiz_by_code:*`, `access_pin`, and classmates' submissions.

### 2. Client-Side PIN Verification, Portal Pre-Warm & Fail-Open Offline Bypass (Critical)
- `src/pages/PortalLandingPage.tsx` (line `404`) calls `prefetchAccessPin()` on landing page mount.
- `src/components/PinGate.tsx` (`76-122`, `275-285`) queries `app_config` (`key = 'access_pin'`) directly from the client, writes the plaintext PIN into `inMemoryPin` and `localStorage.setItem('testmaker_cached_access_pin', res.data.value)`, compares it in JS, and **fails open** (`if (!targetPin) { sessionStorage.setItem(SESSION_KEY, 'true'); ... }`) if Supabase is unreachable/blocked.
- `src/App.tsx` (`154-156`) schedules `import('./pages/QuestionBankPage'); prewarmQuestionBankData();` `1200ms` after app mount—even when a user is in Student Portal mode—causing `src/services/questionBankService.ts` (`1137-1145`) to prefetch syllabuses, facets, and question bank rows into the browser before any teacher login occurs.
- `public/pilot_exam_170_package.json` (`29`, `45`) ships plaintext `"teacherPin": "2026"` as a static public asset.
- **Exploit:** A student reads `localStorage['testmaker_cached_access_pin']` (or blocks Supabase to trigger fail-open bypass), triple-clicks the ICM logo (`PortalLandingPage.tsx:465-474`) to enter `PinGate`, unlocks Teacher Mode, and uses `ExportModal` to download `.docx`/`.pdf`/`.html` papers and mark schemes.

### 3. Full Unsanitized Exam Payload Prefetched & Cached Before Lockdown (High)
- `src/services/quizCodeService.ts` (`210-349`) resolves an exam code by fetching `published_quizzes` / `quiz_by_code:<CODE>`, `custom_tests`, and raw `questions[]` rows into the student browser **before** entering fullscreen/proctoring lockdown.
- It caches the array in `localStorage` (`'fluffykitten_published_quizzes'`) and only strips `mark_scheme` **in browser memory** via `sanitizeQuestionsForStudent(questions, stripAnswerKeys)` (`337`).
- **Exploit:** A student opens DevTools Network tab (or inspects `localStorage`) on the pre-exam lobby/portal screen and copies the full JSON exam paper (plus `mark_scheme`, attachments, and `source_pdf_url`) with zero proctoring violations.

### 4. Unauthenticated R2 PDF/Media Proxy, Deterministic Paths & Hardcoded Secret (High)
- Although `supabase/storage_setup.md` intends `raw-pdfs` to be private (`auth.role() = 'authenticated'`), `uploadPastPaperPdf` (`src/services/storageService.ts:345-388`) and `uploadInsertBookletPdf` (`395-438`) upload full Question Paper & Insert PDFs to public Cloudflare R2 under deterministic, guessable paths (`papers/${cleanSubject}_${year}_${series}_qp_${paper}.pdf`) or fallback public Supabase bucket `exam-diagrams`.
- `worker/index.js` (`449-555`) serves all `GET`/`HEAD` requests from R2 **unauthenticated** with `Access-Control-Allow-Origin: *` and zero signed-URL/expiry validation.
- `src/services/storageService.ts` (`10-11`), `src/lib/settings.ts` (`84-85`), and `worker/index.js` (`414` fallback) contain the hardcoded uploader secret `tm_r2_uploader_secret_2026`.
- `src/components/ExamAttachmentModal.tsx` (`126-131`) renders PDF attachments in `<iframe src={currentAttachment.url} />`, showing the browser's built-in PDF viewer toolbar (which includes a native **Download** and **Print** button) and exposing raw asset URLs.

### 5. Post-Submit Script PDF Export & Missing Student `@media print` Suppression (Medium-High)
- When `completedSubmission.status !== 'submitted'` (`src/pages/StudentQuizRunner.tsx:5835-6260`) or when results are viewed via `src/components/StudentResultModal.tsx` (`310-320`, `358-445`), students are given a **`📄 Full Script PDF`** button (`exportIndividualStudentReportPdf` in `src/services/quizReportPdfService.ts:1340-1545`) that opens a printable full-paper HTML document with every question stem, sub-question, and an interactive **Show Mark Scheme** checkbox (`1393-1396`).
- Additionally, `@media print` only exists in `TestPaperPreview.css:365`; there is no `@media print` block hiding `.student-runner-root` or `.student-results-wrap` against `Ctrl+P` / browser Print → Save as PDF.

---

## Part 2 — Phased Security Upgrade Plan

Each phase is divided into small, independently executable steps with concrete verification checks.

---

### Phase 1: Immediate Client, Storage & Leakage Hardening (Quick Wins — Low Migration Risk)

> **Goal:** Close client-side PIN leaks, idle question-bank prefetches, attachment PDF toolbar downloads, and accidental script/print exports while keeping the existing teacher workflow running during transition.

#### Step 1.1 — Remove Client Pre-Warm & Student `localStorage` Caching
- **Files:** `src/App.tsx`, `src/pages/PortalLandingPage.tsx`, `src/services/quizCodeService.ts`, `public/pilot_exam_170_package.json`
- **Changes:**
  1. Remove unconditional `import('./pages/QuestionBankPage'); prewarmQuestionBankData();` from `App.tsx` mount; only trigger prewarm after teacher authentication succeeds.
  2. Remove `prefetchAccessPin()` from `PortalLandingPage.tsx` (`404`) and stop writing `testmaker_cached_access_pin` to `localStorage` in `PinGate.tsx`.
  3. Stop caching `published_quizzes` or resolved exam papers into `localStorage['fluffykitten_published_quizzes']` during student resolution in `quizCodeService.ts`.
  4. Remove `"teacherPin"` from `public/pilot_exam_170_package.json` and strip `teacherPin` / `source_pdf_url` from any student-facing object normalization.
- **Verification:** Open Portal in clean Incognito DevTools → confirm zero `/questions`, `/syllabuses`, or `access_pin` network calls occur on landing, and `localStorage` contains no PINs or exam question lists.

#### Step 1.2 — Move `PinGate` Verification Server-Side & Remove Fail-Open Bypass
- **Files:** `supabase/migrations/<next>_verify_access_pin_rpc.sql`, `src/components/PinGate.tsx`
- **Changes:**
  1. Add a Postgres `SECURITY DEFINER` RPC `verify_teacher_access_pin(candidate_pin text) returns boolean` (plus rate-limit/attempt logging if desired) comparing against `app_config` (`key = 'access_pin'`) or a hashed secret—matching the pattern in `019_exam_submission_security_rpcs.sql`.
  2. Update `PinGate.tsx` to call `supabase.rpc('verify_teacher_access_pin', { candidate_pin })` instead of reading `access_pin` via `.from('app_config').select(...)`.
  3. **Remove the offline fail-open block (`if (!targetPin)`)** so blocking network requests to Supabase denies entry rather than granting Teacher Suite access.
- **Verification:** Disconnect network / block `*.supabase.co` in DevTools and verify `PinGate` rejects unlock. Verify valid PIN still unlocks Teacher Mode and invalid PIN returns `false`.

#### Step 1.3 — Gate `Full Script PDF`, Results Review & Add Print Suppression
- **Files:** `src/pages/StudentQuizRunner.tsx`, `src/pages/StudentQuizRunner.css`, `src/components/StudentResultModal.tsx`, `src/services/quizManagerService.ts`
- **Changes:**
  1. Add an exam policy flag (`allowStudentScriptDownload?: boolean`, default `false` for formal exams / `isExamMode`) on `PublishedQuiz`.
  2. In `StudentQuizRunner.tsx` (`5835-6260`) and `StudentResultModal.tsx` (`310-320`, `358-445`), hide the **`📄 Full Script PDF`** button, question-by-question full stem cards, and mark-scheme panes unless `allowStudentScriptDownload === true` (keep **`🎓 1-Page Report Card`** with score/topic mastery only).
  3. Add `@media print` rules in `StudentQuizRunner.css` and `StudentResultModal.css` hiding `.student-runner-root`, `.student-results-wrap`, and `.srm-overlay` (replacing print output with a blank/blocked notice).
- **Verification:** Submit a formal quiz with `allowStudentScriptDownload = false` → confirm no Full Script PDF or full question text appears in runner receipt, `StudentResultModal`, or `Ctrl+P` Print Preview.

#### Step 1.4 — Prevent Native PDF Toolbar Downloads in `ExamAttachmentModal`
- **Files:** `src/components/ExamAttachmentModal.tsx`, `src/components/ExamAttachmentModal.css`
- **Changes:**
  1. Replace raw `<iframe src={currentAttachment.url} />` for PDF attachments with an in-app PDF.js canvas renderer (PDF.js is already used elsewhere in `src/`, or render pages to `<canvas>` with zoom controls and watermark overlay) with no browser Download/Print toolbar.
  2. Append `#toolbar=0&navpanes=0` only as a non-primary fallback; prefer canvas-rendered pages so no direct PDF file URL is handed to Chrome's PDF plugin.
- **Verification:** Open an exam PDF attachment as a student → confirm pages render crisply with zoom controls and no native PDF Download/Print button appears.

---

### Phase 2: True Trust Boundary — Supabase Auth, Strict RLS & Server-Side Exam Delivery (High Impact)

> **Goal:** Eliminate anonymous database reads/writes completely so DevTools / `curl` against `VITE_SUPABASE_ANON_KEY` cannot read `questions`, `custom_tests`, `app_config`, or `quiz_submissions`.

#### Step 2.1 — Introduce Real Teacher Authentication (Supabase Auth)
- **Files:** `src/components/PinGate.tsx` (or new `TeacherAuthModal.tsx`), `src/lib/supabase.ts`, `supabase/migrations/<next>_teacher_auth_rls.sql`
- **Changes:**
  1. Enable Supabase Auth (email/password or Google Workspace SSO for `@<school-domain>`, plus optional `teacher_users` allowlist table / JWT custom role `teacher`).
  2. Replace the shared static `PinGate` for database writes/reads with authenticated Supabase sessions (`supabase.auth.signInWithPassword` / OAuth). Optionally retain a secondary quick lock screen PIN only *after* an authenticated session exists.
  3. Ensure Teacher Dashboard services (`questionBankService.ts`, `quizManagerService.ts`, `quizSubmissionService.ts`, `settings.ts`) execute under the authenticated teacher's JWT, never as `anon`.
- **Verification:** Unauthenticated `anon` client calling `supabase.from('questions').select('*')` receives `[]` / permission denied (`401`/`403` or zero rows under RLS). Signed-in teacher can CRUD normally.

#### Step 2.2 — Enable Strict RLS on All Database Tables
- **Files:** `supabase/migrations/<next>_enable_strict_rls.sql`
- **Changes:**
  1. `ALTER TABLE syllabuses ENABLE ROW LEVEL SECURITY;`
  2. `ALTER TABLE questions ENABLE ROW LEVEL SECURITY;`
  3. `ALTER TABLE custom_tests ENABLE ROW LEVEL SECURITY;`
  4. `ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;`
  5. `ALTER TABLE quiz_submissions ENABLE ROW LEVEL SECURITY;`
  6. Restrict `SELECT/INSERT/UPDATE/DELETE` policies on these tables strictly to `auth.role() = 'authenticated'` AND teacher check (`EXISTS (SELECT 1 FROM teacher_users WHERE user_id = auth.uid() AND active = true)`).
  7. Explicitly revoke direct table `SELECT` on `questions`, `custom_tests`, `app_config`, and `quiz_submissions` from the `anon` role.
- **Verification:** Run curl/PostgREST tests with `VITE_SUPABASE_ANON_KEY` against `/rest/v1/questions`, `/custom_tests`, `/app_config`, `/quiz_submissions` → confirm `0` rows / `403` for every table.

#### Step 2.3 — Server-Side Exam Session & Grading RPCs (`SECURITY DEFINER`)
- **Files:** `supabase/migrations/<next>_student_exam_delivery_rpcs.sql`, `src/services/quizCodeService.ts`, `src/services/quizSubmissionService.ts`, `src/services/examDraftService.ts`
- **Changes:**
  1. Create `start_or_resume_student_exam(p_quiz_code text, p_student_name text, p_student_class text, p_candidate_number text, p_student_pin text) returns jsonb` (`SECURITY DEFINER`):
     - Validates `isActive`, schedule window, single-attempt lock, and `verify_student_pin` on the server.
     - Fetches the specific `custom_test` and associated `questions` inside Postgres.
     - Strips `mark_scheme`, `acceptable_answers`, `model_answer`, `source_pdf_url`, and `teacher_pin` **inside Postgres** before returning JSON.
     - Returns a short-lived signed `session_token` + sanitized paper (optionally progressive/per-question or full active session payload for offline resilience).
  2. Create `save_student_exam_draft(...)` & `submit_student_exam(...)` `SECURITY DEFINER` RPCs keyed by `session_token` (replacing direct `anon` writes to `app_config` `draft_*` and `quiz_submissions`).
  3. Update `lookup_student_exam_result` so when `status != 'released'` (or `allow_script_review = false`), `question_results` strips `questionText` and `correctAnswer` on the server.
- **Verification:** Capture network payload when a student enters an exam code and clicks Start → confirm response contains **zero** `mark_scheme`, `source_pdf_url`, `teacherPin`, or sibling `published_quizzes` entries, and attempts prior to activation window return access denied.

---

### Phase 3: Private Storage, Short-Lived Signed URLs & Forensic Deterrents

> **Goal:** Eliminate static public paper PDF URLs, hardcoded upload secrets, and raw image/PDF scraping.

#### Step 3.1 — Remove Hardcoded R2 Upload Secret & Authenticate Worker Writes
- **Files:** `worker/index.js`, `src/services/storageService.ts`, `src/lib/settings.ts`
- **Changes:**
  1. Remove `tm_r2_uploader_secret_2026` from `storageService.ts` (`11`), `settings.ts` (`85`), and the fallback in `worker/index.js` (`414`). Rotate the secret in Cloudflare Workers (`wrangler secret put UPLOAD_SECRET`).
  2. Update `worker/index.js` upload/delete routes (`POST`/`PUT`/`DELETE`) to require and verify the **Supabase Auth JWT** (checking teacher role via Supabase JWKS / `GET /auth/v1/user`) instead of a client-embedded static shared header.
- **Verification:** Calling Worker `POST` upload from an unauthenticated script or with the old hardcoded secret returns `401 Unauthorized`. Teacher upload with valid Supabase JWT succeeds.

#### Step 3.2 — Isolate Past Paper PDFs in Private Storage & Lock Down Worker `GET`
- **Files:** `worker/index.js`, `src/services/storageService.ts`, `supabase/storage_setup.md`
- **Changes:**
  1. Route `uploadPastPaperPdf` and `uploadInsertBookletPdf` **only** to private Supabase bucket `raw-pdfs` (authenticated teacher access via `createSignedUrl`) or a private R2 prefix (`private-papers/...`) blocked from unauthenticated `GET`.
  2. Add HMAC-signed short-lived URL generation (`?exp=<unix>&sid=<session>&sig=<hmac_sha256>`) in `worker/index.js` (or Edge Function) for exam diagrams, attachments, and booklet inserts—verifying `sig` and `Date.now() < exp` on every `GET` request.
  3. Set strict `CORS` (`Access-Control-Allow-Origin` restricted to app origin) and `Cache-Control: private, no-store` on sensitive exam assets so CDNs/browsers do not cache raw files publicly.
  4. Migrate existing files under public `papers/` in R2 to private prefix / rotate keys so old guessable URLs (`papers/<subject>_<year>_...`) stop returning `200 OK`.
- **Verification:** Requesting `/papers/...` or any diagram URL without `?exp=...&sig=...` (or with an expired timestamp) returns `403 Forbidden`. Active exam loads diagrams cleanly within the session window.

#### Step 3.3 — Per-Candidate Forensic Watermarking & Optional Progressive Question Delivery
- **Files:** `src/lib/settings.ts`, `src/pages/StudentQuizRunner.tsx`, `src/components/ExamAttachmentModal.tsx`, `src/components/ResourceBookletDrawer.tsx`
- **Changes:**
  1. Enable `defaultEnableWatermark` by default for Formal Exam quizzes and render the candidate's name, class, candidate number, timestamp, and session hash as a subtle tiled SVG/Canvas overlay across question bodies, diagrams, the Attachment Modal, and the Resource Booklet Drawer (deterring screenshots/photos).
  2. *(Optional high-security mode)* Add a per-quiz setting for **Server-Graded Progressive Delivery** (`get_exam_question_item(session_token, index)` via Edge Function/RPC), delivering only the active question rather than the whole paper JSON upfront, paired with server-side grading on submission.
- **Verification:** Inspect question view, diagram zoom, attachment viewer, and booklet drawer in Formal Exam mode → watermark overlay tracks candidate identity cleanly without obstructing readability.

---

## Recommended Execution Order
1. **Immediate (Today — Zero Migration Breakage):** Steps **1.1 → 1.2 → 1.3 → 1.4** (stops PIN leak, portal pre-warm, `localStorage` caching, offline bypass, `Full Script PDF` leak, and PDF iframe toolbar download).
2. **Core Architecture Upgrade:** Steps **2.1 → 2.2 → 2.3** (Teacher Supabase Auth + strict RLS + `SECURITY DEFINER` exam delivery).
3. **Storage & Media Lockdown:** Steps **3.1 → 3.2 → 3.3** (remove hardcoded R2 secret, rotate/privatize `papers/*.pdf`, HMAC-signed media URLs, default forensic watermark).

