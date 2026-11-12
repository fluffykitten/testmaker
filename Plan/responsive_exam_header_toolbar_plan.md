# Responsive Exam Header & Tools Bar Plan

## Diagnosis

In [`StudentQuizRunner.tsx`](../src/pages/StudentQuizRunner.tsx#L6268-L6502) and [`StudentQuizRunner.css`](../src/pages/StudentQuizRunner.css#L43-L119), the top exam bar (`.sq-runner-header`) puts the title, subject badge, and up to **10 right-side controls** on a single non-wrapping flex row:

- Left: `.sq-runner-title` + `.sq-runner-subject` (no `min-width: 0`, no `flex-shrink`, no ellipsis truncation).
- Right: inline `<div style={{ display: 'flex', gap: '8px' }}>` holding `Attachments`, `Resource Booklet`, `Periodic Table`, `Calculator`, `Scratchpad`, `Q 10/10 (8/11)`, plus `Strikes`, `Timer`, `Emergency Save`, and `Finish & Submit`.
- There are **no laptop breakpoints** (nothing between `860px` and desktop `1440px+`), and tool buttons lack CSS utility classes (`white-space: nowrap`, responsive sizing). On `1024px–1366px` student laptops, the tools press directly against the exam title, wrap unevenly, and clutter the header.

---

## Proposed Architecture (Zero Collisions Across Desktop, Laptop & Tablet)

1. **Always-Clean Primary Row**:
   - **Left Zone (`.sq-runner-title-group`)**: `flex: 1 1 200px; min-width: 0;` with single-line ellipsis truncation on `.sq-runner-title` (with `title={title}` hover tooltip) and `flex-shrink: 0` on `.sq-runner-subject`.
   - **Critical Status & Actions (`.sq-header-actions`)**: Strike badge, Timer (`⏱️ 19:00`), and `Finish & Submit` always stay pinned, unclipped, and single-line (`white-space: nowrap; flex-shrink: 0`).
2. **Eliminate Redundant Pill on Desktop/Laptop**:
   - Hide `.sq-header-nav-btn` (`Q 10/10 (8/11)`) whenever the right-hand **Question Navigator** sidebar is already visible (`> 860px`), freeing ~115px immediately.
3. **Responsive Tools Layout Across Breakpoints**:
   - **`>= 1400px` (Large Desktop)**: Single clean row with full tool pills, comfortable spacing (`gap: 8px`), and capped title `max-width` so it never crowds the tools.
   - **`1024px – 1399px` (Small–Standard Laptops)**: Either:
     - **Option A (Recommended — Slim Sub-Bar / Two-Tier Exam Bar)**: Keep Row 1 strictly for `Title + Subject` (left) and `Strikes + Timer + Emergency Save + Finish & Submit` (right), and place `.sq-header-tools-bar` cleanly underneath as a compact, centered/left-aligned utility strip with balanced pills (`Attachments`, `Resource Booklet`, `Periodic Table`, `Calculator`, `Scratchpad`) whenever 2+ tools are active — zero hidden tools, zero title overlap.
     - **Option B (`🧰 Tools (N) ▾` Dropdown)**: Keep 1 single 56px header row at all widths >= 768px by grouping `Attachments`, `Resource Booklet`, `Periodic Table`, `Calculator`, `Scratchpad` (and `Emergency Save`) into one crisp `🧰 Tools (N) ▾` popover menu on viewports `<= 1360px` (saving ~42px vertical height).
   - **`<= 860px` (Tablet / Mobile)**: Compact header (`Timer + Submit + Tools/Q-Nav`), horizontally scrollable or popover tools drawer without overflowing viewport width.
4. **Sticky Audio Bar Offset Sync**:
   - Currently `.sq-ielts-audio-bar` hardcodes `top: 56px` ([`StudentQuizRunner.css:150`](../src/pages/StudentQuizRunner.css#L150)). Track header height via a CSS custom property `--sq-header-height` (updated via `ResizeObserver` on `.sq-runner-header`) so the sticky listening bar always docks cleanly beneath the header regardless of 1-row vs 2-row height.

---

## Executable Implementation Steps

### Step 1: Extract Header Inline Styles & Title Truncation
- **Files**: `src/pages/StudentQuizRunner.tsx`, `src/pages/StudentQuizRunner.css`
- **Changes**:
  - Replace inline `style={{ ... }}` objects on header tool buttons and container ([`StudentQuizRunner.tsx:6276-6490`](../src/pages/StudentQuizRunner.tsx#L6276-L6490)) with semantic CSS classes (`.sq-header-tools`, `.sq-tool-btn`, `.sq-tool-btn--emerald`, `.sq-tool-btn--sky`, `.sq-tool-btn--purple`, `.sq-tool-btn--amber`, `.sq-header-actions`).
  - Add `min-width: 0; flex: 1 1 auto;` to `.sq-runner-title-group`, single-line ellipsis truncation + `title={title}` on `.sq-runner-title`, and `white-space: nowrap; flex-shrink: 0` on all header pills/badges.
  - Hide `.sq-header-nav-btn` above `860px` where the sidebar Question Navigator is already visible.

### Step 2: Implement Laptop / Tablet Responsive Grouping & Sticky Header Height Sync
- **Files**: `src/pages/StudentQuizRunner.tsx`, `src/pages/StudentQuizRunner.css`
- **Changes**:
  - Add responsive media queries (`@media (max-width: 1380px)`, `@media (max-width: 1024px)`, `@media (max-width: 640px)`) implementing the chosen tools layout (2-row slim tool bar **or** `Tools ▾` dropdown — and compact `Emergency Save` sizing).
  - Bind a lightweight `ResizeObserver` on `<header className="sq-runner-header">` to update `--sq-header-height` on `.sq-runner-shell` so `.sq-ielts-audio-bar` (`top: var(--sq-header-height, 56px)`) and `.sq-sidebar-sticky` never collide with a wrapped/2-row header.
  - Ensure `Escape` closes any open `Tools ▾` dropdown cleanly without triggering fullscreen-exit violation logic.

### Step 3: Verification Across Breakpoints
- **Checks**:
  - Verify `npm run build` (`tsc -b && vite build`) and `npm run lint` (`oxlint`) pass with 0 errors.
  - Verify existing tests (`npm run test:pilot-exam`, `npm run test:resource-booklet`, `npm run test:security-tiers`, `npm run test:keyboard-controls`) still pass with no regressions on Resource Booklet / header triggers.
  - Visually inspect at `1440×900`, `1280×720` (laptop), `1024×768`, and `768×1024` (with `ICM170`: 4 tools + Attachments + Emergency Save + Timer + Submit).

