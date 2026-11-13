# Individual Student Audit Log in Proctoring: UI, UX, and Architecture Plan

**Location:** `Plan/individual_proctor_audit_log_plan.md`  
**Status:** Proposed for review  
**Scope:** Individual candidate audit inspection across Live Proctoring (`LiveInvigilatorModal`), Post-Exam Results (`QuizResultsModal`), Durable Audit Persistence (`proctorAuditLogService`), and Telemetry Fidelity (`examProctorRealtimeService`, `StudentQuizRunner`, `examDraftService`).

---

## 1. Problem Statement & Lessons from the Nov 13 Pilot

Today, proctoring audit visibility is split across two incomplete views:

1. **Global live stream (`LiveInvigilatorModal.tsx`):** The top bar toggle `Audit Feed` opens a global `.lip-log-drawer` mixing every student in one ungrouped list capped at 250 entries in React state (`setLogEvents`) and 250 rows in `loadProctorAuditEvents(codes, 250)`.
2. **Card tooltip only (`LiveInvigilatorModal.tsx:1993-2010`):** Clicking or hovering a student's strike count only shows a plain browser `title` tooltip over `s.recentViolations`, with no filtering, timestamps/elapsed comparison, teacher action history, or ability to inspect a locked/offline candidate's full timeline.
3. **Post-exam view (`QuizResultsModal.tsx:2154-2217`):** Displays `selectedSubmission.proctoringLogs` only for students who completed submission. Stranded `in_progress` or locked drafts (`app_config` keys `draft_<CODE>_*`) never appear, and invigilator interventions (`forensics.invigilatorActions`) are not merged chronologically alongside violations in the timeline.

Real-world pilot telemetry (`PILOT` test, Nov 13, 2026) exposed four underlying data gaps that any individual audit UI must solve:

| Gap Observed in Pilot | Root Cause in Code | Impact on Individual Audit Log |
| :--- | :--- | :--- |
| Only 13 rows saved in `proctor_audit_events` starting at `07:47:29 WIB`, missing the entire `07:20-07:46 WIB` rush | `recordProctorAuditEvent()` for student events is only called inside `LiveInvigilatorModal.tsx:407` (`handleLogEvent`). When no teacher has the Live Cockpit open, zero events reach Postgres. | Opening Live Proctor late or inspecting post-exam leaves an empty or partial timeline for students whose browser closed or locked earlier. |
| `candidate_class` was `null` on all 13 `proctor_audit_events` rows | `ProctorLogEvent` (`examProctorRealtimeService.ts:76-100`) lacks `studentId` and `candidateClass`. `handleLogEvent` calls `getCanonicalProctorStudentId` without `studentClass` (`LiveInvigilatorModal.tsx:410-414`) and omits `candidateClass`. | When `candidateNumber` is empty, `studentId` hash in `proctor_audit_events` does not match `sessionHash` or `submission.forensics.proctorStudentId`, breaking per-student lookups and class filtering. |
| Raw `violations[]` reached 23 while `finalStrikeCount` stayed 1 | `shouldCountAsStrike` skips strike increments while `isLockedByProctor` is true (`StudentQuizRunner.tsx:980-1070`), fullscreen grace sets `isLockedByProctor(true)` before logging (`StudentQuizRunner.tsx:1284-1293`), and `StudentQuizRunner.tsx:2020` checks `violations.length >= maxViolations` while `proctorGuards` / cards track `strikeCount`. | Teachers see conflicting numbers ("23 violations" vs "1 strike") unless the UI separates **Formal Strikes**, **Suppressed/Logged While Locked Events**, and **Total Penalty Time**. |
| 7 locked students remained in `draft_PILOT_*` with `isLockedByProctor: true` and never submitted | `LiveInvigilatorModal.tsx` hydrates local/cloud submissions (`quiz_submissions`), not unsubmitted cloud `app_config` drafts (`draft_<CODE>_*`), and `QuizResultsModal.tsx` only lists submitted papers. | Locked candidates whose browser closes disappear after 45s offline sweep without leaving an inspectable audit trail in Results. |

---

## 2. Core UX Goals & Mental Model

