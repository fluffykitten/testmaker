# 200-Student Stress Test & Vulnerability Audit Report

- **Run ID**: `mwniyqcp`
- **Target**: Live Supabase (`https://jtxmlmexvfvrkhfavwdr.supabase.co`)
- **Total Wall-Clock Runtime**: 92294.2 ms
- **Logged Events**: 1809 JSONL entries (`artifacts/stress200_events.jsonl`)
- **Zero-Residue Cleanup**: 13 draft keys deleted via RPC; 133 `STRESS200` submissions and `STRESS200` audit events remain (run with `SUPABASE_SERVICE_ROLE_KEY` or `TEACHER_SESSION_TOKEN`, or delete `quiz_code = 'STRESS200'` in Supabase SQL Editor)

---

## 1. Concurrency & Latency Telemetry Summary

| Wave / Operation | Volume | Wall Time (ms) | Success Rate | Min (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Wave 1: `get_student_exam_paper('ICM170')`** (200 concurrent) | 200 | 7046.9 | 200/200 (leaks=0) | 2040.1 | 2176.5 | 2325.4 | 2349.6 | 2360.9 |
| **Wave 1: `check_student_attempt_submitted`** (200 concurrent) | 200 | 7046.9 | 200/200 | 94.4 | 154.5 | 208.8 | 218.6 | 224.7 |
| **Wave 1B: `get_public_roster_directory`** (200 concurrent) | 200 | 4512.9 | 200/200 (leaks=0) | 301.9 | 675.4 | 901 | 978.5 | 1067.6 |
| **Wave 1B: `verify_student_pin`** (200 concurrent + lockout check) | 200 | 4512.9 | 200/200 (lockout=true) | 253.4 | 533.7 | 862.7 | 878.8 | 879.1 |
| **Wave 2: `save_student_exam_draft`** (3 rounds × 200) | 600 | 2749.5 | 600/600 (lock_race_ok=true) | 93.1 | 168.7 | 251.5 | 272.8 | 274.1 |
| **Wave 2: `get_student_exam_draft`** (30 device switches) | 30 | — | 30/30 | 102.1 | 135.7 | 150.7 | 151.1 | 151.1 |
| **Wave 2: `proctor_audit_events` inserts** (25 violators) | 114 | — | 114/114 | 95 | 120.7 | 202.6 | 292.7 | 329.2 |
| **Wave 2: `verify_teacher_unlock_pin`** (wrong PIN rejections) | 25 | — | 25/25 | 112.4 | 299.9 | 498.4 | 520.4 | 520.4 |
| **Wave 3: `submit_student_exam_attempt`** (200 concurrent) | 200 | 73395 | 131/200 (dup=10/10, blank_retry=5/5, homonyms=true) | 3756.7 | 57328.2 | 64419.1 | 64484 | 65453 |

---

## 2. Vulnerability & Red-Team Probe Findings (Wave 4 — 7404.4 ms)

| ID | Severity | Status | Summary & Observed Evidence |
| :--- | :---: | :---: | :--- |
| **BUG-01** | **CRITICAL** | MITIGATED | **save_student_exam_draft fails across all clients if app_config lacks updated_at column** — 600/600 draft saves succeeded cleanly (30/30 device-switch recoveries). |
| **VULN-H1** | **CRITICAL** | MITIGATED | **Client-trusted score, percentage & duration in submit_student_exam_attempt** — STU-191 submitted wrong answers with score=999, percentage=100; RPC returned false (note: on Migration 022, Exam Mode zeroes claimed score server-side; on 021, 999 is stored verbatim). |
| **VULN-H2a** | **HIGH** | MITIGATED | **Cross-student draft read, overwrite & delete without session ownership check** — Attacker wrong-token probes on STU-001 draft: read=null, overwrite=false, delete=false. |
| **VULN-H2b** | **MEDIUM** | MITIGATED | **Draft key prefix guard blocks config overwrite, payload cap rejects 512 KB bloat** — Config overwrites: published_quizzes=false, claiming=false; 512 KB bloat=false. |
| **VULN-H3a** | **HIGH** | MITIGATED | **Single-attempt bypass: submit_student_exam_attempt accepts a second row under a new client ID** — Re-submitting Sim Student 002 (mwniyqcp) (CAND-mwniyqcp-002) under new id=stress200-mwniyqcp-bypass-stu194 returned false. |
| **VULN-H3b** | **HIGH** | MITIGATED | **ON CONFLICT (id) rejects cross-name, cross-class, and mismatched-PIN overwrites** — Blank-PIN(STU-002) cross-name=false; 6-digit(STU-151) wrong-PIN=false; homonym cross-class=false. |
| **VULN-H4** | **MEDIUM** | MITIGATED | **Proctor audit RLS blocks invigilator role & anon reads, 32 KB log spam cap check** — actor='invigilator' HTTP 401; anon SELECT count=0; 32 KB detail spam HTTP 400. |
| **VULN-H5** | **LOW** | MITIGATED | **lookup_student_exam_result shields unreleased scores & exposes allowStudentScriptDownload cleanly** — Unreleased lookup keys=[status, submissions, hasUnreleased, allowStudentScriptDownload]; wildcard lookup status=not_found; anon app_config policy rows=0. |
| **BASELINE-RLS-AUTH** | **INFO** | VERIFIED | **Strict RLS & Account Claiming Guard Verification (Expected Blocked)** — Table scraping: [questions:200(rows=0), custom_tests:200(rows=0), teacher_profiles:200(rows=0), teacher_auth_sessions:401(blocked), syllabuses:200(rows=0), quiz_submissions:200(rows=0), exam_draft_locks:401(blocked), security_rate_limits:400(blocked), exam_paper_cache:401(blocked), published_quizzes:401(blocked), app_config_secrets:200(rows=0)]; forged header rows=0; claim disabled msg="Educator account creation and profile claiming are currently disabled by the administrator.". |
| **JOIN-PIN-GUARD** | **INFO** | VERIFIED | **Student Join PIN burst, zero roster PIN leak, brute-force lockout & submit enforcement** — directory_leaks=0/200; join_pin_burst=200/200; exact_lockout=true; mixed_class_lockout=true; enrolled_wrong_pin_submit=false. |
| **PHASE-3B-LIVE** | **INFO** | VERIFIED | **Migration 024 live controls (no teacherPinHash, game_profiles RLS, draft-lock submit guard, reset gate)** — teacherPinHashExposed=false; game_profiles=401(err); draft_lock_hijack=HTTP 401(Active exam session belongs to another device. Please submit from the active exam device or ask the teacher to unlock.); reset_gate="Master PIN password resets are disabled while account claiming is locked. Please ask an administrator to enable Account Claiming.". |

---

## 3. Verification & Migration Baseline (`022`–`033`)

If any probe shows `CONFIRMED` (or `FAILED`), confirm that migrations through [033_resync_pin_verification_parity.sql](file:///e:/VibeCoding/testmaker/supabase/migrations/033_resync_pin_verification_parity.sql) (including `029` `published_quizzes` RLS, `030` optional `result_pin`, `031` class-scoped identity/scale, and `032` paper cache) are applied in Supabase, then re-run `npm run test:stress-200`.
