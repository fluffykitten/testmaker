# Diagnosis & Optimization Plan: Slow Published Exam Save & Post-Save Sync Cascade

## 1. Executive Summary & Problem Statement

When teachers create or edit a published exam in the Quiz Manager modal (`"Save & Publish Exam"` / `"Save Changes"` in `src/pages/QuizManagerPage.tsx`), saving can hang for several seconds (or stall indefinitely on poor connections), leaving the modal unresponsive with no loading feedback.

This latency is caused by two compounding bottlenecks:
1. **Blocking monolithic cloud round-trips before closing the modal** inside `savePublishedQuiz()` (`src/services/quizManagerService.ts`).
2. **A synchronous `quizzes_updated` reload cascade (`loadData()`)** that invalidates fresh cache, re-downloads the entire `published_quizzes` array, and hits a **3.6-second SQL statement timeout** followed by a **5.77 MB `app_config` JSON fallback download** in `loadAndSyncAllSubmissions()`.

---

## 2. Root Cause Analysis

### 2.1 Pre-Close Blocking Chain (`handleSaveQuizConfig` -> `savePublishedQuiz`)

In `src/pages/QuizManagerPage.tsx:563-632`, `handleSaveQuizConfig` awaits `savePublishedQuiz(updated, originalQuizCode)` at line `624` before closing the modal at line `627` (`setIsConfigModalOpen(false)`).

Inside `savePublishedQuiz()` (`src/services/quizManagerService.ts:439-511`):
1. **Local write is immediate, but return is blocked** (lines `490-492`): `localStorage` (`fluffykitten_published_quizzes`) updates synchronously, yet the function waits on multiple network round-trips before resolving.
2. **Forced full `published_quizzes` download** (lines `495-496`): Calls `clearCloudQuizzesCache()` and awaits `fetchPublishedQuizzesFromSupabase(true)`, forcing a full download of the single `app_config` row (`key = 'published_quizzes'`) containing every published quiz (up to 5,000 ms timeout).
3. **Full array re-upload + up to 6 per-code writes with no timeout guard** (lines `500-503`):
   - `syncPublishedQuizzesToCloud(finalMerged)` (lines `357-375`) serializes (`JSON.stringify`) and upserts the **entire array of all published quizzes** into `app_config` (`key = 'published_quizzes'`).
   - `upsertQuizCodeIndexToCloud(cleanQuiz)` (lines `237-263`) concurrently executes 1 to 6 more `app_config` upserts (`quiz_by_code_<CODE>` plus each alias in `previousCodes`).
   - Neither `syncPublishedQuizzesToCloud` nor `upsertQuizCodeIndexToCloud` is wrapped in `withTimeout(...)`, so any slow response or network stall blocks the modal indefinitely.

### 2.2 Payload Bloat Inside `PublishedQuiz.headerConfig`

1. **`questionOverrides` duplication** (`src/services/quizManagerService.ts:456-471`, `686-725`):
   - `createDraftFromTest()` copies `test.header_config` onto `PublishedQuiz.headerConfig`, and `savePublishedQuiz()` spreads it back untouched.
   - When `headerConfig.questionOverrides` is present (`src/services/testBuilderService.ts:26`), full question override objects are embedded directly inside **every** copy of the quiz in `published_quizzes` and `quiz_by_code_*`, even though test overrides are already persisted on `custom_test_header_*` and resolved via `testId`.
2. **Base64 attachment fallback risk** (`src/services/storageService.ts:277-338`):
   - `uploadExamAttachment()` tries Cloudflare R2, then Supabase Storage (`exam-diagrams`). If both fail, lines `320-328` fall back to embedding a Base64 Data URL (`reader.readAsDataURL(file)`, up to 25 MB) directly inside `PublishedQuiz.attachments`, inflating the global `published_quizzes` JSON row for every future save. *(Note: current `PILOT` attachment uses an R2 URL of 93 chars, not Base64.)*

### 2.3 Missing Saving Feedback & Double-Click Risk