An invigilator or academic coordinator opens an individual student's audit log for one of three concrete jobs:

1. **Triage during an active exam:** *"Student B's card just turned red/locked. Why did they lock out, how many times has this happened in the last 3 minutes, and have they already been unlocked or given +5m earlier?"*
2. **Adjudication & intervention in context:** *"Can I unlock them, pardon 1 erroneous fullscreen strike, grant +5 minutes, or force-submit right from the evidence drawer without losing my place in the class grid?"*
3. **Post-exam disciplinary or technical verification:** *"After the exam closed (even if no teacher watched live or the student got stranded in a locked draft), give me a clean, printable/exportable chronological record of every focus loss, shortcut block, tier escalation, unlock, and clock adjustment."*

### Key UX Principles

- **Zero clutter on the grid:** Keep `.lip-student-card` scannable. Add one explicit trigger (`Inspect Audit` / clickable telemetry badge or header action) rather than cramming logs inside every card.
- **Two counts, clearly explained:** Always present **Strikes (Policy Count)** alongside **Raw Security Events** (with a breakdown if events were logged while already locked or inside the 5s fullscreen grace window) so numbers never contradict each other.
- **Unified causal timeline:** Student violations, policy tier escalations (Tier 1 Lock, Tier 2 -5m Penalty, Tier 3 -10m Penalty, Tier 4 Auto-Submit), and invigilator interventions (Unlock, Pardon, +Time, Force Submit) live in **one single chronological stream** so cause and effect read cleanly.
- **Resilient across tabs and reloads:** Opening the individual drawer queries `(quizCode, studentId)` directly from `proctor_audit_events` plus live heartbeat state and (when available) draft/submission forensics, instead of relying on the global 250-event ring buffer.

---

## 3. User Flows

### Flow A: Inspecting a Candidate During Live Invigilation (`LiveInvigilatorModal`)
1. Invigilator spots a locked, warning, or high-violation student card (or finds them via Search / Class Sidebar / Filter tab).
2. Invigilator clicks the **Audit** button on the student card (or clicks the violation summary badge `.lip-telemetry-val`).
   - Also allow clicking a student name inside the global `.lip-log-drawer` to pivot directly into that student's individual audit drawer.
3. The **Individual Audit Log Drawer** slides open on the right edge (replacing or switching smoothly with the global `.lip-log-drawer` so the workspace never shows two cramped side panels at once).
4. Background grid stays visible on desktop so the invigilator keeps peripheral awareness of other locked cards, while a subtle Previous / Next candidate switcher lets them step through filtered/flagged students without closing the drawer.
5. On open, the drawer immediately renders known live/cached events (`s.recentViolations` + matching in-memory `logEvents`) and asynchronously fetches the full per-student history from Supabase `proctor_audit_events` (eliminating the global 250-row starvation problem).
6. Invigilator optionally filters the timeline (`All`, `Strikes & Policy`, `Focus / Fullscreen`, `Blocked Keys`, `Invigilator Actions`) and takes direct action from the sticky action footer (`Unlock`, `+5m`, `Pardon`, `Force Submit`). Any action immediately appends an `invigilator` audit entry at the top/bottom of the open timeline and records to `proctor_audit_events`.
7. Pressing `Escape` or clicking `Close` closes the drawer and returns focus cleanly to the card button that opened it.

### Flow B: Inspecting from Post-Exam Results (`QuizResultsModal`)
1. Teacher selects a candidate in `QuizResultsModal` (`selectedSubmission`).
2. Inside `.qrm-proctor-card` (`QuizResultsModal.tsx:2154`), alongside `Exam Browser & Proctoring Audit Trail`, add:
   - A filterable, upgraded chronological timeline merging:
     - `selectedSubmission.proctoringLogs`
     - `selectedSubmission.forensics.tierHistory`
     - `selectedSubmission.forensics.invigilatorActions`
     - Backfilled durable rows from `proctor_audit_events` for `(quizCode, studentId)` (catching early events or invigilator actions that happened before a reconnect).
   - A **"Full Audit Drawer / Export Evidence"** button opening the shared `StudentAuditTimelineView` component with print/CSV export and summary counters (`Formal Strikes`, `Logged While Locked`, `Total Time Deducted`, `Invigilator Unlocks`).
