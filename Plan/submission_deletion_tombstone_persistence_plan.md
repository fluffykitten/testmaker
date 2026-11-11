# Architecture & Implementation Plan: Persistent Submission Deletion & Anti-Resurrection Tombstone System

## 1. Executive Summary & Root Cause Analysis

### Problem Statement
When a teacher deletes a student submission (single delete or bulk delete for a quiz) in the **Published Exam Results** modal (`QuizResultsModal.tsx`), the deletion works immediately in the current view. However, **the deleted submission can resurrect and reappear**.

### Root Cause Analysis (4 Specific Vulnerability Vectors)
Unlike `quizManagerService` (which has `DELETED_QUIZZES_KEY` and cloud tombstones in `app_config`) and `testBuilderService` (which has `DELETED_TESTS_KEY`), **`quizSubmissionService.ts` currently lacks a tombstone registry**. This causes 4 resurrection pathways:

1. **Multi-Device / Multi-Tab Synchronization Resurrection (Primary Vector)**:
   - Teacher A deletes a submission on Device 1. Device 1 deletes the row in Supabase `quiz_submissions` and from Device 1's `localStorage`.
   - Device 2 (or a co-teacher, another tab, or a mobile device) previously viewed the exam and still holds the submission in its `localStorage` (`fluffykitten_quiz_submissions`).
   - When Device 2 opens the **Quiz Manager Lobby** (`QuizManagerPage.tsx:184`) or **Live Invigilator Cockpit** (`LiveInvigilatorModal.tsx:222`), `loadAndSyncAllSubmissions()` runs automatically.
   - `loadAndSyncAllSubmissions()` compares `localList` (Device 2) with `cloudList` (Supabase).
   - Because Device 2 sees the submission in `localList` but missing in `cloudList`, it assumes: *"This is a new offline or locally graded submission not yet in the cloud."*
   - It sets `hasLocalExclusiveOrNewer = true` and calls `saveBatchQuizSubmissionsCloud(merged)`.
   - **Device 2 re-uploads the deleted submission back into Supabase**, resurrecting it for all devices across the school.

2. **Cross-View Local Cache Merge (`fetchSubmissionsFromSupabase:1435`)**:
   - In `fetchSubmissionsFromSupabase(quizId, quizCode, testId)`, after fetching cloud rows, it executes:
     ```typescript
     const local = getSubmissionsForQuiz(quizId, quizCode, testId);
     const map = new Map<string, StudentSubmission>();
     cloudSubs.forEach((s) => map.set(s.id, s));
     local.forEach((s) => {
       if (!map.has(s.id)) map.set(s.id, s);
     });
     ```
   - If a device still has the submission in its local cache (e.g. from an earlier sync), the submission is merged back in, returned to the UI, and rewritten back to `localStorage`.

3. **Student Offline Outbox Retries (`PortalLandingPage.tsx` / `flushSubmissionOutbox`)**:
   - If a student submitted with intermittent Wi-Fi or offline, their browser queued the submission in `fluffykitten_submission_outbox`.
   - When that device reconnects or opens `PortalLandingPage`, `flushSubmissionOutbox()` flushes all pending items to Supabase.
   - Because the outbox is not cleared and no cloud tombstone blocks it, the student's device re-uploads the deleted submission.

4. **Bulk Deletion Lack of Persistence (`clearSubmissionsForQuiz`)**:
   - `clearSubmissionsForQuiz` deletes rows from the Supabase table for a quiz, but does not record which IDs were removed.
   - Any client running `loadAndSyncAllSubmissions()` with those submissions in its cache will re-upload the entire batch.

---

## 2. Target Architecture

We will implement a **dual-tier persistent tombstone registry** (local `localStorage` + cloud `app_config`), coupled with **strict tombstone gatekeeping on all read, write, merge, and outbox flushes**.

