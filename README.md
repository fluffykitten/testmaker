# ICM Exam Platform

**Version `2.7.7`** · Cambridge International Assessment Authoring, Proctoring & Diagnostic Suite  
Built for **Insan Cendekia Madani (ICM)** · Compatible with Web, Android, and iOS via Capacitor

[![Version](https://img.shields.io/badge/version-2.7.7-0f4c81.svg)](#changelog)
[![React](https://img.shields.io/badge/React-19-149eca.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20RLS-3ecf8e.svg)](https://supabase.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-64748b.svg)](#license)

---

## Contents

- [Overview](#overview)
- [Core Capabilities](#core-capabilities)
- [Security Architecture](#security-architecture)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Database Migrations](#database-migrations)
- [Verification & Diagnostics](#verification--diagnostics)
- [Changelog](#changelog)
- [License](#license)

---

## Overview

ICM Exam Platform is a full-stack digital examination authoring, live proctoring, and diagnostic reporting system designed around **Cambridge Assessment International Education** and **IELTS** workflows. Teachers can extract past-paper PDFs and mark schemes with Google Gemini multimodal AI, assemble balanced assessments with Table of Specifications validation, administer proctored online or air-gapped offline exams, host live multiplayer game arenas, ingest paper exam spreadsheets, and export publication-grade PDFs and `.docx` booklets.

---

## Core Capabilities

| Domain | Capabilities |
| :--- | :--- |
| **AI Paper Extraction** | Multimodal Gemini PDF & mark scheme extraction for MCQ, structured sub-parts (`(a)(i)`), IELTS cloze `[1]` / `[term1\|term2]` inline gaps, fillable `data_tables`, Bloom's taxonomy (C1–C6), and canvas diagram cropping with WebP compression. |
| **Audio Listening Suite** | Persistent top listening bar with strict exam seek/speed locks ($1.0\times$), play-limit enforcement (1–3 plays or unlimited), 4-section IELTS range auto-divider, Opus compression, mic recording, and AI TTS. |
| **Cambridge & Office Exports** | Authentic IGCSE / AS & A Level cover pages, interactive & printable 118-element Chemistry Periodic Table drawer, Humanities Resource Insert booklets (`.docx` & PDF), MCQ bubble sheets, and standalone offline HTML papers. |
| **Formal Proctored Exam Mode** | Fullscreen lockdown with blur/tab-switch detection, tiered security strike policies, 5-min / 1-min alerts, canonical roster ID binding, per-student `exam_draft_locks`, `AES-256-GCM` air-gapped `.exam` emergency packages, and canvas `pdfjs-dist` attachment viewer. |
| **Live Invigilator Cockpit** | Multi-class real-time monitoring dashboard with heartbeat micro-batching, ECDSA P-256 signed commands (`unlock`, `add_time`, `force_submit`, `pardon`), SHA-256 student heartbeat binding, and persistent `proctor_audit_events`. |
| **Live Game Arena** | Multiplayer host controller and solo sprint runner with synthesized Web Audio (`gameSoundEngine.ts`), signed host broadcasts, server-side answer verification, and streak leaderboards. |
| **Offline Grading & Reports** | Custom multi-sheet Excel mark-entry templates with deterministic auto-grading, 1-page ink-saving A4 student diagnostic reports, class/cohort analytics, and A\*–U grade boundary curves. |

---

## Security Architecture

- **Educator Authentication & Workspace RLS**: Password-authenticated educator accounts (`teacherProfileService.ts`) backed by 12-hour `x-teacher-session` tokens and strict PostgreSQL Row-Level Security across workspace tables (`021`, `024`).
- **Student Data Isolation**: Student exams load via sanitized `SECURITY DEFINER` RPCs (`get_student_exam_paper`, `get_student_game_paper`) with mark schemes, `source_pdf_url`, metadata, and `teacherPinHash` stripped (`021`, `022`, `024`).
- **Draft & Submission Integrity**: Single-device `exam_draft_locks` ownership tokens (`022`), 256 KB draft caps, server-side Exam Mode score zeroing, single-attempt locks, roster PIN verification, and 6-digit CSPRNG result PINs (`024`).
- **Abuse & Rate Protection**: `security_rate_limits` lockouts across Master PIN, educator login/reset, student PIN, game PIN, and result lookups (`024`), plus audit table payload/frequency triggers (`022`).
- **Client & AI Output Hardening**: KaTeX `trust: false` and escaped HTML/PDF template interpolation (XSS prevention), CSV/Excel formula prefix neutralization, AES-256-GCM mandatory enforcement on `.exam` emergency ingestion with server-side question re-grading, WebCrypto ECDSA P-256 signed proctor commands & game broadcasts, and randomized nonce isolation with prompt-injection flagging in AI examiner prompts (`023`, `2.5.1`).

---

## Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Frontend** | React 19, TypeScript, Vite, Vanilla CSS Design System |
| **Mobile Wrapper** | Capacitor 8 (Android & iOS with 1:1 web parity) |
| **Math, PDF & Media** | KaTeX, `pdfjs-dist`, `pdf-lib`, Web Audio API, Opus audio compression |
| **Document Exports** | `docx` (Word), `exceljs` / `xlsx` (Excel gradebooks), HTML5 Print Engine (PDF) |
| **Backend & AI** | Supabase (PostgreSQL, RLS, Realtime Broadcast, Storage), Google Gemini Multimodal APIs |

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) v18 or higher
- A [Supabase](https://supabase.com) project
- A [Google AI Studio](https://aistudio.google.com/apikey) API key (optional server proxy supported)

### Install & Run
```bash
git clone https://github.com/fluffykitten/testmaker.git
cd testmaker
npm install
```

Create `.env.local` in the repository root:
```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
VITE_GEMINI_API_KEY=your-gemini-api-key
```

Run locally or build for production:
```bash
npm run dev      # Start local dev server at http://localhost:5173
npm run build    # Type-check (tsc -b) and build production bundle (dist/)
```

### Native Mobile Builds (Android & iOS)
```bash
npm run mobile:build     # Build web assets and sync Capacitor projects
npm run mobile:android   # Open Android Studio (build APK / signed AAB)
npm run mobile:ios       # Open Xcode (archive for TestFlight / App Store)
```

---

## Database Migrations

Run the SQL files inside `supabase/migrations/` **in numerical order (`001` through `040`)** in the **Supabase SQL Editor**:

| Migration Range | Purpose |
| :--- | :--- |
| `001` – `007` | Core schema: syllabuses, questions, custom tests, app config, options, diagrams/inserts, quiz submissions |
| `008` – `019` | Audio columns, natural sorting, student PIN verification, teacher/game profiles, Bloom's cognitive level, proctor audit log & submission RPCs |
| [`020_verify_teacher_access_pin_rpc.sql`](supabase/migrations/020_verify_teacher_access_pin_rpc.sql) | Server-side teacher Master PIN verification (`verify_teacher_access_pin`) |
| [`021_phase2_teacher_login_rls_and_exam_rpcs.sql`](supabase/migrations/021_phase2_teacher_login_rls_and_exam_rpcs.sql) | Educator auth/session tokens (`teacher_auth_sessions`), strict table RLS, and sanitized exam/draft/submission/result RPCs |
| [`022_exam_anti_tamper_and_rate_guards.sql`](supabase/migrations/022_exam_anti_tamper_and_rate_guards.sql) | `exam_draft_locks`, Exam Mode server score zeroing, single-attempt enforcement, download gating, set-based paper assembly, and audit triggers |
| [`023_proctor_security_and_pin_parity.sql`](supabase/migrations/023_proctor_security_and_pin_parity.sql) | Unlock PIN lookup parity and `proctor_channel_keys` ECDSA P-256 key registry |
| [`024_phase3_deep_rls_ratelimit_and_game_security.sql`](supabase/migrations/024_phase3_deep_rls_ratelimit_and_game_security.sql) | `teacherPinHash` removal, `game_profiles` RLS & reward caps, `security_rate_limits` lockouts, roster PIN & draft-lock submission enforcement, and `get_student_game_paper` / `check_game_question_answer` |
| [`025_personal_exam_pin_hardening.sql`](supabase/migrations/025_personal_exam_pin_hardening.sql) | `normalize_roster_class_label` spacing parity (`X IPA3` ↔ `X IPA 3`), strict enrolled-PIN rejection inside `verify_roster_pin_if_enrolled`, and composite `name__pin` draft lock resolution in `submit_student_exam_attempt` |
| [`026_admin_teacher_account_management.sql`](supabase/migrations/026_admin_teacher_account_management.sql) | Centralized Admin Educator Account RPCs (`admin_list/create/update/reset_password/delete`), `must_change_password` temporary password flow, session revocation on suspension, and self-service `change_own_teacher_password` |
| [`027_exam_session_scheduling.sql`](supabase/migrations/027_exam_session_scheduling.sql) | Scheduled Exam Session windows (`scheduled_start_at`, `scheduled_end_at`) enforced in `get_student_exam_paper` / `submit_student_exam_attempt` against server `NOW()`, plus teacher `set_quiz_schedule` RPC |
| [`028_game_profiles_anon_grant.sql`](supabase/migrations/028_game_profiles_anon_grant.sql) | Restores table GRANT on `public.game_profiles` for `anon` role so `x-teacher-session` RLS policies allow backup/restore of Arena profiles |
| [`029_lock_published_quizzes_table_rls.sql`](supabase/migrations/029_lock_published_quizzes_table_rls.sql) | Enables strict teacher-only RLS and revokes `PUBLIC`/`anon`/`authenticated` grants on legacy `public.published_quizzes` |
| [`030_optional_result_pin.sql`](supabase/migrations/030_optional_result_pin.sql) | Makes post-submit Personal Access PIN optional (`ENABLE_POST_SUBMIT_RESULT_PIN`) with idempotent blank-`result_pin` submission retries |
| [`031_class_scoped_identity_and_170_student_scale.sql`](supabase/migrations/031_class_scoped_identity_and_170_student_scale.sql) | Class-scoped homonym disambiguation (`normalize_roster_class_label`), Practice `'graded'` status + optional `result_pin` idempotency, `fillfactor = 70` HOT tuning, 10-min `exam_draft_locks` refresh guard, functional audit/attempt lookup indexes, and `cleanup_stale_exam_drafts` RPC |
| [`032_exam_paper_cache_and_fast_lobby.sql`](supabase/migrations/032_exam_paper_cache_and_fast_lobby.sql) | Private RLS-locked `exam_paper_cache` with trigger-based invalidation (`app_config` / `questions` / `custom_tests`), live `scheduleStatus`/`serverNow` window enforcement, per-code advisory-lock single-flight builds, and indexed UUID/PK CTE question resolution |
| [`033_resync_pin_verification_parity.sql`](supabase/migrations/033_resync_pin_verification_parity.sql) | Teacher unlock PIN RPC parity across `quiz_by_code_`, `quiz_by_code:`, `published_quizzes`, `previousCodes`, and default `'1234'` fallback |
| [`034_atomic_draft_lock_index_and_pin_ratelimit.sql`](supabase/migrations/034_atomic_draft_lock_index_and_pin_ratelimit.sql) | Expression index `idx_quiz_submissions_code_norm_name_class`, atomic `exam_draft_locks` upsert, and normalized student PIN rate-limit scoping |
| [`035_fix_exam_paper_cache_safeupdate.sql`](supabase/migrations/035_fix_exam_paper_cache_safeupdate.sql) | Qualified `DELETE FROM public.exam_paper_cache WHERE quiz_code IS NOT NULL` unblocking `app_config` / `questions` / `custom_tests` writes under `pg_safeupdate` |
| [`036_icm_multi_exam_scale_and_roster_cache.sql`](supabase/migrations/036_icm_multi_exam_scale_and_roster_cache.sql) | Trigger-synced `school_roster_entries`/`school_roster_meta` indexed cache, selective `exam_paper_cache` diff invalidation, bundled lobby metadata (`publicRosterDirectory`, `schoolClasses`, `securityTiers`, `hideEmergencyExamButton`), PK-guarded `clear_rate_limit`, and inline post-submit draft/lock cleanup |
| [`037_admin_prewarm_and_unified_exam_entry.sql`](supabase/migrations/037_admin_prewarm_and_unified_exam_entry.sql) | 90-minute `exam_paper_cache` TTL with schedule-preserving wait state, authenticated-teacher `prewarm_exam_paper_cache` RPC, and atomic unified `enter_student_exam_session` entry RPC |
| [`038_fix_submission_index_grant_and_pagination.sql`](supabase/migrations/038_fix_submission_index_grant_and_pagination.sql) | Restores `EXECUTE` on `normalize_roster_class_label(TEXT)` for `anon`/`authenticated` PostgREST writes on `quiz_submissions` (`42501` fix) and adds `idx_quiz_submissions_submitted_at_desc` (`submitted_at DESC, id DESC`) for fast pagination |
| [`039_teacher_dummy_test_student.sql`](supabase/migrations/039_teacher_dummy_test_student.sql) | Adds the universal **Teacher Test Account** (`PIN: 0000`, valid across all school and custom classes) directly inside `verify_student_pin` while keeping `app_config('school_roster')`, Desk Cards, and printed PIN sheets clean |
| [`040_quiz_submissions_timeout_and_index_cleanup.sql`](supabase/migrations/040_quiz_submissions_timeout_and_index_cleanup.sql) | Drops unused `quiz_submissions` lookup indexes (`idx_quiz_submissions_attempt_lookup`, `idx_quiz_submissions_candidate_number`, `idx_quiz_submissions_student_name`) to reduce write amplification during batch and single-row upserts |

---

## Verification & Diagnostics

| Suite | Command | Coverage |
| :--- | :--- | :--- |
| **Phase 1 Security** | `npm run test:phase1-security` | Client bundle leaks, Master PIN RPC, PDF canvas & print guards |
| **Phase 2 Auth & RLS** | `npm run test:phase2-security` | Teacher sessions, strict RLS policies, sanitized RPC contracts |
| **Phase 2.5 Anti-Tamper** | `npm run test:phase25-security` | Draft locks, score zeroing, single-attempt enforcement, crash recovery |
| **Phase 3A Client Security** | `npm run test:phase3a-security` | XSS & KaTeX `trust: false`, CSV neutralization, `.exam` crypto/re-grading, prompt-injection isolation |
| **Phase 3B Deep Security** | `npm run test:phase3b-security` | Migration `024` contracts, `game_profiles` RLS/caps, rate limits, signed game frames, heartbeat proofs |
| **Scale & Class Identity** | `npm run test:scale-170` | Class-scoped homonym locks/receipts, draft dirty-check fingerprint, `544` circuit breaker, `031` & `032` contracts |
| **Post-Submit Re-Sync & PIN** | `npm run test:resync` | Unreachable vs. wrong Teacher PIN detection, outbox error propagation/cleanup, Practice UI, offline reload & `033` |
| **Student PIN Sheet (.docx)** | `npm run test:roster-pin-docx` | Auto-assigned 4-digit PINs, per-class Master Tables, `3×6` cut-out slips, strict field filtering |
| **Optional Result PIN** | `npm run test:optional-result-pin` | Optional post-submit result PIN gating, empty-`result_pin` `030`/`031` idempotent retries & copy checks |
| **Candidate Cards & Workbook Import** | `npm run test:desk-cards` | ICM multi-sheet workbook parsing, PIN-preserving diff import, schedule targeting, 2×3 A4 duplex mirroring |
| **Personal Exam PIN Hardening** | `npm run test:student-pin` | Quiz PIN toggle inheritance, school-wide unique PINs, composite draft isolation, class normalization & `025` guards |
| **Admin Educator Accounts** | `npm run test:teacher-accounts` | Migration `026` admin RPCs, bootstrap authorization, temporary password lifecycle, pre-026 fallback |
| **Exam Session Scheduling** | `npm run test:exam-schedule` | Start/End time window resolution, Waiting Room sync, Migration `027` server gates & UI layout |
| **Multiple Select Grading** | `npm run test:multi-select` | Strict all-or-nothing scoring across online deterministic and offline Excel grading |
| **Backup & Folder Sync** | `npm run test:backup-restore` | Incremental PC folder media diffing, `v1.1` archive inspection, cross-project URL rewriting & cache sync |
| **Topic Mastery & Reports** | `npm run test:topic-mastery` | Configurable mastery bands and student Excel diagnostic export generation |
| **Emergency Fallback** | `npm run test:emergency` & `npm run test:emergency:sim` | `AES-256-GCM` `.exam` encryption, outbox retries, conflict resolution |
| **Proctoring Hardening** | `node --import ./scripts/register-ts.mjs scripts/test-proctor-hardening-023.mjs` | ECDSA P-256 command auth, UTF-8 byte clamping, `023` audit guards |
| **Proctoring State Machine** | `node --import ./scripts/register-ts.mjs scripts/test-proctor-p1-p2-p3.mjs` | Heartbeat throttling, command replay protection, strike/pardon guards |
| **200-Student Live Load & Red-Team** | `npm run test:stress-200` | Concurrent 200-student Supabase stress simulation & exploit probes ([latest report](Plan/student_200_stress_test_report.md)) |
| **Multi-Exam Sitting Stress Test** | `npm run test:stress-realistic` | Full-fidelity 200-student across `ICM-1`..`ICM-13` + 3 Invigilators + 2 Results Watchers + 2s health probe ([latest report](Plan/realistic_stress_test_report.md)) |
| **Pre-Warm & Unified Entry (`037`)** | `npm run test:prewarm-037` | 10-min landing boot cache, `prewarmExamPaperCache` guardrails, local lobby draft lookup, unified `enterStudentExamSession`, sequential toggles & `037` SQL contracts ([live report](Plan/stress_test_037_report.md)) |
| **Semester Day Organizer** | `npm run test:semester-days` | Exam day grouping, chronological schedule presets, batched Open & Pre-Warm / Pause All Day toggles, 90-min warm-state tracking & Unscheduled cleanup |
| **Table Choice Question Type** | `npm run test:table-choice` | `Table Choice` normalization, `Upaya`/`Tepat`/`Tidak Tepat` matrix parsing, PDF cleanup, full & partial per-row deterministic grading |
| **Mark Scheme Strictness & QA** | `npm run test:mark-scheme` | Official MS preamble/chunking boundaries, cross-chunk MS quality merge, deterministic MS QA audits (marks & option-letter parity) |
| **Languages, Arabic & BiDi** | `npm run test:languages-bidi` | `Bahasa Indonesia` / `PAI` / `Bahasa Arab` non-Cambridge detection, Arabic visual PNG routing, Presentation Form/harakat normalization, range-scoped passage merging, `[passage]...[/passage]` stitching, `<bdi dir="rtl">` isolation |
| **Live Diagnostics** | `node scripts/diagnose-proctoring-system.mjs` | Live RLS, PIN parity, audit guard, and Realtime fan-out checks |

---

## Changelog

### [v.2.7.7] — Extended A–H MCQ Option & Mark Scheme Support + PDF Upload Optimization Plan
- **Extended MCQ / Matching Letter Support (`A–H`):**
  - Updated `toCanonicalOptionLetter` and `PAIR_RE` in [`mcqMarkSchemeExtractor.ts`](src/lib/mcqMarkSchemeExtractor.ts) from `A–E`/`A–F` to `A–H` so deterministic official Mark Scheme reconciliation covers 6–8 choice matching exercises (such as Cambridge IGCSE 0510 Listening Exercise 4 `A–H` statements).
  - Updated `letters` and `parseMcqOption` in [`mcqUtils.ts`](src/utils/mcqUtils.ts) to normalize `A`–`H` option prefixes cleanly.
- **PDF Upload Optimization Blueprint:**
  - Documented per-chunk Mark Scheme slicing/text-first routing and zero-value page stripping (`sourcePageNumbers` remapping) in [`Plan/pdf_upload_token_optimization_plan.md`](Plan/pdf_upload_token_optimization_plan.md).

### [v.2.7.6] — High-Fidelity `.docx` Exam Export, Native OMML Math & 150-Student Supabase Scaling
- **`.docx` Exam Export Overhaul (Images, Tables, OMML Math & Content Hygiene):**
  - Created [`src/utils/docxImageUtils.ts`](src/utils/docxImageUtils.ts) (`getImageDimensionsFromBytes`, `fitImageDimensions`, `prepareDocxImageBytes`) to decode real PNG/JPEG/WebP/SVG pixel dimensions, transcode WebP/SVG payloads into valid PNGs via browser `<canvas>` (rejecting raw WebP/SVG bytes if un-transcodable), and scale proportionally without upscaling across all 5 exporters in [`docxExportService.ts`](src/services/docxExportService.ts).
  - Created [`src/utils/docxMathUtils.ts`](src/utils/docxMathUtils.ts) (`parseFormattedTextToDocxChildren`, `convertMhchemToFormattedText`, `normalizeCommonLatexForDocx`) to convert balanced LaTeX (`\frac`, `\sqrt`), `\ce{...}` chemistry, and nuclide isotopes (`^{37}_{17}\text{Cl}`, `^{63}_{29}\text{Cu}^{+}`) into native Word OMML (`<m:oMath>`, `<m:f>`, `<m:rad>`, `<m:sPre>`), while preserving protected currency symbols (`$15`).
  - Upgraded `convertMarkdownBlocksToDocxElements` and `computeFixedTableColumnWidths` to emit fixed `dxa` `columnWidths` + `TableLayoutType.FIXED` + `cantSplit` tables in both stems and sub-questions, preserve multi-line breaks/bullet lists, blank `[ ]`/`☐` fillable cells, suppress redundant dotted answer lines beneath pure completion tables or inline blanks, strip duplicated sub-question prefixes and `[Figure ...]` placeholders (`sanitizeExamTextForDocx`, `stripDuplicateSubQuestionPrefix`), and use Word's native `PageNumber.TOTAL_PAGES` (`NUMPAGES`) field on cover pages.
  - Added automated OOXML verification in [`scripts/test-docx-export-fidelity.mjs`](scripts/test-docx-export-fidelity.mjs) (`npm run test:docx-export`) and exported `buildStudentPaperDocxDocument`.
- **Supabase 150-Student Concurrency Migration & Grading/Reporting Hardening:**
  - Added [`supabase/migrations/20261124_optimize_indexes_and_rls_for_150_students.sql`](supabase/migrations/20261124_optimize_indexes_and_rls_for_150_students.sql) adding covering foreign-key indexes on `teacher_auth_sessions(teacher_id)` and `custom_tests(user_id)` and consolidating duplicate permissive RLS policies on `app_config` and `proctor_audit_events`.
  - Refined MCQ re-grading & AI essay grading handling ([`deterministicGradingService.ts`](src/services/deterministicGradingService.ts), [`QuizResultsModal.tsx`](src/components/QuizResultsModal.tsx), [`aiGradingService.ts`](src/services/aiGradingService.ts)) and ICM Excel export formatting ([`icmExcelExportService.ts`](src/services/icmExcelExportService.ts)).

### [v.2.7.5] — Proctor Polling Payload Optimization, Submission Pagination & Batch Sync Hardening (`040`)
- **Proctor Polling Payload & 15-Second Reconnect Stabilization:**
  - Dropped heavy `raw_answers` JSONB retrieval from `fetchProctorMonitoredSubmissions` in [`quizSubmissionService.ts`](src/services/quizSubmissionService.ts), synthesizing `forensics.proctorStudentId` canonically on read (with defensive `_forensics` fallback for unit mocks).
  - Decoupled [`LiveInvigilatorModal.tsx`](src/components/LiveInvigilatorModal.tsx) backfill and Realtime subscription effects onto a stable `[monitoredCodesKey]` dependency backed by `monitoredQuizzesRef` / `quizByCodeRef` and cancellation guards, and memoized `activeExamQuizzes` / `proctorModalQuizzes` in [`QuizManagerPage.tsx`](src/pages/QuizManagerPage.tsx) across 15-second `nowMs` countdown ticks so Realtime channels are no longer torn down and re-polled every 15 seconds.
- **Submission Pagination, Batch Upsert Chunking & Concurrency Safety:**
  - Reduced `fetchAllSubmissionsFromSupabase` `pageSize` from `250` to `100` with a 2-attempt (`400 ms` delay) per-page retry in [`quizSubmissionService.ts`](src/services/quizSubmissionService.ts) to prevent `57014` statement timeouts on deep offsets.
  - Added `compactForensicsForStorage` in [`quizSubmissionService.ts`](src/services/quizSubmissionService.ts) and bounded `recordAnswerChange` in [`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx) (`240`-char string previews, `30` revisions per question, `250` total entries) to prevent `_forensics.answerChangeLogs` bloat.
  - Hardened `saveBatchQuizSubmissionsCloud`: reduced `chunkSize` from `100` to `20`, stamped consistent `updatedAt` timestamps across localStorage and DB payloads, added `inFlightSubmissionSaves` token protection and per-chunk pending/synced/failed outbox tracking, and deferred `submissions_updated` event dispatch until `finally`.
  - Batched multi-submission auto-grading and deterministic re-grade writes in [`QuizResultsModal.tsx`](src/components/QuizResultsModal.tsx) (uploading only `changed === true` submissions), and added [`supabase/migrations/040_quiz_submissions_timeout_and_index_cleanup.sql`](supabase/migrations/040_quiz_submissions_timeout_and_index_cleanup.sql) to drop 3 unused `quiz_submissions` indexes.

### [v.2.7.4] — Multi-Image Questions, MC Option Diagrams, Civics (PKn) Subject & Semester Day Exam Time Column
- **Multi-Image Questions & Per-Option Multiple Choice Diagrams:**
  - Extended [`database.ts`](src/types/database.ts), [`questionDiagramUtils.ts`](src/utils/questionDiagramUtils.ts), [`questionBankService.ts`](src/services/questionBankService.ts), and [`pdfProcessor.ts`](src/lib/pdfProcessor.ts) with `diagram_urls` and `option_diagrams` support using backward-compatible plain URL storage for single-image stems and compact JSON envelope packing in `questions.diagram_url` so multi-figure stems and visual MC options survive student RPC `mark_scheme` stripping (`sanitize_question_json_for_student`) with zero SQL migrations.
  - Upgraded [`QuestionEditorModal.tsx`](src/components/QuestionEditorModal.tsx) and [`ExtractionReview.tsx`](src/components/ExtractionReview.tsx) with multi-image stem/sub-question galleries (multi-file upload, PDF/image cropping, clipboard paste, reordering, URL slots) and per-option MC diagram upload/crop/URL/preview controls that preserve image-only MC choices on save.
  - Updated [`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx) (stacked stem/sub-question visuals, responsive `.sq-choices-list--visual-grid` cards with dedicated `🔍` zoom buttons, quick-choice thumbnails, and post-submit visual review), [`deterministicGradingService.ts`](src/services/deterministicGradingService.ts) / [`quizSubmissionService.ts`](src/services/quizSubmissionService.ts) (image-only MC grading & formatting), [`QuestionCard.tsx`](src/components/QuestionCard.tsx), [`QuestionDetailModal.tsx`](src/components/QuestionDetailModal.tsx), [`pdfExportService.ts`](src/services/pdfExportService.ts), [`docxExportService.ts`](src/services/docxExportService.ts), [`htmlQuizExportService.ts`](src/services/htmlQuizExportService.ts), [`backupService.ts`](src/services/backupService.ts), and [`restoreService.ts`](src/services/restoreService.ts).
  - Added automated regression tests in [`scripts/test-multi-image-questions.mjs`](scripts/test-multi-image-questions.mjs) (`npm run test:multi-image`).
- **Indonesian Civics (`Civics (PKn)`) Subject Support:**
  - Added full `Civics (PKn)` / `PPKn` / `Pendidikan Pancasila dan Kewarganegaraan` classification, catalog metadata (`PKN / NAT-ID`), Civic Shield SVG icon, default subject preset, and teacher profile chip/modal support across [`subjectClassifier.ts`](src/lib/subjectClassifier.ts), [`subjectCatalog.ts`](src/utils/subjectCatalog.ts), [`subjectMeta.tsx`](src/utils/subjectMeta.tsx), [`settings.ts`](src/lib/settings.ts), [`TeacherProfileModal.tsx`](src/components/TeacherProfileModal.tsx), [`TeacherProfileChip.tsx`](src/components/TeacherProfileChip.tsx), and [`scripts/test-languages-and-bidi.mjs`](scripts/test-languages-and-bidi.mjs).
- **Semester Exam Day Organizer Exam Time Column & Wider Layout:**
  - Added `resolveQuizExamTimeInfo` and per-day `scheduleSessions` in [`semesterDayOrganizer.ts`](src/lib/semesterDayOrganizer.ts), widened [`SemesterDayOrganizerModal.css`](src/components/SemesterDayOrganizerModal.css) (`1280px`), and added the **Exam Time** column in [`SemesterDayOrganizerModal.tsx`](src/components/SemesterDayOrganizerModal.tsx) showing exam windows, durations, and matching timetable hints.

### [v.2.7.3] — Animated Student Exam-Entry Loader, Lotus Orbital Emblem & Locked Tool Tooltip Cleanup
- **Animated Exam Join & Fetch Loading Flow:**
  - Added `@keyframes spin`, `@keyframes sqSpin`, `@keyframes sqLoaderPulse`, and `@keyframes sqIndeterminateBar` directly inside [`StudentQuizRunner.css`](src/pages/StudentQuizRunner.css) so student entry and grading spinners animate reliably without depending on teacher-only stylesheets.
  - Upgraded [`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx) with `.sq-loading-card` featuring the ICM lotus flower emblem (`/favicon.svg` with `DEFAULT_SCHOOL_LOGO` fallback), orbital ring animation, exam code pill, indeterminate shimmer progress bar, live 2-stage transitions (**Securing connection** → **Fetching paper**), and a 12-second slow-network notice with a **← Back to Portal** escape button.
  - Added `isJoining` state and `.portal-btn-spinner` (`"Joining…"`) to [`PortalLandingPage.tsx`](src/pages/PortalLandingPage.tsx) and [`PortalLandingPage.css`](src/pages/PortalLandingPage.css) so clicking **Start Exam** gives immediate visual feedback during Turnstile verification and prevents duplicate submits.
- **Exam Tool Close-Button Tooltip Cleanup:**
  - Removed misleading `(Esc)` shortcut hints from the close-button tooltips in [`PeriodicTableDrawer.tsx`](src/components/PeriodicTableDrawer.tsx) and [`ExamAttachmentModal.tsx`](src/components/ExamAttachmentModal.tsx) so candidates aren't prompted to press `Esc` in browsers where hardware keyboard lock is unsupported.

### [v.2.7.2] — Fisika Subject Support, KaTeX Text-Mode Degree Fix, Exam Config Combobox & Semester Organizer Polish
- **Indonesian Subject Support (`Fisika`), Arabic MCQ Reconciliation & Extraction Review Edit Sync:**
  - Added full **Fisika** (`FIS` / `FIS / NAT-ID`) subject support across [`subjectClassifier.ts`](src/lib/subjectClassifier.ts), [`subjectCatalog.ts`](src/utils/subjectCatalog.ts), [`subjectMeta.tsx`](src/utils/subjectMeta.tsx), [`questionDomainDetector.ts`](src/utils/questionDomainDetector.ts), [`settings.ts`](src/lib/settings.ts), [`TeacherProfileModal.tsx`](src/components/TeacherProfileModal.tsx), and [`TeacherProfileChip.tsx`](src/components/TeacherProfileChip.tsx).
  - Fixed [`ExtractionReview.tsx`](src/components/ExtractionReview.tsx) and [`UploadPage.tsx`](src/pages/UploadPage.tsx) paper metadata edit synchronization so post-extraction header/question edits persist cleanly without resetting, and included Arabic MCQ mark-scheme key reconciliation and visual PNG chunking improvements (`b448c7e`).
- **KaTeX Degree-in-`\text{...}` Parsing Fix:**
  - Extracted shared [`src/lib/latexUtils.ts`](src/lib/latexUtils.ts) (`normalizeLatexString`) wired through [`ExamMathText.tsx`](src/components/ExamMathText.tsx) and [`pdfExportService.ts`](src/services/pdfExportService.ts) so degree symbols inside `\text{...}` / `\mbox{...}` (such as `$1\text{ kal/g°C}$`) stay literal `°C` / `°F` / `°` in text mode instead of emitting `^\circ` parse errors in KaTeX.
- **Quiz Manager Exam Configuration Modal & Semester Day Organizer Fixes:**
  - Redesigned the Configure Exam Settings modal in [`QuizManagerPage.tsx`](src/pages/QuizManagerPage.tsx) and [`QuizManagerPage.css`](src/pages/QuizManagerPage.css) with compact spacing, a sticky save footer, default-open Target Classes & Session Schedule sections, and searchable/subject-filtered [`SourceTestCombobox.tsx`](src/components/SourceTestCombobox.tsx) + [`sourceTestPickerUtils.ts`](src/lib/sourceTestPickerUtils.ts).
  - Fixed [`SemesterDayOrganizerModal.tsx`](src/components/SemesterDayOrganizerModal.tsx) so bulk **▶ Activate & Warm** activates selected exams in place without altering `examDay`, and fixed the `hasInitializedBulkTarget` guard so **Move to Day** cleanly supports moving exams back to **Unscheduled**.
- **Live 180-Student Multi-Exam Stress Test & Verification:**
  - Upgraded [`scripts/stress-test-realistic-exam-sitting.mjs`](scripts/stress-test-realistic-exam-sitting.mjs) with a default Safe Mode delete gate (`--approve-delete=true`) and debounced `QuizResultsModal` realtime watcher parity, passing **7/7 SLOs** (`0` errors across `2,466` requests, `180/180` first-try submissions, `p95=193 ms`) across active `ICM-1`..`ICM-13` ([`Plan/realistic_stress_test_report.md`](Plan/realistic_stress_test_report.md)).

### [v.2.7.1] — Visual Arabic PDF Extraction, CMap Corruption Bypass & PAI/Arabic Auto-Detection
- **Lossless High-DPI Visual Page Routing for Arabic-Containing PDFs:**
  - Added [`detectArabicPagesInPdf`](src/lib/pdfChunker.ts) and [`renderPdfPagesToImages`](src/lib/pdfChunker.ts) (`2.8x` lossless PNG) and wired them through [`pdfProcessor.ts`](src/lib/pdfProcessor.ts) and [`buildGeminiMultimodalParts`](src/lib/gemini.ts) so chunks containing Arabic bypass corrupted PDF `ToUnicode` CMaps (which drop hamza letters such as `أ` in `الْأَ` / `الْأَلْبَابِ` or scramble ligatures across lines) while keeping 4-page chunk bounds.
- **Shared Arabic Script Normalization, Extraction Prompt Rules & Auto-Detection:**
  - Created [`src/lib/arabicTextUtils.ts`](src/lib/arabicTextUtils.ts) with selective Arabic Presentation Form normalization (`U+FB50–U+FEFF` → canonical `U+0600–U+06FF` without mutating math superscripts), stray BiDi control stripping, detached harakat reattachment (`خَلْق ِ` → `خَلْقِ`), and unified visual Arabic / inline tajwid snippet rules injected across STEM, Humanities, and Languages prompts (`gemini.ts`, `humanitiesPrompt.ts`) as well as defense-in-depth rendering in [`ExamMathText.tsx`](src/components/ExamMathText.tsx).
  - Updated [`subjectClassifier.ts`](src/lib/subjectClassifier.ts) to auto-detect `PAI` (`Pendidikan Agama Islam`, `Al-Qur'an Hadis`, `Fiqih`, `Aqidah Akhlak`, `SKI`) and `Bahasa Arab` (`BAR`) papers as non-Cambridge exams.

### [v.2.7.0] — Official Mark Scheme Strictness, Languages & Mixed-Script BiDi Extraction, Passage Tag Stitching, Edit Persistence & Teacher Test Account (`039`)
- **Official Mark Scheme Strictness, Vision-Aware Generation & QA Audit:**
  - Added strict verbatim official mark scheme fidelity prompts (`src/lib/markSchemePrompt.ts`), labeled QP/Insert/Official MS multimodal parts in `buildGeminiMultimodalParts`, and threaded `hasMarkScheme` across all extraction pipelines (`gemini.ts`, `humanitiesPrompt.ts`, `ieltsPrompt.ts`, `practicalPrompt.ts`).
  - Added `src/lib/markSchemeAudit.ts` (`auditQuestionMarkScheme`, `auditExtractionMarkSchemes`, `chooseBetterMarkScheme`, `chooseBetterSubMarkScheme`) to detect mark/option mismatches deterministically, rank stronger cross-chunk MS matches in `pdfProcessor.ts`, and surface inline QA alerts and bulk audit filters in `ExtractionReview`, `QuestionEditorModal`, and `QuestionDetailModal`.
  - Upgraded `generateQuestionMarkScheme` and `enrichQuestionWithGuidance` with dual-mode **Official MS Verification / Sync** vs. **AI Mark Scheme Generation** backed by question diagram/SVG visual context, plus guarded `part-label` preamble trimming and standalone answer-key chunk boundaries (`markSchemeDetect.ts`, `pdfChunker.ts`).
- **Languages Extraction, Bahasa Indonesia Auto-Detect & Mixed Arabic/Indonesian BiDi Rendering:**
  - Extended `subjectClassifier.ts` and `PdfUpload.tsx` to auto-detect `Bahasa Indonesia` (`BI`) papers as non-Cambridge (`isIgcse = false`), tightened chunk budgets for dense reading exams, and added `src/lib/passageMerge.ts` (`mergeChunkPassagesAndQuestions`) so cross-chunk `"Text 1"` / `"Teks 1"` passage keys never collide.
  - Upgraded `getLanguageExtractionPrompt` with range-scoped passage IDs, full question-number coverage (including 40+ item exams), infographic stimulus transcription rules, and verbatim Arabic/harakat preservation.
  - Fixed mixed Arabic + Latin/Indonesian BiDi layout in `ExamMathText.tsx`, `deterministicGradingService.ts` (`hasArabicCharacters`, `isDominantlyArabicText`), and `StudentQuizRunner.tsx` using dominant-script direction detection and inline `<bdi dir="rtl" lang="ar">` isolation.
- **Explicit `[passage]...[/passage]` Stitching During PDF Extraction:**
  - Updated `stitchPassagesToQuestions` (`src/lib/passageExtractor.ts`), `propagateReadingPassages` (`src/lib/readingPassageUtils.ts`), and `pdfProcessor.ts` to emit and preserve `[passage]...[/passage]` tags idempotently for extracted reading passages (including Indonesian `Teks` stimuli), with `[no_passage]` suppression respected if a teacher removes a passage during review.
- **Extraction Review Edit Persistence Across Save & Page Refresh:**
  - Synchronized inline edits, tag updates, split sub-question diagram migrations, and diagram deletions from `ExtractionReview` back into `UploadPage` state and debounced `IndexedDB` draft storage (`uploadDraftStorage.ts`, including `msBase64` restoration) with `pagehide` / `visibilitychange` flush before reload.
  - Added `filterActiveDiagramDataForSave` in `pdfProcessor.ts` so Question Bank saves honor `has_diagram === false`, preserve non-`blob:` `diagram_url` edits, and persist `_svg_content` and `_ai_diagram_prompt` in `mark_scheme` JSONB.
- **Two-Zone Quiz Manager Header & Universal Teacher Test Account (`039`):**
  - Reorganized `QuizManagerPage` header into two structured zones and added migration `039_teacher_dummy_test_student.sql` (plus `verify-student-pin` edge function and `studentRosterService.ts` integration) enabling teachers to test any quiz end-to-end with the reserved `Teacher Test Account` (`PIN: 0000`) across every class without polluting rosters or printed PIN sheets.

### [v.2.6.2] — Semester Exam Day Organizer, Dedicated `Table Choice` Question Type & Submission Sync Hardening (`038`)
- **Semester Exam Day Organizer (`SemesterDayOrganizerModal`)**:
  - Added [`src/lib/semesterDayOrganizer.ts`](src/lib/semesterDayOrganizer.ts) and [`src/components/SemesterDayOrganizerModal.tsx`](src/components/SemesterDayOrganizerModal.tsx) (wired into [`QuizManagerPage.tsx`](src/pages/QuizManagerPage.tsx)) to group quizzes chronologically by exam day (explicit `examDay` or scheduled start date) with schedule presets from the imported exam timetable.
  - Added batched **Open All & Pre-Warm** and **Pause All** day actions (`activateExamDayQuizzes`, `pauseQuizzesBatch`, `assignQuizzesToExamDay`) in [`quizManagerService.ts`](src/services/quizManagerService.ts) without write storms, complete with live `90 min` warm/partial/cold indicators.
- **Dedicated `Table Choice` Question Category**:
  - Added `'Table Choice'` as a first-class `QuestionStyle` in [`src/types/database.ts`](src/types/database.ts) and shared matrix parser/serializer [`src/lib/tableChoiceUtils.ts`](src/lib/tableChoiceUtils.ts).
  - Added a visual row-by-row **Table Choice Matrix Builder** in [`QuestionEditorModal.tsx`](src/components/QuestionEditorModal.tsx) with quick presets (*Tepat / Tidak Tepat*, *Benar / Salah*, *Sesuai / Tidak Sesuai*, *Setuju / Tidak Setuju*, *Fakta / Opini*, *True / False*, *Ya / Tidak*), editable item/choice columns, radio-button answer keys, and **Sync Marks to Rows**.
  - Updated [`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx), [`deterministicGradingService.ts`](src/services/deterministicGradingService.ts), [`offlineGradingService.ts`](src/services/offlineGradingService.ts), [`pdfProcessor.ts`](src/lib/pdfProcessor.ts), [`gemini.ts`](src/lib/gemini.ts), [`ExtractionReview.tsx`](src/components/ExtractionReview.tsx), and [`QuestionFilters.tsx`](src/components/QuestionFilters.tsx) to extract `Tepat | Tidak Tepat` and `No. | Upaya | ...` tables cleanly, strip stale combo `options`, award proportional per-row partial marks, and fix affirmative/negative substring collisions (`Tidak Tepat` vs `Tepat`).
- **Production Teacher Sync & Pagination Fix (`038`)**:
  - Added [`supabase/migrations/038_fix_submission_index_grant_and_pagination.sql`](supabase/migrations/038_fix_submission_index_grant_and_pagination.sql) restoring `EXECUTE` on `normalize_roster_class_label(TEXT)` for `anon`/`authenticated` (fixing `42501` errors on direct teacher `quiz_submissions` writes) and adding `idx_quiz_submissions_submitted_at_desc`.
  - Updated [`quizSubmissionService.ts`](src/services/quizSubmissionService.ts) to paginate full `quiz_submissions` syncs in `250`-row pages with `(submitted_at DESC, id DESC)` ordering and chunk batch upserts into `100`-row batches, eliminating `57014` 3-second statement timeouts.
- **Verification**:
  - Added [`scripts/test-semester-day-organizer.mjs`](scripts/test-semester-day-organizer.mjs) (`npm run test:semester-days`, `11/11` passed) and [`scripts/test-table-choice.mjs`](scripts/test-table-choice.mjs) (`npm run test:table-choice`, `6/6` passed).
  - Verified live production `EXPLAIN (ANALYZE, BUFFERS)` pagination index scan (`0.821 ms`), cleaned `1,770` synthetic stress-test submissions (`STRESS200`, `SEC-SIM-200`), and passed `npm run test:multi-select` + `npm run build`.

### [v.2.6.1] — Admin Pre-Warm Cache, Unified Exam Entry (`037`) & 170-Student Submission Smoothing
- **90-Minute Pre-Warmed Exam Paper Cache & Atomic Start RPC (`037`)**:
  - Added [`supabase/migrations/037_admin_prewarm_and_unified_exam_entry.sql`](supabase/migrations/037_admin_prewarm_and_unified_exam_entry.sql):
    - Extended `exam_paper_cache` TTL from `5` to `90` minutes while preserving live `scheduled_start_at`/`scheduled_end_at` checks and instant trigger invalidation on edits or pauses.
    - Preserved pre-warmed cache rows during `'scheduled'` waiting-room polls (`questions: []` withheld until `NOW() >= scheduled_start_at`) so unlocking at start time serves all students straight from warm cache without a cold build stampede.
    - Added teacher-only `prewarm_exam_paper_cache(p_quiz_codes)` (gated via `is_authenticated_teacher()`, `42501`) sharing private `_compile_and_cache_exam_paper` sanitization.
    - Added `enter_student_exam_session(p_payload)` combining authoritative server `verify_student_pin` + brute-force rate limit, single-attempt check (`check_student_attempt_submitted`), `exam_draft_locks` verification/acquisition, and recoverable cloud draft fetch in one atomic round-trip.
- **Admin Pre-Warm Workflow & Student Burst Smoothing**:
  - Added **⚡ Pre-Warm Cache** (`prewarmExamPaperCache`, auto-warm on save/open/unpause) in [`QuizManagerPage.tsx`](src/pages/QuizManagerPage.tsx) and serialized `toggleQuizActiveStatus` writes (`upsertQuizCodeIndexToCloud` before `syncPublishedQuizzesToCloud`) in [`quizManagerService.ts`](src/services/quizManagerService.ts).
  - Throttled `loadAndSyncCreativeModeLandingVisibility` to a 10-minute `localStorage` cache in [`settings.ts`](src/lib/settings.ts), switched lobby draft detection to synchronous `findLocalExamDraft` and wired `enterStudentExamSession` (with pre-`037` fallback) + staggered initial draft sync in [`examDraftService.ts`](src/services/examDraftService.ts) & [`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx).
  - Widened jitter windows in [`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx) (`0–6s` boot, `1–6s` waiting-room refresh, `0–7s` manual submit, `0–15s` timer-expiry auto-submit) and set default `maxRetries = 4` with wider transient backoff (`1.8–3.2s+`) in [`quizSubmissionService.ts`](src/services/quizSubmissionService.ts).
- **Verification**:
  - Added [`scripts/test-admin-prewarm-and-entry-037.mjs`](scripts/test-admin-prewarm-and-entry-037.mjs) (`npm run test:prewarm-037`, `15/15` passed) and [`scripts/stress-test-037-live.mjs`](scripts/stress-test-037-live.mjs).
  - Verified live 170-student Migration `037` simulation against pre-warmed `ICM-1..ICM-13` (`Run ID: mwoxelw5`, [`Plan/stress_test_037_report.md`](Plan/stress_test_037_report.md)): `5/5` SLOs passed (`0` errors, `72` peak in-flight, `get_student_exam_paper` `p50=183.4ms` / `p95=616ms`, `enter_student_exam_session` `p50=220ms` / `p95=427.7ms`, `submit_student_exam_attempt` `p50=122ms` / `p95=204.5ms`, `0/22` degraded probe ticks).

### [v.2.6.0] — Multi-Exam Scale Hardening, Indexed Roster Cache & 200-Student Live Sitting Verification (`036`)
- **Indexed Roster Cache, Lobby Payload Bundling & Atomic Post-Submit Cleanup (`036`)**:
  - Added [`supabase/migrations/036_icm_multi_exam_scale_and_roster_cache.sql`](supabase/migrations/036_icm_multi_exam_scale_and_roster_cache.sql):
    - Replaced repeated `app_config('school_roster')` full JSON scans with RLS-locked, trigger-synced `school_roster_entries` and `school_roster_meta` cache tables powering indexed `get_public_roster_directory`, `verify_student_pin`, and `verify_roster_pin_if_enrolled`.
    - Replaced bare full-table cache flushes on `published_quizzes` updates with selective diff invalidation, bypassed `pg_advisory_xact_lock` for non-active papers, dropped redundant `idx_quiz_submissions_attempt_class_lookup`, and guarded `clear_rate_limit` with a read-only `IF EXISTS` probe.
    - Bundled `publicRosterDirectory`, `schoolClasses`, `securityTiers`, and `hideEmergencyExamButton` directly into `get_student_exam_paper`, and upgraded `submit_student_exam_attempt` to look up quiz metadata from `exam_paper_cache` and delete the student's cloud draft and lock inline in the same transaction.
- **Student Boot, Autosave & Teacher Dashboard Storm Elimination**:
  - Gated `TeacherProfileProvider` ([`App.tsx`](src/App.tsx)) and student boot settings ([`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx), [`quizCodeService.ts`](src/services/quizCodeService.ts), [`settings.ts`](src/lib/settings.ts), [`studentRosterService.ts`](src/services/studentRosterService.ts)) behind `hasActiveTeacherSession()` with 5-minute in-memory caching and `0..3,400ms` boot smoothing jitter; added `12–18s` cloud draft debounce jitter, `0..4,500ms` upload smoothing jitter, `{ localOnly: true }` post-submit `clearExamDraft()` ([`examDraftService.ts`](src/services/examDraftService.ts)), and backoff enforcement on `keepalive` draft saves.
  - Added `{ localOnly: true }` audit mirroring and staggered `exam_paper_cache` pre-warming on cockpit mount (`4m` refresh) in [`LiveInvigilatorModal.tsx`](src/components/LiveInvigilatorModal.tsx), `2,500ms` `postgres_changes` debouncing in [`QuizResultsModal.tsx`](src/components/QuizResultsModal.tsx), surgical `upsert` diffing in [`quizSubmissionService.ts`](src/services/quizSubmissionService.ts), and fresh-browser protection in [`quizManagerService.ts`](src/services/quizManagerService.ts).
- **Full-Fidelity 200-Student / 13-Exam Stress Harness & Verification**:
  - Added [`scripts/stress-test-realistic-exam-sitting.mjs`](scripts/stress-test-realistic-exam-sitting.mjs) (`npm run test:stress-realistic`) and [`scripts/test-icm-multi-exam-scale-036.mjs`](scripts/test-icm-multi-exam-scale-036.mjs) (`npm run test:multi-exam-scale`).
  - Verified live 200-student + 5-proctor simulation (`Run ID: mwoo886j`) passing all 6 SLOs (`0` HTTP errors, `200/200` 1st-try submissions, `get_student_exam_paper` `p95 = 393.2ms`, `submit_student_exam_attempt` `p95 = 406.1ms`, `0/24` degraded health ticks) alongside `npm run test:scale-170` (`18/18`), `npm run test:multi-exam-scale` (`10/10`), and `npm run build`.

### [v.2.5.9] — Simulation Part 2 Saved Test, Published Exam Scaling & Same-Browser Link Resolution (`035`)
- **Published Exam Save Scaling & `pg_safeupdate` Fix (`035`)**:
  - Added [`supabase/migrations/035_fix_exam_paper_cache_safeupdate.sql`](supabase/migrations/035_fix_exam_paper_cache_safeupdate.sql) and patched [`032_exam_paper_cache_and_fast_lobby.sql`](supabase/migrations/032_exam_paper_cache_and_fast_lobby.sql) to qualify `DELETE FROM public.exam_paper_cache` with `WHERE quiz_code IS NOT NULL`, unblocking `published_quizzes`, `custom_test_header_*`, `custom_tests`, and `questions` writes under Supabase `pg_safeupdate`.
  - Added missing-only per-row `ensureCloudTestHeadersExist()` backfill in [`testBuilderService.ts`](src/services/testBuilderService.ts) and stripped redundant `questionOverrides` from backed `published_quizzes` and `quiz_by_code_*` entries in [`quizManagerService.ts`](src/services/quizManagerService.ts), with `reconstructPublishedQuizzesFromCodeIndex()` self-healing recovery, `enqueueQuizMutation()` serialization, `QuotaExceededError`-safe `localStorage` caching, and `isSavingConfig` / exact error surfacing in [`QuizManagerPage.tsx`](src/pages/QuizManagerPage.tsx).
- **Same-Browser New Tab Quiz Link Resolution**:
  - Updated `resolveStudentQuizUncached()` in [`quizCodeService.ts`](src/services/quizCodeService.ts) to call `get_student_exam_paper` RPC even when `localStorage` already has a slimmed quiz snapshot, with `getLocalTests()` offline fallback so new non-teacher tabs resolve all questions cleanly.
- **12-Question Saved Test Variant**:
  - Added **"ICM Exam Simulation Part 2"** (`pilot-sim-part2-12q`, `30` minutes, `30` marks) in [`pilotExamPart2Data.ts`](src/data/pilotExamPart2Data.ts) with dynamic `"0L1 my room"` Audio Library binding and verified via [`scripts/test-pilot-sim-part2.mjs`](scripts/test-pilot-sim-part2.mjs) and [`scripts/test-published-quiz-save-scale.mjs`](scripts/test-published-quiz-save-scale.mjs).

### [v.2.5.8] — Atomic Draft-Lock Upsert, Normalized Submission Index & Student Join PIN Rate-Limit Hardening (`034`)
- **Database Scale & Security Hardening (`034`)**:
  - Added [`supabase/migrations/034_atomic_draft_lock_index_and_pin_ratelimit.sql`](supabase/migrations/034_atomic_draft_lock_index_and_pin_ratelimit.sql):
    - Added expression index `idx_quiz_submissions_code_norm_name_class` (matching `REGEXP_REPLACE` normalized `student_name` and `normalize_roster_class_label(student_class)`) + `ANALYZE public.quiz_submissions`.
    - Fixed simultaneous first-write `exam_draft_locks` contention inside `save_student_exam_draft` using an atomic conditional `ON CONFLICT (draft_key) DO UPDATE ... WHERE ... RETURNING TRUE INTO v_lock_acquired`.
    - Re-applied `normalize_roster_class_label`-normalized rate-limit scoping in `verify_student_pin` so mixed class notations (e.g. `'X IPA 3'` vs `'10-IPA-03'`) share one brute-force lockout bucket.
- **200-Student Stress Test & Student Join PIN Suite**:
  - Upgraded [`scripts/simulate-200-students-stress-and-redteam.mjs`](scripts/simulate-200-students-stress-and-redteam.mjs) with Wave 1B Student Join PIN burst (`200/200` `get_public_roster_directory` + `verify_student_pin`), exact & mixed-class brute-force lockout verification (`JOIN-PIN-GUARD`), homonym isolation, blank- vs 6-digit `result_pin` duplicate races, and expanded RLS scraping (`published_quizzes`, `exam_paper_cache`, `exam_draft_locks`, `teacher_auth_sessions`, `security_rate_limits`).
  - Added [`scripts/test-migration-034.mjs`](scripts/test-migration-034.mjs) and verified `11/11` security/functional probes in [`Plan/student_200_stress_test_report.md`](Plan/student_200_stress_test_report.md) (`mwniyqcp`).

### [v.2.5.7] — 200-Student Scale Hardening, Class-Scoped Identity, Re-Sync Recovery & Student PIN `.docx` Export (`031`–`033`)
- **Class-Scoped Homonym Identity & Database Scale Hardening (`031`–`032`)**:
  - Isolated non-PIN draft lock keys (`__cls_<class>`), offline receipts (`DeviceExamReceipt.studentClass`), shared-device session resets (`normalizeClassIdentityPart`), and `submit_student_exam_attempt` / `check_student_attempt_submitted` duplicate checks across classes (`"X IPA 1"` vs `"X IPA 2"`, normalizing spacing variants like `"X IPA3"`).
  - Reduced Postgres draft write amplification by ~85–90% via `computeCloudDraftFingerprint` dirty-checking, removing `currentIndex` navigation from cloud debounces, relaxing edit debounce to `12s` and periodic sync to `90–110s` jittered, skipping redundant `exam_draft_locks` writes within 10 minutes, setting `fillfactor = 70` on `app_config` / `exam_draft_locks`, throttling duplicate student audit DB inserts to `3s`, adding `idx_proctor_audit_guard_lookup`, blocking RLS-failed table fallbacks on `544`/timeout with per-key backoff, and spreading timer-expiry auto-submits across `0–6s` jitter.
  - Added RLS-locked `exam_paper_cache` with trigger-based invalidation, live `scheduledStartAt`/`scheduledEndAt` schedule window re-evaluation, and per-code `pg_advisory_xact_lock` in [`032_exam_paper_cache_and_fast_lobby.sql`](supabase/migrations/032_exam_paper_cache_and_fast_lobby.sql) plus 2-attempt `12s` retry logic in [`quizCodeService.ts`](src/services/quizCodeService.ts), raising Wave 1 live 200-student exam load throughput from `178/200` (`34.2s`) to `200/200` (`2.67s`).
- **Post-Submission Re-Sync, Offline Reload & Teacher PIN Parity (`033`)**:
  - Added `verifyTeacherUnlockPinDetailed` in [`quizCodeService.ts`](src/services/quizCodeService.ts) to distinguish unreachable servers (`544`/offline) from genuine wrong Teacher PINs, backed by [`033_resync_pin_verification_parity.sql`](supabase/migrations/033_resync_pin_verification_parity.sql).
  - Preserved optional `resultPin` (`createPostSubmitResultPin()`) and `forensics.studentPin` in emergency fallback & Practice Mode submissions in [`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx), exposed Pending Cloud Upload retry/backup controls in Practice Mode and offline browser reloads, fixed stuck modal spinners, and upgraded [`flushSubmissionOutbox`](src/services/quizSubmissionService.ts) & [`PortalLandingPage.tsx`](src/pages/PortalLandingPage.tsx) to surface real errors and clear synced session/draft residue.
- **Printable Student Name & PIN `.docx` Export**:
  - Added [`rosterPinDocxService.ts`](src/services/rosterPinDocxService.ts) (`prepareRosterForPinExport`, `exportRosterPinSheetDocx`) and wired **`📄 Export PINs (.docx)`** into [`AdvancedSettingsPage.tsx`](src/pages/AdvancedSettingsPage.tsx) and [`CandidateCardPrintModal.tsx`](src/components/CandidateCardPrintModal.tsx) (auto-assigns missing unique 4-digit PINs, outputs per-class A4 Proctor Master Tables followed by `3×6` dashed Cut-Out Student PIN Slips).
- **Variant Image Grounding & Older Mac Trackpad/Scroll Shield**:
  - Added Gemini Vision multimodal image grounding (`imageUrl` / inline base64), shared-passage Set Variant support, and override pruning across [`variantClassification.ts`](src/utils/variantClassification.ts), [`gemini.ts`](src/lib/gemini.ts), [`examVariantService.ts`](src/services/examVariantService.ts), [`QuestionVariantModal.tsx`](src/components/QuestionVariantModal.tsx), [`ExamVariantModal.tsx`](src/components/ExamVariantModal.tsx), and [`SavedTestsPage.tsx`](src/pages/SavedTestsPage.tsx).
  - Refined diagonal trackpad wheel/touch handling and Split/Stacked View scroll containment in [`examGestureGuard.ts`](src/lib/examGestureGuard.ts), [`StudentQuizRunner.css`](src/pages/StudentQuizRunner.css), and [`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx).
- **Verification**:
  - Verified with `npm run test:roster-pin-docx`, `npm run test:resync`, `npm run test:scale-170`, `npm run test:optional-result-pin`, `npm run test:exam-schedule`, `npm run test:multi-select`, `npm run test:backup-restore`, `npm run test:variants`, `npm run test:gestures`, `npm run test:student-pin`, `npm run test:phase1-security`, `npm run test:phase2-security`, `npm run test:phase25-security`, `npm run test:phase3a-security`, `npm run test:phase3b-security`, and `npm run build`.

### [v.2.5.6] — Exam Session Scheduling (`027`), Incremental PC Folder Backup (`028`), Strict Multi-Select & Proctor Fixes
- **Scheduled Exam Session Windows (`027`) & Publish Exam Redesign**:
  - Added [`src/lib/examSessionSchedule.ts`](src/lib/examSessionSchedule.ts) and [`supabase/migrations/027_exam_session_scheduling.sql`](supabase/migrations/027_exam_session_scheduling.sql) supporting `Scheduled`, `Active`, `Closed`, and `Paused` exam states gated server-side in `get_student_exam_paper` / `submit_student_exam_attempt`.
  - Updated [`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx) with a synchronized pre-exam Waiting Room countdown and post-close lockout view, and redesigned [`QuizManagerPage.tsx`](src/pages/QuizManagerPage.tsx) / [`QuizManagerPage.css`](src/pages/QuizManagerPage.css) with schedule pickers, **Open Now**, clean List View action layout (eliminating hover overlap), and aligned Card View schedule chips.
- **Proctor Dashboard Progress & Live Position Fixes**:
  - Added `hasNonEmptyProctorAnswer`, `computeSubmissionProgress`, and `clampProgressPercent` in [`src/lib/proctorGuards.ts`](src/lib/proctorGuards.ts) so submitted hydration in [`LiveInvigilatorModal.tsx`](src/components/LiveInvigilatorModal.tsx) flattens `subQuestionResults`, ignores unanswered blanks, clamps progress bars to `[0, 100]%`, and displays live `· Q#` question positions without extra WebSocket traffic.
- **Strict All-or-Nothing Multiple Select Grading**:
  - Updated `gradeDeterministicAnswer` in [`deterministicGradingService.ts`](src/services/deterministicGradingService.ts) to award full marks only on an exact selection match (`0` otherwise), and routed Excel imports in [`offlineGradingService.ts`](src/services/offlineGradingService.ts) through the same strict multi-select evaluator.
- **Incremental PC Folder Backup, Database-Only Snapshots & Full Restore Upgrade (`028`)**:
  - Added [`src/services/localBackupFolderService.ts`](src/services/localBackupFolderService.ts) (`showDirectoryPicker` + `IndexedDB` folder handle persistence) to write fresh `data/*.json` snapshots and download **only** new/missing diagrams, audio, and PDFs already absent from your PC folder.
  - Upgraded [`backupService.ts`](src/services/backupService.ts), [`restoreService.ts`](src/services/restoreService.ts), and [`BackupRestoreModal.tsx`](src/components/BackupRestoreModal.tsx) (`v1.1` manifest, fail-loud core DB reads, `42501` optional table skip with visible error/warning banners, PDF/resource URL backup & cross-project `published_quizzes` rewriting, **Database-Only (.zip)** mode, `STORE` media compression, full Clean Replace preserving the active educator session, complete `localStorage` cache sync, and [`028_game_profiles_anon_grant.sql`](supabase/migrations/028_game_profiles_anon_grant.sql)).
- **Verification**:
  - Added `npm run test:exam-schedule` (11/11), `npm run test:multi-select`, and `npm run test:backup-restore` (7/7), updated `scripts/test-proctor-p1-p2-p3.mjs` (64/64), ran `npm run test:proctor-alerts` (15/15), and verified `npm run build`.

### [v.2.5.5] — Mid-Run Audio Resume Fix Under 1x Playback Limits
- **Resumable 1x Audio Playback (`ExamAudioPlayer`)**:
  - Added [`src/utils/audioPlaybackUtils.ts`](src/utils/audioPlaybackUtils.ts) (`getAudioLimitStatus`, `shouldConsumePlayCount`, `isMidAudioRun`) and updated [`ExamAudioPlayer.tsx`](src/components/ExamAudioPlayer.tsx) so pausing mid-track under a `1x` (or final) play limit allows resuming the current run until the track finishes (`onEnded`), instead of locking the button immediately upon pause.
  - Prevented double-counting plays when resuming at `< 1s` or restoring a mid-track session (`initialCurrentTime > 0 && initialPlayedCount > 0`), and aligned both compact and full player limit badges (`Paused Mid-Play (Resume Allowed)`, `Final Play Active`, `Limit Reached (0 plays left)`).
- **Verification**:
  - Added [`scripts/test-audio-playback-limit.mjs`](scripts/test-audio-playback-limit.mjs) (`npm run test:audio-limit`) and verified alongside `npm run test:domain-helper`, `npm run test:inline-gaps`, and `npm run build`.

### [v.2.5.4] — Printable A4 Candidate Cards, Personal Exam PIN Hardening & Admin Educator Provisioning (`025`–`026`)
- **Printable 2×3 A4 Duplex Candidate Cards & ICM Workbook Importer**:
  - Added [`candidateCardPrintService.ts`](src/services/candidateCardPrintService.ts), [`CandidateCardPrintModal.tsx`](src/components/CandidateCardPrintModal.tsx), and [`examSchedule.ts`](src/lib/examSchedule.ts) / [`examScheduleService.ts`](src/services/examScheduleService.ts) to import multi-sheet ICM class/room/schedule Excel workbooks, preserve existing 4-digit PINs while normalizing class labels (`X IPA3` -> `X IPA 3`, adding `X IPS 2`) and pruning inactive entries, and render ink-saving A4 front + long/short-edge mirrored reverse timetable **Candidate Cards** with ICM & Cambridge logos and `Room N - Akhwat/Ikhwan` seating.
- **Personal Exam PIN Hardening (`025`)**:
  - Exposed the **Require Personal Candidate PIN** per-exam toggle in [`QuizManagerPage.tsx`](src/pages/QuizManagerPage.tsx) and school-wide default in [`AdvancedSettingsPage.tsx`](src/pages/AdvancedSettingsPage.tsx) / [`settings.ts`](src/lib/settings.ts).
  - Enforced global uniqueness across school 4-digit PINs in [`studentRosterService.ts`](src/services/studentRosterService.ts), isolated drafts with composite `name__pin` owner keys in [`examDraftService.ts`](src/services/examDraftService.ts) and [`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx), improved mid-string masked PIN editing in [`examSecurityUtils.ts`](src/utils/examSecurityUtils.ts), normalized class spacing across [`verify-student-pin`](supabase/functions/verify-student-pin/index.ts), and hardened strict server-side PIN enforcement in [`025_personal_exam_pin_hardening.sql`](supabase/migrations/025_personal_exam_pin_hardening.sql).
- **Centralized Admin Educator Accounts & Password Lifecycle (`026`)**:
  - Added the **Educator Accounts** tab in [`AdvancedSettingsPage.tsx`](src/pages/AdvancedSettingsPage.tsx) for provisioning Teacher/Admin accounts with temporary passwords, one-step **`Register / Edit`** upgrades for legacy passwordless profiles, inline credential copy banners, password resets, and account suspension/deletion.
  - Added forced first-login password setup (`must_change_password`) in [`PinGate.tsx`](src/components/PinGate.tsx) and self-service **Change Login Password** in [`TeacherProfileSettingsModal.tsx`](src/components/TeacherProfileSettingsModal.tsx), backed by [`026_admin_teacher_account_management.sql`](supabase/migrations/026_admin_teacher_account_management.sql) and Migration-021 direct-table fallbacks in [`teacherProfileService.ts`](src/services/teacherProfileService.ts).
- **Verification**:
  - Added `npm run test:desk-cards` (17/17), `npm run test:student-pin` (12/12), and `npm run test:teacher-accounts` (16/16), alongside existing security suites and `npm run build`.

### [v.2.5.3] — Topic Mastery Reports, Batch Excel ZIP Exports & School-Wide Live Proctor Redesign
- **Topic Mastery & Diagnostic Excel Reporting**: Added [`topicMastery.ts`](src/lib/topicMastery.ts), admin mastery-band configuration in [`AdvancedSettingsPage.tsx`](src/pages/AdvancedSettingsPage.tsx), and batch ZIP report generation in [`icmExcelExportService.ts`](src/services/icmExcelExportService.ts) (`npm run test:topic-mastery`).
- **Dual-Logo Exam Masthead & Passage Editor Formatting**: Upgraded [`TestHeaderEditor.tsx`](src/components/TestHeaderEditor.tsx), [`docxExportService.ts`](src/services/docxExportService.ts), [`pdfExportService.ts`](src/services/pdfExportService.ts), [`readingPassageUtils.ts`](src/lib/readingPassageUtils.ts), and [`QuestionEditorModal.tsx`](src/components/QuestionEditorModal.tsx).
- **School-Wide Live Invigilator Redesign**: Overhauled [`LiveInvigilatorModal.tsx`](src/components/LiveInvigilatorModal.tsx) and [`proctorAlertEngine.ts`](src/lib/proctorAlertEngine.ts) for responsive multi-class monitoring and actionable alert workflows (`npm run test:proctor-alerts`).

### [v.2.5.2] — Mini-IELTS / CEFR Framework, Mixed-Domain Math Helper & Inline Gap Flow Fix
- **Mini-IELTS / CEFR Integrated Assessment Option (`Languages` Domain)**:
  - Added the `isIeltsCefr` extraction toggle across [`subjectClassifier.ts`](src/lib/subjectClassifier.ts), [`PdfUpload.tsx`](src/components/PdfUpload.tsx), [`UploadPage.tsx`](src/pages/UploadPage.tsx), [`gemini.ts`](src/lib/gemini.ts), [`pdfChunker.ts`](src/lib/pdfChunker.ts), [`pdfProcessor.ts`](src/lib/pdfProcessor.ts), and [`passageExtractor.ts`](src/lib/passageExtractor.ts), backed by dedicated skill extraction rules in [`src/lib/ieltsPrompt.ts`](src/lib/ieltsPrompt.ts) (`L1`/`R1`/`W1` skill namespacing and passage propagation).
  - Enhanced [`BatchAudioModal.tsx`](src/components/BatchAudioModal.tsx) with auto-grouping for Listening questions, and upgraded [`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx) & [`StudentQuizRunner.css`](src/pages/StudentQuizRunner.css) with Reading split-view passage layout and Writing word-target tracking.
  - Added `/` alternative grading support in [`deterministicGradingService.ts`](src/services/deterministicGradingService.ts), 0.5-band / CEFR mapping in [`src/utils/ieltsScoringUtils.ts`](src/utils/ieltsScoringUtils.ts), CEFR rubric prompting in [`aiGradingService.ts`](src/services/aiGradingService.ts), and skill band breakdowns in [`QuizResultsModal.tsx`](src/components/QuizResultsModal.tsx) and [`StudentResultModal.tsx`](src/components/StudentResultModal.tsx).
- **Per-Question Math/Science Detection & Cursor-Aware Textbox Helpers (`Admission Tests`)**:
  - Added [`src/utils/questionDomainDetector.ts`](src/utils/questionDomainDetector.ts) (`classifyQuestionDomain`, `classifyExamFallbackDomain`, `applySymbolInsertion`) so mixed-subject exams (e.g. English + Math Admission Tests) detect domains per question/sub-part rather than locking exam-wide, and prevented English reading passages from bleeding across STEM/Math questions.
  - Added `MATH_QUICK_SYMBOLS` (subscripts `xₙ` -> `_{}`, exponents `xⁿ` -> `^{}`, fractions `\frac{}{}`, roots `\sqrt{}`, and math variables/operators `π`, `θ`, `Δ`, `±`, `×`, `÷`, `≤`, `≥`, `≠`, `≈`, `°`, `∞`), extended `CHEM_QUICK_SYMBOLS` with `xₙ`/`xⁿ`, and wired cursor-aware insertion, selection wrapping, and a compact `Σ Math` toggle pill into [`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx).
- **Inline Gap Rendering Fix & Architecture Notes**:
  - Fixed `.sq-inline-gap-container .exam-text-block { display: inline; }` in [`InlineGapText.css`](src/components/InlineGapText.css) so Fill-in-the-Blank `[1]` boxes render inline instead of forcing unwanted line breaks around inputs.
  - Documented reading passage extraction, stitching, and runtime split boundaries in [`Plan/reading_passage_detection_boundaries.md`](Plan/reading_passage_detection_boundaries.md), alongside [`Plan/english_cefr_mini_ielts_framework_plan.md`](Plan/english_cefr_mini_ielts_framework_plan.md) and [`Plan/mixed_domain_structured_math_helper_plan.md`](Plan/mixed_domain_structured_math_helper_plan.md).
- **Verification**:
  - Added [`scripts/test-question-domain-detector.mjs`](scripts/test-question-domain-detector.mjs) (`npm run test:domain-helper`) and [`scripts/test-ielts-cefr-framework.mjs`](scripts/test-ielts-cefr-framework.mjs), and verified alongside `npm run test:inline-gaps` and `npm run build`.

### [v.2.5.1] — Deep Client, Database & Live Game Security Hardening (`024`)
- **Phase 3A — Client XSS, Export, Emergency Re-Grading & Prompt-Injection Hardening**:
  - Locked KaTeX rendering (`trust: false`) in [`ExamMathText.tsx`](src/components/ExamMathText.tsx) and [`pdfExportService.ts`](src/services/pdfExportService.ts), HTML-escaped untrusted metadata across PDF reports ([`quizReportPdfService.ts`](src/services/quizReportPdfService.ts)) and Cambridge covers ([`cambridgeCoverService.ts`](src/services/cambridgeCoverService.ts)), and neutralized spreadsheet formula injection (`=`, `+`, `-`, `@`, `\t`, `\r`) via `sanitizeSpreadsheetCell` in [`icmExcelExportService.ts`](src/services/icmExcelExportService.ts).
  - Enforced encrypted `AES-256-GCM` `.exam` envelope ingestion by default and authoritative question-bank re-grading in [`quizSubmissionService.ts`](src/services/quizSubmissionService.ts), [`QuizResultsModal.tsx`](src/components/QuizResultsModal.tsx), and [`LiveInvigilatorModal.tsx`](src/components/LiveInvigilatorModal.tsx).
  - Isolated untrusted student answers inside randomized nonce delimiters and added prompt-injection flagging in [`aiGradingService.ts`](src/services/aiGradingService.ts).
- **Phase 3B — Database RLS, Rate Limiting, Draft Binding & Cryptographic Broadcasts (`024`)**:
  - Removed `teacherPinHash` from `get_student_exam_paper` (`024` & [`quizCodeService.ts`](src/services/quizCodeService.ts)) and tightened `D2` verification in [`diagnose-proctoring-system.mjs`](scripts/diagnose-proctoring-system.mjs).
  - Enabled RLS on `public.game_profiles`, stripped `pin_hash` from RPC responses, capped match rewards (`coins <= 500`, `xp <= 1000`), and migrated [`gameProfileService.ts`](src/services/gameProfileService.ts) to authenticated RPC calls (`auth_game_profile`, `update_game_profile_student`, `sync_game_match_rewards`).
  - Added `public.security_rate_limits` across auth, PIN, and result-lookup RPCs, gated `reset_teacher_password_with_master_pin`, upgraded `generateResultPin()` to 6-digit CSPRNG PINs, and enforced roster PIN + `exam_draft_locks.owner_token_hash` verification inside `submit_student_exam_attempt`.
  - Stripped game-mode answer keys from student payloads (`get_student_game_paper`, `check_game_question_answer`), signed Live Game host broadcasts with ephemeral ECDSA P-256 keys ([`gameRealtimeService.ts`](src/services/gameRealtimeService.ts), [`proctorCommandAuth.ts`](src/lib/proctorCommandAuth.ts)), and enforced first-seen SHA-256 `heartbeatKey` binding on student proctor telemetry and logs ([`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx), [`LiveInvigilatorModal.tsx`](src/components/LiveInvigilatorModal.tsx)).
- **Verification**:
  - Added [`scripts/test-phase3a-client-security.mjs`](scripts/test-phase3a-client-security.mjs) (12/12) and [`scripts/test-phase3b-deep-security.mjs`](scripts/test-phase3b-deep-security.mjs) (16/16), updated [`scripts/simulate-200-students-stress-and-redteam.mjs`](scripts/simulate-200-students-stress-and-redteam.mjs) with `draft_key`/`draft_owner_token` and live `PHASE-3B-LIVE` checks (200/200 lobby reads, 600/600 draft saves, 198/200 expected valid submissions), and verified all Phase 1–3B suites plus `npm run build`.

### [v.2.5.0] — Unified Educator Auth, Strict DB RLS, Anti-Tamper Exam RPCs & Signed Proctoring (`020`–`023`)
- **Phase 1 — Client, PDF Viewer & Export Hardening (`020`)**: Removed unauthenticated Question Bank pre-warming in [`App.tsx`](src/App.tsx), moved Master PIN verification server-side (`verify_teacher_access_pin`), replaced PDF `<iframe>` viewers with canvas `pdfjs-dist` rendering in [`ExamAttachmentModal.tsx`](src/components/ExamAttachmentModal.tsx), suppressed print views, and gated Full Script PDF downloads.
- **Phase 2 — Unified Educator Auth, Strict RLS & Exam RPCs (`021`)**: Added email/username + password authentication (`teacherProfileService.ts`), 12-hour `x-teacher-session` tokens in [`supabase.ts`](src/lib/supabase.ts), workspace RLS policies, and sanitized exam delivery/draft/submission/result RPCs.
- **Phase 2.5 — Anti-Tamper Guards & Crash-Safe Drafts (`022`)**: Added `exam_draft_locks`, 256 KB draft payload caps, Exam Mode server score zeroing, single-attempt enforcement, `beforeunload`/`pagehide`/`visibilitychange` `keepalive` exit flushes in [`StudentQuizRunner.tsx`](src/pages/StudentQuizRunner.tsx), and `proctor_audit_events` rate/size triggers.
- **Live Proctoring Hardening (`023`)**: Added WebCrypto ECDSA P-256 signed proctor commands (`proctorCommandAuth.ts`), `proctorGuards.ts`, stale-closure ref fixes, `verify_teacher_unlock_pin` parity, direct student/bulk audit persistence, and expired teacher session banners.

### [v.2.4.8] — Fillable Data Tables, Inline Term-Selection Cloze & Responsive Exam Toolbar
- Wired `ExamDataTable` and `dataTableUtils.ts` for interactive fillable tables with end-to-end storage and deterministic grading; added pipe-delimited `[opt1|opt2]` inline cloze pickers (`inlineGapParser.ts`) and two-row responsive CSS Grid header layout in `StudentQuizRunner.tsx`.

### [v.2.4.7] — Saved-Test Source of Truth, Manual Grading Persistence & Teacher Guide
- Consolidated custom test authoring around saved test records, persisted teacher manual marks/notes cleanly on re-grades, expanded Humanities Resource Booklet support, and updated integrated teacher guides.

### [v.2.3.8] — Gemini API Key Tier Selection & Deterministic Exam Grading Ingestion
- Added Cloudflare-configured Paid / Free / Auto-Failover Gemini key selection in Admin Settings, automatic deterministic Exam Mode MCQ grading upon submission receipt, and live detail pane syncing in `QuizResultsModal`.

### [v.2.3.7] — Emergency Air-Gapped Offline Fallback (`AES-256-GCM`)
- Added zero-dependency `AES-256-GCM` `.exam` packages (`examCryptoUtils.ts`) with AAD header binding, automatic download fallback after failed cloud submission retries, guarded **Emergency Save** exit flow, and teacher batch dropzone ingestion with **Newest Timestamp Wins** reconciliation.

### [v.2.3.6] — Bloom's Taxonomy Parity, Test Builder Sorting & Proctor Finalization
- Unified independent Bloom's taxonomy (C1–C6) editing, added 5 question sorting presets preserving Cambridge Section A/B order, and finalized canonical proctor candidate identities with bounded violation windows.

### [v.2.3.5] — Cambridge IGCSE Geography (`0460`) & Economics (`0455`)
- Added `0460` Geography & `0455` Economics syllabus profiles, packed sub-question outline parsing, multi-section optional-choice groups, offline retry outboxes, and persistent proctor audit events (`018`).

### [v.2.3.4] — Cambridge AS & A Level Geography (`9696`) & Multimodal Resilience
- Registered `9696` Geography profile, raised Gemini extraction timeout to 150s and `maxOutputTokens` to 32,768, and added verification benchmarks.

### [v.2.3.3] — Cambridge IGCSE Sociology (`0495`) & Safe Rubric Trimming
- Added `0495` Sociology stimulus & Level 1–4 response grid extraction, boundary-safe mark scheme trimming (`detectMarkSchemeTableStart`), and stale-chunk reload recovery.

### [v.2.3.2] — Google Forms Export & Touchscreen Security Shield
- Added direct Google Forms quiz/Apps Script export and tablet/iPad touchscreen gesture lockdown controls.

### [v.2.3.0] – [v.2.3.1] — Science Practical Papers, Cloudflare R2 & Dynamic Model Config
- Added Cambridge IGCSE Paper 5/6 Practical extraction, Cloudflare R2 resource bridging, configurable Gemini model selection, and standardized `Plan/` architecture documentation.

### [v.2.0.0] – [v.2.2.0] — Platform Redesign, Multi-Class Live Proctoring & ToS Exports
- Redesigned UI for ICM Cambridge International School, added Save My Exams pack ingestion, synthesized game audio, Bloom's & Table of Specifications (`.docx`) exports, grade threshold curves, and 300ms micro-batched multi-class proctoring.

---

<a id="license"></a>
## License

MIT License · Maintained by [fluffykitten](https://github.com/fluffykitten)