3. **Unsubmitted / Stranded Draft Visibility:** Add a secondary badge/tab or expandable banner in `QuizResultsModal` (or a "Draft / Locked Sessions" filter pill next to the status filters) querying `app_config` `draft_<QUIZCODE>_%` keys so students who locked out without submitting (like the 7 stranded candidates in `PILOT`) can still have their audit log inspected and exported.

### Flow C: Exporting Evidence for Homeroom / Admin Review
1. From the drawer header, teacher clicks **Export Audit**:
   - **Copy Summary:** Copies a plain-text timestamped summary (candidate, class, strikes, tier reached, chronological list) for quick chat/email escalation.
   - **Download CSV / Print View:** Generates a clean single-student audit sheet (`<QuizCode>_<StudentName>_audit.csv` or print-friendly layout using existing print styles) with timestamp, elapsed exam time, actor (`student` / `invigilator`), category, strike delta, severity, and detail.

---

## 4. UI Layout & Visual Design Specification

All styling must reuse existing theme variables in `LiveInvigilatorModal.css` and `QuizResultsModal.css` (`--color-surface`, `--color-surface-raised`, `--color-surface-sunken`, `--color-border`, `--color-text-primary`, `--color-text-secondary`, `--color-primary`) and support `[data-theme='dark']`. No decorative gradients, no glassmorphism blur on inner panels, and sharp semantic hierarchy using status borders and crisp badges only.

### 4.1 Entry Point on `.lip-student-card`
Inside `LiveInvigilatorModal.tsx` (`.lip-card-header` or `.lip-card-actions`), keep card density disciplined:
- Make the existing `.lip-telemetry-val` (`2 strikes (-5m)`) clickable as a semantic `<button>` with subtle underline/chevron affordance (`View log >`) instead of relying on an inaccessible hover `title`.
- Add a compact icon+label button `Audit` (`.lip-card-btn--audit`) inside `.lip-card-actions` (right-aligned or first secondary slot) that toggles `aria-expanded={isSelected}` and highlights the active card with a clean 2px `--color-primary` outline while open.
- Clicking a candidate name in the global `.lip-log-drawer` row (`.lip-log-name`) acts as a button that opens that student's Individual Audit Drawer directly.

### 4.2 Individual Audit Drawer Anatomy (`.lip-audit-drawer`)

**Desktop (`> 900px`):** Right-side docked panel (`width: 460px`, `max-width: 42vw`, solid `var(--color-surface)` with `1px solid var(--color-border)` left divider) inside `.lip-body`, replacing `.lip-log-drawer` when a student is selected, with a `Back to Global Feed` breadcrumb if opened from the feed.  
**Tablet / Mobile (`<= 900px`):** Full-width overlay sheet inside `.lip-modal-container` (`inset: 0`, keyboard trapped / `Escape` close, prominent Back button).

Vertical structure of the drawer (4 crisp regions):

