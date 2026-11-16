# Candidate PIN System Review & Printable Candidate Desk Card Plan

## 1. Current Candidate PIN System Audit & Review

### What Already Works Well
1. **Centralized Directory & Per-Class PIN Generation** ([studentRosterService.ts](file:///e:/VibeCoding/testmaker/src/services/studentRosterService.ts)):
   - Manages `RosterStudent[]` (`id`, `name`, `class`, `candidateNumber`, `pin`, `createdAt`) stored in Supabase `app_config` (`key: 'school_roster'`) with localStorage fallback.
   - `assignMissingPins` and `regenerateAllPins` guarantee random 4-digit PINs unique within each class (`1000–9999`).
   - Supports Excel import (`parseExcelRosterFile`), copy-paste import (`parseBulkRosterText`), and Excel export (`exportRosterToExcel`).
2. **Server-Side Verification & Rate Limiting** ([024_phase3_deep_rls_ratelimit_and_game_security.sql](file:///e:/VibeCoding/testmaker/supabase/migrations/024_phase3_deep_rls_ratelimit_and_game_security.sql)):
   - `get_public_roster_directory()` exposes names, classes, and candidate numbers for autocomplete (`CandidateNameAutocomplete`) **without exposing PINs** to unauthenticated student clients.
   - `verify_student_pin(p_name, p_class, p_pin)` validates server-side with normalized whitespace/casing and rate limiting (`10` failures / `600s` per `name::class`), and `submit_student_exam` re-enforces roster PIN matching on submission.
   - Authenticated teachers (`public.is_authenticated_teacher()`) retain authorized read/write access to `school_roster` via `app_config` RLS ([021_phase2_teacher_login_rls_and_exam_rpcs.sql](file:///e:/VibeCoding/testmaker/supabase/migrations/021_phase2_teacher_login_rls_and_exam_rpcs.sql)).
3. **Exam Lobby Flow** ([StudentQuizRunner.tsx](file:///e:/VibeCoding/testmaker/src/pages/StudentQuizRunner.tsx)):
   - When `requireStudentPin` is enabled on a quiz, candidates enter a masked `• • • •` 4-digit PIN (`applyMaskedPinInput`) before starting or resuming a draft, and `result.student.candidateNumber` is auto-populated if present in the roster.

### Current Gaps & Limitations Found
1. **No Printable Candidate Desk Cards**: Only a plain raw spreadsheet (`exportRosterToExcel`) exists — no printable desk card/slip with institutional **ICM + Cambridge** branding, candidate profile, PIN, or exam schedule.
2. **No `room` / `seatNumber` Fields**: `RosterStudent` currently has `candidateNumber` only, without dedicated `room` or `seatNumber` properties or Excel columns for physical exam room allocation and desk placement.
3. **Draft Resume Parity Minor Gap**: Notice `handleResumeDraft` (`StudentQuizRunner.tsx:3678`) validates `verifyStudentPin` cleanly, while `handleStartExam` (`line 3804`) auto-fills `candidateNumber`; adding `room` & `seatNumber` cleanly to `RosterStudent` prepares for upcoming room/seating management without breaking existing PIN verification.

---

## 2. Agreed Feature Specification (from `/grill-me`)

1. **Access Points**:
   - **Master Admin (`AdvancedSettingsPage.tsx`) → Student Directory**: **`🪪 Print Desk Cards`** button respecting the selected class filter (`All Classes` or a specific class).
   - **Published Quiz Share/Actions (`StudentShareModal.tsx` & `QuizManagerPage.tsx`)**: **`🪪 Print Desk Cards`** entry point allowing teachers to select target class(es) and print cards for candidates using `school_roster`.
2. **Card Layout & Institutional Branding**:
   - **2 × 3 A4 Grid (6 compact slips per A4 page)** with clean dashed crop/cut borders (`@page { size: A4 portrait; margin: 8mm; }`).
   - **Front Side (Evergreen Profile Card — reusable across exams)**:
     - Dual institutional header: **ICM School Logo** (`222×71` exact ratio) + **"EXAMINATION CANDIDATE CARD"** + **Cambridge International Logo** (`215×64` exact ratio).
     - Candidate Data Profile: **Full Name**, **Class / Cohort**, **Candidate #**, **Room**, and **Seat #** (cleanly showing `-` or room/seat badges when assigned).
     - Highlighted **4-Digit Personal Exam PIN** (`4 8 2 1` tabular monospace pill) + brief confidentiality reminder.
3. **Back Side — Configurable Exam Schedule (Duplex Mirrored)**:
   - Master Admin UI in **`🎯 Topic Mastery & Reporting`** (or dedicated **Exam Schedule** sub-section in `AdvancedSettingsPage.tsx`) to manage Exam Schedule rows (`Date`, `Time`, `Subject / Paper`, `Duration`, `Target Class / Grade` filter e.g. `All`, `10`, `11-A`, `XI IPA 1`) persisted in `app_config` (`key: 'exam_schedule_entries'`).
   - **Duplex Alignment**: Back pages mirror the 2-column grid horizontally (`[Col 2 | Col 1]` per row on Page 2 behind `[Col 1 | Col 2]` on Page 1) with an in-preview control bar toggle:
     - `[x] Include Exam Schedule (Back Side — Duplex Mirrored)`
     - `Sort Order`: **Room & Seat -> Class -> Name** (default for fast desk distribution) | `Class -> Candidate # -> Name`.
4. **Room & Seating Schema Prep** (`studentRosterService.ts` + `AdvancedSettingsPage.tsx`):
   - Extend `RosterStudent` with optional `room?: string` and `seatNumber?: string`.
   - Update Excel template/import/export (`parseExcelRosterFile`, `parseBulkRosterText`, `exportRosterToExcel`, `downloadSampleExcelTemplate`) and Master Admin Student Directory table so teachers can view/edit `Room` and `Seat #` immediately.

---

## 3. Small Executable Implementation Steps

### Step 1: Extend `RosterStudent` (`room`, `seatNumber`) & Add `ExamScheduleEntry` Persistence
- **Files**: [studentRosterService.ts](file:///e:/VibeCoding/testmaker/src/services/studentRosterService.ts), `src/services/examScheduleService.ts` (or inside `studentRosterService.ts` / `settings.ts`).
- **Details**:
  - Add `room?: string` and `seatNumber?: string` to `RosterStudent`, update `loadAndSyncSchoolRoster`, `parseBulkRosterText`, `parseExcelRosterFile` (matching headers like `Room`, `Ruangan`, `Seat`, `Kursi`, `Desk`), `exportRosterToExcel`, and `downloadSampleExcelTemplate`.
  - Create `src/lib/examSchedule.ts` (pure normalization, class/grade schedule matcher e.g. matching exact class `"11-A"`, grade prefix `"11"` / `"XI"`, or `"ALL"`, and sort helpers for Room/Seat -> Class -> Name).
  - Add cloud + localStorage sync helpers (`getExamSchedule`, `saveExamSchedule`, `loadAndSyncExamSchedule`) backed by `app_config` key `'exam_schedule_entries'`.

### Step 2: Build Printable 2×3 A4 Candidate Desk Card Print Service (`src/services/candidateCardPrintService.ts`)
- **Details**:
  - Build pure HTML/CSS generator `renderCandidateDeskCardsHtml(students, scheduleEntries, options)` using `DEFAULT_SCHOOL_LOGO` & `DEFAULT_CAMBRIDGE_LOGO` (`object-fit: contain` preserving exact aspect ratios) and `escapeHtml` XSS sanitization on all fields.
  - Render 6 cards per A4 page (`2×3` CSS Grid with exact page breaks and dashed cut guides).
  - Generate duplex mirrored back pages (`[col2, col1]` swap per row) filtered per each student's class/grade schedule.
  - Include an interactive **non-printing top control bar** in the print window (`Include Back Side: Schedule`, `Sort by Room & Seat vs Class & Seat`, `Flip Long Edge vs Short Edge` preview hint, `🖨️ Print Cards`).

### Step 3: Master Admin UI — Room/Seat Columns + Exam Schedule Editor + `Print Desk Cards`
- **File**: [AdvancedSettingsPage.tsx](file:///e:/VibeCoding/testmaker/src/pages/AdvancedSettingsPage.tsx)
- **Details**:
  - Add `Room` & `Seat #` inputs/columns in the Student Directory inline add form and table.
  - Add **`🪪 Print Desk Cards`** button beside `📊 Export to Excel` in the Student Directory toolbar.
  - Add an **Exam Schedule (Desk Card Back Side)** editor panel under Master Admin so admins can add/edit/delete schedule rows (`Date`, `Time`, `Subject / Paper`, `Duration`, `Target Grade / Class`) and save/sync to Supabase.

### Step 4: Published Quiz Integration (`StudentShareModal.tsx` & `QuizManagerPage.tsx`)
- **Details**:
  - Add a **`🪪 Print Candidate Desk Cards`** action button inside [StudentShareModal.tsx](file:///e:/VibeCoding/testmaker/src/components/StudentShareModal.tsx) (allowing class filter selection from `school_roster`, synced via `loadAndSyncSchoolRoster` & `loadAndSyncExamSchedule`) so teachers preparing an exam session can print desk slips right from the quiz Share dialog.

### Step 5: Automated Tests & Build Verification
- **Test Script**: `scripts/test-candidate-desk-cards.mjs`
  - Verify `parseExcelRosterFile` / `parseBulkRosterText` extract `room` and `seatNumber` cleanly.
  - Verify schedule matching logic (`ALL`, exact class `"XI IPA 1"`, grade match `"XI"` / `"11"`).
  - Verify `renderCandidateDeskCardsHtml` chunks strictly into 6 cards per A4 page, mirrors duplex back-side pairs (`[card2Back, card1Back]`), includes both `DEFAULT_SCHOOL_LOGO` & `DEFAULT_CAMBRIDGE_LOGO`, and escapes untrusted `<script>` / XSS strings in student names, rooms, or schedule notes.
- Run `npm run test:desk-cards`, existing test suites, `npx oxlint`, and `npm run build`.

---

## 4. Confirmed Workbook Analysis & Sync Adaptations (`MASTER_NEW_DATA_SEMESTER_GENAP_26_27.xlsx`)

1. **Workbook Multi-Sheet & Standard Import Support**:
   - Automatically recognizes ICM's active A.Y. 2026/2027 sheets (`DAFTAR SISWA HS 2627` with 166 students + `Copy of PEMBAGIAN RUANGAN` across 11 rooms + `Time Table Semester Exam`), ignoring legacy A.Y. 2025/2026 sheets and broken right-hand visual seating grids.
   - Auto-places the 2 omitted students (`AUDREY ATHA NITYASA` `262710010` → `Room 5 - Akhwat` Seat `13`; `AHMAD HANANT AL QORNY` `242510004` → `Room 11 - Ikhwan` Seat `9`) and captures `MUHAMMAD AZZAM PANDYA` (`242510039` → `Room 9 - Ikhwan` Seat `16`).
2. **Smart Sync, PIN Preservation & Class Normalization**:
   - Normalizes class spacing (`X IPA3` → `X IPA 3`, `X IPS 2` added across all 13 classes).
   - Matches existing roster candidates by NIS (`candidateNumber`) or normalized Name so existing 4-digit PINs stay unchanged while `room`, `seatNumber`, and `class` update.
   - Provides a **Sync / Prune Extra Students** review dialog during Excel import so extra/obsolete DB rows (such as 2 extras in `XII IPA 2`) can be removed cleanly.
3. **Room Format & Class/Grade+Stream Timetable Filtering**:
   - Formats rooms with gender label (`Room 1 - Akhwat` .. `Room 5 - Akhwat`, `Room 6 - Ikhwan` .. `Room 11 - Ikhwan`).
   - Supports compound Grade+Stream targets (`X IPA` for the 3 Grade-10 IPA Practical dates, `X` for Grade-10 English Listening, `IPA` / `IPS` for stream splits, and `ALL` for common Written papers).
