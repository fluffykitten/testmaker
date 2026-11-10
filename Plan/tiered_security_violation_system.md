# Plan: Multi-Tier Exam Security Violation & Penalty System

Status: **Reviewed against codebase — Broken down into small executable steps** · Target version: next minor after v.2.3.8

## 1. Summary

Replace the flat `maxViolations` / `requireTeacherUnlock` model with an admin-configured list of escalation tiers. Each tier fires at a strike count and performs one action:

| Action | Lock | Unlock | Effect |
|---|---|---|---|
| `warning` | Yes | Teacher PIN or remote unlock | No penalty |
| `time_penalty` | Yes | Teacher PIN or remote unlock | Deducts $N$ minutes immediately |
| `auto_submit` | Yes, permanent | None | Submits answers, shows completion screen |

Default (4 tiers): Strike 1 warning · Strike 2 −5 min · Strike 3 −10 min · Strike 4 auto-submit.

---

## 2. Decisions & Rules

### 2.1 Confirmed in `/grill-me`

| Area | Decision |
|---|---|
| Tier structure | Dynamic list, $N$ tiers, admin can add/remove |
| Default | 4 tiers: Strike 1 Warning · Strike 2 −5 min · Strike 3 −10 min · Strike 4 Auto-Submit |
| Scope | Strictly global (Admin Settings). No per-quiz override |
| Penalty timing | Applied immediately on lock. Clamps at 0; on unlock if remaining time was exhausted by penalty, student gets a 30 s grace window to finalize before auto-submit |
| Final tier | Irreversible lock screen, auto-submit to cloud, no PIN field |
| Strike weighting | Every violation type = +1 strike |
| Pardon | Resets the strike counter to 0; deducted time stays deducted |

### 2.2 Technical Guardrails from Code Review

| # | Rule | Why |
|---|---|---|
| R1 | **No strikes while locked.** Violations raised while the lock screen is open are logged (`countedAsStrike: false`), not counted. | `logViolation` (`StudentQuizRunner.tsx:769`) has no lock guard. A student waiting for the invigilator could otherwise go from Tier 1 to auto-submit before the teacher arrives. |
| R2 | **Coalesce bursts.** Violations within **2 s** of the last counted strike are logged but count as the same strike. | A single Alt+Tab fires `window_blur` + `tab_switch` + `fullscreen_exit`. Without this, one action = 3 strikes. |
| R3 | **Tiers apply only when `isExamMode && securityEnabled`.** Practice mode keeps the current non-blocking banner. | Practice sessions have no invigilator to enter the PIN. |
| R4 | **Snapshot tiers per sitting.** The runner stores the tiers it started with in the draft; resumes reuse that snapshot. | If admin edits tiers mid-exam, a candidate's rules should not change halfway (and resume must be deterministic). |
| R5 | **Strikes above the last threshold** resolve to the last tier (which validation forces to be `auto_submit`). | Gaps between thresholds (e.g. 1, 3, 5) resolve to the highest tier at or below the strike count; strike counts below the first threshold resolve to "no tier" (log only). |
| R6 | **Legacy fields ignored.** `PublishedQuiz.maxViolations` and `requireTeacherUnlock` stay in the type for old data, but the runner no longer reads them. | They aren't exposed in Quiz Manager UI anyway (defaults 3 / true). |

---

## 3. Complete File Inventory

