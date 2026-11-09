# Comprehensive Diagnosis & Audit: Exam Mode, Proctoring System, and Security System

**Audit Date**: November 9, 2026  
**Target Files**: [`src/pages/StudentQuizRunner.tsx`](file:///e:/VibeCoding/testmaker/src/pages/StudentQuizRunner.tsx), [`src/services/examProctorRealtimeService.ts`](file:///e:/VibeCoding/testmaker/src/services/examProctorRealtimeService.ts), [`src/components/LiveInvigilatorModal.tsx`](file:///e:/VibeCoding/testmaker/src/components/LiveInvigilatorModal.tsx), [`scripts/verify-exam-key-lock.mjs`](file:///e:/VibeCoding/testmaker/scripts/verify-exam-key-lock.mjs)

---

## 1. Executive Summary

A comprehensive forensic audit and test suite execution was conducted across the three core exam integrity subsystems:
1. **Exam Mode Runtime Lifecycle** (Timing, Single-Attempt gates, Draft resilience, Submission outbox, Question navigation).
2. **Security System** (W3C Keyboard Lock, Fullscreen traps, 1-Time 5-Second Grace Period countdown, Modal dismissal handlers, Clipboard/DevTools blocking).
3. **Proctoring Realtime Telemetry** (Bi-directional Supabase Realtime channels, Host/Student heartbeat receipt synchronization, Remote commands `unlock`/`add_time`/`force_submit`/`pardon`).

The audit discovered **3 critical vulnerabilities and 1 UX trap**:
- **Critical Flaw 1 (Security System)**: Anti-Cheating effect dependency churn. The security `useEffect` depended on `logViolation`, which changed on every countdown second (`timeLeft`). On every second tick, the effect unmounted and called `releaseKeyboardLock()`, leaving the browser Keyboard Lock unlocked after second 1 of the exam.
- **Critical Flaw 2 (Modal / Tool Escape Trap)**: In capture phase, the keydown listener blocked `Escape` unconditionally. When a candidate opened the Calculator, Periodic Table, Zoomed Diagram, or Attachment Drawer, pressing `Escape` failed to close the tool, trapping the candidate and prompting repeated Escape presses that drop fullscreen.
- **Critical Flaw 3 (Proctoring Remote Unlock)**: `requestSecureFullscreen()` called asynchronously upon receiving a remote `unlock` command fails due to browser user-gesture restrictions (`element.requestFullscreen()` requires active user interaction). The student was unlocked but remained out of fullscreen without a reset grace counter.

---

## 2. Findings Matrix

| ID | Subsystem | Severity | Description | Impact |
|:---|:---|:---|:---|:---|
| **SEC-01** | Security | **P0 Critical** | Anti-cheating effect has `logViolation` in dependency array. `logViolation` changes every second as `timeLeft` decrements, unmounting the effect and calling `releaseKeyboardLock()`. Keyboard lock is lost after 1s. | Candidates pressing `Esc` or `F11` exit fullscreen immediately without OS interception. |
| **SEC-02** | Security / UI | **P1 High** | Global keydown listener unconditionally intercepts `Escape` without checking if reference tools (Calculator, Periodic Table, Diagram Zoom, Reference Booklet, Attachments, Scratchpad) are open. | Pressing `Esc` to close a tool does nothing, confusing candidates and causing accidental exam exits. |
| **PROC-01** | Proctoring | **P1 High** | Remote `unlock` command calls `requestSecureFullscreen().catch(...)` asynchronously. Browser blocks non-gesture fullscreen requests. Student is unlocked but remains un-fullscreened with exhausted grace count. | Student can remain outside fullscreen or get immediately locked on next event. |
| **TEST-01** | Test Suite | **P2 Medium** | `scripts/verify-exam-key-lock.mjs` failed due to divergence between planned helper names and runtime implementation. | Automated regression test failing on CI/CD runs. |

---

## 3. Remediation Architecture

### SEC-01 & TEST-01: Stabilize Security Effect & Keyboard Lock
- Update all violation logging inside the security effect to route through `logViolationRef.current(...)`.
- Decouple the security effect dependencies to strictly lifecycle triggers: `[hasStarted, isSubmitted, isGrading, securityEnabled, isExamMode]`.
- Re-assert `enableKeyboardLock(['Escape', 'F11'])` on effect mount if `document.fullscreenElement` is present.
- Maintain `releaseKeyboardLock()` strictly on final component unmount / teardown.

### SEC-02: Modal-Aware Escape Dispatcher
- When `Escape` is pressed:
  1. Check if `zoomedImage` is active -> close zoom modal and stop propagation.
  2. Check if `showCalculator` is active -> close calculator and stop propagation.
  3. Check if `showPeriodicTable` is active -> close periodic table drawer and stop propagation.
  4. Check if `showAttachmentModal` is active -> close attachments and stop propagation.
  5. Check if `showScratchpad` is active -> close scratchpad and stop propagation.
  6. Check if `showResourceBooklet` is active -> close resource booklet and stop propagation.
  7. Check if `showSubmitModal` is active -> close submit confirmation and stop propagation.
  8. If no modal is active -> prevent default and stop propagation to prevent exiting fullscreen.

### PROC-01: Resilient Remote Proctor Unlock
- In `handleCommand` for `cmd.type === 'unlock'` and `cmd.type === 'pardon'`:
  - Reset `fullscreenExitCountRef.current = 0` and `setFullscreenExitCount(0)`.
  - Reset `setIsFullscreenGraceActive(false)` and `setFullscreenGraceSecondsLeft(5)`.
  - Unlock `setIsLockedByProctor(false)`.
  - If the browser cannot enter fullscreen automatically without a gesture, the Fullscreen Recovery Overlay cleanly guides the candidate to click once, which invokes `handleResumeFullscreen` from a legitimate user gesture.

---

## 4. Verification Plan
1. Run `node scripts/verify-exam-key-lock.mjs` (must pass 100%).
2. Run `npm run test:fullscreen-grace` (must pass 100%).
3. Run `node --import ./scripts/register-ts.mjs scripts/test-proctor-p1-p2-p3.mjs` (must pass 100%).
4. Run `node --import ./scripts/register-ts.mjs scripts/test-exam-gestures.mjs` (must pass 100%).
5. Run `node --import ./scripts/register-ts.mjs scripts/test-exam-submission-fixes.mjs` (must pass 100%).
6. Run full project build (`npm run build`).