```text
+-------------------------------------------------------------------+
| [<- Back / Feed]  [Prev] [Next]             [Export]  [Close (X)] |
+-------------------------------------------------------------------+
| CANDIDATE HEADER (Sticky Top)                                     |
| Ahmad Fauzi                                   [LOCKED - TIER 2]   |
| Class: 8A  |  Code: PILOT  |  OS: Desktop/Edge | ID: 9f3c1a       |
| Progress: 12/20 Qs   |  Clock: 14:22 left (-5m penalty applied)   |
+-------------------------------------------------------------------+
| KPI & STRIKE RECONCILIATION STRIP (3 compact cells)               |
| [ Formal Strikes: 2 / 4 ]  [ Raw Events: 5 ]  [ Interventions: 2 ]|
| Note when Raw > Strikes: "3 events suppressed while locked/grace" |
+-------------------------------------------------------------------+
| TIMELINE FILTERS & ORDER                                          |
| [All (7)] [Violations (4)] [Tier/Lock (2)] [Teacher (1)] [Old->New|
+-------------------------------------------------------------------+
| CHRONOLOGICAL EVENT TIMELINE (Scrollable Body)                    |
|                                                                   |
|  07:24:11  (+02m 11s)  [STRIKE 1]  [TIER 1 LOCK]                  |
|  | Blur / Focus Lost   Browser window lost focus (Alt+Tab / App)  |
|  | Impact: Lock screen triggered. Timer paused/continued per rule.|
|                                                                   |
|  07:24:14  (+02m 14s)  [SUPPRESSED - ALREADY LOCKED]              |
|  | Fullscreen Exit     Attempted Exit Fullscreen while locked     |
|  | Note: Recorded for audit; +0 strike increment                  |
|                                                                   |
|  07:24:45  (+02m 45s)  [INVIGILATOR ACTION]                       |
|  | Remotely Unlocked   Cleared by invigilator via Live Cockpit    |
|                                                                   |
|  07:29:02  (+07m 02s)  [STRIKE 2]  [TIER 2: -5m PENALTY]          |
|  | Blocked Shortcut    Pressed Esc key                            |
|                                                                   |
+-------------------------------------------------------------------+
| STICKY INTERVENTION BAR (Live Mode Only, if not submitted)        |
| [Unlock Candidate]  [+5m Time]  [Pardon Strikes]  [Force Submit]  |
+-------------------------------------------------------------------+
```

### 4.3 Event Visual Distinction & Semantics

Use left-accent borders (3px solid, matching existing `.lip-log-item--*` convention) and explicit text tags (never color alone):

| Event Category | Actor | Badge Label | Visual Marker | Notes |
| :--- | :--- | :--- | :--- | :--- |
| Session Lifecycle (`join`, `submitted`, `auto_submitted`, `offline_gap`) | `student` / `system` | `SESSION` | Neutral slate border (`#64748b`) | Shows device/OS & start/end boundaries |
| Policy Strike (`tab_switch`, `blur`, `fullscreen_exit`, `shortcut`, `multi_monitor`) | `student` | `STRIKE N` + optional `TIER` pill | Amber (`#d97706`) for warning, Red (`#dc2626`) for critical/lock/Tier 3+ | Explicitly shows strike counter before/after (`Strike 1 -> 2`) and elapsed time (`+04m 12s`) |
| Logged Without Strike (`rate_limit`, `logged_while_locked`, `grace_warning`) | `student` / `system` | `LOGGED (+0 STRIKE)` | Dashed muted amber/slate border | Makes clear *why* strike count did not increase |
| Invigilator Command (`unlocked`, `time_extended`, `pardon`, `force_submit`) | `invigilator` | `TEACHER ACTION` | Blue (`#2563eb`) border + distinct subtle tinted header | Pairs command with exact timestamp so audit proves how long a student waited to be unlocked |

### 4.4 Accessibility & Responsiveness Checklist
- Drawer has `role="dialog"` (on mobile sheet) or `aria-label="Individual Audit Log for <Student>"`.
- Focus moves to drawer close/header on open; pressing `Escape` closes the drawer (without closing the whole `LiveInvigilatorModal` behind it — handle `stopPropagation()` on the drawer key listener).
- Timestamp, elapsed time (`+MMm SSs`), and delta tags use `font-variant-numeric: tabular-nums` so rows scan vertically without jitter.
- Minimum touch target `36px` height on filter pills and action buttons; horizontal scroll for filter pills on narrow screens so nothing wraps awkwardly or clips horizontally.

---

## 5. Data Model & Pipeline Fixes Needed

To make the Individual Audit Log accurate even when no teacher keeps the cockpit open for the full exam duration, fix five telemetry/persistence seams:

### 5.1 Include `studentId` and `candidateClass` on `ProctorLogEvent` & `recordProctorAuditEvent`
- **File:** `src/services/examProctorRealtimeService.ts`
  - Add `studentId?: string;` and `candidateClass?: string;` to `ProctorLogEvent` (lines 76-100).
  - Populate both inside `sendStudentViolation` (`studentState.studentId`, `studentState.candidateClass`) and rate-limit fallback notices (lines 254-265, 365-375).