| # | File | Action | Purpose |
|---|---|---|---|
| 1 | `src/lib/securityTiers.ts` | **NEW** | Pure types, 4-tier default constant, validation, normalization, strike resolution, time penalty math |
| 2 | `scripts/test-tiered-security-system.mjs` | **NEW** | Automated unit + scenario + source tripwire verification suite |
| 3 | `package.json` | **EDIT** | Add `"test:security-tiers"` script |
| 4 | `src/lib/settings.ts` | **EDIT** | Add `securityTiers` to `AppSettings` (L9–84) + local/cloud sync helpers (`exam_security_tiers`) at bottom of file |
| 5 | `src/App.tsx` | **EDIT** | Call `loadAndSyncSecurityTiers()` on app boot alongside `loadAndSyncGeminiApiKeyTier()` (L15, L149) |
| 6 | `src/pages/AdvancedSettingsPage.tsx` | **EDIT** | Add interactive "Violation Escalation Tiers" editor card in `activeSection === 'security'` (L1089) |
| 7 | `src/pages/AdvancedSettingsPage.css` | **EDIT** | Add styling for tier rows, badges, inline validation errors, and action controls |
| 8 | `src/services/quizCodeService.ts` | **EDIT** | Add `securityTiers?: SecurityViolationTier[]` to `StudentQuizData` (L9–50) and load from `app_config` in `resolveStudentQuiz` (L151–246) |
| 9 | `src/services/examDraftService.ts` | **EDIT** | Extend `ExamDraftPayload` (L8–28) with `securityTiersSnapshot`, `strikeCount`, `lastStrikeAt`, `totalPenaltySeconds`, `tierHistory`, `autoSubmittedBySecurity` |
| 10 | `src/services/examProctorRealtimeService.ts` | **EDIT** | Extend `ProctorStudentState` (L30–60) with `strikeCount`, `currentTierName`, `currentTierAction`, `totalPenaltySeconds`, `autoSubmittedBySecurity` |
| 11 | `src/services/quizSubmissionService.ts` | **EDIT** | Extend `ExamForensics` (L815–845) with `totalPenaltySeconds`, `finalStrikeCount`, `finalTierReached`, `autoSubmittedBySecurity`, `tierHistory` |
| 12 | `src/pages/StudentQuizRunner.tsx` | **EDIT** | Wire tier state, rewrite `logViolation` (L769), update timer lock guard (L2628), update PIN/remote unlock with `resolveUnlockClock` (L865, L1260), update pardon (L1311), render irreversible auto-submit overlay (L6806) |
| 13 | `src/components/LiveInvigilatorModal.tsx` | **EDIT** | Display active tier badge & total penalty on student cards (L144, L1915, L1983), update pardon handler (L935) |
| 14 | `src/components/QuizResultsModal.tsx` | **EDIT** | Update Proctor Integrity Card (L2005–2040) to display final tier reached, penalty time deducted, and auto-submit status |
| 15 | `src/components/StudentResultModal.tsx` | **EDIT** | Display time penalty and tier summary in candidate result view (L256–280) |
| 16 | `src/services/icmExcelExportService.ts` | **EDIT** | Replace hardcoded `violationsCount >= 3` (L496, L550, L874) with tier forensics and add Penalty Minutes info |
| 17 | `src/services/quizReportPdfService.ts` | **EDIT** | Include penalty minutes and final tier in candidate PDF report (L265, L1440) |

---

## 4. Breakdown into Small Executable Steps

Each step below is scoped so it can be implemented and verified independently without breaking the build.

---

### Step 1: Create Pure Tier Engine (`src/lib/securityTiers.ts`)
- **Files**:
  - Create `src/lib/securityTiers.ts`
- **What to implement**:
  - Types: `SecurityTierAction` (`'warning' | 'time_penalty' | 'auto_submit'`), `SecurityViolationTier`, `SecurityTierEvent`.
  - Constants:
    - `DEFAULT_SECURITY_TIERS`:
      1. Strike 1: `Early Warning` (`warning`, `0` min)
      2. Strike 2: `Warning with Penalty` (`time_penalty`, `5` min)
      3. Strike 3: `Severe Warning with Penalty` (`time_penalty`, `10` min)
      4. Strike 4: `Final Warning (Auto Submit)` (`auto_submit`, `0` min)
    - `STRIKE_COALESCE_MS = 2000`
    - `PENALTY_GRACE_SECONDS = 30`
  - Pure functions:
    - `normalizeSecurityTiers(raw: unknown): SecurityViolationTier[]` — parses array/JSON, sorts ascending by `strikeCount`, ensures final tier is `auto_submit`, falls back to `DEFAULT_SECURITY_TIERS` on empty/invalid input.
    - `validateSecurityTiers(tiers: SecurityViolationTier[]): { ok: boolean; errors: string[] }` — checks $\ge 1$ tier, $\le 10$ tiers, integer `strikeCount >= 1`, strictly increasing `strikeCount`, `penaltyMinutes` between $1$ and $120$ for `time_penalty`, and last tier `action === 'auto_submit'`.
    - `resolveTierForStrike(tiers: SecurityViolationTier[], strikeCount: number): SecurityViolationTier | null` — resolves highest tier with `tier.strikeCount <= strikeCount`, clamping to final tier if `strikeCount >= lastTier.strikeCount`.
    - `shouldCountAsStrike(args: { isLocked: boolean; nowMs: number; lastStrikeAtMs: number | null; coalesceMs?: number }): boolean` — returns `false` if `isLocked` (R1) or if `lastStrikeAtMs !== null && nowMs - lastStrikeAtMs < coalesceMs` (R2).
    - `applyTimePenalty(args: { targetEndTime: number; nowMs: number; penaltyMinutes: number }): { targetEndTime: number; remainingSeconds: number; deductedSeconds: number; exhausted: boolean }` — subtracts `penaltyMinutes * 60 * 1000` from `targetEndTime`, clamps to `nowMs`, computes `remainingSeconds` and `exhausted`.
    - `resolveUnlockClock(args: { targetEndTime: number; nowMs: number; graceSeconds?: number }): { targetEndTime: number; remainingSeconds: number; graceApplied: boolean }` — if `targetEndTime <= nowMs`, returns `nowMs + graceSeconds * 1000` with `graceApplied: true`.
