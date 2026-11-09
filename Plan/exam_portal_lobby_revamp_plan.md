# Exam Portal Lobby Revamp Plan

## 1. Overview
Revamp the initial candidate intake and landing screen (previously titled "Student Assessment Portal") into a clean, modern, official **Exam Portal**. The new layout removes unnecessary visual clutter, introduces official institutional branding (ICM & Cambridge Assessment), elevates the assessment duration visibility, and provides clear, prominent candidate rules regarding `Esc`, `Alt+Tab`, `F11`, and screen lock procedures.

---

## 2. Key Changes & Specifications

### 2.1 Header & Branding
- **Header Badge**: Change text from `STUDENT ASSESSMENT PORTAL` to `EXAM PORTAL`.
- **Institutional Logos**: Place the ICM school logo and Cambridge Assessment logo side-by-side at the top of the card header:
  - Left: ICM School Logo (`/logos/icm_school_logo.png` / `ICM_LOGO_PATH`)
  - Right: Cambridge Assessment Logo (`/logos/cambridge_school_header.png` / `CAMBRIDGE_LOGO_PATH`)
  - Dimensions: Cleanly scaled (`maxHeight: 44px`, `objectFit: contain`), flex layout with `justifyContent: space-between`.

### 2.2 Box Removals
- Remove the `"Security Guard: Fullscreen & tab-switch tracking active"` box from the rules grid.
- Remove the `"Formal Examination Session: ENFORCED BY TEACHER"` banner container above the action buttons.

### 2.3 Prominent Assessment Duration Box
- Replace the split 2-column grid with a single, full-width prominent duration card:
  - Clean container with subtle background accent (`rgba(59, 130, 246, 0.08)`, border: `1.5px solid rgba(59, 130, 246, 0.3)`).
  - Left side: Timer icon (`⏱️`), label: **Assessment Duration**.
  - Right side: Big, high-visibility duration badge (e.g., `75 Minutes Total` in bold `1.15rem` font with `#2563eb` text and crisp background pill).

### 2.4 Candidate Security & Anti-Exit Instructions Callout
- Under the paper instructions (`Instructions to Candidate`), add a high-visibility security notice box:
  - 🚫 **Do Not Exit Fullscreen**: Do not press **`Esc`**, **`Alt+Tab`**, or **`F11`** during the examination. Doing so drops fullscreen and flags an invigilator security notice.
  - 🙋 **Invigilator Assistance**: If your screen becomes locked at any point, immediately raise your hand to inform the invigilator.

---

## 3. Implementation Steps
1. Edit [`src/pages/StudentQuizRunner.tsx`](file:///e:/VibeCoding/testmaker/src/pages/StudentQuizRunner.tsx):
   - Import `ICM_LOGO_PATH` and `CAMBRIDGE_LOGO_PATH` from `../assets/logoConstants`.
   - Update the lobby card markup:
     - Render top institutional logo bar.
     - Update badge to `EXAM PORTAL`.
     - Replace the 2-column grid with the full-width high-contrast Duration hero box.
     - Add the candidate security callout box under `Instructions to Candidate`.
     - Remove the `Formal Examination Session Enforced by Teacher` box.
2. Verify with test suite:
   - Run `npm run test:fullscreen-grace`.
   - Run full regression suites (`test:cambridge-links`, `test:tos-citations`, `test:emergency`, `test:sorting`, `test:blooms`).
   - Run `npm run build` and `npm run lint`.