```
                           ┌────────────────────────────────────────┐
                           │      Teacher Deletes Submission        │
                           └───────────────────┬────────────────────┘
                                               │
                       ┌───────────────────────┴───────────────────────┐
                       ▼                                               ▼
         ┌───────────────────────────┐                   ┌───────────────────────────┐
         │ Local Tombstone Registry  │                   │ Cloud Tombstone Registry  │
         │ fluffykitten_deleted_     │                   │ Supabase app_config       │
         │ submission_ids            │                   │ key: deleted_submission_  │
         └─────────────┬─────────────┘                   │      ids                  │
                       │                                 └─────────────┬─────────────┘
                       │                                               │
                       └───────────────────────┬───────────────────────┘
                                               ▼
                                 ┌───────────────────────────┐
                                 │   Strict Tombstone Gates  │
                                 └─────────────┬─────────────┘
                                               │
        ┌──────────────────────┬───────────────┴───────────────┬──────────────────────┐
        ▼                      ▼                               ▼                      ▼
┌────────────────┐    ┌─────────────────┐            ┌──────────────────┐   ┌──────────────────┐
│ getAllSub-     │    │ fetchSub-       │            │ loadAndSync-     │   │ flushSubmission- │
│ missions()     │    │ missionsFrom-   │            │ AllSubmissions() │   │ Outbox()         │
│ Auto-prunes    │    │ Supabase()      │            │ Strips tombstones│   │ Discards         │
│ tombstones     │    │ Drops tombstone │            │ from local &     │   │ tombstoned       │
│ from storage   │    │ cloud & local   │            │ cloud; prevents  │   │ outbox items;    │
│                │    │ rows            │            │ re-upload        │   │ never pushes     │
└────────────────┘    └─────────────────┘            └──────────────────┘   └──────────────────┘
```

---

## 3. Detailed Executable Step Breakdown

### Step 1: Implement Submission Tombstone Registry in `quizSubmissionService.ts`
- **File**: `src/services/quizSubmissionService.ts`
- **Actions**:
  1. Define constants:
     ```typescript
     const DELETED_SUBMISSIONS_KEY = 'fluffykitten_deleted_submission_ids';
     const CLOUD_TOMBSTONE_CONFIG_KEY = 'deleted_submission_ids';
     const MAX_TOMBSTONES = 1000;
     ```
  2. Implement pure tombstone management functions:
     - `getDeletedSubmissionIds(): Set<string>`: Reads from `localStorage`, parses JSON array, returns a `Set<string>`.
     - `recordDeletedSubmissionIds(ids: string | string[]): void`: Adds ID(s) to the local set, bounds to the most recent 1,000 entries (to prevent storage bloat), saves to `localStorage`, and triggers cloud sync.
     - `isSubmissionDeleted(id?: string): boolean`: Checks if an ID exists in the tombstone set.
     - `fetchDeletedSubmissionIdsFromCloud(): Promise<string[]>`: Fetches `deleted_submission_ids` from Supabase `app_config`.
     - `syncDeletedSubmissionIdsWithCloud(): Promise<Set<string>>`: Two-way merges local and cloud tombstones so all devices learn about deletions immediately.
- **Verification Gate**:
  - Write test case in `scripts/test-submission-deletion-tombstones.mjs` verifying that adding IDs persists to local storage, caps at 1,000, and is queryable via `isSubmissionDeleted`.

---

