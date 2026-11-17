# Exam Session Scheduling Plan (`Active / Scheduled / Closed / Paused`)

## 1. Agreed Design Decisions (From `/grill-me` Session)
1. **Windowed Auto-Activation & Closure with Master Toggle**:
   - Exams (`quizMode !== 'game'`) gain optional `scheduledStartAt?: string | null` and `scheduledEndAt?: string | null` (stored as UTC ISO-8601 strings, edited in the browser's local timezone with explicit timezone/WIB indicator).
   - `isActive` remains the master **Enabled / Armed** switch:
     - `isActive === false` -> **`paused`** (Manually Paused — blocks entry at any time, even during a scheduled window).
     - `isActive === true` + `scheduledStartAt` & `now < scheduledStartAt` -> **`scheduled`** (Armed & Waiting — students cannot access questions yet).
     - `isActive === true` + inside `[scheduledStartAt, scheduledEndAt]` -> **`active`** (Open for student entry).
     - `isActive === true` + `scheduledEndAt` & `now > scheduledEndAt` -> **`closed`** (Entry Window Ended).
   - An explicit **"Open Now"** action lets a teacher clear `scheduledStartAt` (or set it to now) to start an upcoming exam early without losing `scheduledEndAt`.
2. **Entry-Gate Only (No Mid-Exam Cutoff)**:
   - Only **new lobby entries** are blocked before `scheduledStartAt` and after `scheduledEndAt`.
   - Already-started candidates stay unlocked on their device for their full `durationMinutes` timer, and `submit_student_exam_attempt` continues accepting their submissions after `scheduledEndAt`.
3. **Exam Mode Only**:
   - Enforced on Exam Mode (`quizMode !== 'game'`) both server-side (`public.get_student_exam_paper`) and client-side (`quizCodeService.ts` / `StudentQuizRunner.tsx`). Game Mode (`quizMode === 'game'`) remains purely manual.
4. **Quiz Manager Configuration & Admin Schedule Preset Picker**:
   - Teachers set optional Start & End `datetime-local` inputs in the Quiz Manager publish/edit modal, PLUS an optional **"Pick from School Exam Schedule"** quick-fill dropdown fed by `examScheduleService.ts` (`ICM_SEMESTER1_2026_2027_SCHEDULE` / cloud schedule) that pre-fills Date, Start Time, and optional End Time (`Start + duration`).
5. **Student Waiting Room & Closed View**:
   - Before `scheduledStartAt`: shows a dedicated **Scheduled Exam Waiting Room** displaying the exam title, subject, formatted Start/End times, and a **server-clock-synced live countdown** (`serverNow`). Uses a manual **"Enter Exam" / "Check Status"** button (no automatic thundering-herd auto-refresh at `00:00:00`).
   - After `scheduledEndAt`: shows a dedicated **Exam Window Closed** screen explaining entry closed at `scheduledEndAt`.
6. **Quiz Manager Filters & Card Status**:
   - Add a **`Scheduled`** status filter pill alongside `All`, `Active`, `Paused`, `Formal Exams`, `Quizizz Games` (and show `Closed` clearly on cards + include `Closed` in non-active filtering or show clear effective badges: `Active`, `Scheduled`, `Closed`, `Paused`).

---

## 2. Step-by-Step Implementation Plan

### Step 1: Pure Schedule Domain Helper & `PublishedQuiz` / `StudentQuizData` Types
- **Files**:
  - `src/lib/examSessionSchedule.ts` (new pure helper module)
  - `src/services/quizManagerService.ts`
  - `src/services/quizCodeService.ts`
- **Changes**:
  - Create `src/lib/examSessionSchedule.ts`:
    - `export type EffectiveQuizStatus = 'active' | 'scheduled' | 'closed' | 'paused';`
    - `resolveEffectiveQuizStatus(quiz: { isActive?: boolean; quizMode?: string; scheduledStartAt?: string | null; scheduledEndAt?: string | null }, nowMs?: number): EffectiveQuizStatus` (always returns `'active'`/`'paused'` ignoring schedule when `quizMode === 'game'`).
    - `validateExamScheduleWindow(startIso?: string | null, endIso?: string | null): { valid: boolean; error?: string }` (checks valid ISO dates and `end > start`).
    - `isoToLocalDateTimeInput(iso?: string | null): string` & `localDateTimeInputToIso(val: string): string | null`.
    - `buildWindowFromSchoolScheduleEntry(entry: ExamScheduleEntry, durationMinutes?: number): { scheduledStartAt: string; scheduledEndAt: string }`.
    - `formatScheduleWindowLabel(startIso?: string | null, endIso?: string | null): string`.
  - Add `scheduledStartAt?: string | null;` and `scheduledEndAt?: string | null;` to `PublishedQuiz` (`quizManagerService.ts`) and preserve them in `createDraftFromTest`.
  - Add `scheduledStartAt?: string | null;`, `scheduledEndAt?: string | null;`, `scheduleStatus?: EffectiveQuizStatus;`, and `serverNow?: string;` to `StudentQuizData` (`quizCodeService.ts`), and compute `scheduleStatus` in `buildStudentQuizData` (stripping questions if status !== `'active'` and bypassing `resolvedQuizMemoryCache` caching whenever `scheduleStatus !== 'active'` so clicking `Check Status` always re-checks live!).
- **Step 1 Verification (`ES-1`)**: Unit test `resolveEffectiveQuizStatus`, `validateExamScheduleWindow`, local<->ISO round-trip, school schedule preset builder, and `quizMode === 'game'` bypass.

---

### Step 2: Server-Side Schedule Gate Migration (`027_exam_session_scheduling.sql`)
- **Files**:
  - `supabase/migrations/027_exam_session_scheduling.sql`
- **Changes**:
  - Upgrade `public.get_student_exam_paper(p_code TEXT)` (from `024_phase3_deep_rls_ratelimit_and_game_security.sql`):
    - Parse optional `scheduledStartAt` (`TIMESTAMPTZ`) and `scheduledEndAt` (`TIMESTAMPTZ`) safely inside a `BEGIN ... EXCEPTION WHEN OTHERS` block.
    - When `COALESCE((v_quiz->>'quizMode'), 'exam') <> 'game'`:
      - If `NOT v_is_active`: return `'scheduleStatus' => 'paused'`, `'isActive' => FALSE`, `'serverNow' => NOW()`, `'questions' => '[]'::jsonb`.
      - If `v_scheduled_start IS NOT NULL AND NOW() < v_scheduled_start`: return `'scheduleStatus' => 'scheduled'`, `'isActive' => FALSE`, `'serverNow' => NOW()`, `'questions' => '[]'::jsonb`.
      - If `v_scheduled_end IS NOT NULL AND NOW() > v_scheduled_end`: return `'scheduleStatus' => 'closed'`, `'isActive' => FALSE`, `'serverNow' => NOW()`, `'questions' => '[]'::jsonb`.
    - Otherwise return `'scheduleStatus' => 'active'`, `'isActive' => TRUE`, `'serverNow' => NOW()`, plus the sanitized questions.
  - Keep `submit_student_exam_attempt(JSONB)` accepting submissions from candidates who already started on time.
- **Step 2 Verification (`ES-2`)**: Migration SQL verification assertions checking `get_student_exam_paper` handles `'paused'`, `'scheduled'`, `'closed'`, `'active'`, `serverNow`, game-mode exemption, and question withholding.

---

### Step 3: Quiz Manager Scheduling UI, Preset Picker & Card Filters
- **Files**:
  - `src/pages/QuizManagerPage.tsx`
  - `src/pages/QuizManagerPage.css` (status badge styling for `Scheduled` and `Closed`)
- **Changes**:
  - Load cloud/local school exam schedule (`loadAndSyncExamSchedule()`) when `QuizManagerPage` mounts / opens config modal.
  - Add a **Session Schedule (Active / Inactive Window)** card inside the Exam Configuration modal (shown when `activeQuizDraft.quizMode !== 'game'`):
    - **Pick from School Exam Schedule** `<select>` (pre-fills `scheduledStartAt` and `scheduledEndAt` from `ExamScheduleEntry` + duration/slot).
    - **Auto-Open At (`Start Date & Time`)** and **Close Entry At (`End Date & Time`, optional)** `datetime-local` inputs with local timezone hint (`e.g. Asia/Jakarta WIB`) + **Clear Schedule** button.
    - Live validation preventing `End <= Start`.
  - Update Quiz Manager card & status bar:
    - Live ticking clock (`nowMs` refreshed every 15s) so cards automatically transition `Scheduled` -> `Active` -> `Closed` in real time.
    - Add **`Scheduled`** filter pill alongside `All`, `Active`, `Paused`.
    - Display distinct badges (`Active`, `Scheduled`, `Closed`, `Paused`), schedule time window chip (`🕒 Nov 30, 08:00 – 09:30`), and an **"Open Now"** action on `Scheduled` cards (clears `scheduledStartAt` immediately).
    - Preserve existing `Paused` override notice when toggling Active/Paused on a scheduled quiz.
- **Step 3 Verification (`ES-3`)**: Static/DOM integration checks for Quiz Manager schedule inputs, preset dropdown, `Scheduled` filter pill, live status computation, and `Open Now` action.

---

### Step 4: Student Waiting Room Countdown & Closed Screen (`StudentQuizRunner.tsx`)
- **Files**:
  - `src/pages/StudentQuizRunner.tsx`
- **Changes**:
  - Sync `serverClockOffsetMs` (`Date.parse(data.serverNow) - Date.now()`) when resolving a quiz so the countdown cannot be tricked by changing the device clock.
  - Distinct states on `!hasStarted && !isSubmitted`:
    - `scheduleStatus === 'scheduled'`: Render **Assessment Scheduled** waiting room with exam title, subject, formatted Start/End schedule, live `Starts in HH:MM:SS` countdown synced to `serverNow`, and manual **"Enter Exam"** / **"Check Status"** button (highlighted once countdown hits `00:00:00`, never auto-firing requests for 200 students simultaneously).
    - `scheduleStatus === 'closed'`: Render **Entry Window Closed** screen showing the closing timestamp and **Back to Portal** (plus **Check Status** in case teacher extended the window).
    - `scheduleStatus === 'paused'` (or legacy `isActive === false`): Preserve the existing **Assessment Temporarily Paused** view.
  - Ensure any candidate who **already has `hasStarted === true`** continues normally without interruption when `scheduledEndAt` passes during their exam.
  - Add `"Clear Quiz Cache"` in `Check Status` click handler (`clearQuizMemoryCache(testIdOrCode)`) before calling `resolveStudentQuiz` so pressing Check Status always fetches fresh server status & questions.
- **Step 4 Verification (`ES-4`)**: Test `StudentQuizRunner` / `quizCodeService` state transitions: `scheduled` -> withholds questions + computes countdown; `closed` -> blocks entry + leaves started students uninterrupted; `active` -> delivers questions cleanly.

---

### Step 5: End-to-End Automated Test Suite, Lint & Production Build
- **Files**:
  - `scripts/test-exam-session-schedule.mjs`
  - `package.json` (`"test:exam-schedule"`)
- **Verification**:
  - Run `npm run test:exam-schedule`
  - Run `npm run test:phase3b-security`, `npm run test:student-pin`, `npm run test:desk-cards`
  - Run `npx oxlint` on all modified files
  - Run `npm run build` (`tsc -b && vite build`)