- **File:** `src/components/LiveInvigilatorModal.tsx`
  - In `handleLogEvent` (lines 407-422), pass `studentState?.candidateClass ?? enriched.candidateClass` and prefer `enriched.studentId` or include `studentClass` in `getCanonicalProctorStudentId(...)` so keys match student heartbeats and `quiz_submissions`.
  - Include `candidateClass` and `studentId` in optimistic local event entries for `handleRemoteUnlock`, `handleAddTime`, `handlePardon`, `handleForceSubmit`.

### 5.2 Direct Durable Audit Write from Student Client (Eliminating Blind Spot When No Cockpit Is Open)
- **Observation from Pilot:** Relying solely on an open teacher dashboard tab to call `recordProctorAuditEvent` dropped all violations from `07:20-07:46 WIB` until the dashboard opened at `07:47:29 WIB`.
- **Solution:**
  - In `src/services/examProctorRealtimeService.ts` (inside `sendStudentViolation`), also call `recordProctorAuditEvent(...)` for discrete violations/tier locks/auto-submit events, **OR** persist via an idempotent upsert (`onConflict: 'id'` with deterministic/unique `eventPayload.id`) so both student-side write and dashboard-side backup never double-insert.
  - Guard Supabase bandwidth on free tier: reuse the existing sliding-window rate limit (`LOG_EVENTS_PER_WINDOW` / lock-burst suppression) and keep heartbeat broadcasts strictly off the database (violations + lifecycle events only).
  - Also emit durable `join` and `submitted` audit events on initial exam start and final submission so every candidate has bookend timestamps even if they score 0 violations.

### 5.3 Per-Student Query Function in `proctorAuditLogService.ts`
- **File:** `src/services/proctorAuditLogService.ts`
  - Add `loadStudentProctorAuditEvents({ quizCode, studentId, studentName, candidateNumber, candidateClass, limit = 500 })`:
    1. Primary DB query `.from('proctor_audit_events').select('*').eq('quiz_code', code).eq('student_id', canonicalId).order('created_at', { ascending: false }).limit(limit)`.
    2. Legacy fallback query (for historical rows stored without matching `student_id`, e.g., before `candidateClass` fix): match `.eq('quiz_code', code).ilike('student_name', studentName)` and refine client-side by `candidateNumber` / `candidateClass` if present.
    3. Merge with local `localStorage` mirror via `mergeAuditEvents(...)`.
  - Extend `ProctorAuditEvent` optional metadata (nullable/optional in TypeScript, encoded cleanly into `detail` or structured JSON suffix / new nullable JSONB column `metadata` in a future migration if desired — **or backward-compatible structured prefix/fields without requiring a schema migration first**):
    - `strikeNumber?: number`
    - `tierName?: string`
    - `suppressedWhileLocked?: boolean`
    - `elapsedExamSeconds?: number`
  - Note: Check migration impact — `018_proctor_audit_events.sql` uses `event_type`, `severity`, `detail`, `actor`. Adding an optional `metadata JSONB DEFAULT NULL` column in a small migration `019_proctor_audit_metadata.sql` (with graceful insert fallback if migration not applied, matching the `42P01` / missing-column guard pattern in `proctorAuditLogService.ts`) allows storing `strikeNumber`, `tierName`, `penaltySeconds`, `suppressedWhileLocked`, and `elapsedExamSeconds` cleanly without string-parsing hacks.

### 5.4 Reconcile Locked/Grace Violations & `isExceeded` Metric
- **Files:** `src/pages/StudentQuizRunner.tsx`
  - Ensure fullscreen 5s grace timeout (`StudentQuizRunner.tsx:1284-1293`) records/counts the strike cleanly *before* setting `isLockedByProctor(true)` (or passes a `forceStrike: true` flag to `logViolationRef.current` so `shouldCountAsStrike` does not suppress the strike it just triggered).
  - Standardize `exceededMaxViolations` (`StudentQuizRunner.tsx:2020`) to compare `strikeCount >= maxViolations` rather than raw `violations.length >= maxViolations` when tiers/strike policy is active, while keeping `violations.length` as **Raw Logged Events** in telemetry (`violationsCount` vs `strikeCount`) and clearly labeling both in `ProctorStudentState` and `StudentAuditDrawer`.

