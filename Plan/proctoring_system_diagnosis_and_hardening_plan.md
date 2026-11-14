# Proctoring System Diagnosis & Hardening Plan (`Plan/proctoring_system_diagnosis_and_hardening_plan.md`)

> **Status:** Phase A (Client) Implemented & Verified; Phase B (`023_proctor_security_and_pin_parity.sql`) Authored — Pending User Execution in Supabase SQL Editor  
> **Created:** 2026-11-14  
> **Baseline:** Post-Phase 1, Phase 2 (`021`), Phase 2.5 (`022`), `run=mwftqmli` 200-student stress test, and crash/exit cloud draft flush updates  
> **Primary Targets:** `src/lib/proctorCommandAuth.ts`, `src/pages/StudentQuizRunner.tsx`, `src/components/LiveInvigilatorModal.tsx`, `src/services/examProctorRealtimeService.ts`, `src/services/proctorAuditLogService.ts`, `src/services/quizCodeService.ts`, `src/lib/proctorGuards.ts`, `supabase/migrations/019_exam_submission_security_rpcs.sql`, `supabase/migrations/021_phase2_teacher_login_rls_and_exam_rpcs.sql`, `supabase/migrations/022_exam_anti_tamper_and_rate_guards.sql`, `supabase/migrations/023_proctor_security_and_pin_parity.sql`

---

## 1. Executive Summary & Post-Update Baseline

Following Phase 2 (`021`), Phase 2.5 (`022`), and the recent `StudentQuizRunner` draft autosave fix (`latestCloudDraftRef` + 2.5s answer-edit debounce + 25s heartbeat + `beforeunload`/`pagehide`/`visibilitychange` `keepalive` flush), a full end-to-end audit of the **live proctoring subsystem** was conducted across student telemetry, Realtime Broadcast transport, invigilator UI, PIN unlock RPCs, and audit persistence triggers.

### What Is Already Hardened & Working
- **Telemetry clamping & monotonic strike high-water mark** (`src/lib/proctorGuards.ts`): `clampTelemetry` bounds `answeredCount`, `violationsCount`, `timeLeftSeconds`, and `highWaterViolations` prevents strikes from dropping unless a teacher explicitly triggers `pardon`.
- **Canonical candidate identity & receipt timestamps** (`src/utils/examSecurityUtils.ts`, `src/components/LiveInvigilatorModal.tsx:338-357`): `getCanonicalProctorStudentId` unifies live heartbeats and submission backfills under `${quizCode}::cand_*`, and `lastHeartbeat` is stamped with the teacher's `Date.now()` upon receipt.
- **Database RLS & Trigger Guards (`021` + `022`)**:
  - `proctor_audit_events` RLS (`021_phase2_teacher_login_rls_and_exam_rpcs.sql:1243-1250`) restricts `SELECT/UPDATE/DELETE` and non-student inserts to `is_authenticated_teacher()`, while allowing anonymous student `INSERT` strictly with `WITH CHECK (actor = 'student')`.
  - `enforce_proctor_audit_guard` (`022_exam_anti_tamper_and_rate_guards.sql:776-820`) rejects student-side oversized fields (`quiz_code` outside 2..32, `student_id`/`student_name` outside 1..120, `event_type` outside 2..64, `detail > 1024` bytes), invalid severities, non-`'student'` actors, and floods `>= 60` rows per 10 minutes per `(quiz_code, student_id)`.
- **Remote Unlock & Fullscreen Recovery UI** (`StudentQuizRunner.tsx:1898-1924`, verified by `scripts/verify-proctor-remote-unlock.mjs` & `scripts/test-proctor-p1-p2-p3.mjs`).

### Critical Gaps Identified in This Audit

