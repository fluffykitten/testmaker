# Live Migration 037 & Admin Pre-Warm Stress Test Report (`ICM-1`..`ICM-13`)

- **Run Tag**: `mwoxelw5`
- **Simulated Students**: **170** across **13 Live Exams (`ICM-1`..`ICM-13`)** + isolated `STRESS200` write fixture
- **Total Wall Time**: **47.7s**
- **Peak Concurrent In-Flight Requests**: **72**

## Strict SLO Verdict

| SLO | Check | Actual | Verdict |
| :--- | :--- | :--- | :---: |
| **SLO-1** | Zero HTTP 5xx / 522 / Timeout errors | 0 errors | ✅ PASS |
| **SLO-2** | Pre-warmed Lobby Paper Load (`get_student_exam_paper` p95 < 1000 ms, 100% ok) | 170/170 ok, p50=183.4ms, p95=616ms, max=874.3ms | ✅ PASS |
| **SLO-3** | Unified Start RPC (`enter_student_exam_session` p95 < 1000 ms, 100% ok) | 170/170 ok, p50=220ms, p95=427.7ms, max=559.9ms | ✅ PASS |
| **SLO-4** | 100% Final Submission Delivery (0..15s timer jitter, p95 < 1500 ms) | 170/170 accepted, p50=122ms, p95=204.5ms, max=466.7ms | ✅ PASS |
| **SLO-5** | Zero Degraded 2s Supabase Health Probe Ticks (< 3000 ms) | 0/22 degraded (rpc p95=218.6ms, rest p95=211.8ms) | ✅ PASS |

## Phase Breakdown

| Operation | Count | Ok | Errors | p50 (ms) | p95 (ms) | Max (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Pre-warmed Lobby Paper Load (`get_student_exam_paper`)** | 170 | 170 | 0 | 183.4 | 616 | 874.3 |
| **Unified Start (`enter_student_exam_session`)** | 170 | 170 | 0 | 220 | 427.7 | 559.9 |
| **Staggered Initial Draft (`save_student_exam_draft`)** | 170 | 170 | 0 | 107.5 | 145.6 | 291.1 |
| **Mid-Exam Autosave (`save_student_exam_draft`)** | 340 | 340 | 0 | 105.9 | 134.6 | 258.9 |
| **Crash Reload Recovery (`enter_student_exam_session`)** | 17 | 17 | 0 | 106.6 | 129.9 | 129.9 |
| **Timer-Expiry Submit (`submit_student_exam_attempt`)** | 170 | 170 | 0 | 122 | 204.5 | 466.7 |

Security probes verified in Phase 0: anonymous `prewarm_exam_paper_cache` blocked (401) and server rejected spoofed `require_student_pin=false` on `ICM-1` (`status=invalid_pin`).
