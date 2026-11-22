# Realistic 1-Hour Multi-Exam Sitting Stress Test Report (`ICM-1`..`ICM-13`)

- **Run ID**: `mwr7lise`
- **Simulated Cohort**: **180 Concurrent Students** distributed across **13 Live Exams (`ICM-1`..`ICM-13`)** + **3 Live Invigilator Cockpits** + **2 Live Results Watchers**
- **1-Hour Exam Model**: 40 questions per paper, 6 checkpoints (Minutes 10–60), **36 early finishers** submitting during active draft traffic + **144 simultaneous hour-end expiry submissions**
- **Runtime**: 45s active sitting window (75.9s total runtime; Phase 1: 6.9s, Phase 2: 58.6s, Phase 3: 5.2s)
- **HTTP Volume & Concurrency**: **2466 HTTP requests** (**13.14 MB** write payload, **32.5 avg RPS**), **Peak Concurrent In-Flight Requests: 178**
- **HTTP Status Distribution**: `{"200":2422,"201":44}`
- **Average 40Q Submission Payload Size**: **60.8 KB** (40 questions + sub-questions + 42 answer change logs)
- **Realtime Proctor Telemetry**: 1440 heartbeats received, 224 `proctor_log_event` broadcasts received, **0 duplicate invigilator audit DB inserts**, 0 `postgres_changes` triggers

---

## 1. Strict Production SLO Verdict

| SLO ID | Production Requirement | Target | Observed Actual | Verdict |
| :--- | :--- | :--- | :--- | :---: |
| **SLO-1** | Zero HTTP 544 / 5xx / Client Timeouts across all requests | `0 errors` | 0 errors across 2466 requests | ✅ **PASS** |
| **SLO-2** | 100% Final Exam Submission Delivery (Early Finishers + Hour-End Wave) | `180/180 (100%)` | 180/180 (100.0%) — 1st try: 180, retried: 0 | ✅ **PASS** |
| **SLO-3** | 40-Question Submission RPC Latency (p50 < 1,200 ms, p95 < 4,500 ms) | `p50 < 1200ms, p95 < 4500ms` | p50=156.6ms, p95=193ms, max=235ms (payload ~60.8 KB) | ✅ **PASS** |
| **SLO-4** | Lobby Exam Paper Resolution Latency (p95 < 2,000 ms) | `p95 < 2000ms` | p50=125.2ms, p95=195.2ms, max=224.8ms | ✅ **PASS** |
| **SLO-5** | Cloud Draft Autosave Latency & Reliability across 6 Checkpoints (100% ok, p95 < 1,500 ms) | `100% ok, p95 < 1500ms` | 1044/1044 ok, p50=106.9ms, p95=134.6ms | ✅ **PASS** |
| **SLO-6** | Continuous 2s Health Probe Stability (0 degraded ticks > 3,000 ms) | `0 degraded ticks, max < 3000ms` | 0/35 degraded ticks (rpc p95=258ms, max=600.1ms; rest p95=326.7ms, max=676.6ms) | ✅ **PASS** |
| **SLO-7** | Post-Submit Attempt Verification & Zero Orphaned Cloud Drafts (30-Student Sample) | `30/30 verified, 0 orphans` | verified=30/30, resultLookups=30/30, orphans=0 | ✅ **PASS** |

---

## 2. End-to-End Operation Latency & Error Breakdown