| ID | Severity | Component | Summary |
| :--- | :--- | :--- | :--- |
| **PROC-01** | **HIGH (Security)** | `examProctorRealtimeService.ts`, `StudentQuizRunner.tsx`, `proctorGuards.ts` | **Unauthenticated Realtime Broadcast commands & telemetry spoofing** on public `exam_proctor:<CODE>`, plus unconnected `proctorGuards.ts` command checks (`isAllowedProctorCommand`, `claimCommandId`, `clampAddTimeMinutes`) |
| **PROC-02** | **HIGH (Correctness)** | `StudentQuizRunner.tsx:1897-2018` | **Stale closure in `handleCommand`** (`isFinalSecurityLock`, `targetEndTime`, `violations`, `answeredCount` captured once at exam start) |
| **PROC-03** | **HIGH (Audit Loss)** | `StudentQuizRunner.tsx`, `LiveInvigilatorModal.tsx:407-422, 991-1108`, `examProctorRealtimeService.ts` | **Discrete student audit events only saved when dashboard is open**; `ProctorLogEvent` omits `studentId`/`candidateClass` causing ID drift; bulk `unlock`/`add_time` never audited; multi-invigilator duplicate key contention |
| **PROC-04** | **HIGH (Post-021 Auth)** | `LiveInvigilatorModal.tsx:173-273, 424-458` | **Silent partial/empty proctor failures when `x-teacher-session` expires** (returns empty arrays and fails `actor='invigilator'` writes silently) |
| **PROC-05** | **MEDIUM (Post-019/022)** | `019_exam_submission_security_rpcs.sql:35-48`, `quizCodeService.ts:584-605` | **`verify_teacher_unlock_pin` RPC checks only `published_quizzes`**, ignoring `quiz_by_code_*`, `previousCodes`, and `headerConfig.teacherPin`; blocks offline `expectedHash` fallback when RPC returns `false` |
| **PROC-06** | **MEDIUM (Post-022 Trigger)** | `proctorAuditLogService.ts`, `022:776-820` | **No client-side UTF-8 byte clamping before DB insert** (`1024`-byte cap throws `22023` instead of truncating cleanly) |
| **PROC-07** | **MEDIUM (Scale / Exit)** | `StudentQuizRunner.tsx:2004-2018, 2115-2154, 3312-3317` | **200-way `request_sync` spike + reactive heartbeats + exit unmount race** (`visibilitychange` overlap & channel teardown on submit/close) |

---

## 2. Detailed Technical Diagnosis

### PROC-01 — Unauthenticated Realtime Broadcast Spoofing & Unwired Client Command Guards (`examProctorRealtimeService.ts`, `StudentQuizRunner.tsx`, `proctorGuards.ts`)
- **Current Behavior**:
  - `examProctorRealtimeService.ts` connects both students and the teacher dashboard to `exam_proctor:${quizCode.trim().toUpperCase()}` using the public `supabase` anon client (`broadcast: { self: false }`).
  - There is no signature, capability proof, or teacher token attached to `proctor_cmd` broadcasts (`unlock`, `add_time`, `pardon`, `force_submit`, `announcement`).
  - Furthermore, the pure helpers `isAllowedProctorCommand`, `claimCommandId`, `clampAddTimeMinutes`, `sanitizeAnnouncement`, and `recentViolationsSlice` in `src/lib/proctorGuards.ts` (already unit-tested in `scripts/test-proctor-p1-p2-p3.mjs`) are **not currently imported or called in `StudentQuizRunner.tsx`**. Without `clampAddTimeMinutes(cmd.minutes)` at `StudentQuizRunner.tsx:1926`, a negative `cmd.minutes` subtracts time; without `claimCommandId(executedCommandIdsRef.current, cmd.id)`, retried broadcasts from `retryBroadcast` can apply `add_time` multiple times.
- **Exploit / Failure Scenario**:
  - Any user with a valid exam code (or who opens DevTools on an exam device) can subscribe to `exam_proctor:<CODE>` via Supabase JS SDK and broadcast:
    1. `{ type: 'unlock', targetStudentId: '<their_id>' }` or `'pardon'` to bypass lockouts and reset their local strike count.
    2. `{ type: 'add_time', minutes: 120, targetStudentId: '<their_id>' }` (or even negative `minutes` because `clampAddTimeMinutes` is not wired in `StudentQuizRunner.tsx`).
    3. `{ type: 'force_submit', targetStudentId: 'ALL' }` or spoofed `announcement` to disrupt all 200 classmates mid-exam.
    4. Spoofed `student_heartbeat` or `proctor_log_event` messages posing as another candidate (only throttled per sender channel client-side by `LOG_EVENTS_PER_WINDOW = 5` / `10s`, trivially bypassed by reconnecting or using a Node script).
