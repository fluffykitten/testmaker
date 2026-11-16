# Live Proctor UI Declutter & Light-Mode Redesign Plan

## 1. Problems Diagnosed (from Screenshot & CSS Audit)
1. **Light-Mode Contrast Bugs**: `.lip-alert-chip` and related chips used dark-theme colors (`#cbd5e1`, `#bfdbfe`, `#a7f3d0`) on a light `#f8fafc` header, making header pills nearly unreadable in light mode.
2. **Header Chrome Overload (~35% vertical waste)**: Top header + 6 duplicate KPI `.lip-stat-card` boxes + stage header + multi-line toolbar pushed candidate cards far down the screen.
3. **Verbose Cards & Irrelevant Actions on Submitted Rows**: Submitted students still displayed `+5m`, `Pardon`, and `Log` across wrapping button rows plus redundant `Seat: -` tags and stacked badges.
4. **Inflated `Not Joined` Count**: In `All Candidates` view for a single grade exam, unrelated grade rosters (e.g. Grade X and XII) were counted into `Not Joined (149)`.

---

## 2. Agreed Design Decisions (from `/grill-me`)

1. **Declutter Top Chrome & Fix Contrast**:
   - Remove the redundant 6-card `.lip-stats-bar` (counts remain visible directly inside the interactive filter pills: `All`, `Exceeded`, `Locked`, `Warnings`, `Active`, `Submitted`, `Not Joined`).
   - Fix light-mode & dark-mode CSS contrast tokens for `.lip-alert-chip`, `.lip-toast`, `.lip-template-pill`, and header action buttons.
   - Shorten bulk action button labels (`📢 Notice`, `🔓 Unlock (N)`, `⏱️ +5m`) with full scope names in `title` tooltips so the toolbar fits neatly.
2. **Dual View Switcher (`Table` Default + `Cards` Toggle)**:
   - Add a `☰ Table | ⊞ Cards` segmented toggle (defaulting to **`Table`** for fast 200+ candidate scanning).
   - **Compact Table View**: Columns for Candidate (Name + Seat if present), Class/Exam, Status (+ live `⏳ MM:SS` lock timer & strike indicator), Progress, Time Left, Strikes, and contextual Actions.
   - **Streamlined Cards View**: Single-line candidate name (`text-overflow: ellipsis`), hide empty `Seat: -` pills, combine status/exceeded indicator cleanly, and keep action buttons on one clean compact row.
3. **Contextual Actions**:
   - On **`submitted`** rows/cards: hide live-session controls (`+5m`, `Unlock`, `Notice`, `Submit`, `Pardon`) so only clean status, strike count, and **`📜 Log`** appear.
   - Keep full contextual controls for `active`, `warning`, `locked`, and `offline` candidates.
4. **Sidebar & Accurate `Not Joined` Scoping**:
   - Keep all classes visible in the left sidebar (`Hide empty classes` toggle stays optional).
   - In `All Candidates` (`selectedKey === '__ALL__'`), scope `Not Joined` roster calculations to classes that have at least one participating student **or** match the monitored quiz's `targetClass`. When a specific class is clicked in the sidebar, show that class's missing students directly.

---

## 3. Executable Steps
1. **Refactor Header, Toolbar & Scope Calculations** ([LiveInvigilatorModal.tsx](file:///e:/VibeCoding/testmaker/src/components/LiveInvigilatorModal.tsx)):
   - Remove `.lip-stats-bar` block and merge stage count cleanly into the toolbar header line.
   - Scope `missingStudents` in `__ALL__` view to active participating classes + `targetClass` metadata from `monitoredQuizzes`.
   - Add `viewMode: 'table' | 'cards'` state (default `'table'`).
2. **Implement Compact Table View + Streamlined Card Layout** ([LiveInvigilatorModal.tsx](file:///e:/VibeCoding/testmaker/src/components/LiveInvigilatorModal.tsx)):
   - Build responsive `.lip-table-wrap` / `.lip-table` with row states for `overdue`, `locked`, `warning`, `exceeded`, `submitted`, and `focused`.
   - Clean up Card markup: hide empty `Seat: -`, apply contextual action gating for `submitted` students, and simplify badge stacking.
3. **Fix Light-Mode Contrast & Add Table/Compact Card Styles** ([LiveInvigilatorModal.css](file:///e:/VibeCoding/testmaker/src/components/LiveInvigilatorModal.css)):
   - Fix `.lip-alert-chip*`, `.lip-template-pill`, and toast colors for crisp readability in both light and `[data-theme='dark']` modes.
   - Add styles for the view-mode switcher and compact candidate table.
4. **Verify**: Run `npm run test:proctor-alerts`, `npx oxlint`, and `npm run build` (`tsc -b && vite build`).
