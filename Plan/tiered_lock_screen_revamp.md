# Implementation Plan: Tier-Adaptive Exam Lock Screen Revamp

**Specification Version**: 2.0.0 (Step-by-Step Execution & UI Guardrails Edition)  
**Target Files**:
- `src/pages/StudentQuizRunner.tsx`
- `src/pages/StudentQuizRunner.css`
- `scripts/test-tiered-security-system.mjs`

**Status**: Ready for Step-by-Step Execution  

---

## 1. Root-Cause Analysis of Prior UI Errors & Mandatory Guardrails

Before writing any JSX or CSS, all changes must obey these **5 Layout & Overflow Guardrails** so the out-of-bounds / overlapping box issues from earlier never recur:

### Guardrail G1 — No Unbounded Text in Narrow Horizontal Columns
- The lock card has `max-width: 540px` (`~484px` inner width).
- A 4-step horizontal progression bar gives each step at most `~110px` of width.
- **Rule**: Step nodes in the horizontal progression bar MUST NOT render verbose user-configured tier names (like `"Severe Warning with Penalty"`). Instead, each step node renders:
  1. Top pill/circle: `✓` (completed) or `Strike N`
  2. Bottom concise action tag: `Warning` | `-${penaltyMinutes}m` | `Auto-Submit`
- If a school configures `> 4` tiers, `.sq-lockdown-stepper` wraps cleanly (`flex-wrap: wrap`) with `min-width: 96px` per step so boxes never crush or overflow the card border.

### Guardrail G2 — Key-Value Row Collision Prevention (`.sq-lockdown-row`)
- **Prior Bug in Lock Screen Screenshot**: `.sq-lockdown-row` used `display: flex; justify-content: space-between; align-items: center;` with **no `gap`** and **no `flex-shrink: 0`** on `.sq-ld-lbl`. When `Violation Event` had a 3-line message, `"Violation Event:"` broke into 2 lines and collided directly with the value text (`0px` spacing).
- **Rule**:
  - `.sq-lockdown-row` MUST enforce `gap: 16px; align-items: flex-start;`.
  - `.sq-ld-lbl` MUST enforce `flex-shrink: 0; white-space: nowrap;`.
  - `.sq-ld-val` MUST enforce `text-align: right; min-width: 0; overflow-wrap: break-word; line-height: 1.4;`.
  - Strip redundant `[Tier Name]` and `"Invigilator PIN required to resume..."` boilerplate from the displayed `Violation Event` value so it cleanly displays only the actual trigger (e.g., `"Attempted to leave the exam view (Escape / F11 intercepted)"`).

### Guardrail G3 — Strict `box-sizing` and `min-width: 0` on All Flex/Grid Children
- Every child inside `.sq-lockdown-card`, `.sq-lockdown-stepper`, `.sq-lockdown-details-box`, and `.sq-ld-input-row` MUST have `box-sizing: border-box` and `min-width: 0` where flex shrinking is expected.

### Guardrail G4 — CSS Custom Properties for Tier Color Escalation
- Instead of scattering inline style overrides that can conflict with stylesheet rules, `.sq-lockdown-card` will set scoped CSS variables (`--ld-accent`, `--ld-accent-rgb`, `--ld-border`, `--ld-bg-tint`, `--ld-glow`) via modifier classes:
  - `.sq-lockdown-card--warning` (Amber `#f59e0b`)
  - `.sq-lockdown-card--time_penalty` (Vivid Orange `#ea580c`)
  - `.sq-lockdown-card--final` (Critical Red `#dc2626`)

### Guardrail G5 — Mobile & Small-Viewport Safety
- On viewports `< 480px`, `.sq-ld-input-row` stacks vertically (`flex-direction: column`) and `.sq-lockdown-card` reduces padding to `22px 18px` with `max-height: calc(100vh - 32px); overflow-y: auto;` so content never clips off-screen.

---

## 2. Visual Escalation Matrix

| Tier / State | Modifier Class | Primary Accent (`--ld-accent`) | Border & Outer Glow | Icon | Header Title |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Strike 1 (Warning)** | `.sq-lockdown-card--warning` | Amber (`#f59e0b`) | `rgba(245, 158, 11, 0.65)`<br>`0 0 40px rgba(245, 158, 11, 0.28)` | `⚠️` | `EXAMINATION PAUSED (FIRST WARNING)` |
| **Strikes 2–3 (Penalty)** | `.sq-lockdown-card--time_penalty` | Vivid Orange (`#ea580c`) | `rgba(234, 88, 12, 0.75)`<br>`0 0 45px rgba(234, 88, 12, 0.35)` | `🚨` | `EXAMINATION LOCKED (TIME PENALTY)` |
| **Final Strike (Auto-Submit)** | `.sq-lockdown-card--final` | Critical Red (`#dc2626`) | `rgba(220, 38, 38, 0.85)`<br>`0 0 55px rgba(220, 38, 38, 0.45)` | `🛑` | `EXAMINATION TERMINATED (STRIKE LIMIT REACHED)` |

---

## 3. Small Executable Steps