- **Important nuance with `021` / `022`**: While `022` prevents score forgery on DB submit, a rogue `force_submit` or self-`unlock`/`add_time` still disrupts the live exam session itself.

### PROC-02 — Stale Closure Bug in `StudentQuizRunner.tsx` Proctor Command Listener
- **Evidence**: `src/pages/StudentQuizRunner.tsx:1864-2018` registers `handleCommand` inside `useEffect(..., [hasStarted, resolvedQuizCode, sessionHash])` once when the exam starts.
- **Concrete Failures Observed in Code**:
  1. **Final Security Lock Bypass (`lines 1899, 1972`)**: `if (isFinalSecurityLock) return;` reads the `false` value captured when `hasStarted` first turned `true`. Even if a student later hits the `auto_submit` tier (`setIsFinalSecurityLock(true)` at `1228`), a subsequent `unlock` or `pardon` command evaluates `if (false) return;` and unlocks them!
  2. **Incorrect Time/Grace Calculation on Remote Unlock/Pardon (`lines 1900-1908, 1977-1985`)**: `resolveUnlockClock({ targetEndTime: targetEndTime || (Date.now() + timeLeft * 1000), ... })` uses the exam-start values of `targetEndTime` and `timeLeft`, completely ignoring later `time_penalty` deductions (`1174-1175`) or `add_time` extensions (`1926-1928`).
  3. **Zeroed Telemetry on Remote `force_submit` (`lines 1935-1970`)**: `submitTelemetry` inside `force_submit` reads `quizStats.answeredItems`, `violations`, `strikeCount`, and `currentIndex` from the exam-start closure (typically `0` answered, `0` violations, index `1`), overwriting the teacher dashboard card with stale `0/N` telemetry right before submission completes.
  - *(Note: `latestStateForHeartbeat` ref was added right below at `lines 2021-2060` for heartbeats, so `handleHeartbeat` stays fresh, whereas `handleCommand` right above it was missed.)*

### PROC-03 — Audit Log Persistence Blind Spots, Missing `studentId`/`candidateClass` Propagation & Multi-Invigilator Collisions
- **Evidence**:
  - `StudentQuizRunner.tsx` calls `sendStudentViolation(...)` (`1000+`, `1053+`, `1126+`, `1188+`, `1236+`), which **only** broadcasts `proctor_log_event` on the ephemeral WebSocket channel (`examProctorRealtimeService.ts`). It **never** calls `recordProctorAuditEvent`.
  - `ProctorLogEvent` (`examProctorRealtimeService.ts:76-100, 254-264`) currently **omits `studentId` and `candidateClass`**, so `LiveInvigilatorModal.tsx:410-416` recomputes `getCanonicalProctorStudentId` **without** `studentClass`. For candidates without a `candidateNumber`, `getCanonicalProctorStudentId` hashes `studentClass` (`scripts/test-proctor-p1-p2-p3.mjs:62`), yielding a different `student_id` on the dashboard (`cand_X`) than on the student runner (`cand_Y`).
  - `LiveInvigilatorModal.tsx:407-422` (`handleLogEvent`) is the **only** place calling `recordProctorAuditEvent` for `actor: 'student'`, and it writes each event into `proctor_audit_events` only while the dashboard is open and connected.
  - Meanwhile, individual actions `handleUnlock`, `handleAddTime`, `handleForceSubmit`, `handlePardon` (`800-986`) call `recordProctorAuditEvent({ actor: 'invigilator', ... })`, whereas bulk actions **`handleScopedUnlockAll` (`991-1044`)** and **`handleScopedAddTime` (`1047-1108`)** do **not** call `recordProctorAuditEvent` at all (and note `proctor_audit_events.student_id` is `TEXT NOT NULL`, requiring a non-empty synthetic target such as `'ALL'` or `'ALL::<class>'`).
