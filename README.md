# ICM Exam Platform

**Version `2.5.1`** · Cambridge International Assessment Authoring, Proctoring & Diagnostic Suite  
Built for **Insan Cendekia Madani (ICM)** · Compatible with Web, Android, and iOS via Capacitor

[![Version](https://img.shields.io/badge/version-2.5.1-0f4c81.svg)](#changelog)
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

Run the SQL files inside `supabase/migrations/` **in numerical order (`001` through `024`)** in the **Supabase SQL Editor**:

| Migration Range | Purpose |
| :--- | :--- |
| `001` – `007` | Core schema: syllabuses, questions, custom tests, app config, options, diagrams/inserts, quiz submissions |
| `008` – `019` | Audio columns, natural sorting, student PIN verification, teacher/game profiles, Bloom's cognitive level, proctor audit log & submission RPCs |
| [`020_verify_teacher_access_pin_rpc.sql`](supabase/migrations/020_verify_teacher_access_pin_rpc.sql) | Server-side teacher Master PIN verification (`verify_teacher_access_pin`) |
| [`021_phase2_teacher_login_rls_and_exam_rpcs.sql`](supabase/migrations/021_phase2_teacher_login_rls_and_exam_rpcs.sql) | Educator auth/session tokens (`teacher_auth_sessions`), strict table RLS, and sanitized exam/draft/submission/result RPCs |
| [`022_exam_anti_tamper_and_rate_guards.sql`](supabase/migrations/022_exam_anti_tamper_and_rate_guards.sql) | `exam_draft_locks`, Exam Mode server score zeroing, single-attempt enforcement, download gating, set-based paper assembly, and audit triggers |
| [`023_proctor_security_and_pin_parity.sql`](supabase/migrations/023_proctor_security_and_pin_parity.sql) | Unlock PIN lookup parity and `proctor_channel_keys` ECDSA P-256 key registry |
| [`024_phase3_deep_rls_ratelimit_and_game_security.sql`](supabase/migrations/024_phase3_deep_rls_ratelimit_and_game_security.sql) | `teacherPinHash` removal, `game_profiles` RLS & reward caps, `security_rate_limits` lockouts, roster PIN & draft-lock submission enforcement, and `get_student_game_paper` / `check_game_question_answer` |

---

## Verification & Diagnostics

| Suite | Command | Coverage |
| :--- | :--- | :--- |
| **Phase 1 Security** | `npm run test:phase1-security` | Client bundle leaks, Master PIN RPC, PDF canvas & print guards |
| **Phase 2 Auth & RLS** | `npm run test:phase2-security` | Teacher sessions, strict RLS policies, sanitized RPC contracts |
| **Phase 2.5 Anti-Tamper** | `npm run test:phase25-security` | Draft locks, score zeroing, single-attempt enforcement, crash recovery |
| **Phase 3A Client Security** | `npm run test:phase3a-security` | XSS & KaTeX `trust: false`, CSV neutralization, `.exam` crypto/re-grading, prompt-injection isolation |
| **Phase 3B Deep Security** | `npm run test:phase3b-security` | Migration `024` contracts, `game_profiles` RLS/caps, rate limits, signed game frames, heartbeat proofs |
| **Emergency Fallback** | `npm run test:emergency` & `npm run test:emergency:sim` | `AES-256-GCM` `.exam` encryption, outbox retries, conflict resolution |
| **Proctoring Hardening** | `node --import ./scripts/register-ts.mjs scripts/test-proctor-hardening-023.mjs` | ECDSA P-256 command auth, UTF-8 byte clamping, `023` audit guards |
| **Proctoring State Machine** | `node --import ./scripts/register-ts.mjs scripts/test-proctor-p1-p2-p3.mjs` | Heartbeat throttling, command replay protection, strike/pardon guards |
| **200-Student Live Load & Red-Team** | `npm run test:stress-200` | Concurrent 200-student Supabase stress simulation & exploit probes ([latest report](Plan/student_200_stress_test_report.md)) |
| **Live Diagnostics** | `node scripts/diagnose-proctoring-system.mjs` | Live RLS, PIN parity, audit guard, and Realtime fan-out checks |

---

## Changelog

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