### Step 1: Add Pure Helper for Lock Screen Presentation Metadata
- **Goal**: Centralize the lock screen's derived presentation state (modifier class, icon, title, clean violation event text, stepper items, and remaining strikes counter) so JSX remains clean and testable.
- **File**: `src/lib/securityTiers.ts`
- **Changes**:
  - Export `resolveLockScreenPresentation({ tiers, strikeCount, activeTier, isFinalLock, rawLockReason })`:
    - Returns:
      - `variant`: `'warning' | 'time_penalty' | 'final'`
      - `icon`: `'⚠️' | '🚨' | '🛑'`
      - `title`: `'EXAMINATION PAUSED (FIRST WARNING)' | 'EXAMINATION LOCKED (TIME PENALTY)' | 'EXAMINATION TERMINATED (STRIKE LIMIT REACHED)'`
      - `cleanViolationEvent`: strips leading `[TierName]` and trailing `Invigilator PIN required...` / `Penalty: -Xm...` suffix from `rawLockReason` so the incident row shows a concise 1-line description.
      - `steps`: array of `{ strike: number; shortLabel: string; status: 'completed' | 'active' | 'upcoming'; action: SecurityTierAction }` where `shortLabel` is strictly bounded (`'Warning'`, `'-5m'`, `'-10m'`, `'Auto-Submit'`).
      - `strikesRemaining`: number of strikes left before the `auto_submit` tier (`Math.max(0, finalStrike - strikeCount)`).
- **Verification**: Run a quick node check confirming `resolveLockScreenPresentation` outputs accurate metadata for Strikes 1, 2, 3, and 4.

---

### Step 2: Refactor Lock Screen CSS with Scoped Tier Variables & Overflow Guards
- **Goal**: Update `.sq-lockdown-*` styles in `src/pages/StudentQuizRunner.css` with zero out-of-bounds risk.
- **File**: `src/pages/StudentQuizRunner.css`
- **Changes**:
  1. Define `--ld-accent`, `--ld-border`, `--ld-glow`, `--ld-tint-bg`, and `--ld-tint-border` on `.sq-lockdown-card` with modifier classes:
     - `.sq-lockdown-card--warning`
     - `.sq-lockdown-card--time_penalty`
     - `.sq-lockdown-card--final`
  2. Fix `.sq-lockdown-row`, `.sq-ld-lbl`, and `.sq-ld-val` per **Guardrail G2** (`gap: 16px`, `align-items: flex-start`, `white-space: nowrap` on label, `text-align: right` on value).
  3. Add bounded styles for the Horizontal Step Progression Bar (`.sq-lockdown-stepper`, `.sq-lockdown-step`, `.sq-lockdown-step--completed`, `.sq-lockdown-step--active`, `.sq-lockdown-step--upcoming`, `.sq-lockdown-remaining-pill`) per **Guardrail G1**.
  4. Bind `.sq-ld-form-header`, `.sq-ld-pin-input:focus`, and `.sq-ld-unlock-btn` to `--ld-accent` so the Compact Inline Unlock Gate matches the active tier color.
  5. Add `@media (max-width: 480px)` responsive rules per **Guardrail G5**.
- **Verification**: Inspect CSS rules for any fixed column widths or unguarded flex containers.

---

### Step 3: Wire Tier-Adaptive Header & Step Progression Bar in `StudentQuizRunner.tsx`
- **Goal**: Connect `resolveLockScreenPresentation` into `StudentQuizRunner.tsx` and render the tier-specific icon, title, subtitle, and horizontal step progression bar.
- **File**: `src/pages/StudentQuizRunner.tsx`
- **Changes**:
  - Call `resolveLockScreenPresentation` via `useMemo`.
  - Apply `sq-lockdown-card--${lockPresentation.variant}` to `.sq-lockdown-card`.
  - Render dynamic icon (`⚠️` / `🚨` / `🛑`) and title (`EXAMINATION PAUSED (FIRST WARNING)` / `EXAMINATION LOCKED (TIME PENALTY)` / `EXAMINATION TERMINATED (STRIKE LIMIT REACHED)`).
  - Render `.sq-lockdown-stepper` directly below `.sq-lockdown-subtitle` showing each step badge (`Strike 1 • Warning` → `Strike 2 • -5m` → `Strike 3 • -10m` → `Strike 4 • Auto-Submit`) and the remaining strikes notice (`"X strikes remaining before automatic submission"`).
- **Verification**: Run `tsc -b` to verify zero TypeScript issues.

---

### Step 4: Clean Up Incident Details Box & Color-Accented Inline Unlock Gate
- **Goal**: Fix the cramped `Violation Event:` row and ensure the minimalist `Time Deducted` row and inline PIN gate align cleanly.
- **File**: `src/pages/StudentQuizRunner.tsx`
- **Changes**:
  - Use `lockPresentation.cleanViolationEvent` in the `Violation Event:` row so it no longer repeats the tier name or PIN instructions.
  - Keep `Time Deducted: -X min penalty` as a clean minimalist row inside `.sq-lockdown-details-box` (shown whenever `totalPenaltySeconds > 0`).
  - Keep the Compact Inline Unlock Gate (`.sq-ld-input-row`) with its single input and button, styled automatically by the card's `--ld-accent` CSS variable.
- **Verification**: Run `tsc -b` to verify clean compilation.

---

### Step 5: Add Automated Unit & Source Tripwire Tests
- **Goal**: Lock in the new presentation logic and CSS guardrails with automated tests.
- **File**: `scripts/test-tiered-security-system.mjs`
- **Changes**:
  - Add unit tests for `resolveLockScreenPresentation` across Strike 1 (Warning), Strike 2 (Penalty -5m), Strike 3 (Penalty -10m), and Strike 4 (Auto-Submit):
    - Verify titles, icons, variants, bounded `shortLabel` length (`<= 12` chars so it never overflows), `cleanViolationEvent` stripping, and `strikesRemaining` math.
  - Add CSS tripwire assertions verifying `.sq-lockdown-row` has `gap` and `.sq-ld-lbl` has `white-space: nowrap` and `flex-shrink: 0`.
- **Verification**: Run `npm run test:security-tiers` and `npm run build` (`tsc -b && vite build`).