- **Impact**:
  1. If a student cheats or locks out before the teacher opens `LiveInvigilatorModal`, during a teacher Wi-Fi drop, or after closing the modal, **those audit rows never reach `proctor_audit_events`** (and if the student closes the tab while locked out without submitting, `quiz_submissions.proctoring_logs` never receives them either).
  2. If two invigilators open `LiveInvigilatorModal` on two laptops simultaneously, both call `recordProctorAuditEvent` for the exact same `enriched.id`, generating unnecessary `23505` duplicate-key DB errors (note: under `021` RLS, students only have `INSERT` and **cannot** call `.upsert()`, which would fail with `42501` — duplicate suppression must stay plain `.insert()` ignoring `23505`).
  3. Under Phase 2 RLS (`021:1248-1250`), students *already have permission* to insert `actor = 'student'` directly into `proctor_audit_events` (`run=mwftqmli` tested `114/114` direct student inserts successfully), so failing to call `recordProctorAuditEvent` on the student side leaves that server capability unused.

### PROC-04 — Silent Teacher Auth Expiry in `LiveInvigilatorModal.tsx`
- **Evidence**: `src/lib/supabase.ts` (`teacherAwareFetch` injects `x-teacher-session` from `localStorage`), `LiveInvigilatorModal.tsx:173-273` (`loadAndSyncAllSubmissions().catch(() => {})`) and `424-458` (`loadProctorAuditEvents`).
- **Root Cause**:
  - If a teacher leaves the browser open past the `teacher_auth_sessions` expiry window (or opens the modal after clearing/rotating session state in another tab), `is_authenticated_teacher()` flips to `false`.
  - `proctor_audit_events` `SELECT` returns `[]` cleanly (no HTTP error under RLS!) and `recordProctorAuditEvent({ actor: 'invigilator' })` fails RLS (`42501`) inside a fire-and-forget `console.warn` (`proctorAuditLogService.ts`).
  - Result: **The invigilator sees an empty cloud audit drawer and zero cloud-submitted cards with zero UI indication that their teacher session expired.**

### PROC-05 — `verify_teacher_unlock_pin` RPC Lookup Divergence (`019` vs `022`) & Offline Fallback Nuance
- **Evidence**:
  - `supabase/migrations/019_exam_submission_security_rpcs.sql:35-48` resolves `teacherPin` **only** from `app_config WHERE key = 'published_quizzes'`.
  - However, `022_exam_anti_tamper_and_rate_guards.sql:215-260` (`get_student_exam_paper`) resolves exams from **`quiz_by_code_<CODE>` first**, then falls back to `published_quizzes` matching either `quizCode` or `previousCodes`, and allows PIN config in `headerConfig->>'teacherPin'` or top-level `teacherPin`.
  - Furthermore, in `src/services/quizCodeService.ts:593-604`, if the RPC returns `false` without throwing (`!error && typeof data === 'boolean'`), it previously returned `false` **immediately without checking `expectedHash`** (`teacherPinHash`). Live `D2` against `get_student_exam_paper('ICM170')` showed `rawPinExposed=false` and `teacherPinHashPresent=true` (`teacherPinHash` is preserved by `022`), meaning that early return actively blocked `expectedHash` fallback whenever `019`'s `verify_teacher_unlock_pin` missed `quiz_by_code_*` or `previousCodes`. Both fixing `verify_teacher_unlock_pin` server-side in **Migration `023`** and falling through to `expectedHash` when `data === false && Boolean(expectedHash)` fix this for cloud and offline `.exam` packages alike.
- **Impact**: For any cloud quiz stored in `quiz_by_code_<CODE>` (not mirrored in `published_quizzes`), or opened under a `previousCodes` alias, or offline `.exam` packages checked while online, **invigilator PIN unlock (`StudentQuizRunner.tsx:1370`) and emergency re-upload authorization (`3093`) fail with `Incorrect Teacher PIN` even when the PIN is right.**

### PROC-06 — `enforce_proctor_audit_guard` Client Boundary Mismatch
- **Evidence**: `022_exam_anti_tamper_and_rate_guards.sql:793-816` rejects inserts where `OCTET_LENGTH(COALESCE(NEW.detail, '')) > 1024` (`22023`), `student_id > 120`, `student_name > 120`, or `event_type` outside `2..64`.
- **Gap**: Neither `proctorAuditLogService.ts` nor `LiveInvigilatorModal.tsx` clamps UTF-8 byte lengths before `.insert(...)`. Long multi-line `detail` strings (e.g., long user-agent / multi-monitor screen summaries / announcement echoes) or fallback names/IDs >120 chars fail silently in DB insert while appearing in local memory.
- Also note: `proctorAuditLogService.ts:74-77` sends `actor: event.actor` defaulting safely, but if a student triggers >60 violation broadcasts in 10 minutes (e.g. rapid blur/focus flicker on glitchy hardware), DB inserts after #60 raise `42501`, so the student-side logger should enforce client-side deduplication/cooldown and summarize burst events locally before DB write.

