# ICM-1 to ICM-13 Class-Scoped + Student PIN Stress Test Report

- **Run ID**: `mwnzo2wa`
- **Timestamp**: 2026-11-19T20:15:00.295Z
- **Target**: Live Supabase (`https://jtxmlmexvfvrkhfavwdr.supabase.co`)
- **Total Wall-Clock Runtime**: 23323.8 ms
- **Logged Events**: 830 JSONL entries (`artifacts/icm13_stress_events.jsonl`, student names & PINs redacted)
- **Zero-Residue Cleanup**: Remaining test drafts cleaned=0; residual test submissions=0; residual test audits=0

---

## 1. Concurrency & Latency Telemetry (166 Real Students Across 13 Classes)

| Wave / Operation | Volume | Pass Rate | p50 (ms) | p95 (ms) | max (ms) | Wall (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Wave 1 — `get_student_exam_paper` (`ICM-1..ICM-13`)** | 166 | 166/166 | 12881.9 | 13179.4 | 13205.4 | 13217.6 |
| **Wave 1 — `get_public_roster_directory`** | 166 | 166/166 | 12901.9 | 13170.3 | 13184.2 | — |
| **Wave 2 — `verify_student_pin` (Real Student PINs)** | 166 | 166/166 | 511 | 763.9 | 772.4 | 2220.9 |
| **Wave 3 — `save_student_exam_draft` (2x burst)** | 332 | 332/332 | 226.7 | 429.7 | 542.5 | 2963.9 |
| **Wave 4 — `submit_student_exam_attempt` (With PINs)** | 166 | 166/166 | 844.2 | 1312.2 | 1373.5 | 1804.3 |

---

## 2. Per-Exam Class Submission Results (`ICM-1` .. `ICM-13`)

| Quiz Code | Enrolled Cohort Tested | Accepted With Real PIN |
| :--- | :---: | :---: |
| `ICM-1` | 18 | 18/18 |
| `ICM-2` | 11 | 11/11 |
| `ICM-3` | 11 | 11/11 |
| `ICM-4` | 19 | 19/19 |
| `ICM-5` | 7 | 7/7 |
| `ICM-6` | 12 | 12/12 |
| `ICM-7` | 13 | 13/13 |
| `ICM-8` | 6 | 6/6 |
| `ICM-9` | 11 | 11/11 |
| `ICM-10` | 17 | 17/17 |
| `ICM-11` | 18 | 18/18 |
| `ICM-12` | 17 | 17/17 |
| `ICM-13` | 6 | 6/6 |

---

## 3. Security & Integrity Verification

- **Key / Answer / PIN Leakage Scan**: `0` leaked key/PIN fields across all 166 `get_student_exam_paper` + `get_public_roster_directory` payloads.
- **Class Notation Parity (`normalize_roster_class_label`)**: `33/33` passed with hyphenated/lowercase class notation + real PIN.
- **Brute-Force PIN Lockout**: Synthetic probe wrong-PIN rejection = `13/13`; 12-attempt mixed-class brute-force lockout triggered = `true`.
- **Draft Lock & Hijack Resistance**: Recovery = `13/13`; cross-token hijack blocked = `13/13`; audit inserts = `26/26`.
- **Submission Gate Enforcement**: Unregistered/wrong-PIN submit rejected = `13/13`; duplicate second-attempt blocked = `true`.