- **Verification**:
  - Create `scripts/test-tiered-security-system.mjs` (Parts A & B) and add `"test:security-tiers": "node --import ./scripts/register-ts.mjs scripts/test-tiered-security-system.mjs"` to `package.json`.
  - Run `npm.cmd run test:security-tiers` — all 18 unit & scenario assertions (A1–A12, B1–B6) must pass.

---

### Step 2: Persist & Cloud-Sync Security Tiers in Settings (`src/lib/settings.ts` & `src/App.tsx`)
- **Files**:
  - Edit `src/lib/settings.ts` (lines 9–84, 720+)
  - Edit `src/App.tsx` (lines 15, 149)
- **What to implement**:
  1. In `src/lib/settings.ts`:
     - Import `SecurityViolationTier`, `DEFAULT_SECURITY_TIERS`, `normalizeSecurityTiers` from `./securityTiers`.
     - Add `securityTiers?: SecurityViolationTier[];` to `AppSettings`.
     - Add `securityTiers: DEFAULT_SECURITY_TIERS` to `DEFAULT_SETTINGS`.
     - Implement and export:
       - `getSecurityTiers(): SecurityViolationTier[]`
       - `saveSecurityTiers(tiers: SecurityViolationTier[]): void`
       - `syncSecurityTiersToCloud(tiers: SecurityViolationTier[]): Promise<boolean>` (upserts `app_config` key `'exam_security_tiers'`)
       - `loadAndSyncSecurityTiers(): Promise<SecurityViolationTier[]>` (fetches `'exam_security_tiers'` from `app_config`, normalizes, caches to `localStorage`, dispatches `'security_tiers_updated'` custom event)
  2. In `src/App.tsx`:
     - Import `loadAndSyncSecurityTiers` from `./lib/settings`.
     - Call `loadAndSyncSecurityTiers().catch(() => {});` inside the boot `useEffect` at line 149.
- **Verification**:
  - Run `npx tsc --noEmit` to confirm zero type errors.

---

### Step 3: Build Admin UI for Escalation Tiers (`src/pages/AdvancedSettingsPage.tsx` & `.css`)
- **Files**:
  - Edit `src/pages/AdvancedSettingsPage.tsx` (lines 20–30, 170–225, 1089–1140)
  - Edit `src/pages/AdvancedSettingsPage.css`
