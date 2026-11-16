# School-Wide Proctoring Log, Alert Notification & Invigilator UX Plan

## 1. Context & Current Gaps Diagnosis

An audit of [examProctorRealtimeService.ts](file:///e:/VibeCoding/testmaker/src/services/examProctorRealtimeService.ts), [proctorAuditLogService.ts](file:///e:/VibeCoding/testmaker/src/services/proctorAuditLogService.ts), [LiveInvigilatorModal.tsx](file:///e:/VibeCoding/testmaker/src/components/LiveInvigilatorModal.tsx), and [StudentQuizRunner.tsx](file:///e:/VibeCoding/testmaker/src/pages/StudentQuizRunner.tsx) identified four key gaps for whole-school exam operations:

1. **Individual & Class Log System**:
   - Currently, `LiveInvigilatorModal` only has a single global slide-out drawer (`logEvents`, capped at 250 items) mixing all classes and exams together.
   - Missing: per-class log filtering, per-student chronological audit modal (`📜 Student Log`), event category filters (`Violations`, `Locks/Unlocks`, `Teacher Actions`), search, and one-click **Class / Individual Proctoring Log Export (`.xlsx`)**.
   - Bug found: recovered violation events from heartbeats (`LiveInvigilatorModal.tsx:432`) omit `candidateClass` and `studentId`, preventing accurate class/student filtering after a page refresh.
2. **Real-Time Violation Notification System**:
   - Currently, student violations silently prepend to `logEvents` (invisible when the log drawer is closed).
   - Missing: floating live alert toasts with inline quick actions (`[🔓 Unlock]`, `[🔍 Locate]`, `[📜 Log]`), unread violation badges on class sidebar items, anti-storm toast coalescing, and optional Web Audio sound alerts.
3. **> 1 Minute Lock-Screen Escalation Alert**:
   - Currently, `ProctorStudentState` tracks `status === 'locked'` and `lockReason`, but has **no `lockedSince` timestamp**.
   - Missing: tracking how long a student has been stuck on the violation lock screen, live lock-duration timer badges on student cards (`⏳ Locked 01:18`), and an automatic **60-second escalation alert** so no student loses excessive exam time waiting for an invigilator.
4. **Invigilator Smoothness at Scale (200+ Students)**:
   - Scrolling through hundreds of normal green cards to find locked/flagged students is slow during a live exam.
   - Missing: a pinned **"Needs Attention" triage bar**, **Batch Unlock for Class**, **Unlock + Compensate Wait Time**, **Direct Student Whisper/Notice**, and **Alert Scope Toggle (`Current Class Filter` vs `Whole School`)**.

---

## 2. Invigilator UX Recommendations (Included in Plan)

- **Rec 1 — Pinned "Needs Attention" Triage Strip**: Automatically pins students who are `Locked > 1m`, `Locked`, or `Exceeded Limit` at the top of the view (or via a 1-click `🚨 Triage (N)` filter pill) so invigilators never hunt through normal cards.
- **Rec 2 — "Unlock + Restore Wait Time (`🔓 Unlock & +Xm`)"**: When a student has been on the lock screen for `>= 1 minute`, offer a 1-click button that unlocks the screen **and** adds back the rounded minutes spent waiting.
- **Rec 3 — Scoped "Unlock All Locked (`🔓 Unlock All (N)`)"**: Allows a classroom invigilator to clear simultaneous false-positive locks (e.g., after a projector/network hiccup) in their selected class with one confirmation click.
- **Rec 4 — Direct Candidate Notice ("Whisper")**: Send a targeted banner message to a **single candidate** (with 1-click presets like *"Please keep your eyes on your screen"* or *"Return to fullscreen mode"*) instead of broadcasting to the entire hall.
- **Rec 5 — Notification Scope & Sound Controls**: Let each room invigilator choose whether pop-up/sound alerts fire for **`Selected Class/Exam Only`** (recommended for room proctors) or **`Whole School`** (recommended for chief invigilators), with Web Audio chimes (`Mute` / `Critical & Stuck >1m` / `All Violations`).

---

## 3. Small Executable Steps Breakdown

### Step 1: Lock-Screen Duration Tracking & Pure Proctor Alert Engine (`src/lib/proctorAlertEngine.ts`)
- **Goal**: Build a pure, unit-testable state machine for lock-screen timers, >60s escalation detection, notification deduplication/coalescing, and log filtering.
- **Changes**:
  - Extend `ProctorStudentState` in [examProctorRealtimeService.ts](file:///e:/VibeCoding/testmaker/src/services/examProctorRealtimeService.ts) with optional `lockedSince?: number`.
  - Stamp `lockedSince` in [StudentQuizRunner.tsx](file:///e:/VibeCoding/testmaker/src/pages/StudentQuizRunner.tsx) when entering the violation lock screen (and clear on unlock); also stamp/preserve `lockedSince` authoritatively on the receiver side in `LiveInvigilatorModal` whenever a student transitions from non-locked to `'locked'`.
  - Create `src/lib/proctorAlertEngine.ts` with pure functions:
    - `reconcileStudentLockTimestamp(prev: ProctorStudentState | undefined, next: ProctorStudentState, nowMs: number): number | undefined`
    - `findOverdueLockedStudents(students: ProctorStudentState[], alreadyAlertedMap: Record<string, number>, nowMs: number, thresholdMs?: number): ProctorStudentState[]` (defaults to `60_000` ms = 1 minute).
    - `filterProctorLogs(logs: ProctorLogEvent[], filter: { quizCode?: string; className?: string; studentId?: string; category?: 'all' | 'violations' | 'locks' | 'interventions'; search?: string }): ProctorLogEvent[]`
    - `coalesceIncomingAlerts(queue: ProctorAlertItem[], windowMs?: number): ProctorAlertToast[]`
- **Verification**: Unit test script `scripts/test-proctor-alert-engine.mjs` verifying `lockedSince` transitions, exact 60s trigger firing once per lock episode, reset after unlock, and log filtering by student/class/category.

### Step 2: Individual & Class Log System + Excel Audit Export
- **Goal**: Give invigilators both a **Class Log View** and an **Individual Candidate Log Modal**, plus downloadable Excel logs.
- **Changes**:
  - Fix heartbeat log recovery in [LiveInvigilatorModal.tsx](file:///e:/VibeCoding/testmaker/src/components/LiveInvigilatorModal.tsx) (`line 432`) so recovered `ProctorLogEvent` items preserve `studentId` and `candidateClass`.
  - Increase local durable event retention in [proctorAuditLogService.ts](file:///e:/VibeCoding/testmaker/src/services/proctorAuditLogService.ts) (`MAX_LOCAL_EVENTS` from `500` to `2000` for whole-school sittings) and support filtering by `candidateClass` and `studentId`.
  - Upgrade the **Activity Log Drawer** in `LiveInvigilatorModal.tsx`:
    - Scope toggle: **`Current Scope (Class / Exam)`** vs **`Whole School`**.
    - Category pills: `All`, `Violations ⚠️`, `Locks 🔒`, `Teacher Actions 🛡️`.
    - Search input (by student name, seat #, or event detail) + **`📥 Export Log (.xlsx)`** button.
  - Add a **`📜 Log`** button on every Student Card opening an **Individual Candidate Timeline Modal** showing that student's complete chronological history (join time, every strike/violation with timestamp, lock durations, and teacher unlocks/pardons/+time) with a 1-click individual log export.
- **Verification**: Automated test verifying per-student and per-class log filtering, heartbeat recovery with `candidateClass`, and `.xlsx` audit log generation.

### Step 3: Real-Time Violation Toast System & Web Audio Alert Chimes
- **Goal**: Immediately notify the invigilator when a student commits a violation or gets locked, without overwhelming the screen during high concurrency.
- **Changes**:
  - Add a floating **Live Proctor Alert Stack** (top-right of `LiveInvigilatorModal`) displaying up to 4 concurrent toasts (auto-dismissing warnings after 8s; keeping critical/lock alerts pinned until acknowledged or unlocked).
  - Each toast shows: Student Name, Class, Seat #, Exam Code, Violation detail, and inline buttons:
    - **`[🔓 Unlock]`** (if locked)
    - **`[🔍 Locate]`** (focuses the student's card and scrolls it into view with a highlight pulse)
    - **`[📜 History]`** (opens that student's Individual Log Modal)
  - Add **Alert Scope & Audio Controls** in the Invigilator top bar:
    - Scope: `My Filter Scope` vs `All Classes`.
    - Sound (Web Audio oscillator chime — no external audio files needed): `🔔 All Alerts` | `🚨 Critical & >1m Lock Only` | `🔕 Muted`.
  - Add unread violation badge counters on the `📜 Logs` button and beside classes in the left sidebar.
- **Verification**: Test alert generation on incoming violation events, scope filtering (`10-A` proctor only alerted for `10-A` when scoped), and toast coalescing under burst traffic.

### Step 4: > 1 Minute Violation Screen Escalation Alert & Live Lock Timer
- **Goal**: Alert invigilators whenever a student stays on the violation/lock screen for more than 60 seconds and show live elapsed lock time.
- **Changes**:
  - Run a lightweight `1000ms` ticker in `LiveInvigilatorModal` when at least one student is in `status === 'locked'`.
  - On each locked student card, render a live **`⏳ Locked mm:ss`** pill inside the lock banner (turning pulsing crimson at `>= 01:00`).
  - When `now - lockedSince >= 60_000` for any locked student (and not yet alerted for the current lock episode):
    - Emit a high-priority **`🚨 STUCK ON LOCK SCREEN (> 1 MIN)`** escalation alert toast + distinct urgent dual-tone chime.
    - Log a system audit entry (`locked_overdue`: *"Candidate remained on violation lock screen for over 1 minute"*).
    - Surface a sticky **`🚨 N Candidate(s) Waiting on Lock Screen > 1m`** banner at the top of the Invigilator Console with 1-click **`[🔓 Unlock]`** and **`[🔓 Unlock & +Xm]`** (compensate wait time) actions.
- **Verification**: Test 60-second threshold detection, non-duplicate firing within the same lock session, re-arming if the student unlocks and locks again later, and wait-time compensation calculation.

### Step 5: Invigilator Smoothness Enhancements (Batch Unlock, Direct Student Notice & Priority Sort)
- **Goal**: Streamline common invigilator interventions during whole-school exams.
- **Changes**:
  - Add **`Priority Triage`** sort mode in `LiveInvigilatorModal` (`Stuck >1m` -> `Locked` -> `Exceeded Limit` -> `Warning` -> `Offline` -> `Active` -> `Submitted`).
  - Add **`🔓 Unlock All Locked (N)`** button in the scoped action bar to batch-unlock all currently locked candidates in the active class/exam scope.
  - Add **`💬 Direct Notice`** button on each student card (and inside the Individual Student Log modal) with quick-select templates (*"Please keep your eyes on your own screen"*, *"Please re-enter fullscreen immediately"*, *"See invigilator desk"*) + custom text input using the existing signed `announcement` command targeted to `student.studentId`.
- **Verification**: Run full test suite (`npm run test:topic-mastery`, `npm run test:proctor-alerts`, `npm run test:phase3a-security`), `npx oxlint`, and `npm run build`.