| Phase & Operation | Requests | Success | 5xx / Timeouts | Min (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Phase 0: `register_proctor_public_key`** | 1 | 1/1 | 0 | 120.4 | 120.4 | 120.4 | 120.4 | 120.4 |
| **Lobby: `get_student_exam_paper(ICM-1..13)`** | 198 | 198/198 | 0 | 100.7 | 125.2 | 195.2 | 208.3 | 224.8 |
| **Lobby: `get_public_roster_directory`** | 0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Lobby Typing: `get_student_exam_draft`** | 198 | 198/198 | 0 | 95.9 | 110.6 | 149.6 | 211.2 | 372.9 |
| **Begin Exam: `verify_student_pin`** | 198 | 198/198 | 0 | 96.3 | 340 | 636.6 | 865.8 | 876.2 |
| **Begin Exam: `check_student_attempt_submitted`** | 198 | 198/198 | 0 | 93.7 | 225.9 | 564.7 | 709.3 | 845.9 |
| **Begin Exam: Initial `save_student_exam_draft`** | 198 | 198/198 | 0 | 99.7 | 187.4 | 437.6 | 673.5 | 690.3 |
| **Mid-Exam: Periodic `save_student_exam_draft` (6 rounds)** | 1044 | 1044/1044 | 0 | 93 | 106.9 | 134.6 | 275 | 436.5 |
| **Mid-Exam: `visibilitychange` Keepalive Draft Flush** | 44 | 44/44 | 0 | 95.1 | 107.4 | 136.9 | 164.3 | 164.3 |
| **Mid-Exam: Student `proctor_audit_events` Insert** | 44 | 44/44 | 0 | 96.2 | 108.1 | 151.2 | 173 | 173 |
| **Mid-Exam: `verify_teacher_unlock_pin(ICM-1..13)`** | 44 | 44/44 | 0 | 95.4 | 106.3 | 127.3 | 139.3 | 139.3 |
| **Mid-Exam: `get_proctor_public_key` Room Verification** | 13 | 13/13 | 0 | 95.2 | 104.1 | 114.2 | 114.2 | 114.2 |
| **Submit Wave: `submit_student_exam_attempt` (Attempt 1)** | 180 | 180/180 | 0 | 135.2 | 156.6 | 193 | 221 | 235 |
| **Submit Wave: `submit_student_exam_attempt` (All Attempts)** | 180 | 180/180 | 0 | 135.2 | 156.6 | 193 | 221 | 235 |
| **Post-Submit: `check_student_attempt_submitted` Sample** | 30 | 30/30 | 0 | 164.1 | 373.3 | 472.4 | 516.8 | 516.8 |
| **Post-Submit: `lookup_student_exam_result` Sample** | 30 | 30/30 | 0 | 214.2 | 434.1 | 530.7 | 543.8 | 543.8 |
| **Post-Submit: `get_student_exam_draft` Orphan Probe** | 30 | 30/30 | 0 | 170 | 389.4 | 509.9 | 524.8 | 524.8 |

---

## 3. Continuous 2-Second Supabase Health Probe Timeline

| Tick | Elapsed (s) | In-Flight Reqs | RPC Ping (ms) | RPC HTTP | REST Ping (ms) | REST HTTP | Status |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 1 | 0.9s | 21 | 258 | 200 | 326.7 | 200 | 🟢 Healthy |
| 2 | 3.2s | 9 | 107 | 200 | 114.4 | 200 | 🟢 Healthy |
| 3 | 5.3s | 3 | 104 | 200 | 101.9 | 200 | 🟢 Healthy |
| 4 | 7.4s | 146 | 600.1 | 200 | 676.6 | 200 | 🟢 Healthy |
| 5 | 10.1s | 0 | 133.7 | 200 | 113.1 | 200 | 🟢 Healthy |
| 6 | 12.3s | 0 | 110 | 200 | 105.1 | 200 | 🟢 Healthy |
| 7 | 14.4s | 0 | 110.9 | 200 | 101.3 | 200 | 🟢 Healthy |
| 8 | 16.5s | 1 | 135.7 | 200 | 152.1 | 200 | 🟢 Healthy |
| 9 | 18.7s | 4 | 107.3 | 200 | 100.8 | 200 | 🟢 Healthy |
| 10 | 20.8s | 2 | 149 | 200 | 139.9 | 200 | 🟢 Healthy |
| 11 | 22.9s | 3 | 117.5 | 200 | 98.3 | 200 | 🟢 Healthy |
| 12 | 25s | 1 | 131.3 | 200 | 105.9 | 200 | 🟢 Healthy |
| 13 | 27.2s | 0 | 106.2 | 200 | 99.4 | 200 | 🟢 Healthy |
| 14 | 29.3s | 1 | 112.6 | 200 | 99.6 | 200 | 🟢 Healthy |
| 15 | 31.4s | 3 | 112.7 | 200 | 97.9 | 200 | 🟢 Healthy |
| 16 | 33.5s | 1 | 102.6 | 200 | 142.7 | 200 | 🟢 Healthy |
| 17 | 35.7s | 4 | 109.4 | 200 | 109.5 | 200 | 🟢 Healthy |
| 18 | 37.8s | 6 | 100.3 | 200 | 101.3 | 200 | 🟢 Healthy |
| 19 | 39.9s | 0 | 116.3 | 200 | 98.7 | 200 | 🟢 Healthy |
| 20 | 42s | 4 | 117.1 | 200 | 126.3 | 200 | 🟢 Healthy |
| 21 | 44.1s | 6 | 104.1 | 200 | 124.2 | 200 | 🟢 Healthy |
| 22 | 46.3s | 1 | 108.2 | 200 | 102.1 | 200 | 🟢 Healthy |
| 23 | 48.4s | 3 | 102.9 | 200 | 103.7 | 200 | 🟢 Healthy |
| 24 | 50.5s | 4 | 99.1 | 200 | 107.5 | 200 | 🟢 Healthy |
| 25 | 52.6s | 2 | 103.7 | 200 | 106 | 200 | 🟢 Healthy |
| 26 | 54.7s | 0 | 99.9 | 200 | 99.5 | 200 | 🟢 Healthy |
| 27 | 56.8s | 1 | 100.7 | 200 | 96.6 | 200 | 🟢 Healthy |
| 28 | 58.9s | 3 | 100.8 | 200 | 104.7 | 200 | 🟢 Healthy |
| 29 | 61s | 1 | 113.2 | 200 | 108.6 | 200 | 🟢 Healthy |
| 30 | 63.2s | 2 | 115.7 | 200 | 126.9 | 200 | 🟢 Healthy |
| 31 | 65.3s | 1 | 95.2 | 200 | 94.4 | 200 | 🟢 Healthy |
| 32 | 67.4s | 1 | 111.4 | 200 | 106.8 | 200 | 🟢 Healthy |
| 33 | 69.5s | 3 | 106.4 | 200 | 107.7 | 200 | 🟢 Healthy |
| 34 | 71.6s | 4 | 112.2 | 200 | 105.2 | 200 | 🟢 Healthy |
| 35 | 73.7s | 0 | 110.6 | 200 | 110 | 200 | 🟢 Healthy |

---

## 4. Supabase Server-Side State & Pre-Cleanup Database Forensics

- **Verification Access Mode**: `teacher_session`
- **Post-Submit RPC Attempt Checks (30-student sample)**: **30/30** confirmed `submitted=true`
- **Post-Submit Result Lookups (30-student sample)**: **30/30** returned clean HTTP 200 JSON responses
- **Inline Cloud Draft Cleanup Probe (30-student sample)**: **0** orphaned draft keys left behind in Postgres `app_config`
- **Privileged Table Row Counts (`quiz_submissions` / `proctor_audit_events` / `app_config`)**: this_run_submissions=180 (total_STRESS200=270), this_run_audit_events=44 (total_STRESS200=44), this_run_remaining_drafts=0 (total_draft_stress200=1)

