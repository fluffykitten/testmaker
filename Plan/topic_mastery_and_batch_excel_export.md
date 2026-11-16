# Topic Mastery & Batch Individual Student Excel Export Plan

## 1. Agreed Design Specification (from `/grill-me`)

1. **Topic Mastery Placement in Individual Student Excel Report (`exportSingleSubmissionExcelICM`)**:
   - Render a **compact Topic Mastery Summary Table** directly on **Sheet 1: `Candidate Overview`** (to the right of or immediately below the Candidate Performance Profile), **AND**
   - Add a **dedicated `Topic Mastery` worksheet** containing full per-topic diagnostics, linked question numbers, marks breakdown, percentage achieved, mastery tier classification, and recommended focus notes.
2. **Topic Mastery Calculation & Admin-Configurable Tiers**:
   - Derive mastery primarily from `submission.questionResults` (normalizing topic names case-insensitively and tracking exact `Question #` references + earned/max marks per topic), with fallback to `submission.topicBreakdown` when `questionResults` is empty.
   - Classify each topic using **configurable Mastery Tiers in Master Admin (`AdvancedSettingsPage`)**, modeled after `securityTiers`:
     - Default tiers:
       - `>= 75%`: **Mastered** (`emerald` styling)
       - `>= 50%`: **Developing** (`amber` / `blue` styling)
       - `>= 0%`: **Needs Support** (`crimson` styling)
     - Admins can add/edit/reorder/delete tiers (min percentage cutoff, label, color tone, optional guidance note) and reset to defaults, synced locally + via Supabase `app_config`.
3. **Batch Individual Excel Reports in `Export & Tools` (`QuizResultsModal.tsx`)**:
   - Add a **Batch Individual Reports (Excel .zip)** deliverable under `Class Deliverables` in the **Export & Tools** menu.
   - Packages one formatted individual `.xlsx` workbook per candidate inside a single `.zip` archive using `jszip`.
   - Respects the active `selectedClass` filter (`All Candidates` or specific class), handles duplicate student filenames cleanly inside the archive, and shows progress/loading feedback during zip generation.

---

## 2. Architecture & File Breakdown

### Step 1: Pure Topic Mastery Domain Module (`src/lib/topicMastery.ts`)
- Define `MasteryTierColor = 'emerald' | 'blue' | 'amber' | 'crimson'`.
- Define `TopicMasteryTier`:
  - `id: string`
  - `minPercentage: number` (0–100)
  - `label: string`
  - `color: MasteryTierColor`
  - `recommendation?: string`
- Export `DEFAULT_TOPIC_MASTERY_TIERS: TopicMasteryTier[]`:
  - `>= 75%` -> `Mastered` (`emerald`)
  - `>= 50%` -> `Developing` (`blue` or `amber`)
  - `>= 0%` -> `Needs Support` (`crimson`)
- Export pure helpers:
  - `normalizeTopicMasteryTiers(raw: unknown): TopicMasteryTier[]` — sanitizes array/JSON, sorts descending by `minPercentage`, guarantees a `0%` catch-all fallback tier exists.
  - `validateTopicMasteryTiers(tiers: TopicMasteryTier[]): { ok: boolean; errors: string[] }` — verifies non-empty labels, valid percentages (0–100), no duplicate `minPercentage` thresholds, and existence of a `0%` floor tier.
  - `resolveMasteryTier(tiers: TopicMasteryTier[], percentage: number): TopicMasteryTier` — returns the highest tier with `percentage >= minPercentage`.
  - `normalizeTopicLabel(rawTopic?: string): string` — trims whitespace and defaults empty/missing topics to `'General'`.
  - `computeSubmissionTopicMastery(submission: StudentSubmission, tiers?: TopicMasteryTier[]): TopicMasteryEntry[]` — computes merged topic stats:
    - Primary source: `submission.questionResults` (aggregates `earnedMarks`, `maxMarks`, `questionNumbers: string[]`, `questionCount`, `correctCount`).
    - Fallback source: `submission.topicBreakdown` when `questionResults` is absent/empty.
    - Returns sorted entries (lowest percentage first or highest percentage first, with deterministic tie-breaking) enriched with resolved `tier`.