- **What to implement**:
  1. Load `securityTiers` into component state via `getSecurityTiers()`, and sync from cloud via `loadAndSyncSecurityTiers()` on mount.
  2. In `activeSection === 'security'` (right at the top of the section around line 1100):
     - Render the **🚨 Violation Escalation Tiers (School-Wide Policy)** card.
     - Live summary pill bar: e.g. `Strike 1: Early Warning (0m) → Strike 2: Warning with Penalty (-5m) → Strike 3: Severe Warning (-10m) → Strike 4: Auto-Submit`.
     - Interactive list of tier rows:
       - **Strike #** input (number $\ge 1$)
       - **Tier Name** input (text)
       - **Action** dropdown:
         - `Early Warning (Teacher PIN Unlock, No Penalty)` (`warning`)
         - `Warning with Time Penalty (Teacher PIN Unlock + Deduct Time)` (`time_penalty`)
         - `Last Warning (Lock & Auto-Submit Immediately)` (`auto_submit`)
       - **Penalty (Minutes)** input (enabled & visible when `action === 'time_penalty'`, badge `No penalty` / `Irreversible Submit` otherwise)
       - **Custom Student Notice** input (optional message shown on the student's lock screen)
       - **Delete Tier** button (disabled if `tiers.length <= 1` or on the required final `auto_submit` row unless another row becomes final)
     - Action footer:
       - **+ Add Escalation Tier** button (inserts a new `time_penalty` tier just before the final `auto_submit` tier and increments the final tier's strike count by 1).
       - **↺ Restore 4-Tier Default** button (resets to `DEFAULT_SECURITY_TIERS`).
     - Validation banner: calls `validateSecurityTiers(securityTiers)`; displays any validation errors inline and disables the Save button if invalid.
  3. Wire `handleSaveSettings` to also call `saveSecurityTiers(securityTiers)` when validation passes.
- **Verification**:
  - Run `npx tsc --noEmit` to verify compilation.

---

### Step 4: Deliver Tiers to Candidate Sessions & Extend Data Contracts
- **Files**:
  - Edit `src/services/quizCodeService.ts` (lines 9–50, 151–246)
  - Edit `src/services/examDraftService.ts` (lines 8–28)
  - Edit `src/services/examProctorRealtimeService.ts` (lines 30–60)
  - Edit `src/services/quizSubmissionService.ts` (lines 815–845)
- **What to implement**:
  1. `src/services/quizCodeService.ts`:
     - Add `securityTiers?: SecurityViolationTier[]` to `StudentQuizData`.
     - Create helper `fetchSchoolSecurityTiers(): Promise<SecurityViolationTier[]>` that reads `app_config` where `key = 'exam_security_tiers'` with fallback to `getSecurityTiers()`.
     - In `resolveStudentQuiz` (both published quiz branch and local test fallback), attach `securityTiers`.
  2. `src/services/examDraftService.ts`:
     - Add `securityTiersSnapshot?: SecurityViolationTier[]`, `strikeCount?: number`, `lastStrikeAt?: number | null`, `totalPenaltySeconds?: number`, `tierHistory?: SecurityTierEvent[]`, `autoSubmittedBySecurity?: boolean` to `ExamDraftPayload`.
  3. `src/services/examProctorRealtimeService.ts`:
     - Add `strikeCount?: number`, `currentTierName?: string`, `currentTierAction?: SecurityTierAction`, `totalPenaltySeconds?: number`, `autoSubmittedBySecurity?: boolean` to `ProctorStudentState`.
  4. `src/services/quizSubmissionService.ts`:
     - Add `totalPenaltySeconds?: number`, `finalStrikeCount?: number`, `finalTierReached?: string`, `autoSubmittedBySecurity?: boolean`, `tierHistory?: SecurityTierEvent[]` to `ExamForensics`.
- **Verification**:
  - Run `npx tsc --noEmit` to confirm all service contracts type-check cleanly.

---

### Step 5: Enforce Multi-Tier Escalation in `StudentQuizRunner.tsx`
- **Files**:
  - Edit `src/pages/StudentQuizRunner.tsx`
- **What to implement**:
  1. **State initialization** (around L465–485):
     - Add `securityTiers` state (initialized from `savedExam?.securityTiersSnapshot || DEFAULT_SECURITY_TIERS`, updated when `resolveStudentQuiz` loads unless `savedExam?.securityTiersSnapshot` is already locked in).
     - Add `strikeCount` state (`savedExam?.strikeCount ?? 0`).
     - Add `lastStrikeAtRef` (`useRef<number | null>(savedExam?.lastStrikeAt ?? null)`).
     - Add `totalPenaltySeconds` state (`savedExam?.totalPenaltySeconds ?? 0`).
     - Add `tierHistory` state (`savedExam?.tierHistory ?? []`).
     - Add `activeLockedTier` state (`SecurityViolationTier | null`).
     - Add `isFinalSecurityLock` state (`Boolean(savedExam?.autoSubmittedBySecurity)`).
  2. **Rewrite `logViolation`** (L769–855):
     - Always append to `violations` log for forensic completeness.
     - If `!isExamMode || !securityEnabled`: show standard non-locking warning banner (R3).
     - Check `shouldCountAsStrike({ isLocked: isLockedByProctor || isFinalSecurityLock, nowMs: Date.now(), lastStrikeAtMs: lastStrikeAtRef.current })` (R1 & R2). If `false`, broadcast log update without incrementing `strikeCount` and return.
     - Increment `newStrike = strikeCount + 1`, update `lastStrikeAtRef.current = Date.now()`, set `strikeCount(newStrike)`.
     - Resolve tier via `matchedTier = resolveTierForStrike(securityTiers, newStrike)`.
     - Record `SecurityTierEvent` in `tierHistory`.
     - Branch on `matchedTier.action`:
       - `'warning'`:
         - Lock exam (`setIsLockedByProctor(true)`), set `activeLockedTier(matchedTier)`, set `lockReason` with tier name & no-penalty notice.
       - `'time_penalty'`:
         - Compute `penaltyResult = applyTimePenalty({ targetEndTime: targetEndTime || Date.now() + timeLeft * 1000, nowMs: Date.now(), penaltyMinutes: matchedTier.penaltyMinutes })`.
         - Update `setTargetEndTime(penaltyResult.targetEndTime)` and `setTimeLeft(penaltyResult.remainingSeconds)`.
         - Add `penaltyResult.deductedSeconds` to `totalPenaltySeconds`.
         - Lock exam (`setIsLockedByProctor(true)`), set `activeLockedTier(matchedTier)`, set `lockReason` explaining `-X minutes deducted`.
       - `'auto_submit'`:
         - Set `setIsFinalSecurityLock(true)`, `setIsLockedByProctor(true)`, `setActiveLockedTier(matchedTier)`.
         - Broadcast `status: 'submitted'` and `autoSubmittedBySecurity: true` to proctor channel.
         - Trigger `submitExamRef.current()` immediately to persist submission to Supabase/cloud.
  3. **Guard countdown timer while locked** (L2628):
     - In `syncRemainingTime()`, if `remainingSec <= 0`: only auto-submit if `!isLockedByProctor || isFinalSecurityLock`. While waiting for teacher PIN on a `warning` or `time_penalty` lock, hold timer at `00:00` without auto-submitting behind the lock screen.
  4. **Apply 30s Grace Window on Unlock** (L865 `handleUnlockWithPin` & L1260 `cmd.type === 'unlock'`):
     - If `isFinalSecurityLock` is `true`, ignore unlock attempts.
     - Call `resolveUnlockClock({ targetEndTime, nowMs: Date.now() })`.
     - If `graceApplied`, update `setTargetEndTime` and `setTimeLeft(30)` and display alert: `"🔓 Exam unlocked. 30-second grace period granted to finalize answers before automatic submission."`
  5. **Update Pardon Handler** (L1311 `cmd.type === 'pardon'`):
     - If `isFinalSecurityLock` is `true`, ignore pardon.
     - Reset `setStrikeCount(0)` and `lastStrikeAtRef.current = null` (so next violation starts at Strike 1 / Tier 1).
     - Keep `violations`, `totalPenaltySeconds`, and reduced `targetEndTime` intact.
     - Unlock the exam and notify candidate.
  6. **Update Lock Screen UI** (L6806):
     - Display current Tier Badge (`Tier: ${activeLockedTier?.name}`), Strike Counter (`Strike ${strikeCount} of ${finalTierStrike}`), and Penalty Notice (if `time_penalty`, show `-X mins deducted` in red badge; if `warning`, show `No time penalty`).
     - When `isFinalSecurityLock` is `true`:
       - Hide the Teacher PIN form completely.
       - Show an irreversible **🛑 FINAL SECURITY VIOLATION — EXAM AUTO-SUBMITTED** panel with sync status indicator and a **"View Submission Receipt"** button once `isSubmitted` completes.
  7. **Update Badge, Draft Auto-Save & Forensics** (L1597, L2569, L2946, L5552):
     - Top bar badge (L5552) shows `⚠️ ${strikeCount} strike(s)` (and `-Xm` if penalized).
     - Include `strikeCount`, `totalPenaltySeconds`, `finalTierReached`, `autoSubmittedBySecurity`, `tierHistory` in `ExamForensics` and `saveExamDraft`.
- **Verification**:
  - Run `npx tsc --noEmit` to confirm `StudentQuizRunner.tsx` compiles with zero errors.

---

### Step 6: Update Live Invigilator Cockpit (`src/components/LiveInvigilatorModal.tsx`)
- **Files**:
  - Edit `src/components/LiveInvigilatorModal.tsx` (lines 144–160, 300–320, 935–982, 1910–2030)
- **What to implement**:
  1. Update `isExceeded` / status badge logic (L144–156, L1915) to display:
     - `🛑 AUTO-SUBMITTED (Strike X)` when `s.autoSubmittedBySecurity` is true.
     - `⏱️ ${s.currentTierName} (-${Math.round((s.totalPenaltySeconds || 0)/60)}m)` when penalty tier active.
     - `⚠️ ${s.currentTierName || 'Warning'} (Strike ${s.strikeCount ?? s.violationsCount})` on warning tier.
  2. In student telemetry row (L1983), show `${s.strikeCount ?? s.violationsCount} strike(s)` and total time penalty if `totalPenaltySeconds > 0`.
  3. In `handlePardon` (L935):
     - Hide pardon button if `s.autoSubmittedBySecurity` is true.
     - Reset `strikeCount: 0` on local state while preserving `totalPenaltySeconds`.
     - Update audit log detail to `"Security strike counter reset to 0 by invigilator (prior time penalties retained)"`.
- **Verification**:
  - Run `npx tsc --noEmit`.

---

### Step 7: Update Results Modal, Student Result View, Excel & PDF Reports
- **Files**:
  - Edit `src/components/QuizResultsModal.tsx` (L2005–2040)
  - Edit `src/components/StudentResultModal.tsx` (L256–280)
  - Edit `src/services/icmExcelExportService.ts` (L496, L550, L874, L1005)
  - Edit `src/services/quizReportPdfService.ts` (L265, L1440)
- **What to implement**:
  1. `QuizResultsModal.tsx`:
     - Replace the outdated `"Real-time invigilator notification was dispatched without auto-submitting the exam"` message at L2022 with dynamic tier reporting:
       - If `forensics?.autoSubmittedBySecurity`: `"🛑 Auto-Submitted by Security Policy: Candidate reached final tier (${forensics.finalTierReached}). Exam was automatically locked and submitted."`
       - Show total time penalty deducted (`-${Math.round(forensics.totalPenaltySeconds / 60)} mins`) and the `tierHistory` timeline if present.
  2. `StudentResultModal.tsx`:
     - Show penalty time deducted and final tier reached alongside strike count.
  3. `icmExcelExportService.ts`:
     - Replace hardcoded `s.violationsCount >= 3` (L496, L550, L874) with `Boolean(s.forensics?.autoSubmittedBySecurity || s.forensics?.exceededMaxViolations)`.
     - Include penalty minutes in integrity status string (e.g. `Flagged (2 Strikes, -5m Penalty)` or `Auto-Submitted (4 Strikes, -15m Penalty)`).
  4. `quizReportPdfService.ts`:
     - Append penalty summary (`-${mins}m penalty`) next to strikes in the summary table and individual candidate report card.
- **Verification**:
  - Run `npx tsc --noEmit`.

---

### Step 8: Complete Source Tripwires & Full Regression Verification
- **Files**:
  - Edit `scripts/test-tiered-security-system.mjs` (add Section C source tripwires C1–C10)
- **What to run**:
  1. `npm.cmd run test:security-tiers` (all A1–A12, B1–B6, C1–C10 assertions pass)
  2. `node scripts/test-exam-submission-fixes.mjs`
  3. `node scripts/test-mcq-grading-flow.mjs`
  4. `node scripts/test-test-builder-header-persistence.mjs`
  5. `node scripts/test-gemini-key-tier-proxy.mjs`
  6. `npm.cmd run test:gestures`
  7. `npm.cmd run build` (`tsc -b && vite build`)
