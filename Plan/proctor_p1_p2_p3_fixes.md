# Diagnostic Findings & Remediation Plan: Live Proctor P1, P2, and P3 Issues (`Plan/proctor_p1_p2_p3_fixes.md`)

> **Status:** Implemented 2026-11-06 — see §6 for the implementation record and verification  
> **Created:** 2026-11-06  
> **Scope:** P1, P2, and P3 Live Proctoring Reliability, State Reconciliation, Rate Limiting, and Audit Persistence  
> **Target Files:** [`src/services/examProctorRealtimeService.ts`](file:///c:/testmaker/src/services/examProctorRealtimeService.ts), [`src/pages/StudentQuizRunner.tsx`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx), [`src/components/LiveInvigilatorModal.tsx`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx), [`src/services/quizSubmissionService.ts`](file:///c:/testmaker/src/services/quizSubmissionService.ts), [`src/utils/examSecurityUtils.ts`](file:///c:/testmaker/src/utils/examSecurityUtils.ts)

---

## 1. Executive Summary

Following the security and reliability review of the Live Invigilator subsystem, all reported **P1**, **P2**, and **P3** issues were audited against the codebase and confirmed. This document details the exact root causes, line-by-line code evidence, and the concrete engineering plan to resolve every P1, P2, and P3 defect without breaking the 200+ concurrent student budget on the Supabase Free Tier.

| Priority | Issue ID | Summary | Primary Files & Lines |
| :--- | :--- | :--- | :--- |
| **P1** | **P1-A** | Presence computed from student's clock (`lastHeartbeat` skew & spoofing) | [`examProctorRealtimeService.ts:154`](file:///c:/testmaker/src/services/examProctorRealtimeService.ts#L154), [`LiveInvigilatorModal.tsx:265, 338`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx#L265) |
| **P1** | **P1-B** | Duplicate candidate rows (`sessionHash` with `startTime` vs. `name_number` submission key) | [`StudentQuizRunner.tsx:535-537`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L535-L537), [`LiveInvigilatorModal.tsx:152, 190, 263`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx#L152) |
| **P1** | **P1-C** | Live events and teacher interventions (`unlock`, `add_time`, `pardon`) lost on dashboard reload | [`LiveInvigilatorModal.tsx:272-317, 685-785`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx#L685-L785) |
| **P2** | **P2-A** | Fire-and-forget `channel.send()` and dropped events prior to `SUBSCRIBED` | [`examProctorRealtimeService.ts:137-187, 294`](file:///c:/testmaker/src/services/examProctorRealtimeService.ts#L137-L187) |
| **P2** | **P2-B** | Unvalidated telemetry & monotonic strike regression (plus unbounded/negative `add_time`) | [`StudentQuizRunner.tsx:1275`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L1275), [`LiveInvigilatorModal.tsx:237-270`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx#L237-L270) |
| **P2** | **P2-C** | No per-student rate limits on heartbeats or log events (250-entry ring buffer flooding) | [`examProctorRealtimeService.ts:231-245`](file:///c:/testmaker/src/services/examProctorRealtimeService.ts#L231-L245), [`LiveInvigilatorModal.tsx:309-317`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx#L309-L317) |
| **P3** | **P3-1** | No command deduplication by `cmd.id` (`add_time` applied multiple times on retry) | [`StudentQuizRunner.tsx:1263-1328`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L1263-L1328) |
| **P3** | **P3-2** | Every heartbeat carries the full `recentViolations` array ($O(N)$ payload growth) | [`StudentQuizRunner.tsx:1256, 1414`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L1414) |
| **P3** | **P3-3** | `sendStudentViolation` ignores its `_quizCode` parameter | [`examProctorRealtimeService.ts:161-187`](file:///c:/testmaker/src/services/examProctorRealtimeService.ts#L161-L187) |
| **P3** | **P3-4** | Module-level singleton `studentChannel` tears down active session across tabs | [`examProctorRealtimeService.ts:86, 98-104, 192-199`](file:///c:/testmaker/src/services/examProctorRealtimeService.ts#L86) |

---

## 2. P1 Findings & Fixes Plan

### P1-A: Presence Computed from the Student's Clock

#### 1. Root Cause Diagnosis
- In [`src/services/examProctorRealtimeService.ts:154`](file:///c:/testmaker/src/services/examProctorRealtimeService.ts#L154):
  ```ts
  studentChannel.send({
    type: 'broadcast',
    event: 'student_heartbeat',
    payload: { ...state, lastHeartbeat: Date.now() }, // <-- Student's local clock
  });
  ```
- In [`src/components/LiveInvigilatorModal.tsx:261-269`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx#L261-L269), `handleHeartbeat` stores the incoming `student` object without overwriting `lastHeartbeat`.
- In [`src/components/LiveInvigilatorModal.tsx:338`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx#L338), the 10-second offline sweep compares the teacher's `Date.now()` against the student's `s.lastHeartbeat`:
  ```ts
  if (s.status !== 'submitted' && s.status !== 'offline' && now - s.lastHeartbeat > 45000) {
    next[id] = { ...s, status: 'offline' };
  }
  ```
- **Failure Mode**:
  1. If a student's Windows laptop clock is $>45\text{s}$ behind the invigilator's laptop (common in school labs with restricted NTP), `now - s.lastHeartbeat` is always $>45000$, causing the student to flip to `offline` every 10 seconds despite actively sending heartbeats.
  2. If a student's clock is set ahead (or spoofed to `Date.now() + 3_600_000`), `now - s.lastHeartbeat` is negative, so the student appears `active` forever even after closing their browser.

#### 2. Remediation Plan
- **File 1: [`src/services/examProctorRealtimeService.ts`](file:///c:/testmaker/src/services/examProctorRealtimeService.ts)**
  - Add optional `clientTimestamp?: number` to `ProctorStudentState` for diagnostic drift visibility if needed, while stamping `lastHeartbeat: Date.now()` on the **receiving** side inside `subscribeMultiProctorDashboard` (lines 231–237):
    ```ts
    ch.on('broadcast', { event: 'student_heartbeat' }, ({ payload }) => {
      const student = payload as ProctorStudentState;
      const receivedAt = Date.now();
      callbacks.onHeartbeat({
        ...student,
        clientTimestamp: student.lastHeartbeat,
        lastHeartbeat: receivedAt, // Authoritative teacher receipt time
        quizCode: (student.quizCode || code).toUpperCase(),
      });
    });
    ```
- **File 2: [`src/components/LiveInvigilatorModal.tsx`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx)**
  - In `handleHeartbeat` (line 265), ensure `lastHeartbeat: Date.now()` is always set to the dashboard's local monotonic receipt time before buffering into `pendingHeartbeatsRef.current[compKey]`.

---

### P1-B: The Same Candidate Appears Twice (Key Mismatch)

#### 1. Root Cause Diagnosis
Three different places compute student dictionary keys differently:
1. **Live Student Client ([`src/pages/StudentQuizRunner.tsx:535-537`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L535-L537))**:
   ```ts
   const sessionHash = useMemo(() => {
     return formatSessionHash(`${candidateName}_${candidateNumber}_${resolvedQuizCode}_${startTime}`);
   }, [candidateName, candidateNumber, resolvedQuizCode, startTime]);
   ```
   This produces a 6-character hex string like `"7F3C9A"`, so live heartbeats in `LiveInvigilatorModal.tsx:263` use key:
   ```text
   "CHEM-1A2B::7F3C9A"
   ```
   Furthermore, because `startTime` is baked into the hash seed, if a student refreshes without `startTime` restoring identically before `sessionHash` evaluates, a new hash `"2B91E0"` is generated, leaving the old row orphaned as `offline`.
2. **Local & Cloud Submission Backfill ([`src/components/LiveInvigilatorModal.tsx:152-154, 190-191`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx#L152-L154))**:
   ```ts
   const rawId = (sub.candidateNumber ? `${sub.studentName}_${sub.candidateNumber}` : sub.studentName) || sub.id;
   const compositeKey = `${qCode}::${rawId}`;
   ```
   This produces key:
   ```text
   "CHEM-1A2B::Ahmad Fauzi_0012"
   ```
3. **Result**:
   When Ahmad submits his exam (or when `loadAndSyncAllSubmissions` runs), `students` contains **both** `"CHEM-1A2B::7F3C9A"` and `"CHEM-1A2B::Ahmad Fauzi_0012"`, and `Object.values(students)` (line 363) renders two cards for the same candidate.

#### 2. Remediation Plan
- **Step 1: Define One Canonical Student Identifier in [`src/utils/examSecurityUtils.ts`](file:///c:/testmaker/src/utils/examSecurityUtils.ts)**:
  ```ts
  /**
   * Produces a deterministic, collision-resistant canonical student ID for a quiz sitting.
   * Normalizes name, candidateNumber, and class (excluding startTime so reloads and
   * final submissions resolve to the exact same key).
   */
  export function getCanonicalProctorStudentId(params: {
    quizCode?: string;
    studentName?: string;
    candidateNumber?: string;
    studentClass?: string;
  }): string {
    const norm = (s?: string) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const code = (params.quizCode || '').trim().toUpperCase();
    const name = norm(params.studentName) || 'candidate';
    const num = norm(params.candidateNumber);
    const cls = norm(params.studentClass);
    // Prefer candidateNumber + name when available; include class to disambiguate same-name students across cohorts
    const identity = num ? `${name}#${num}` : cls ? `${name}@${cls}` : name;
    return `cand_${formatSessionHash(`${code}::${identity}`)}`;
  }
  ```
- **Step 2: Use `getCanonicalProctorStudentId` Everywhere**:
  1. [`src/pages/StudentQuizRunner.tsx:535`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L535): Replace `sessionHash` seed with `getCanonicalProctorStudentId({ quizCode: resolvedQuizCode, studentName: candidateName, candidateNumber, studentClass: candidateClass })`.
  2. [`src/services/quizSubmissionService.ts:396`](file:///c:/testmaker/src/services/quizSubmissionService.ts#L396): Add `proctorStudentId?: string` to `ExamForensics` (and save it when building the submission in `StudentQuizRunner.tsx`).
  3. [`src/components/LiveInvigilatorModal.tsx:152, 190`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx#L152): Compute `const rawId = sub.forensics?.proctorStudentId || getCanonicalProctorStudentId({ quizCode: qCode, studentName: sub.studentName, candidateNumber: sub.candidateNumber, studentClass: sub.studentClass });`.
  4. **Legacy Migration Guard in `LiveInvigilatorModal.tsx:237`**: When merging heartbeats or cloud submissions, also check if an older entry with the same normalized `(quizCode, studentName, candidateNumber)` exists under a legacy key and migrate/deduplicate it in-place.

---

### P1-C: Live Events & Teacher Interventions Are Lost on Dashboard Reload

#### 1. Root Cause Diagnosis
- In [`src/components/LiveInvigilatorModal.tsx:685-785`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx#L685-L785), teacher interventions (`handleUnlock`, `handleAddTime`, `handleForceSubmit`, `handlePardon`) only call `setLogEvents((prev) => [...])` in local component state.
- Student violations (`proctor_log_event`) only live in `logEvents` React state and inside the student's in-memory `recentViolations` array until the exam is submitted.
- If the teacher closes and reopens `LiveInvigilatorModal` (or refreshes the browser), all teacher intervention records (`unlocked`, `+5m time_extended`, `pardon`) vanish, and if a student cleared or modified their memory, prior violations are gone.

#### 2. Remediation Plan (Zero Heartbeat DB Overhead)
To keep 15-second heartbeats 100% free of database writes while making **discrete security violations and teacher interventions durable**:

1. **Durable Proctor Event Log Service (`src/services/proctorAuditLogService.ts` + Migration `018_proctor_audit_events.sql`)**:
   - Create a lightweight table `public.proctor_audit_events`:
     ```sql
     CREATE TABLE IF NOT EXISTS public.proctor_audit_events (
       id TEXT PRIMARY KEY,
       quiz_code TEXT NOT NULL,
       student_id TEXT NOT NULL,
       student_name TEXT NOT NULL,
       candidate_number TEXT,
       candidate_class TEXT,
       event_type TEXT NOT NULL,
       severity TEXT NOT NULL DEFAULT 'warning',
       detail TEXT NOT NULL,
       actor TEXT NOT NULL DEFAULT 'student', -- 'student' | 'invigilator'
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     );
     CREATE INDEX IF NOT EXISTS idx_proctor_audit_quiz_code ON public.proctor_audit_events (quiz_code, created_at DESC);
     ```
   - **Write Path**:
     - Only discrete events (a student triggering a strike or a teacher clicking `Unlock`, `+5m`, `Pardon`, `Force Submit`, `Announce`) insert a row asynchronously (and mirror to `localStorage` under `testmaker_proctor_audit_log`).
     - Periodic heartbeats **never** touch this table.
   - **Read / Hydrate Path (`LiveInvigilatorModal.tsx`)**:
     - On modal mount (`useEffect` at line 142), immediately hydrate `logEvents` from `localStorage` + `proctor_audit_events` for all `monitoredQuizzes`, deduplicating by `event.id`.
2. **Student-Side Forensic Audit Trail (`StudentQuizRunner.tsx` & `quizSubmissionService.ts`)**:
   - Add `invigilatorActions?: Array<{ id: string; type: ProctorCommandType; detail: string; timestamp: string }>` to `ExamForensics` (`src/services/quizSubmissionService.ts:396`).
   - Whenever `handleCommand` in `StudentQuizRunner.tsx:1263` executes `unlock`, `add_time`, `pardon`, or `force_submit`, append the command record to `invigilatorActions` so the final submitted paper permanently carries the full history of teacher interventions alongside `proctoringLogs`.

---

## 3. P2 Findings & Fixes Plan

### P2-A: Fire-and-Forget Delivery & Pre-Subscribe Event Loss

#### 1. Root Cause Diagnosis
- In [`src/services/examProctorRealtimeService.ts:137-141`](file:///c:/testmaker/src/services/examProctorRealtimeService.ts#L137-L141):
  ```ts
  studentChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      sendStudentHeartbeat(initialState);
    }
  });
  ```
- Neither `sendStudentHeartbeat` (line 151), `sendStudentViolation` (line 179), nor `sendProctorCommand` (line 294) checks whether the channel has reached `'SUBSCRIBED'`, nor do they inspect the Promise returned by `channel.send(...)` (`'ok' | 'timed out' | 'error'`).
- Any violation triggered in the first 500–2000ms while the WebSocket handshake is still `JOINING` is silently discarded.

#### 2. Remediation Plan
- In [`src/services/examProctorRealtimeService.ts`](file:///c:/testmaker/src/services/examProctorRealtimeService.ts):
  1. Track subscription state:
     - `let isStudentSubscribed = false;`
     - `let pendingStudentPayloads: Array<{ event: string; payload: any }> = [];` (capped at 50 items; for `student_heartbeat`, only keep the latest state in the queue so stale heartbeats aren't stacked).
     - `const hostSubscribedMap = new Map<string, boolean>();`
     - `const pendingHostCommands = new Map<string, ProctorCommand[]>();`
  2. Create a resilient sender helper:
     ```ts
     async function sendBroadcastWithRetry(
       channel: RealtimeChannel,
       event: string,
       payload: unknown,
       maxAttempts = 3
     ): Promise<boolean> {
       for (let attempt = 1; attempt <= maxAttempts; attempt++) {
         try {
           const status = await channel.send({ type: 'broadcast', event, payload });
           if (status === 'ok') return true;
         } catch {}
         if (attempt < maxAttempts) {
           await new Promise((r) => setTimeout(r, 400 * attempt));
         }
       }
       return false;
     }
     ```
  3. If `isStudentSubscribed === false`, enqueue the message into `pendingStudentPayloads` and flush all queued messages in order as soon as `status === 'SUBSCRIBED'` fires. Apply the same queue-until-subscribed pattern to `hostChannels` for `proctor_cmd`.

---

### P2-B: Self-Reported Telemetry Validation & Monotonic Strike Tracking

#### 1. Root Cause Diagnosis
- **On the Student Side ([`src/pages/StudentQuizRunner.tsx:1275`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L1275))**:
  - `const extraSec = (cmd.minutes || 5) * 60;` trusts `cmd.minutes` without bounds checking. A negative number subtracts time; `NaN` or `Infinity` corrupts `timeLeft`.
- **On the Teacher Dashboard ([`src/components/LiveInvigilatorModal.tsx:237-270`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx#L237-L270))**:
  - `pendingHeartbeatsRef` overwrites the student's state with whatever numbers the student payload claims. If a student reloads or tampers with client state to report `violationsCount: 0` after previously having `3` strikes (without a teacher `pardon`), the dashboard blindly lowers their violation count to `0`.

#### 2. Remediation Plan
1. **Strict Command Validation in [`src/pages/StudentQuizRunner.tsx:1263`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L1263)**:
   - Validate `cmd.type` against an explicit allowlist: `const VALID_CMD_TYPES = new Set(['unlock', 'add_time', 'force_submit', 'announcement', 'pardon']);`.
   - Clamp `add_time` minutes strictly to `[1, 120]` integer minutes:
     ```ts
     const rawMin = Number(cmd.minutes);
     const safeMinutes = Number.isFinite(rawMin) ? Math.max(1, Math.min(120, Math.round(rawMin))) : 5;
     const extraSec = safeMinutes * 60;
     ```
   - Truncate `announcement` message strings to 500 characters max.
2. **Telemetry Sanitization & Monotonic Violation High-Water Mark in [`src/components/LiveInvigilatorModal.tsx`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx)**:
   - Maintain `pardonedAtMapRef = useRef<Record<string, number>>({})` when the teacher clicks `Pardon`.
   - When merging an incoming heartbeat for `compKey` (lines 237–245):
     - Clamp `answeredCount` to `[0, Math.max(1, quizTotalQuestions)]`.
     - Clamp `timeLeftSeconds` to `[0, 86400]`.
     - **High-Water Mark on Strikes**: Unless `compKey` was explicitly pardoned by the teacher since the previous heartbeat, enforce:
       ```ts
       violationsCount: Math.max(existing?.violationsCount || 0, Math.max(0, Number(student.violationsCount) || 0))
       ```
       so a student client can never self-decrement its strike counter on the invigilator's screen.

---

### P2-C: Per-Student Rate Limits & Log Flood Protection

#### 1. Root Cause Diagnosis
- In [`src/components/LiveInvigilatorModal.tsx:309-317`](file:///c:/testmaker/src/components/LiveInvigilatorModal.tsx#L309-L317), every incoming `proctor_log_event` is prepended directly to the global 250-item `logEvents` array.
- A malfunctioning or malicious client sending 300 events in 1 second completely flushes out legitimate violation logs from all other 199 students in the exam hall.

#### 2. Remediation Plan
- Add a lightweight per-student sliding-window rate limiter inside [`src/services/examProctorRealtimeService.ts`](file:///c:/testmaker/src/services/examProctorRealtimeService.ts) (on the host listener side, lines 231–245):
  - **Heartbeat Throttle**: Track `lastHeartbeatAtByStudent = new Map<string, number>()`. Ignore heartbeats arriving $<1000\text{ms}$ after the previous beat from the same `studentId` unless `status === 'submitted'` or `status === 'locked'`.
  - **Log Event Rate Limit**: Track `logWindowByStudent = new Map<string, { windowStart: number; count: number; warned: boolean }>()`:
    - Allow at most **5 log events per 10-second window** per student.
    - If a student exceeds 5 events in 10 seconds, drop subsequent events in that window and emit a single consolidated warning event (`"Telemetry rate limit exceeded for candidate — throttling noisy event stream"`).

---

## 4. P3 Findings & Fixes Plan

### P3-1: Command Deduplication by `cmd.id`
- **Problem**: [`StudentQuizRunner.tsx:1263`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L1263) does not track executed `cmd.id` values. With P2-A retry logic enabled (or duplicate WebSocket delivery), a retried `add_time` command would add $+5\text{m}$ twice.
- **Fix**:
  - Add `const executedCommandIdsRef = useRef<Set<string>>(new Set());` in `StudentQuizRunner.tsx`.
  - At the top of `handleCommand(cmd)`:
    ```ts
    if (!cmd || !cmd.id || executedCommandIdsRef.current.has(cmd.id)) return;
    executedCommandIdsRef.current.add(cmd.id);
    ```

### P3-2: Bounded `recentViolations` in Heartbeats ($O(1)$ Payload Size)
- **Problem**: [`StudentQuizRunner.tsx:1256, 1414`](file:///c:/testmaker/src/pages/StudentQuizRunner.tsx#L1414) maps the **entire** `s.violations` array into every 15-second heartbeat.
- **Fix**:
  - Add a parameter `includeFullHistory = false` to `sendCurrentHeartbeat(includeFullHistory?: boolean)`.
  - On regular 15-second heartbeats, send only the **last 5 violations**:
    ```ts
    const violationsSlice = includeFullHistory ? s.violations : s.violations.slice(-5);
    ```
  - Pass `includeFullHistory = true` only inside `onSyncRequested` (`StudentQuizRunner.tsx:1336`) and on final submission.

### P3-3: `sendStudentViolation` Ignores `_quizCode` Parameter
- **Problem**: [`examProctorRealtimeService.ts:161-187`](file:///c:/testmaker/src/services/examProctorRealtimeService.ts#L161-L187) accepts `_quizCode: string` (unused) and relies solely on `studentState.quizCode`.
- **Fix**:
  - Normalize `const normalizedCode = (quizCode || studentState.quizCode || '').trim().toUpperCase();`.
  - Verify `currentQuizCode === normalizedCode` before sending on `studentChannel`, and set `quizCode: normalizedCode` on `eventPayload` and the follow-up heartbeat.

### P3-4: Multi-Tab / Session-Scoped Channel Lifecycle
- **Problem**: [`examProctorRealtimeService.ts:86`](file:///c:/testmaker/src/services/examProctorRealtimeService.ts#L86) uses a single module-level `studentChannel` without tracking which `sessionToken` owns it. If a component cleanup runs from a stale effect or secondary tab, `leaveProctorSession()` unconditionally removes the active channel.
- **Fix**:
  - Track `let activeSessionToken: string = '';` when `joinProctorSession` is called, and return a scoped cleanup token (or accept `expectedStudentId?: string` in `leaveProctorSession(expectedStudentId?)`) so a cleanup callback only tears down the channel if it still belongs to that session.

---

## 5. Verification Strategy (Once Approved for Implementation)

1. **Realtime Transport & Security Simulation Harness (`scripts/test-proctor-p1-p2-p3.mjs`)**:
   - **Clock Drift Test (P1-A)**: Simulate students with `lastHeartbeat = Date.now() - 300_000` (5 minutes behind) and `Date.now() + 3_600_000` (1 hour ahead); verify dashboard stamps `receivedAt` and transitions both to `offline` after 45s of silence.
   - **Canonical ID Reconciliation Test (P1-B)**: Simulate a student joining live (`handleHeartbeat`), reloading the page with a new `startTime`, and then submitting (`loadAndSyncAllSubmissions`); assert `Object.keys(students).length === 1` with zero duplicate rows.
   - **Audit Persistence Test (P1-C)**: Trigger `unlock`, `add_time`, and `pardon`, simulate a dashboard unmount/remount, and assert all intervention events and student strike counts are restored.
   - **Pre-Subscribe Buffer & Retry Test (P2-A)**: Emit a violation before `SUBSCRIBED` fires and simulate a failed first `channel.send()`; assert the event is buffered, retried, and delivered once subscribed.
   - **Bounds, High-Water Mark & Rate-Limit Test (P2-B, P2-C, P3-1, P3-2)**:
     - Send `add_time` with `minutes: -50` and duplicate `cmd.id`; assert time increases once by `+1m` (clamped) and the duplicate `cmd.id` is ignored.
     - Send 50 log events in 1 second from one student; assert the rate limiter caps accepted events at 5 + 1 throttle notice without evicting other students' logs.
2. **Production Build Verification**:
   - Run `npm.cmd run build` (`tsc -b && vite build`) to ensure zero TypeScript or bundling errors.

---

## 6. Review & Implementation Record (2026-11-06)

### 6.1 Review — one plan defect found before implementation

**The canonical id as specified would have merged different candidates.** Step 1 proposed
`cand_${formatSessionHash(`${code}::${identity}`)}`, but `formatSessionHash`
(`examSecurityUtils.ts:7`) is a 32-bit rolling hash whose result is cut to its **first six** hex
characters — it discards the low bits that distinguish near-identical inputs. Measured:

```text
cand_D880F1   ← candidateNumber "0012"
cand_D880F1   ← candidateNumber "0013"   ← same row for two different students
```

So the plan's key function would have re-created the duplicate/merge problem it was meant to fix,
and silently merged every candidate whose number differs only in trailing digits. Replaced with a
two-seed FNV-1a digest (12 hex chars): 500 sequential candidate numbers now produce 500 distinct ids.
`formatSessionHash` itself is untouched — it is only a display/watermark code.

### 6.2 What was implemented

| ID | Change |
|---|---|
| **P1-A** | `stampHeartbeatReceipt()` stamps `lastHeartbeat` with the **receiver's** clock and keeps the sender's value as `clientTimestamp`. Applied in the service and again in the dashboard merge. The 45 s offline sweep now measures silence, not clock agreement. |
| **P1-B** | `getCanonicalProctorStudentId()` (quiz + name + number/class, no `startTime`) is used by the student runner, by both dashboard hydration paths, and by heartbeats. `proctorStudentId` is written into `ExamForensics`, so a submitted record resolves to the live row. Legacy/duplicate keys for the same name+number are retired on merge. |
| **P1-C** | New `proctor_audit_events` table (`018_proctor_audit_events.sql`) + `proctorAuditLogService` writing every student violation and every teacher intervention (`unlock`, `add_time`, `force_submit`, `pardon`) with a local-storage mirror. The dashboard rehydrates the log on mount (`loadProctorAuditEvents`). Inserts degrade to the local mirror when the migration has not been applied. |
| **P2-A** | `retryBroadcast()` (3 attempts, backoff) behind every send; student payloads and host commands are queued until the channel reports `SUBSCRIBED` and flushed in order (heartbeats collapse to the newest). |
| **P2-B** | Command allowlist, `clampAddTimeMinutes` (1–120, NaN→5), 500-char announcement cap, `claimCommandId` de-duplication; dashboard clamps `answeredCount`/`timeLeft`/`violations` and enforces a strike **high-water mark** that only a pardon can lower. |
| **P2-C** | Per-student heartbeat throttle (1 s, state changes bypass) and a 5-per-10 s log-event sliding window that emits **one** `rate_limit` notice per window. |
| **P3-1** | Commands applied at most once, by `cmd.id`. |
| **P3-2** | Regular heartbeats carry the last 5 violations; `proctor_sync_request` and submission carry the full history. |
| **P3-3** | `sendStudentViolation` normalises the quiz code, drops mismatched events, and stamps the code on the payload and follow-up heartbeat. |
| **P3-4** | `leaveProctorSession(expectedToken?)` only tears down the session that owns the channel; the runner passes its canonical id. |

Pure policy lives in `src/lib/proctorGuards.ts` so it is testable without a socket.

### 6.3 Verification

`node scripts/test-proctor-p1-p2-p3.mjs` — **48 passed, 0 failed**:

- P1-A: beats from a clock 5 min behind and 1 h ahead both stamp to receipt; only silence ages a row.
- P1-B: casing/whitespace variants collapse to one id; `0012` vs `0013` stay distinct; class disambiguates.
- P1-C: audit merge de-dupes by id, orders newest-first, honours the cap.
- P2-B/P3-1: type allowlist, `-50 → +1`, `999 → 120`, `NaN → 5`, announcement truncation, replay ignored.
- P2-C: exactly 5 accepted per window, one throttle notice, other students unaffected, window resets.
- P3-2: 5 violations per beat, 40 on sync.
- P2-A: flaky send succeeds on attempt 3, dead channel stops at 3, exception retried.
- Source tripwires for the queue, cross-quiz guard, scoped teardown, audit writes and receipt stamping.

`tsc -b` exit 0 · `vite build` exit 0 · oxlint 0 errors on the changed files.

### 6.4 Known limits / not done here

1. **The channel is still public.** This plan covers P1–P3 reliability, not the P0 authorization gap
   (public broadcast + unauthenticated `proctor_cmd`). Command validation now bounds the damage of a
   forged command, but it does not stop one: a student can still unlock themselves or grant +120 min.
   Private channels + RLS remain the outstanding P0.
2. **`proctor_audit_events` RLS is open**, matching every other table in the schema. Tighten with the
   P0 work.
3. **Resits share a canonical id** (no `startTime` by design). Two attempts of the same quiz by the
   same candidate collapse onto one dashboard row; if resits must be distinguished, add an attempt
   discriminator to the id rather than reintroducing `startTime`.
4. **No live-browser test.** The harness covers policy and source wiring; the WebSocket paths
   (queue flush, rate limiting under load, reconnect) still need a two-browser manual run.