### Step 2: Settings Persistence & Supabase Sync (`src/lib/settings.ts`)
- Extend `AppSettings` with `topicMasteryTiers?: TopicMasteryTier[]` and set default in `DEFAULT_SETTINGS`.
- Follow the `securityTiers` pattern:
  - `getTopicMasteryTiers(): TopicMasteryTier[]`
  - `saveTopicMasteryTiers(tiers: TopicMasteryTier[]): void` (persists to `localStorage`, dispatches `topic_mastery_tiers_updated` event, syncs to Supabase `app_config` key `'topic_mastery_tiers'`).
  - `syncTopicMasteryTiersToCloud(tiers: TopicMasteryTier[]): Promise<boolean>`
  - `loadAndSyncTopicMasteryTiers(): Promise<TopicMasteryTier[]>`

### Step 3: Master Admin Configuration UI (`src/pages/AdvancedSettingsPage.tsx`)
- Add **Topic Mastery Bands** configuration card inside Master Admin (`AdvancedSettingsPage.tsx` under a Reporting/Security section or Academic Settings block):
  - Visual preview strip showing configured percentage ranges (e.g. `75–100% Mastered`, `50–74% Developing`, `0–49% Needs Support`).
  - Editable rows for Label, Min `%`, Color Tone (`emerald`, `blue`, `amber`, `crimson`), and Optional Focus Note.
  - Add Tier / Delete Tier (protecting the `0%` baseline tier) / Reset Defaults / Save buttons with live validation via `validateTopicMasteryTiers`.
  - Hydrate with `loadAndSyncTopicMasteryTiers()` on mount.

### Step 4: Dual-Logo Institutional Header + Individual Excel Topic Mastery + Shared Workbook Builder (`src/services/icmExcelExportService.ts`)
- **Clean Dual-Logo Masthead (`renderIcmBanner`)**:
  - Import `DEFAULT_SCHOOL_LOGO` (`222x71`, ratio `3.127`) and `DEFAULT_CAMBRIDGE_LOGO` (`215x64`, ratio `3.359`) from `src/assets/logoConstants.ts`.
  - Cache workbook image IDs per `ExcelJS.Workbook` via `registerIcmBannerLogos(wb)` so logos are embedded once per workbook even across multi-tab workbooks.
  - Replace the dark-blue row 1–2 / overflowing row-4 banner with a clean white executive masthead:
    - **Rows 1–2 (merged `A1:${endColLetter}2`)**: Crisp white header (`#FFFFFF`) with left-aligned **ICM logo** (`editAs: 'oneCell'`, fixed pixel `ext` preserving exact `222:71` aspect ratio), centered **School Name + Report Title + Subheading** in ICM Navy (`#1E3A8A`) & Slate (`#475569`), and right-aligned **Cambridge Assessment logo** (`editAs: 'oneCell'`, fixed pixel `ext` preserving exact `215:64` aspect ratio) positioned within the right columns of `A..${endColLetter}`. Never stretch via two-cell `br` anchors.
    - **Row 3**: Thin ICM emerald (`#16A34A`) / navy accent divider line strictly across `A3:${endColLetter}3`.
    - **Row 4**: Neat metadata strip (`Assessment`, `Subject`, `Code`, `Cohort`, `Export Date`) rendered cleanly inside `A4:${endColLetter}4` (solving the previous column-J overflow bug on narrower tabs like `Candidate Overview` `'F'` and `Proctoring Log` `'F'`).
    - **Row 5**: Subtle spacer row separating banner from table headers / KPI cards.