### 5.5 Drafts Recovery Hydration for Stranded Candidates
- **File:** `src/services/examDraftService.ts`
  - Add `listCloudDraftsForQuiz(quizCode: string): Promise<ExamDraftPayload[]>` querying `app_config` where `key LIKE 'draft_<CODE>_%'`.
  - Allow both `LiveInvigilatorModal` (initial load for late-opening proctors) and `QuizResultsModal` (new "Incomplete / Locked Sessions" filter or badge) to hydrate stranded candidates so an invigilator can inspect their individual audit timeline (`draft.violations`, `draft.tierHistory`, `draft.isLockedByProctor`, `draft.lockReason`, `draft.lastSavedAt`) + `proctor_audit_events`.

---

## 6. Component Architecture & File Plan

Keep code modular so both `LiveInvigilatorModal` and `QuizResultsModal` share the same timeline renderer without duplicating formatting, icon mapping, or strike logic:

| File | Role | Change Type |
| :--- | :--- | :--- |
| `src/types/proctorAudit.ts` (new or inside `proctorAuditLogService.ts`) | Normalized `NormalizedAuditEntry` type + merge helper (`mergeStudentAuditSources`) combining live heartbeats, `proctor_audit_events`, `ProctoringViolationEvent[]`, `SecurityTierEvent[]`, `invigilatorActions`, and `ExamDraftPayload` | New pure helper module (easy to unit test in Node) |
| `src/components/StudentAuditDrawer.tsx` + `src/components/StudentAuditDrawer.css` (new) | Reusable individual audit drawer / panel (`header`, `KPI strip`, `filter pills`, `chronological timeline`, `export actions`, optional `live intervention bar`) | New UI component used by `LiveInvigilatorModal` and `QuizResultsModal` |
| `src/services/proctorAuditLogService.ts` | Add `idempotent upsert`, optional `metadata` field fallback, and `loadStudentProctorAuditEvents(...)` | Service extension |
| `src/services/examProctorRealtimeService.ts` | Add `studentId` & `candidateClass` to `ProctorLogEvent`, persist discrete violations idempotently from student side so unattended sessions aren't lost | Service update |
| `src/services/examDraftService.ts` | Add `listCloudDraftsForQuiz(quizCode)` | Service extension |
| `src/pages/StudentQuizRunner.tsx` | Emit `join`/`submitted` audit lifecycle events, fix fullscreen grace ordering vs `isLockedByProctor`, reconcile `strikeCount` vs `violations.length` for `exceededMaxViolations`, annotate suppressed-while-locked events | Runner telemetry fix |
| `src/components/LiveInvigilatorModal.tsx` & `.css` | Wire card `Audit` trigger + `.lip-telemetry-val` click + global `.lip-log-name` drill-down + Previous/Next navigation + swap right drawer cleanly between Global Feed and `StudentAuditDrawer` | UI integration |
| `src/components/QuizResultsModal.tsx` & `.css` | Upgrade `.qrm-proctor-card` timeline using shared merger + "Inspect Full Audit / Stranded Drafts" view | UI integration |
| `supabase/migrations/019_proctor_audit_metadata.sql` (optional/progressive) | Add nullable `metadata JSONB` column + `(quiz_code, student_id, created_at DESC)` composite index on `proctor_audit_events` | DB migration (with safe client fallback) |

---

## 7. Phased Implementation Breakdown

### Step 1: Data & Identity Foundation (Safe, Non-Visual)
1. Add `studentId` and `candidateClass` to `ProctorLogEvent` (`examProctorRealtimeService.ts`).
2. Fix `handleLogEvent` in `LiveInvigilatorModal.tsx` so `getCanonicalProctorStudentId` receives `candidateClass` and saves `candidate_class`.
3. Update `recordProctorAuditEvent` in `proctorAuditLogService.ts` to upsert idempotently (`onConflict: 'id'`), add `loadStudentProctorAuditEvents`, and support optional `metadata`.
4. Create pure helper `mergeStudentAuditSources(...)` + unit-testable dedupe/sort logic that fuses live events, DB audit rows, `proctoringLogs`, `tierHistory`, and `invigilatorActions`.

