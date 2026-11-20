# Realistic Multi-Exam Sitting Stress Test Report (`ICM-1`..`ICM-13`)

- **Run ID**: `mwoo886j`
- **Simulated Cohort**: **200 Concurrent Students** distributed across **13 Live Exams (`ICM-1`..`ICM-13`)** + **3 Live Invigilator Cockpits** + **2 Live Results Watchers**
- **Sitting Duration**: 20s active sitting window (53.2s total runtime)
- **Peak Concurrent In-Flight HTTP Requests**: **200**
- **Average Submission Payload Size**: **21.6 KB** (12 questions + sub-questions + full forensics)
- **Realtime Proctor Telemetry**: 1000 heartbeats received, 250 proctor log events received, **0 duplicate invigilator audit DB inserts triggered**, 0 `postgres_changes` watcher triggers

---

## 1. Strict Production SLO Verdict

| SLO ID | Production Requirement | Target | Observed Actual | Verdict |
| :--- | :--- | :--- | :--- | :---: |
| **SLO-1** | Zero HTTP 544 / 5xx / Client Timeouts across all requests | `0 errors` | 0 errors | ✅ **PASS** |
| **SLO-2** | 100% Final Exam Submission Delivery (within 3 retries) | `200/200 (100%)` | 200/200 (100.0%) — 1st try: 200, retried: 0 | ✅ **PASS** |
| **SLO-3** | Submission RPC Latency (p50 < 1,200 ms, p95 < 4,500 ms) | `p50 < 1200ms, p95 < 4500ms` | p50=151.3ms, p95=406.1ms, max=596.5ms (payload ~21.6 KB) | ✅ **PASS** |
| **SLO-4** | Lobby Exam Paper Resolution Latency (p95 < 2,000 ms) | `p95 < 2000ms` | p50=234ms, p95=393.2ms, max=496.1ms | ✅ **PASS** |
| **SLO-5** | Cloud Draft Autosave Latency & Reliability (100% ok, p95 < 1,500 ms) | `100% ok, p95 < 1500ms` | 600/600 ok, p50=117.5ms, p95=199.9ms | ✅ **PASS** |
| **SLO-6** | Continuous 2s Health Probe Stability (0 degraded ticks > 3,000 ms) | `0 degraded ticks, max < 3000ms` | 0/24 degraded ticks (rpc p95=208.1ms, max=1404.5ms; rest p95=286.9ms, max=1375.4ms) | ✅ **PASS** |

---

## 2. End-to-End Operation Latency & Error Breakdown