- Extract a shared internal builder `buildSingleSubmissionWorkbookICM(submission: StudentSubmission, options?: { gradeThresholds?: GradeThresholds; masteryTiers?: TopicMasteryTier[] }): { wb: ExcelJS.Workbook; filename: string }` so single download and batch zip export share 100% identical workbook generation logic without duplication.
- Inside `buildSingleSubmissionWorkbookICM`:
  - Resolve active tiers (`options?.masteryTiers ?? getTopicMasteryTiers()`).
  - Compute entries via `computeSubmissionTopicMastery(submission, tiers)`.
  - **On Sheet 1 (`Candidate Overview`)**:
    - Right below the Candidate Performance Profile table (e.g. starting cleanly after a blank spacer row), render a compact **`TOPIC MASTERY SUMMARY`** section (`Topic`, `Marks`, `Mastery %`, `Status`) so teachers opening the first tab immediately see strengths and gaps.
    - Pass every topic name and tier label through `sanitizeSpreadsheetCell` to prevent CSV/Excel formula injection.
  - **New Dedicated Worksheet (`Topic Mastery`)**:
    - Place immediately after `Candidate Overview` (before `Responses & Solutions`) with ICM banner header and frozen header row.
    - Columns: `Topic`, `Questions`, `Items`, `Marks Earned`, `Total Marks`, `Mastery %`, `Mastery Status`, `Focus / Recommendation`.
    - Color-code `Mastery Status` cell fill/text dynamically based on the resolved `tier.color` (`emerald`, `blue`, `amber`, `crimson`).
    - Include a **Total / Overall** summary footer row and AutoFilter.
    - Render a clear `"No topic metadata recorded for this assessment."` row if a legacy submission has zero topic data.
- Update `exportSingleSubmissionExcelICM` to call `buildSingleSubmissionWorkbookICM(...)` and download via `exportFileUniversal`.
- Add `exportBatchSingleSubmissionsExcelZipICM(submissions: StudentSubmission[], options?: { quizTitle?: string; selectedClass?: string; gradeThresholds?: GradeThresholds; masteryTiers?: TopicMasteryTier[]; onProgress?: (completed: number, total: number) => void }): Promise<{ count: number; zipFilename: string }>`:
  - Filters submissions by `selectedClass` (matching `exportBatchStudentFeedbackReportPdf` behavior).
  - Builds each student's `.xlsx` buffer using `buildSingleSubmissionWorkbookICM` and writes it into `JSZip`.
  - Deduplicates `.xlsx` filenames inside the zip using `candidateNumber` / collision counter when two students sanitize to the same filename.
  - Generates the `.zip` blob and downloads via `exportFileUniversal`.

### Step 5: Export & Tools Integration (`src/components/QuizResultsModal.tsx`)
- Sync cloud mastery tiers (`loadAndSyncTopicMasteryTiers`) alongside exam results or read `getTopicMasteryTiers()` when exporting single or batch reports.
- Under `Export & Tools` -> `Class Deliverables`, add **`Batch Individual Reports (Excel .zip)`**:
  - Subtitle showing candidate count (`Individual .xlsx workbooks for <N> candidates`).
  - Disable button & show live progress label while generating the zip archive so large classes remain responsive and clear.
  - Keep existing single-student `Export Excel` button on the individual detail modal wired cleanly to the upgraded `exportSingleSubmissionExcel` (automatically including Topic Mastery + Master Admin tiers).

### Step 6: Verification Plan
- **Unit & Integration Test Script** (`scripts/test-topic-mastery-excel.mjs` or `npm test` script):
  - Test `computeSubmissionTopicMastery`: merges case-variant topics from `questionResults`, preserves exact `Question #` list, falls back to `topicBreakdown` when `questionResults` is absent, handles zero-mark edge cases without `NaN`, and resolves Admin-configured tiers accurately.
  - Test formula-injection sanitization (`=cmd`, `+1`, `@SUM`) on topic names and custom tier labels in generated `.xlsx` sheets using `ExcelJS` read-back assertions verifying both the `Candidate Overview` summary block and dedicated `Topic Mastery` worksheet columns/values.
  - Test batch ZIP packaging via `JSZip`: verifies per-student `.xlsx` entry count, class filtering, and filename deduplication for same-named students.
- **Typecheck & Production Build**: `npx tsc --noEmit` and `npm run build`.
- **UI Verification**: Verify `Export & Tools` menu item, Master Admin `Topic Mastery Bands` editor, and sample `.xlsx` / `.zip` download flow in browser.
