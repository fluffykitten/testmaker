# Findings & Recommendations: OS/Browser Notifications and Browser AI Extensions / Side Panels

**Date:** 2026-11-18  
**Scope:** Client-side Exam Mode security analysis (`StudentQuizRunner.tsx`, `examSecurityUtils.ts`, `useMobileLifecycle.ts`)  
**Status:** Investigation complete — documentation & recommendations only (no code modified).

---

## 1. Executive Summary

TestMaker's Exam Mode relies on standard browser focus, visibility, fullscreen, keyboard, and clipboard interceptors. While these catch **focus-stealing interactions** (clicking a notification, clicking into a browser side panel, pressing Windows/Copilot keys), a standard web page runs inside a browser sandbox and currently has **two detectable client-side gaps** plus **inherent browser sandbox limitations**:

1. **OS / Browser Notifications:** Passive toast banners that appear without stealing window focus or exiting fullscreen are invisible to the web page and do not trigger a violation. Notifications that steal focus or minimize/switch away from the exam tab are caught via `blur`, `visibilitychange`, `fullscreenchange`, or native Capacitor `appStateChange`.
2. **Gemini / Copilot / AI Browser Extensions & Side Panels:** TestMaker blocks Windows/Copilot keys, copy/paste, context menus, and drag-and-drop, and catches focus loss if the student clicks into an AI side panel. However, it **does not** detect viewport shrinkage caused by opening a docked Side Panel (`innerWidth` vs `outerWidth`), nor does it detect third-party AI extension overlays injected directly into the page DOM (`MutationObserver`). Furthermore, no webpage can list or disable installed browser extensions or stop extensions with page-read permissions from reading question text in the background.

---

## 2. Current Implementation Findings

### 2.1 OS & Browser Notifications

| Behavior / Event | Current Handling | Verified Source |
| :--- | :--- | :--- |
| **Passive OS / browser toast (no click, no focus loss)** | **Not detected / not blocked.** TestMaker does not call or restrict the `Notification` API, and web pages cannot suppress OS or other-origin notifications. | No `Notification` handler in `src/` |
| **Notification steals focus or student clicks it** | `handleWindowBlur` logs `'window_blur'` (`"Exam window lost focus (Alt+Tab / App switch)"`), subject to the navigation-gesture guard (`wasRecentlyIntercepted`). | `src/pages/StudentQuizRunner.tsx` (`L1664-1675`) |
| **Clicking notification switches tab / minimizes browser** | `handleVisibilityChange` checks `document.hidden` (with 600 ms gesture guard) and logs `'tab_switch'`. | `src/pages/StudentQuizRunner.tsx` (`L1656-1661`) |
| **Notification breaks fullscreen** | `handleFullscreenChange` sets a 5-second grace warning (`isFullscreenGraceActive`) on the 1st exit, then triggers an immediate PIN lock on the 2nd+ exit (`'fullscreen_exit'`). | `src/pages/StudentQuizRunner.tsx` (`L1682-1718`) |
| **Mobile native notification shade / app backgrounding (Capacitor)** | `App.addListener('appStateChange')` emits `'mobile-proctor-violation'` when `!isActive`, which `handleMobileProctor` logs as `'window_blur'`. | `src/hooks/useMobileLifecycle.ts` (`L45-54`), `src/pages/StudentQuizRunner.tsx` (`L1883-1888`) |

### 2.2 Gemini / Copilot / AI Browser Extensions & Browser Side Panels

#### What Is Already Protected
1. **Windows & Copilot Key Interception:**
   - `isWindowsOrCopilotKey` matches `Meta`/`OS` (`MetaLeft`/`MetaRight`, `OSLeft`/`OSRight`), `F23` / `LaunchAssistant` / `Assistant` (Windows 11 Copilot key), and `Win+C` (`src/utils/examSecurityUtils.ts`, `L249-276`).
   - `handleKeyDown` and `handleKeyUp` silently suppress these keys in Exam Mode (`src/pages/StudentQuizRunner.tsx`, `L1793-1797`, `L1844-1847`).
   - `enableKeyboardLock(EXAM_LOCKED_KEYS)` requests W3C Keyboard Lock for `['Escape', 'F11', 'MetaLeft', 'MetaRight', 'F23']` while fullscreen is active, falling back to `['Escape', 'F11']` if rejected (`src/utils/examSecurityUtils.ts`, `L198-199`, `L283-300`, `L336-338`).
2. **Side Panel / Extension Popup Focus Loss:**
   - Clicking inside Chrome's Side Panel (e.g., Gemini in Chrome), Edge's Copilot sidebar, or an extension popup shifts focus out of the page `window`, firing `handleWindowBlur` → `'window_blur'`.
3. **Manual Extraction & DevTools Friction:**
   - **Right-click menu:** `onContextMenu` prevented across exam UI surfaces (`src/pages/StudentQuizRunner.tsx`, `L6455`, `L6517`, `L6780`, `L7269`, `L7461`, `L8186`).
   - **Copy / Cut / Paste:** `copy`, `cut` (also logs `'blocked_shortcut'`), `paste` events and keyboard shortcuts (`isCopyShortcut`, `isPasteShortcut`) are intercepted in Exam Mode (`src/pages/StudentQuizRunner.tsx`, `L1823-1880`; `src/utils/examSecurityUtils.ts`, `L214-242`).
   - **Selection & Drag:** `user-select: none` on rendered question text (`src/components/ExamMathText.css`, `L151`, `L201`) and global `dragstart` prevention (`src/pages/StudentQuizRunner.tsx`, `L2395-2405`).
   - **DevTools / Source shortcuts:** `F12`, `Ctrl+Shift+I/J/C`, and `Ctrl+P/S/U` are blocked and recorded as `'blocked_shortcut'` (`src/pages/StudentQuizRunner.tsx`, `L1805-1822`).