- In `src/pages/QuizManagerPage.tsx:2571-2577`, the `"Save Changes"` / `"Save & Publish Exam"` button has no `isSaving` state, `disabled` attribute, or spinner.
- Because the modal stays open and the button remains clickable during multi-second network waits, users perceive the app as frozen and may click repeatedly, queuing overlapping cloud reads and upserts.
- The same blocking `await savePublishedQuiz(updated)` pattern also occurs when updating grade thresholds in `src/components/QuizResultsModal.tsx:70-80`.

### 2.4 Synchronous `quizzes_updated` Cascade & 5.77 MB Submission Fallback

Right before returning, `savePublishedQuiz` executes:

```ts
window.dispatchEvent(new Event('quizzes_updated'));
```

(`src/services/quizManagerService.ts:505`)

Because `dispatchEvent` runs listeners synchronously while `savePublishedQuiz` finishes, two expensive handlers immediately execute:
1. **Immediate cache wipe** (`src/services/quizManagerService.ts:219-221`): `clearCloudQuizzesCache()` clears the `cloudQuizzesCache` just populated on line `360`.
2. **Full dashboard reload (`loadData`)** (`src/pages/QuizManagerPage.tsx:153-221`, lines `208` & `213`): Editing a single quiz fires all of the following:
   - `fetchCustomTestsWithMetadata()` (`src/services/testBuilderService.ts:643`): Fetches `custom_tests`, `syllabuses`, `questions` chunks, and missing `custom_test_header_*` rows when the 3-minute cache has expired.
   - `loadAndSyncPublishedQuizzes()` (`src/services/quizManagerService.ts:381-437`): Fetches `deleted_quiz_ids` and **re-downloads the full `published_quizzes` row a second time** because cache was cleared on `quizzes_updated`.
   - `loadAndSyncAllSubmissions()` (`src/services/quizSubmissionService.ts:1548-1616`): Fetches `deleted_submission_ids` and invokes `fetchAllSubmissionsFromSupabase()` (`lines 1477-1541`), querying `quiz_submissions.select('*')` across all quizzes, failing on statement timeout, and falling back to `fetchSubmissionsFromAppConfig()` (`lines 1129-1144`) to download a **5.77 MB** JSON blob.

---

## 3. Live Read-Only Measurements (2026-11-12)

Observed via read-only queries against the configured Supabase project (no write/upsert mutations were run):

| Query / `app_config` Key | Measured Latency | Payload Size / Scope | Notes |
|---|---|---|---|
| `published_quizzes` (cold read) | **1,187 ms** | **165,922 bytes** (19 quizzes) | 7 quizzes embed `questionOverrides` (e.g., `METAL` 32,862 B, `COVALENT` 32,848 B, `PILOT` 27,516 B, `ICM170` 27,470 B) |
| `published_quizzes` (warm read) | **522 ms** | **165,922 bytes** | Re-fetched twice per save flow (`savePublishedQuiz` + `loadData`) |
| `deleted_quiz_ids` | **1,024 ms** | `app_config` row | Fetched by `loadAndSyncPublishedQuizzes()` |
| `quiz_by_code_PILOT` | **366 ms** | Single quiz JSON | Target size when indexing single quizzes without monolithic array |
| `custom_tests` | **411 ms** | **51 rows** | Triggered by `fetchCustomTestsWithMetadata()` in `loadData()` |
| `quiz_submissions` (`select('*').range(0,999)`) | **3,621 ms -> ERROR** | Timed out | Failed with `canceling statement due to statement timeout` |
| `quiz_submissions` (`app_config` fallback) | **1,631 ms** | **5,768,456 bytes (~5.77 MB)** | 200 submissions downloaded & parsed whenever table query fails |
| `deleted_submission_ids` | **354 ms** | `app_config` row | Fetched by `syncDeletedSubmissionIdsWithCloud()` |

---

## 4. Operational Guidance: Edit & Save vs. Delete & Re-publish

**Do NOT delete and re-publish just to avoid edit latency.** Deleting and re-publishing is slower and drops important state:

| Aspect | Edit -> Save Changes | Delete -> Re-publish |
|---|---|---|
| **Cloud sync cycles** | 1x (`savePublishedQuiz` -> `loadData()`) | **2x** (`deletePublishedQuiz` runs the exact same full download/upload + `loadData()` cascade, then `savePublishedQuiz` runs it all again) |
| **`quiz.id` continuity** | Preserved | Generates a new `quiz_${Date.now()}_...` ID (`quizManagerService.ts:715`) |
| **`previousCodes` aliases** | Preserves up to 5 prior codes (`quizManagerService.ts:447-454`) | Reset to `[]` (`quizManagerService.ts:719`), risking student code lockouts if renamed |
| **Exam-only settings** | Kept (`attachments`, `gradeThresholds`, tool toggles, proctor config) | Permanently discarded upon delete |

**When re-publishing IS required**: Only when switching an exam to a **different source test**, because editing locks the source test dropdown (`disabled={Boolean(originalQuizCode)}` in `src/pages/QuizManagerPage.tsx:1871-1882`).

---

## 5. Proposed Optimization Roadmap (Future Implementation)

### Step 1: Immediate UI Responsiveness & Double-Submit Guard
- Add `isSavingQuiz` state in `src/pages/QuizManagerPage.tsx`: disable `"Save Changes"` / `"Save & Publish Exam"` + backdrop close while saving and show an inline saving label/spinner.
- Return or resolve UI state after optimistic `localStorage` update + single targeted write (`quiz_by_code_*`) or bounded timeout, syncing the background `published_quizzes` list asynchronously with retry tracking so slow network conditions do not freeze the modal.

### Step 2: Eliminate `quizzes_updated` Full-Reload Cascade
- Stop calling full `loadData()` (`fetchCustomTestsWithMetadata` + `loadAndSyncAllSubmissions` + redundant `published_quizzes` re-fetch) from `handleQuizzesUpdated` when a local save just completed.
- Update `quizzes` React state directly from `savePublishedQuiz` return data and remove the self-defeating `clearCloudQuizzesCache()` on `quizzes_updated` when cache was just refreshed by `syncPublishedQuizzesToCloud`.

### Step 3: Strip Redundant Payload Bloat & Add Write Timeouts
- Strip `headerConfig.questionOverrides` when serializing `PublishedQuiz` entries for `published_quizzes` and `quiz_by_code_*` (verify first that student resolution fetches test questions/overrides cleanly from `custom_tests` / `custom_test_header_*` via `testId`).
- Reject or warn before embedding multi-MB Base64 Data URLs in `PublishedQuiz.attachments` when remote upload fails (`src/services/storageService.ts:320-328`).
- Wrap `syncPublishedQuizzesToCloud()` and `upsertQuizCodeIndexToCloud()` with `withTimeout(...)` so failed/slow writes fail gracefully rather than hanging indefinitely.

### Step 4: Fix `quiz_submissions` Timeout & 5.77 MB `app_config` Fallback
- Investigate why `quiz_submissions` `select('*')` hits PostgreSQL statement timeout (e.g., unindexed `submitted_at` sort or oversized `raw_answers` / `question_results` / `proctoring_logs` JSONB columns across rows).
- Switch dashboard submission-count hydration in `QuizManagerPage` to fetch lightweight summary columns (`id, quiz_id, quiz_code, status, score, total_marks, submitted_at`) or a lightweight RPC instead of downloading 5.77 MB of full `proctoring_logs` and `question_results` on every page refresh.

---

## 6. Verification Strategy (When Implemented)
1. Instrument `handleSaveQuizConfig` and `savePublishedQuiz` timing before and after optimization against live Supabase (`Save & Publish Exam` and `Save Changes`).
2. Verify multi-tab/cross-device merge integrity (`deletePublishedQuiz`, `previousCodes` resolution via `resolveStudentQuiz`, and `QuizResultsModal` grade boundary updates).
3. Verify `loadAndSyncAllSubmissions` / dashboard counts load without triggering the `quiz_submissions` statement timeout or downloading the 5.77 MB `app_config` blob.
4. Confirm existing regression scripts (`test:pilot-exam`, `test:submission-tombstones`, `test-exam-submission-fixes.mjs`) and `npm run build` pass cleanly.