### Step 2: Reinforce `deleteSubmission` and `clearSubmissionsForQuiz`
- **File**: `src/services/quizSubmissionService.ts`
- **Actions**:
  1. In `deleteSubmission(id: string)`:
     - Immediately call `recordDeletedSubmissionIds(id)`.
     - Remove `id` from `submissionsMemoryCache`.
     - Remove `id` from `localStorage` (`fluffykitten_quiz_submissions`).
     - Remove `id` from `fluffykitten_submission_outbox` so the device's outbox will never retry syncing it.
     - Execute Supabase delete on `quiz_submissions` table: `.delete().eq('id', id)`.
     - Filter `id` out of `app_config.key = 'quiz_submissions'`.
     - Asynchronously invoke `syncDeletedSubmissionIdsWithCloud()`.
     - Dispatch `window.dispatchEvent(new Event('submissions_updated'))`.
  2. In `clearSubmissionsForQuiz(quizId: string, quizCode?: string)`:
     - Gather all IDs currently matching `quizId` or `quizCode` from both `getAllSubmissions()` and in-memory cache.
     - Call `recordDeletedSubmissionIds(matchingIds)`.
     - Remove all matching submissions from `localStorage` and `submissionsMemoryCache`.
     - Remove matching items from `fluffykitten_submission_outbox`.
     - Execute Supabase delete on `quiz_submissions` table.
     - Update `app_config.key = 'quiz_submissions'`.
     - Asynchronously invoke `syncDeletedSubmissionIdsWithCloud()`.
     - Dispatch `window.dispatchEvent(new Event('submissions_updated'))`.
- **Verification Gate**:
  - Automated test verifying that calling `deleteSubmission` or `clearSubmissionsForQuiz` populates tombstones and purges both storage and outbox.

---

### Step 3: Shield Local Storage Queries & Local Cache Pruning
- **File**: `src/services/quizSubmissionService.ts`
- **Actions**:
  1. In `getAllSubmissions()`:
     - Obtain `deletedIds = getDeletedSubmissionIds()`.
     - Filter out any submission where `deletedIds.has(s.id)`.
     - If any tombstoned submission was found in `localStorage`, auto-prune it immediately to keep local storage clean.
  2. In `getSubmissionsForQuiz(quizId, quizCode, testId)`:
     - Since it calls `getAllSubmissions()`, ensure it benefits from the tombstone filter.
  3. In `safeSaveSubmissionsToLocalStorage(submissions)`:
     - Filter `submissions` through `!isSubmissionDeleted(s.id)` before saving to prevent accidentally writing back deleted records.
- **Verification Gate**:
  - Automated test verifying that `getAllSubmissions()` never returns a tombstoned submission and prunes it from disk.

---

### Step 4: Fix `loadAndSyncAllSubmissions()` to Prevent Cross-Device Resurrection
- **File**: `src/services/quizSubmissionService.ts`
- **Actions**:
  1. In `loadAndSyncAllSubmissions()`:
     - **Phase A**: Synchronize tombstones first via `await syncDeletedSubmissionIdsWithCloud()`.
     - **Phase B**: Obtain updated `deletedIds = getDeletedSubmissionIds()`.
     - **Phase C**: Filter `localList` and `cloudList`:
       ```typescript
       const activeLocal = localList.filter((s) => !deletedIds.has(s.id));
       const activeCloud = cloudList.filter((s) => !deletedIds.has(s.id));
       ```
     - **Phase D**: Merge only `activeLocal` and `activeCloud`.
     - **Phase E**: If `activeCloud` contains any item that was tombstoned, trigger background deletion from Supabase `quiz_submissions` table.
     - **Phase F**: When evaluating `hasLocalExclusiveOrNewer || activeCloud.length < merged.length`:
       - Only push `merged` to `saveBatchQuizSubmissionsCloud` if the exclusive local items are **not tombstoned**.
       - This permanently eliminates the bug where Device 2 re-uploads Device 1's deleted items!
- **Verification Gate**:
  - Automated test simulating Device 2 having a cached submission in `localStorage` that was tombstoned on Device 1; verify that `loadAndSyncAllSubmissions()` purges it locally and does NOT upload it to the cloud.

---

### Step 5: Fix `fetchSubmissionsFromSupabase()` in Quiz Results Modal
- **File**: `src/services/quizSubmissionService.ts`
- **Actions**:
  1. In `fetchSubmissionsFromSupabase(quizId, quizCode, testId)`:
     - Obtain `deletedIds = getDeletedSubmissionIds()`.
     - Filter incoming cloud rows: `data.filter((row) => !deletedIds.has(row.id))`.
     - Filter local storage rows: `local.filter((s) => !deletedIds.has(s.id))`.
     - Merge only non-deleted submissions.
     - Also filter the `app_config` fallback path through `!deletedIds.has(s.id)`.
