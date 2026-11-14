# 200-Student Stress Test & Vulnerability Audit Report

- **Run ID**: `mwg0qg5n`
- **Target**: Live Supabase (`https://jtxmlmexvfvrkhfavwdr.supabase.co`)
- **Total Wall-Clock Runtime**: 14070 ms
- **Logged Events**: 1380 JSONL entries (`artifacts/stress200_events.jsonl`)
- **Zero-Residue Cleanup**: 1 draft keys deleted via RPC; 198 `STRESS200` submissions and `STRESS200` audit events marked for automatic cleanup inside Migration `022`

---

## 1. Concurrency & Latency Telemetry Summary

| Wave / Operation | Volume | Wall Time (ms) | Success Rate | Min (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Wave 1: `get_student_exam_paper('ICM170')`** (200 concurrent) | 200 | 4582.5 | 200/200 (leaks=0) | 584.2 | 2803.3 | 3512.1 | 4312.9 | 4447.2 |
| **Wave 1: `check_student_attempt_submitted`** (200 concurrent) | 200 | 4582.5 | 200/200 | 94.4 | 186.2 | 893.8 | 1637 | 2877.3 |
| **Wave 2: `save_student_exam_draft`** (3 rounds × 200) | 600 | 2612.7 | 600/600 | 105.4 | 163.2 | 271.9 | 307.3 | 515.5 |
| **Wave 2: `get_student_exam_draft`** (30 device switches) | 30 | — | 30/30 | 122.7 | 142 | 158.6 | 186.3 | 186.3 |
| **Wave 2: `proctor_audit_events` inserts** (25 violators) | 114 | — | 114/114 | 98.6 | 119 | 157.2 | 159.3 | 160 |
| **Wave 2: `verify_teacher_unlock_pin`** (wrong PIN rejections) | 25 | — | 25/25 | 100.3 | 107.9 | 149.9 | 153 | 153 |
| **Wave 3: `submit_student_exam_attempt`** (200 concurrent) | 200 | 2376.8 | 198/200 (dup 50ms races ok=10/10) | 292.2 | 1054.5 | 1806.2 | 1874.8 | 1882.5 |

---

## 2. Vulnerability & Red-Team Probe Findings (Wave 4 — 4394.4 ms)

| ID | Severity | Status | Summary & Observed Evidence |
| :--- | :---: | :---: | :--- |
| **BUG-01** | **CRITICAL** | MITIGATED | **save_student_exam_draft fails across all clients if app_config lacks updated_at column** — 600/600 draft saves succeeded cleanly (30/30 device-switch recoveries). |
| **VULN-H1** | **CRITICAL** | MITIGATED | **Client-trusted score, percentage & duration in submit_student_exam_attempt** — STU-191 submitted wrong answers with score=999, percentage=100; RPC returned false (note: on Migration 022, Exam Mode zeroes claimed score server-side; on 021, 999 is stored verbatim). |
| **VULN-H2a** | **HIGH** | MITIGATED | **Cross-student draft read, overwrite & delete without session ownership check** — Attacker wrong-token probes on STU-001 draft: read=null, overwrite=false, delete=false. |
| **VULN-H2b** | **MEDIUM** | MITIGATED | **Draft key prefix guard blocks config overwrite, payload cap rejects 512 KB bloat** — Config overwrites: published_quizzes=false, claiming=false; 512 KB bloat=false. |
| **VULN-H3a** | **HIGH** | MITIGATED | **Single-attempt bypass: submit_student_exam_attempt accepts a second row under a new client ID** — Re-submitting Sim Student 001 (mwg0qg5n) (CAND-mwg0qg5n-001) under new id=stress200-mwg0qg5n-bypass-stu194 returned false. |
| **VULN-H3b** | **HIGH** | MITIGATED | **Pre-PIN / blank-PIN submission overwrite allowed on ON CONFLICT (id) DO UPDATE** — Overwrite attempt on blank-PIN row stress200-mwg0qg5n-stu-195 returned false. |
| **VULN-H4** | **MEDIUM** | MITIGATED | **Proctor audit RLS blocks invigilator role & anon reads, 32 KB log spam cap check** — actor='invigilator' HTTP 401; anon SELECT count=0; 32 KB detail spam HTTP 400. |
| **VULN-H5** | **LOW** | MITIGATED | **lookup_student_exam_result shields unreleased scores & exposes allowStudentScriptDownload cleanly** — Unreleased lookup keys=[status, submissions, hasUnreleased, allowStudentScriptDownload]; wildcard lookup status=not_found; anon app_config policy rows=0. |
| **BASELINE-RLS-AUTH** | **INFO** | VERIFIED | **Strict RLS & Account Claiming Guard Verification (Expected Blocked)** — Table scraping: [questions:200(rows=0), custom_tests:200(rows=0), teacher_profiles:200(rows=0), syllabuses:200(rows=0), quiz_submissions:200(rows=0), app_config_secrets:200(rows=0)]; forged header rows=0; claim disabled msg="Educator account creation and profile claiming are currently disabled by the administrator.". |
| **PHASE-3B-LIVE** | **INFO** | VERIFIED | **Migration 024 live controls (no teacherPinHash, game_profiles RLS, draft-lock submit guard, reset gate)** — teacherPinHashExposed=false; game_profiles=401(err); draft_lock_hijack=HTTP 401(Active exam session belongs to another device. Please submit from the active exam device or ask the teacher to unlock.); reset_gate="Master PIN password resets are disabled while account claiming is locked. Please ask an administrator to enable Account Claiming.". |

---

## 3. Remediation Status (`022_exam_anti_tamper_and_rate_guards.sql`)

Run [022_exam_anti_tamper_and_rate_guards.sql](file:///e:/VibeCoding/testmaker/supabase/migrations/022_exam_anti_tamper_and_rate_guards.sql) in Supabase SQL Editor, then re-run `npm run test:stress-200` to verify every CONFIRMED item turns MITIGATED and clean up all `STRESS200` rows.