#### Current Gaps in Detection
1. **No Side-Panel / Viewport-Shrink Detection:**
   - The `resize` listener in `StudentQuizRunner.tsx` (`L1956-1961`) only runs `detectMultiMonitor()`, which checks `screen.isExtended`, already-granted `window-management` / `getScreenDetails()`, window coordinates, and `window.outerWidth > screenWidth + 50` (`src/utils/examSecurityUtils.ts`, `L66-150`).
   - It does **not** check if `window.innerWidth` shrinks noticeably relative to `window.outerWidth` or `window.screen.width` (which occurs when a browser Side Panel or docked DevTools opens alongside the page without necessarily leaving the window).
2. **No Extension DOM-Injection Detection:**
   - There is **no** `MutationObserver` monitoring `document.documentElement` or `document.body` for unexpected third-party elements, shadow-DOM host tags, or floating AI assistant overlays injected directly inside the exam tab.
   - If an extension injects an interactive widget inside the DOM (or shows a hover toolbar) without stealing `window` focus, no violation is logged.
3. **Browser Sandbox Limitations (Cannot Be Solved in Standard Web JS Alone):**
   - A web page **cannot** enumerate installed browser extensions (`chrome.management` is inaccessible to web content).
   - A web page **cannot** disable built-in browser AI assistants (Chrome Gemini, Edge Copilot) or block browser/extension-reserved global hotkeys when Keyboard Lock is inactive or unsupported.
   - An extension with host read permissions can read the rendered DOM text in the background without typing, copying, or moving focus.

---

## 3. Recommendations

### Tier 1 — Immediate High-Value Client Hardening (Inside Existing Web App)

1. **Add Docked Side-Panel / Viewport-Shrink Detection**
   - In Exam Mode (`isExamMode && securityEnabled && hasStarted`), monitor `window.innerWidth` vs `window.outerWidth` / `window.screen.width` inside `resize` and a periodic check (or inside `detectMultiMonitor` / a sibling `detectViewportObstruction` helper in `src/utils/examSecurityUtils.ts`).
   - Flag a violation or warning if:
     - Fullscreen is active (`document.fullscreenElement`) OR the window previously occupied full width, and `window.outerWidth - window.innerWidth` exceeds a safe scrollbar/chrome margin (e.g., `> 120px`), **or**
     - In desktop fullscreen mode, `window.innerWidth < window.screen.width * 0.85` (indicating a docked side panel, split view, or docked DevTools pane).
   - *False-positive guard:* Exclude mobile/tablet viewports, browser zoom changes (`devicePixelRatio` shifts), and allow normal browser scrollbar widths (~15–25px).

2. **Add an Extension DOM-Injection Monitor (`MutationObserver`)**
   - Attach a lightweight `MutationObserver` watching direct children of `document.documentElement` and `document.body` (excluding `#root` and known portal roots used by React/TestMaker modals).
   - Check newly added nodes for:
     - Unexpected top-level custom elements (`tagName.includes('-')`), extension URLs (`chrome-extension://`, `moz-extension://`, `safari-extension://`) inside attributes/styles/scripts, or unexpected `shadowRoot` hosts outside TestMaker's own UI.
   - Action on detection:
     - **Option A (Strict):** Show a blocking pre-exam / mid-exam banner instructing the student to disable/hide the extension overlay and log a telemetry event (`'extension_overlay_detected'`) to the Live Proctor dashboard so invigilators know which student has an active AI/grammar overlay.
     - **Option B (Defensive):** Optionally hide/disable (`display: none !important` or remove only clearly matched non-app top-level injected siblings outside `#root`), while logging to the proctor audit trail — taking care not to break legitimate accessibility tools or password managers unless flagged as suspicious.

3. **Pre-Exam Readiness Check (Before `hasStarted`)**
   - Before clicking **Start Assessment**, advise candidates cleanly in the pre-exam checklist to:
     - Enable OS **Do Not Disturb / Focus Assist** (so incoming notifications do not steal focus or trigger a `window_blur` strike).
     - Disable AI / grammar / translation browser extensions and close any browser sidebars.
   - Optionally check if `window.innerWidth` is already clipped by a side panel before entering fullscreen and warn the student upfront.

### Tier 2 — Operational & Environment Controls (For High-Stakes Exams)

Because browser extensions with DOM access cannot be fully prevented from a standard browser tab:

1. **Managed Devices / Chromebook Locked Mode / Kiosk Profile:**
   - For high-stakes summative assessments, run TestMaker inside a managed Guest/Kiosk browser profile or Chromebook Managed Exam session with extensions disabled and side panels blocked by policy.
2. **Safe Exam Browser (SEB) / Locked Browser Wrapper (Optional Future Track):**
   - If unmanaged student laptops must be locked down against AI sidebars, browser extensions, and background OS notifications, distribute exam links to launch inside Safe Exam Browser (which wraps the web app in a locked-down Chromium shell with notifications, extensions, and OS shortcuts disabled).

---

## 4. Suggested Rollout Order (If Implemented Later)

1. **Quick win & zero risk:** Add pre-exam **Do Not Disturb + Close Extensions/Sidebars** advisory notice in the Exam Mode security banner.
2. **Phase A (Side-panel shield):** Implement `detectViewportObstruction` / side-panel width ratio check + unit tests in `scripts/test-exam-security-panels.mjs`.
3. **Phase B (DOM injection telemetry):** Add scoped `MutationObserver` outside `#root` that logs proctor audit warnings (telemetry-first before enabling hard PIN locks, to validate zero false positives across browsers and devices).