### PROC-07 — High-Concurrency Broadcast Spikes & Exit/Submit Lifecycle
- **200-way `request_sync` spike**: In `StudentQuizRunner.tsx:2006-2012`, when `LiveInvigilatorModal` mounts or presses sync, all 200 students schedule `sendCurrentHeartbeatRef.current(true)` (`fullSync = true`, sending the **entire** `violations` array) across a `100ms–2500ms` window (~80–200 msgs/sec burst, hitting Supabase Free Tier Realtime message rate limits alongside regular 12–18s heartbeats).
- **`visibilitychange` + Exit Flush interaction**: `StudentQuizRunner.tsx:3312-3317` runs `flushOnExit()` on `visibilitychange === 'hidden'`, firing a `keepalive` draft save simultaneously with `handleVisibilityChange` (`1556-1561`) logging a `tab_switch` violation + reactive heartbeat (`400ms` debounce). On sudden browser/tab close, `leaveProctorSession()` (`2016`) tears down the student channel on unmount immediately without waiting for any pending `status: 'submitted'` or `lock` broadcast frame to flush, leaving the dashboard waiting up to **45–55 seconds** (`45000ms` threshold swept every `10000ms` at `LiveInvigilatorModal.tsx:461-479`) to show `offline`.

---

## 3. Live Proctoring Diagnostic Verification Plan

Before applying changes, run a dedicated diagnostic harness **`scripts/diagnose-proctoring-system.mjs`** (non-destructive, using temporary `[DIAG]` prefix / `PROCTORDIAG` synthetic code or read-only checks against existing quiz codes, cleaning up inserted rows afterward):

| Check | Target Under Test | Method & Pass/Fail Signal |
| :--- | :--- | :--- |
| **D1. Unauthenticated Command Spoof Probe** | `exam_proctor:<CODE>` | Join channel as anonymous client with no teacher session; broadcast `add_time (+120)`, `unlock`, and `force_submit` frames; verify whether student listener accepts unverified commands (**expected pre-fix: FAIL / VULNERABLE**). |
| **D2. `verify_teacher_unlock_pin` Parity Check** | `019` RPC vs `022` paper resolution | Call `verify_teacher_unlock_pin` for quiz codes resolved via `published_quizzes`, `quiz_by_code_*`, and `previousCodes`; confirm exact mismatch cases. |
| **D3. Audit Persistence Under Closed Dashboard** | `proctor_audit_events` + `022` trigger | Simulate student firing violation/lockout with **no** `LiveInvigilatorModal` subscriber attached; query `proctor_audit_events` as authenticated teacher to verify zero discrete rows recorded unless submitted (**confirms PROC-03**). |
| **D4. `022` Audit Guard Boundary Check** | `enforce_proctor_audit_guard` | Probe `1025`-byte `detail`, `121`-char `student_name`, `actor='invigilator'` as anon, and >60 events/10min bursts; verify SQL error codes `22023` / `42501` and clean client handling. |
| **D5. Expired Teacher Session Silent-Failure Probe** | `LiveInvigilatorModal` auth behavior | Query `proctor_audit_events` & `quiz_submissions` with an expired/missing `x-teacher-session` token; confirm PostgREST returns `200 []` with zero error vs explicit `is_authenticated_teacher()` preflight returning `false`. |
| **D6. 200-Student Realtime Fan-Out & `request_sync` Benchmark** | Supabase Realtime Broadcast | Connect 1 dashboard + 200 concurrent student WebSocket sockets on synthetic `DIAG200` channel; measure heartbeat receipt rate, `request_sync` 2.5s burst drop %, and memory/render batching under `300ms` flush. |
| **D7. Offline / Stale-Closure Logic Unit Checks** | `StudentQuizRunner.tsx` command handler | Source/state-machine verification for `isFinalSecurityLock`, penalized `targetEndTime`, and `force_submit` telemetry freshness. |

