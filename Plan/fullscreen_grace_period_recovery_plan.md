# Fullscreen Grace Period Recovery & Accidental Esc Shield Plan

## 1. Context & Motivation
In formal Exam Mode, browser security policies prevent web applications from permanently disabling native browser shortcuts (`Esc` and `F11`). When candidates press `Esc`—often accidentally when trying to close a diagram zoom, calculator, or periodic table—the browser exits fullscreen mode.

Previously, exiting fullscreen immediately triggered a hard `isLockedByProctor` state, locking the student out and requiring the teacher/invigilator to physically walk across the examination room to input the 6-digit teacher PIN. In a room of 30+ students, a few accidental `Esc` taps cause massive disruption.

## 2. Solution Architecture: 1-Time 5-Second Grace Recovery

### 2.1 Core Rules
1. **First Incident Only (Grace Window)**:
   - When a candidate drops fullscreen for the **very first time** (`fullscreenExitCount === 1`), they are granted a **5-second grace window**.
   - No teacher PIN is required if they return to fullscreen within 5 seconds.
   - The drop is recorded in the invigilator real-time cockpit stream as a warning (`"Exited fullscreen (1st incident — 5s grace period)"`).
2. **Rapid 1-Click / 1-Key Re-entry**:
   - Clicking anywhere on screen or pressing `Enter`, `Space`, or `F11` immediately invokes `requestSecureFullscreen()`.
   - On successful re-entry within 5 seconds, the countdown cancels, the exam resumes seamlessly, and the candidate continues without interruption.
3. **Grace Expiration (Hard Lock at 0s)**:
   - If the student fails to re-enter fullscreen before the 5-second countdown reaches 0, the exam immediately transitions to **Hard Invigilator Lock** (`isLockedByProctor = true`).
   - The student must now wait for the teacher to enter the PIN.
4. **Subsequent Incidents (Strict Policy)**:
   - If the student leaves fullscreen a **2nd time or more** (`fullscreenExitCount >= 2`), **zero grace period is granted**.
   - The screen immediately triggers the Hard Invigilator Lock requiring teacher PIN entry.

---

## 3. Implementation Steps

### Step 1: State & Ref Setup in `StudentQuizRunner.tsx`
- Add `fullscreenExitCount` state (defaulting from `savedExam?.fullscreenExitCount || 0`).
- Add `isFullscreenGraceActive` state (boolean).
- Add `fullscreenGraceSecondsLeft` state (number, 5 down to 0).
- Add `graceTimerIntervalRef` and `graceExpiryTimeoutRef` to manage the countdown and prevent memory leaks.
- Persist `fullscreenExitCount` into exam draft / session storage so candidate cannot reset grace by refreshing.

### Step 2: Fullscreen Event Logic Updates
- In `handleFullscreenChange`:
  - When `!isFull`:
    - Increment `fullscreenExitCount`.
    - If `nextCount === 1`:
      - Log proctor violation with grace notice.
      - Start 5s countdown timer.
      - Set `isFullscreenGraceActive = true`.
    - If `nextCount > 1`:
      - Log critical violation.
      - Trigger hard teacher lock `setIsLockedByProctor(true)`.
  - When `isFull`:
    - If `isFullscreenGraceActive`:
      - Clear interval and timeout timers.
      - Reset `isFullscreenGraceActive = false`.
      - Broadcast heartbeat to proctor reporting candidate safely resumed.

### Step 3: Grace Period UI Overlay Component
- Render a distinct, highly visible recovery screen when `isFullscreenGraceActive && !isFullscreenActive`:
  - Warning banner & pulse ring: `⚠️ FULLSCREEN REQUIRED (First Incident Warning)`
  - Animated countdown badge: `⏱️ 5s... 4s... 3s...`
  - Explanatory copy: *"You exited fullscreen mode. Return within 5 seconds to continue, or your exam will be permanently locked for invigilator PIN verification."*
  - Full-width call-to-action button: `🖥️ Return to Fullscreen Now`
  - Keyboard hint: *"💡 Press Enter, F11, or click anywhere on screen to resume."*
  - Keydown & click bindings to trigger `handleResumeFullscreen()`.

### Step 4: Verification & Automated Tests
- Create `scripts/test-fullscreen-grace-period.mjs` verifying:
  1. First exit initializes 5s grace period and does not lock with PIN immediately.
  2. Returning to fullscreen within 5s cancels grace timer and resumes cleanly.
  3. Expiry after 5s triggers `isLockedByProctor = true`.
  4. Second exit skips grace period and locks immediately.
- Run full test suites (`test:cambridge-links`, `test:tos-citations`, `test:emergency`, `test:sorting`, `test:blooms`).
- Run `npm run build` and `npm run lint`.

