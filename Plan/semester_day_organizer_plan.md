# Semester Exam Day Organizer Plan

## Finalized Design Summary
- **Goal**: Organize formal exams by exam Day (e.g., Day 1, Day 2, ...) so an Admin/Teacher can assign exams to days, **Activate & Warm Up** a whole day in one batch, **Pause** a day or all other days, and inspect warm-cache status — without overwhelming Supabase.
- **Day Grouping**:
  - Auto-groups exams by local calendar date of `scheduledStartAt`.
  - Allows optional manual `examDay` (`YYYY-MM-DD`) assignment inline inside the Organizer modal (`Publish / Edit Exam` config modal remains untouched).
  - Day-level granularity only (no sub-session folders inside a day); excludes Quizizz (`quizMode === 'game'`) and includes exams across all subjects.
- **Activate Day & Other-Day Safeguard**:
  - **Activate & Warm** sets `isActive: true`, clears `scheduledStartAt: null`, anchors `examDay` so exams remain in that Day after clearing `scheduledStartAt`, saves in one batch, and invokes `prewarmExamPaperCache` across all activated codes.
  - Only modifies the target Day; provides separate **Pause Other Days** (per dated day) and **Pause All Exams** (modal header) controls so make-up or parallel exams are never unexpectedly terminated.
- **Cache TTL & Warm Indicator**:
  - Uses existing Migration `037` 90-minute cache TTL (no SQL migration needed).
  - Tracks `lastWarmedAt` per quiz code locally in `localStorage` (`fluffykitten_exam_paper_warm_ts`), clearing automatically on pause and expiring after 90 minutes.
- **Batch Cloud Write Safety**:
  - Uses `enqueueQuizMutation` with `batchUpdatePublishedQuizzes`: one chunked `quiz_by_code_*` upsert + one sequential `published_quizzes` upsert per batch action (never N parallel `app_config` rewrites).
- **UI Placement**:
  - Dedicated `SemesterDayOrganizerModal` launched via a **📅 Semester Days** button in `QuizManagerPage` (hub header + drilldown bar), leaving Subject Hub layout unchanged.
  - Supports both per-row inline Day dropdowns and multi-select checkboxes + bulk Day bar.

## Implementation & Verification Checklist
1. [x] Planning document created at `Plan/semester_day_organizer_plan.md`.
2. [ ] `src/lib/semesterDayOrganizer.ts` — pure date normalization (`YYYY-MM-DD` local-safe), grouping, schedule preset extraction, and local warm-cache tracker.
3. [ ] `src/services/quizManagerService.ts` — `PublishedQuiz.examDay`, `batchUpdatePublishedQuizzes`, `assignQuizzesToExamDay`, `activateExamDayQuizzes`, `pauseQuizzesBatch`, and warm-map hooks.
4. [ ] `src/components/SemesterDayOrganizerModal.tsx` & `.css` — modal UI, search/subject filters, `+ Add Exam Day`, bulk action bar, chronological Day cards + Unscheduled card.
5. [ ] `src/pages/QuizManagerPage.tsx` — **📅 Semester Days** trigger buttons + modal wiring.
6. [ ] `scripts/test-semester-day-organizer.mjs` (`npm run test:semester-days`) + `npm run build` + regression suites (`test:prewarm-037`, `test:multi-exam-scale`, `test:exam-schedule`, `npm run lint`).