---

## 4. Phased Hardening & Remediation Plan

### Regression & Tripwire Guardrails (Do Not Break Existing Verification Suites)
Before editing code, any remediation **must** preserve the following source-regex tripwires and unit contracts asserted by `scripts/verify-proctor-remote-unlock.mjs` and `scripts/test-proctor-p1-p2-p3.mjs`:
- **`scripts/verify-proctor-remote-unlock.mjs` (`lines 31–85`)**:
  - `handleCommand` in `StudentQuizRunner.tsx` is regex-parsed with `if (cmd.type === 'unlock') { ... } else if` and `else if (cmd.type === 'pardon') { ... } else if`.
  - Keep those exact branch shapes and keep literal setter/ref calls inside their bodies: `setIsLockedByProctor(false)`, `setLockReason('')`, `setLockTime('')`, `fullscreenExitCountRef.current = 0`, `setFullscreenExitCount(0)`, `setIsFullscreenGraceActive(false)`, `setFullscreenGraceSecondsLeft(5)`, `requestSecureFullscreen().catch(...)`, and `setViolations([])` (inside `pardon`).
- **`scripts/test-proctor-p1-p2-p3.mjs` (`lines 121–160`)**:
  - **Do NOT change `recentViolationsSlice(violations, true)` behavior** in `src/lib/proctorGuards.ts` (`line 126` asserts `recentViolationsSlice(violations, true).length === 40` for a 40-item input). Cap `fullSync` violation slices at the call site in `StudentQuizRunner.tsx` if needed (e.g., `recentViolationsSlice(s.violations, false, fullSync ? 20 : 5)`), keeping `recentViolationsSlice` pure contract intact.
  - Keep existing `examProctorRealtimeService.ts` identifiers (`pendingStudentPayloads`, `flushStudentQueue`, `pendingHostCommands`, `flushHostQueue`, `violation dropped: channel/quiz mismatch`, `export function leaveProctorSession(expectedToken?: string)`, `expectedToken !== activeSessionToken`).
  - Keep `LiveInvigilatorModal.tsx` patterns (`lastHeartbeat: Date.now()`, `>= 4` calls to `recordProctorAuditEvent(`, `loadProctorAuditEvents(codes)`).
  - Keep `StudentQuizRunner.tsx` patterns (`getCanonicalProctorStudentId({`, `proctorStudentId: sessionHash`, `sendCurrentHeartbeatRef.current(true)`).
- **`021` RLS `proctor_audit_events` Insert-Only Policy for Students (`021:1248-1250`)**:
  - Anonymous students ONLY have `FOR INSERT WITH CHECK (actor = 'student')` (no `SELECT` or `UPDATE` policy). **Never** use `.upsert(..., { onConflict: 'id', ignoreDuplicates: true })` from student/shared audit paths — PostgREST `ON CONFLICT DO NOTHING` / `UPSERT` triggers `SELECT`/`UPDATE` RLS checks that fail with `42501` for students.

### Phase A — Client Correctness, Audit Completeness & UI Visibility (No Schema Changes)

1. **Fix `handleCommand` Closure Staleness (`StudentQuizRunner.tsx`)**:
   - Create `latestCommandStateRef` mirroring `isFinalSecurityLock`, `targetEndTime`, `timeLeft`, `quizStats`, `currentIndex`, `violations`, `strikeCount`, `activeLockedTier`, `totalPenaltySeconds`, `candidateName`, `candidateNumber`, `candidateClass`. Also keep `isFinalSecurityLockRef.current` directly checked (`isFinalSecurityLockRef.current` already exists at lines `548-549`!).
   - Inside `handleCommand`, preserve the exact `if (cmd.type === 'unlock') { ... } else if ...` and `else if (cmd.type === 'pardon') { ... } else if` tripwire blocks while reading `isFinalSecurityLockRef.current` and `latestCommandStateRef.current` (`targetEndTime`, `timeLeft`, `answeredItems`, `violations`, `strikeCount`, etc.), guaranteeing `isFinalSecurityLock` actually blocks remote unlock/pardon and `force_submit` reports live progress & strikes.