### Step 2: Runner Telemetry & Draft Hydration Fixes
1. Fix fullscreen grace lock ordering and `exceededMaxViolations` (`strikeCount` vs `violations.length`) in `StudentQuizRunner.tsx`.
2. Record discrete student violations + `join`/`submitted` lifecycle markers via `recordProctorAuditEvent` on the student side (idempotently by `event.id`, subject to rate/burst guards).
3. Add `listCloudDraftsForQuiz(quizCode)` in `examDraftService.ts` and hydrate unsubmitted/locked drafts in `LiveInvigilatorModal` on initial mount if no live heartbeat arrived yet.

### Step 3: Build Shared `StudentAuditDrawer` UI Component
1. Build `StudentAuditDrawer.tsx` + `StudentAuditDrawer.css` using `.lip-*` / `--color-*` design tokens with full dark-mode and `< 900px` responsive sheet support.
2. Implement:
   - Sticky student identity + status + exam clock/penalty bar
   - 3-cell KPI strip explaining `Formal Strikes` vs `Raw Events` vs `Teacher Interventions`
   - Category filter pills + ascending/descending chronological toggle
   - Accessible keyboard navigation (`Escape` closes drawer, focus restoration, `Prev`/`Next` candidate stepping)
   - Copy Text Summary + CSV Export

### Step 4: Integrate into `LiveInvigilatorModal` & `QuizResultsModal`
1. Wire `LiveInvigilatorModal`:
   - State `inspectedStudentKey: string | null` (mutually exclusive with global `showLogDrawer` by default, with a clear `All Events` back button).
   - Wire card button, clickable violation count, and log item name click.
   - Connect `Unlock`, `+5m`, `Pardon`, and `Force Submit` footer actions directly to existing handlers (`handleRemoteUnlock`, `handleAddTime`, `handlePardon`, `handleForceSubmit`).
2. Wire `QuizResultsModal`:
   - Enrich `.qrm-proctor-card` with merged DB + `invigilatorActions` + `tierHistory` + export button.
   - Add Draft / Locked Session visibility for candidates who never completed final submission.

---

## 8. Verification Plan

### Automated Checks (Node / Unit Tests)
1. **Pure Merge & Identity Tests:** Verify `mergeStudentAuditSources` dedupes identical events emitted by both student client and dashboard listener (`id` match + timestamp/detail fallback), orders chronologically, preserves `invigilator` actions, and separates `Formal Strikes` from `suppressedWhileLocked` counts.
2. **Canonical Key Consistency Test:** Verify that `getCanonicalProctorStudentId` produces identical IDs across `StudentQuizRunner` (`sessionHash`), `LiveInvigilatorModal.handleLogEvent` (with empty `candidateNumber` and populated `candidateClass`), and `QuizResultsModal` submission records.

### Manual & Browser Verification Checklist
1. **Live Triage Flow:**
   - Start a simulated exam (`PILOT` copy) without opening the Live Invigilator first; trigger 1 blur violation while unobserved, then open `LiveInvigilatorModal`, trigger a second violation and unlock via `Remote Unlock`.
   - Open the student's `Individual Audit Drawer`: verify both the pre-cockpit violation (`proctor_audit_events`), the second violation, and the `Remotely unlocked by invigilator` action appear in order with `candidateClass` populated.
2. **Global Feed <-> Individual Drawer Pivot:**
   - Open `Audit Feed`, click a student's name in a log row, verify it pivots smoothly into their individual drawer; press `Escape` and verify focus returns cleanly.
3. **Locked & Stranded Draft Flow:**
   - Have a second test student trigger lock and close the browser tab without submitting. Verify they appear after waiting `>45s` (offline / locked) and remain inspectable in Results / Locked Drafts with their `tierHistory` and reason visible.
4. **Dark Mode, Mobile Viewport (`<= 900px`), and Export:**
   - Toggle `[data-theme='dark']`, resize below `900px`, verify zero horizontal overflow, verify CSV download and Copy Summary output.