- **Verification Gate**:
  - Automated test verifying that `fetchSubmissionsFromSupabase` excludes tombstoned submissions even if present in the raw database query or local cache.

---

### Step 6: Guard Submission Uploads & Outbox Flush
- **File**: `src/services/quizSubmissionService.ts`
- **Actions**:
  1. In `saveQuizSubmissionCloud(submission: StudentSubmission)`:
     - Check `if (isSubmissionDeleted(submission.id)) return false;`. Abort re-upload if submission has been deleted.
  2. In `saveQuizSubmissionWithVerification(submission: StudentSubmission)`:
     - Check `if (isSubmissionDeleted(submission.id)) return { success: false, attempts: 0, error: 'Submission deleted' };`.
  3. In `flushSubmissionOutbox()`:
     - Check each outbox item against `isSubmissionDeleted(item.submission.id)`.
     - If tombstoned: discard it from outbox without uploading to cloud.
- **Verification Gate**:
  - Automated test verifying that attempting to push or flush a tombstoned submission is rejected.

---

### Step 7: Automated Verification Suite & Build Integrity
- **Files**:
  - `scripts/test-submission-deletion-tombstones.mjs` (New test script)
  - `package.json` (Add script `"test:submission-tombstones"`)
- **Actions**:
  1. Run `node scripts/test-submission-deletion-tombstones.mjs`.
  2. Run `node scripts/test-exam-submission-fixes.mjs`.
  3. Run `node scripts/test-mcq-grading-flow.mjs`.
  4. Run `node scripts/test-test-builder-header-persistence.mjs`.
  5. Run `npm.cmd run build` (`tsc -b && vite build`) to guarantee clean compilation.

---

## 4. Risk Mitigation & Edge Cases Handled

| Edge Case | Failure Mode Without Fix | Behavior With Tombstone System |
|---|---|---|
| **Second teacher device opens Quiz Manager** | Device 2 sees submission in `localStorage`, assumes it's offline-graded, and pushes to Supabase. | Device 2 fetches cloud tombstones on sync, purges the submission from its local storage, and never re-uploads it. |
| **Offline student reconnects** | Student's browser outbox retries and re-inserts the deleted exam attempt. | Outbox checks tombstones on flush; deletes the queued attempt from outbox instead of uploading. |
| **Network failure during deletion** | Cloud delete fails; submission remains in Supabase. | Local tombstone records deletion immediately. Background retry syncs tombstone to `app_config` and deletes row from table once network restores. |
| **Tombstone storage growth** | `localStorage` fills up over years of exam deletions. | Tombstone list is automatically capped at the most recent 1,000 entries (FIFO), using minimal storage (~36 KB). |
| **Bulk delete ("Delete All Submissions")** | Submissions deleted on Device 1 are re-merged by Device 2. | All deleted IDs are recorded as tombstones in bulk and synchronized across all devices. |

---

## 5. Files to Be Modified

1. **`src/services/quizSubmissionService.ts`**:
   - Add tombstone registry constants & helpers (`getDeletedSubmissionIds`, `recordDeletedSubmissionIds`, `isSubmissionDeleted`, `fetchDeletedSubmissionIdsFromCloud`, `syncDeletedSubmissionIdsWithCloud`).
   - Update `deleteSubmission` and `clearSubmissionsForQuiz` to record tombstones and purge outbox.
   - Update `getAllSubmissions`, `loadAndSyncAllSubmissions`, and `fetchSubmissionsFromSupabase` to filter through tombstones.
   - Update `saveQuizSubmissionCloud` and `flushSubmissionOutbox` to guard against uploading tombstoned records.
2. **`scripts/test-submission-deletion-tombstones.mjs`** *(new file)*:
   - Automated regression test suite covering all 6 tombstone scenarios.
3. **`package.json`**:
   - Add `"test:submission-tombstones"` script.