2. **Wire Unconnected `src/lib/proctorGuards.ts` Helpers into `StudentQuizRunner.tsx`**:
   - Import and enforce `isAllowedProctorCommand(cmd?.type)`, `claimCommandId(executedCommandIdsRef.current, cmd?.id)` (preventing duplicate `add_time` applications on retries/replays), `clampAddTimeMinutes(cmd.minutes)` (blocking negative/unbounded time mutations), `sanitizeAnnouncement(cmd.message)` (500-char cap), and `recentViolationsSlice` inside `StudentQuizRunner.tsx`.
3. **Direct Student-Side Audit Logging, Canonical ID Propagation & Deduplication (`StudentQuizRunner.tsx`, `examProctorRealtimeService.ts`, `proctorAuditLogService.ts`, `LiveInvigilatorModal.tsx`)**:
   - Extend `ProctorLogEvent` (`examProctorRealtimeService.ts:76-100`) with optional `studentId?: string` and `candidateClass?: string`, and populate both in `sendStudentViolation` (`254-264`).
   - Update `LiveInvigilatorModal.tsx:410-416` (`handleLogEvent`) to prefer `enriched.studentId` when present, or compute `getCanonicalProctorStudentId` **with** `studentClass: enriched.candidateClass` so student and dashboard produce the exact same canonical `student_id`.
   - Pass a deterministic client event `id` from `StudentQuizRunner.tsx` / `sendStudentViolation` and invoke `recordProctorAuditEvent({ id, ..., actor: 'student' })` directly on the student side when a violation occurs so events survive even when no dashboard is open.
   - Keep plain `.insert(...)` in `proctorAuditLogService.ts` (never `.upsert()`!) and treat PostgreSQL `23505` (duplicate primary key when both student and invigilator record the same event `id`) as a quiet no-op, while keeping `42501` / `22023` diagnostics reportable to callbacks/banner state.
   - Add `recordProctorAuditEvent({ actor: 'invigilator', studentId: targetClass ? 'ALL::' + targetClass : 'ALL', ... })` to `handleScopedUnlockAll` (`991-1044`) and `handleScopedAddTime` (`1047-1108`) in `LiveInvigilatorModal.tsx`, guaranteeing a non-empty `student_id` (`NOT NULL`).
   - Add client-side UTF-8 byte clamping in `proctorAuditLogService.ts` (`<= 960` UTF-8 bytes for `detail`, `<= 120` chars for `studentId`/`studentName`, `2..64` chars for `eventType`) so `022` trigger `22023` errors never discard valid long logs.
4. **Invigilator Session Health Banner (`LiveInvigilatorModal.tsx`)**:
   - On modal mount and periodically (or whenever `loadAndSyncAllSubmissions` / `loadProctorAuditEvents` / `recordProctorAuditEvent` fails with `42501`), check `supabase.rpc('is_authenticated_teacher')`.
   - Display a persistent top warning banner when the teacher session is missing/expired: *"Cloud invigilator session expired — live edits and cloud logs are paused until you re-authenticate."*