| Phase & Operation | Requests | Success | 5xx / Timeouts | Min (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Boot: `teacher_profiles` select (root provider)** | 0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Boot: `app_config` settings (4 keys/student)** | 0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Lobby: `get_student_exam_paper(ICM-1..13)`** | 220 | 220/220 | 0 | 163.7 | 234 | 393.2 | 436.5 | 496.1 |
| **Lobby: `get_public_roster_directory`** | 0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Lobby Typing: `get_student_exam_draft` (2x/student)** | 220 | 220/220 | 0 | 93.8 | 473.2 | 643 | 738 | 798.1 |
| **Begin Exam: `verify_student_pin`** | 220 | 220/220 | 0 | 98.2 | 219.9 | 433.5 | 487.2 | 623.7 |
| **Begin Exam: `check_student_attempt_submitted`** | 220 | 220/220 | 0 | 92.2 | 261.2 | 566.2 | 847.1 | 866.5 |
| **Begin Exam: Initial `save_student_exam_draft`** | 220 | 220/220 | 0 | 93.1 | 335.6 | 584.2 | 800.8 | 1270.5 |
| **Mid-Exam: Periodic `save_student_exam_draft` (~20 KB)** | 600 | 600/600 | 0 | 89.8 | 117.5 | 199.9 | 385.4 | 815.1 |
| **Mid-Exam: `visibilitychange` Keepalive Draft Flush** | 50 | 50/50 | 0 | 96.9 | 119.5 | 210.7 | 370.3 | 370.3 |
| **Mid-Exam: Student `proctor_audit_events` Insert** | 50 | 50/50 | 0 | 94.9 | 120.1 | 210.7 | 370.3 | 370.3 |
| **Mid-Exam: Invigilator Mirror `proctor_audit_events` Insert** | 0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Mid-Exam: `verify_teacher_unlock_pin(ICM-1..13)`** | 50 | 50/50 | 0 | 89 | 113.3 | 180 | 369.6 | 369.6 |
| **Submit Wave: `submit_student_exam_attempt` (Attempt 1)** | 200 | 200/200 | 0 | 108.1 | 151.3 | 406.1 | 502.7 | 596.5 |
| **Submit Wave: `submit_student_exam_attempt` (All Attempts)** | 200 | 200/200 | 0 | 108.1 | 151.3 | 406.1 | 502.7 | 596.5 |
| **Submit Wave: `delete_student_exam_draft` (Post-Submit)** | 0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 |

---

## 3. Continuous 2-Second Supabase Health Probe Timeline

| Tick | Elapsed (s) | In-Flight Reqs | RPC Ping (ms) | RPC HTTP | REST Ping (ms) | REST HTTP | Status |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 1 | 0s | 20 | 1404.5 | 200 | 1375.4 | 200 | 🟢 Healthy |
| 2 | 3.4s | 12 | 159 | 200 | 283 | 200 | 🟢 Healthy |
| 3 | 5.7s | 6 | 134.6 | 200 | 156.7 | 200 | 🟢 Healthy |
| 4 | 7.9s | 139 | 181.9 | 200 | 183.9 | 200 | 🟢 Healthy |
| 5 | 10.2s | 0 | 108.8 | 200 | 110.9 | 200 | 🟢 Healthy |
| 6 | 12.3s | 0 | 140 | 200 | 140.1 | 200 | 🟢 Healthy |
| 7 | 14.5s | 0 | 110.4 | 200 | 109.2 | 200 | 🟢 Healthy |
| 8 | 16.6s | 2 | 109.9 | 200 | 116.8 | 200 | 🟢 Healthy |
| 9 | 18.9s | 16 | 141.9 | 200 | 140.6 | 200 | 🟢 Healthy |
| 10 | 21s | 1 | 109.2 | 200 | 137.9 | 200 | 🟢 Healthy |
| 11 | 23.2s | 3 | 117.9 | 200 | 117.2 | 200 | 🟢 Healthy |
| 12 | 25.3s | 4 | 97.7 | 200 | 97.7 | 200 | 🟢 Healthy |
| 13 | 27.4s | 2 | 116.3 | 200 | 91.6 | 200 | 🟢 Healthy |
| 14 | 29.5s | 3 | 90.1 | 200 | 109.3 | 200 | 🟢 Healthy |
| 15 | 31.6s | 9 | 163.1 | 200 | 159.4 | 200 | 🟢 Healthy |
| 16 | 33.8s | 3 | 115.4 | 200 | 115.4 | 200 | 🟢 Healthy |
| 17 | 35.9s | 7 | 142.5 | 200 | 141.5 | 200 | 🟢 Healthy |
| 18 | 38.1s | 4 | 113.6 | 200 | 113.9 | 200 | 🟢 Healthy |
| 19 | 40.2s | 6 | 165.7 | 200 | 115.3 | 200 | 🟢 Healthy |
| 20 | 42.4s | 0 | 126.4 | 200 | 129.1 | 200 | 🟢 Healthy |
| 21 | 44.5s | 0 | 208.1 | 200 | 286.9 | 200 | 🟢 Healthy |
| 22 | 46.8s | 9 | 115.1 | 200 | 114.4 | 200 | 🟢 Healthy |
| 23 | 48.9s | 8 | 138.5 | 200 | 118.2 | 200 | 🟢 Healthy |
| 24 | 51.1s | 0 | 111.9 | 200 | 111.3 | 200 | 🟢 Healthy |