5. **Smooth 200-Student Realtime Bursts (`StudentQuizRunner.tsx`, `LiveInvigilatorModal.tsx`)**:
   - Widen `onSyncRequested` jitter from `100ms–2500ms` to `200ms–8000ms` and cap `fullSync` violation telemetry at the call site via `recentViolationsSlice(s.violations, false, fullSync ? 20 : 5)` (leaving `proctorGuards.ts` intact).
   - Fire an explicit `offline`/`submitted` beacon heartbeat before `leaveProctorSession()` on intentional unmount / submit (and verify `document.hidden` exit flush + `tab_switch` listener don't race adversely).

### Phase B — Database & Cryptographic Command Authentication (`023_proctor_security_and_pin_parity.sql`)

1. **Fix `verify_teacher_unlock_pin(p_quiz_code TEXT, p_pin TEXT)` Parity (`019` → `023`) + Offline Fallback (`quizCodeService.ts`)**:
   - Update RPC resolution order identically with `get_student_exam_paper` (`022`):
     1. Check `app_config` key `'quiz_by_code_' || UPPER(TRIM(p_quiz_code))` first.
     2. Fall back to `'published_quizzes'` array matching `quizCode` **or** `previousCodes`.
     3. Compare against `COALESCE(NULLIF(TRIM(v_quiz->>'teacherPin'), ''), NULLIF(TRIM(v_quiz->'headerConfig'->>'teacherPin'), ''))`.
   - Keeping `expectedHash` fallback in `quizCodeService.ts` when `data === false && Boolean(expectedHash)` ensures hashed PIN verification (`teacherPinHash`) still unlocks both cloud papers (where `teacherPinHash` is preserved by `022`) and offline `.exam` packages, while updating `verify_teacher_unlock_pin` server-side in Migration `023` fixes raw/admin RPC verification across all lookup paths.
2. **Eliminate Unauthenticated `proctor_cmd` Spoofing (Two Options for User Choice)**:
   - **Recommended Option B1 — Backward-Compatible Signed Ephemeral Proctor Commands (ECDSA P-256 via WebCrypto)**:
     - Add a lightweight `proctor_channel_keys` table (or scoped `app_config` / RPC pair):
       - `register_proctor_public_key(p_quiz_code TEXT, p_key_id TEXT, p_public_jwk JSONB)` (`SECURITY DEFINER`, gated by `is_authenticated_teacher()`) stores the teacher dashboard's ephemeral WebCrypto ECDSA P-256 public JWK for that live session.
       - `get_proctor_public_key(p_quiz_code TEXT, p_key_id TEXT)` (`SECURITY DEFINER`, `GRANT EXECUTE TO anon, authenticated`) returns only public JWK + `is_active` for `(quizCode, keyId)` — zero private key ever leaves memory!
     - `LiveInvigilatorModal` signs every `{ id, type, quizCode, targetStudentId, targetClass, minutes, message, issuedAt, keyId }` command using `crypto.subtle.sign('ECDSA', ...)` and attaches `keyId` + `sig`.
     - `StudentQuizRunner` verifies `cmd.sig` against the cached public JWK from `get_proctor_public_key`, checks `issuedAt` freshness (`±5 min` window), and runs `claimCommandId` replay protection.
     - **Backward compatibility**: If Migration `023` is not yet deployed (`get_proctor_public_key` RPC fails with SQLSTATE `42883` undefined function / 404 in dev/offline mode), degrade gracefully if configured for legacy fallback; once `023` is live, strictly reject any unsigned or invalidly signed `proctor_cmd`.
   - **Alternative Option B2 — Server-Authorized DB Command Queue + Postgres Changes (`proctor_commands` table)**:
     - Teacher calls `issue_proctor_command(...)` RPC (`is_authenticated_teacher()`) inserting into `proctor_commands` table; students subscribe via `postgres_changes` or short poll. (Simpler cryptography, but uses DB Realtime replication quota and adds ~300–800ms latency.)

---

## 5. Verification Criteria Before Sign-Off

1. Existing regression suites pass (`npm run test:phase1-security`, `npm run test:phase2-security`, `npm run test:phase25-security`, `node --import ./scripts/register-ts.mjs scripts/test-proctor-p1-p2-p3.mjs`, `node scripts/verify-proctor-remote-unlock.mjs`, `npm run build`).
2. New live diagnostic suite `scripts/diagnose-proctoring-system.mjs` demonstrates:
   - Unauthenticated/unsigned `proctor_cmd` (`unlock`, `add_time`, `force_submit`) rejected **100%**.
   - Client command guards (`claimCommandId`, `clampAddTimeMinutes`, `isAllowedProctorCommand`, `sanitizeAnnouncement`) block replays and negative/oversized payloads in `StudentQuizRunner.tsx`.
   - `verify_teacher_unlock_pin` succeeds for `published_quizzes`, `quiz_by_code_*`, and `previousCodes`.
   - Student lockout with **no dashboard open** leaves complete, byte-safe, canonically keyed `actor='student'` audit rows in `proctor_audit_events` (and concurrent `23505` inserts never fall back to `.upsert()` / fail `42501`).
   - Bulk invigilator actions log non-null `student_id` (`ALL` / `ALL::<class>`) rows to `proctor_audit_events`.
   - Expired teacher session surfaces explicit re-auth warning instead of silent empty state.
   - 200 concurrent simulated proctor clients complete `request_sync` + heartbeats cleanly without duplicate candidate cards or dropped commands.

