# Exam-Mode Student Submission Framework — Code Review

> **Status:** Review only — no application code changed.
> **Date:** 2026-11-06
> **Scope:** The formal-exam (`isExamMode`) path only: answer capture → in-progress persistence → submission construction → delivery/retry → grading → release/result lookup.
> **Out of scope:** Extraction pipeline, export layout/typography, game mode, and the visual design system (reviewed only where they touch submission integrity).

---

## 1. Verdict

The exam-mode submission path is thoughtfully engineered on the client: local-first persistence, a deferred-grading submit path, verified retries, an outbox, device receipts, and forensic telemetry. But it is **not a submission framework with a trust boundary**. The database accepts whatever the candidate's browser sends, the marking scheme and teacher PIN are shipped to the candidate's browser, and the live-proctor command channel is publishable by any student. Under real exam conditions the current design permits **score fabrication, answer-key leakage, cohort-wide command spoofing, and silent loss of submitted papers**.

The single highest-leverage change is architectural: make the server the authority for *who* submitted, *when*, *what they answered*, and *what it scored*. Most of the Critical/High findings below collapse into that one change.

| Severity | Count | Theme |
| :--- | ---: | :--- |
| **Critical** | 5 | Trust boundary, key/PIN leakage, client-side result gate, command spoofing, destructive re-grade |
| **High** | 10 | Recovery broken, deadline bypass, fire-and-forget force submit, outbox loss, answer-keying by index, device bleed |
| **Medium** | 8 | Autosave performance/quota, provisional scores in analytics, crash path, draft key mismatch, unbounded reads, duplicates |
| **Low** | 4 | Clock ordering, retention, payload bloat, missing regression tests |

**Checks run:** `tsc --noEmit` passes; `oxlint` reports 0 errors / 230 warnings; `scripts/test-proctor-p1-p2-p3.mjs` (48 assertions) and `scripts/verify-exam-key-lock.mjs` pass. The working tree has uncommitted proctor hardening that this review includes.

---

## 2. How a submission flows today

1. **Load** — `resolveStudentQuiz()` fetches published quiz config and full `questions` rows (`select('*')`) and returns them, plus `teacherPin`, to the runner. (`src/services/quizCodeService.ts:105-233, 347-387`)
2. **Start** — candidate name/class (optionally PIN) is checked; fullscreen is requested; an initial draft is written; `targetEndTime` is set client-side. (`StudentQuizRunner.tsx:2567-2668`)
3. **In progress** — answers live in React state keyed by array index (`0`, `1`, `0_0`…). Session is re-written to `localStorage` on nearly every change; a cloud draft is upserted to `app_config` every 50 s. (`StudentQuizRunner.tsx:2244-2374`, `examDraftService.ts:44-78`)
4. **Submit** — the client builds the whole `StudentSubmission` (identity, timestamps, `score`, `questionResults`, `topicBreakdown`, forensics), saves a device receipt, then calls `saveQuizSubmissionWithVerification()` with 3 retries. (`StudentQuizRunner.tsx:1650-1872`, `quizSubmissionService.ts:661-694`)
5. **Deliver** — `saveQuizSubmissionCloud()` writes one row to `quiz_submissions` and mirrors the entire submission list to `app_config`. The outbox tracks `pending → synced/failed`. (`quizSubmissionService.ts:589-655`)
6. **Grade** — exam submissions are stored as `status: 'submitted'`; a teacher must click **Batch AI Analysis** before they become `graded`. (`QuizResultsModal.tsx:287-478`)
7. **Release / lookup** — teacher publishes; student looks up by code + name + 3-digit PIN, which is filtered in JavaScript after downloading all rows for that quiz. (`quizSubmissionService.ts:1089-1193`)

---

## 3. Critical findings

### C1 — The submission store has no access control; scores are client-authoritative and writable by anyone

**Evidence**
- `supabase/migrations/007_quiz_submissions.sql:43-45` — `ALTER TABLE quiz_submissions DISABLE ROW LEVEL SECURITY;` with the comment "allow seamless client inserts".
- `supabase/migrations/004_app_config.sql:13-15` — `app_config` RLS disabled; it holds drafts, the full roster **with PINs**, and the mirrored submission list.
- `supabase/migrations/003_fix_all_rls_policies.sql:21-23` — `questions`/`custom_tests` use `FOR ALL USING (true) WITH CHECK (true)`.
- `src/lib/supabase.ts:4-7` — the anon key ships in the bundle by design.
- The client computes `score`, `percentage`, `submittedAt`, `durationSeconds`, `violationsCount`, `status`, and the generated `resultPin`, then upserts them (`StudentQuizRunner.tsx:1798-1828`, `quizSubmissionService.ts:599-628`).

**Impact.** Any student who opens DevTools — or simply calls the REST endpoint — can:
- insert a `published` 100 % submission under their own name;
- edit or delete any other candidate's submission (destroy evidence, change marks);
- read every paper, every result, and the roster PINs, before or after the exam.

This invalidates the gradebook, the audit trail, and the "one attempt" rule simultaneously. The PINs and `violationsCount` are advisory, not enforced.

**Fix (minimum, in order)**
1. Enable RLS on `quiz_submissions`, `app_config`, `questions`, `custom_tests` with **no** anon policies; move every write behind `SECURITY DEFINER` RPCs or an Edge Function.
2. Write submissions through `submit_exam_attempt(token, answers)` where `token` is issued at exam start, bound to `(quiz_id, candidate_id, attempt_no, deadline)`. The function stamps `now()`, computes the score server-side (or stores raw answers as `status='submitted'` and lets a server grader score them), and ignores any client-supplied `score`/`status`/`result_pin`.
3. Keep `service_role` only in Edge Functions. Never let the browser choose `status` or `score`.
4. Remove the anon key's write grants as a stop-gap even before the RPCs land: `REVOKE INSERT, UPDATE, DELETE ON quiz_submissions FROM anon;`.

---

### C2 — The marking scheme and the invigilator PIN are delivered to the candidate's browser

**Evidence**
- `src/services/quizCodeService.ts:347-387` — `fetchQuestionsByIds()` uses `.select('*')`; `resolveStudentQuiz()` returns those full `Question` rows (`:191-233`).
- `Question` includes `mark_scheme.marking_points`, `acceptable_answers`, `guidance`, `common_misconceptions`, per-sub-question `mark_scheme`, and `scratchpad` (`src/types/database.ts:106-111, 153-177, 188-223`).
- `resolveStudentQuiz()` explicitly returns `teacherPin: effectiveTeacherPin` (`:178`) and injects it into `headerConfig` (`:180, :188, :206`).

**Impact.** The answer key is in `Network → Response` and in memory for the whole exam. The UI hides solutions until release, but hiding UI does not hide data; DevTools shortcut blocking is a deterrent, not a boundary. The invigilator PIN being in the payload means a candidate can unlock their own strike lock (`StudentQuizRunner.tsx:859-890`) and self-authorize a re-upload (`:2138-2191`). The default PIN is `"1234"` and there is no UI to change it for a quiz.

**Fix**
- Serve questions through a candidate-facing view/RPC that returns only render fields: id, number, stem, options, marks, diagrams, audio, sub-question text/marks. Strip `mark_scheme`, `guidance`, `common_misconceptions`, `scratchpad`, `teacherPin`, and any `correctAnswer`.
- Keep the mark scheme server-side for grading. If the client must show solutions after release, fetch them from a release-gated RPC.
- Never send `teacherPin` to a student client. Authorize unlocks via a teacher session (or a short-lived signed unlock token) through an Edge Function.

---

### C3 — Result lookup downloads the whole quiz cohort and gates it with a 3-digit PIN in JavaScript

**Evidence**
- `quizSubmissionService.ts:1100-1116` — `.select('*').eq('quiz_code', cleanCode)` then filters by name/candidate number **in the browser**, then compares `result_pin` in the browser.
- `:1152-1159` — returns only `published` rows, but every row (including unpublished ones, all raw answers, all question results, and all `result_pin`s) has already been transferred.
- `:242-244` — `Math.random()` 3-digit PIN, 900 possibilities, stored in clear text, no rate limit.
- `PortalLandingPage.tsx:512-519` — the PIN is validated only by the modal.
- The fallback path `loadAndSyncAllSubmissions()` (`quizSubmissionService.ts:1166-1170`) downloads **all** submissions across all quizzes to the student's browser and writes them to `localStorage`.

**Impact.** Anyone who knows a quiz code can read the full candidate list with scores, answers, and PINs without guessing the PIN. They can then brute-force a specific 3-digit PIN (≤900 attempts) or simply open the Network tab. On shared/student devices the fallback additionally persists the whole school's submissions in `localStorage`.

**Fix**
- Add `get_exam_result(p_code, p_name, p_pin)` `SECURITY DEFINER`: normalize and match in SQL, compare a hashed PIN, return **only** `published` rows for that candidate. Add a per-IP/per-candidate attempt counter and lockout.
- Generate the PIN server-side (>=6 digits or a signed receipt token), hash it at rest, and never return `result_pin` in a row payload.
- Never call `loadAndSyncAllSubmissions()` from the student portal.

---

### C4 — Proctor commands are unauthenticated broadcasts that any student can publish

**Evidence**
- `src/services/examProctorRealtimeService.ts:184-224` — `supabase.channel('exam_proctor:<CODE>')` with default (public) broadcast; the channel name is derivable from the quiz code every student has.
- `:191-207` — every `proctor_cmd` broadcast received is applied; there is no signature, sender identity, or host check.
- `:413-442` — `sendProctorCommand()` publishes on the same public channel.
- `StudentQuizRunner.tsx:1282-1368` — applies `unlock`, `add_time`, `force_submit`, `pardon`, `announcement` after only `isAllowedProctorCommand()` (a type allow-list) and a client-side command-id de-dup.
- `LiveInvigilatorModal.tsx:871-920` — `force_submit` is a broadcast + optimistic UI update; there is no server confirmation.

**Impact.** A malicious candidate can open their own console and publish `{type:'force_submit', targetStudentId:'ALL'}` to force the entire cohort to submit, `add_time` to give everyone extra time, or `pardon` to clear strikes. Even without malice, a closed tab means "force submit" silently does nothing while the invigilator dashboard shows **submitted**.

**Fix**
- Use a **private** Realtime channel (`{ config: { private: true } }`) plus RLS on `realtime.messages` so only an authenticated invigilator can publish `proctor_cmd`; students get subscribe-only.
- Prefer a durable `proctor_commands` table + `postgres_changes` with RLS; students apply only rows they are authorized to see. This also survives reloads.
- Make `force_submit` a **server** action: snapshot the last server-persisted answers into a final attempt, then notify the student UI. The dashboard should show "submit requested" until a submission row is confirmed by the server.

---

### C5 — "Re-grade all deterministically" silently zeroes every AI-graded descriptive mark

**Evidence**
- `QuizResultsModal.tsx:530-573` — in the deterministic re-grade loop, `totalSubEarned += det.earnedMarks` and `qEarned = det.earnedMarks` are applied **unconditionally**, then the submission is saved with `status: 'graded'` (`:624-635`).
- `deterministicGradingService.ts:1524-1533` — for multi-mark descriptive responses it returns `{ isHandled: false, earnedMarks: 0 }`.
- The button is presented as safe: "100% exact math, zero AI variance" (`QuizResultsModal.tsx:482-484`).

**Impact.** For any structured/theory paper (the normal Cambridge Paper 2/3/4 case), one click replaces correct AI or manually adjusted marks with 0 and marks the attempt as graded. There is no score history, so the previous values are gone (localStorage + cloud are both overwritten via `updateSubmission`). This is a data-loss bug, not just a UI risk.

**Fix**
- Re-grade only when `det.isHandled` is true; preserve `earnedMarks` and `feedback` for unhandled questions. Show "skipped N descriptive questions — AI/manual marks preserved".
- Or scope the action to a selected exam type ("MCQ-only deterministic re-grade") and refuse to run when unhandled descriptive marks exist.
- Keep an append-only `score_history` (score, method, actor, timestamp) before any bulk write.

---

## 4. High findings

### H1 — "Resume Exam" can never succeed (object used as a boolean)

**Evidence.** `StudentQuizRunner.tsx:2516-2527`:
```ts
const alreadySubmitted = await checkStudentAttemptSubmitted(...);
if (alreadySubmitted) { ...block... }
```
`checkStudentAttemptSubmitted()` returns `{ submitted: boolean; ... }` (`examDraftService.ts:173-235`), so the object is always truthy. With `limitOneAttempt` defaulting to `true` (line 367) and `resolvedQuizCode` always set, the resume branch always shows "Single Attempt Policy" and clears the detected draft.

**Impact.** The advertised crash/device-switch recovery is dead code in the default configuration. The 50-second cloud draft is written but unusable, so a candidate whose browser dies at minute 40 cannot resume. Compare the correct check at `:2612-2627` (`if (attempt.submitted)`).

**Fix.** `if (alreadySubmitted.submitted)`. Add a regression test that starts, submits a draft, then resumes.

---

### H2 — Resuming a draft rewinds the exam clock instead of honoring the deadline

**Evidence.**
- `StudentQuizRunner.tsx:2547-2555` — `rawRemaining = detectedDraft.timeLeftSeconds`, then `setTargetEndTime(now + remaining * 1000)`. `detectedDraft.targetEndTime` and `startTime` are available but only `startTime` is restored.
- The draft is only written every 50 s (`:2349`), so `timeLeftSeconds` is a stale snapshot.
- The unload warning promises "your timer continues running" (`:2431`), but a candidate who clears site data and returns via the draft gets the last snapshot's remaining time.

**Impact.** A candidate can extend their exam indefinitely in ~50-second increments by clearing `localStorage` (or switching devices) and resuming. Even without intent, a genuine crash can award free time relative to the server's eventual receipt time.

**Fix.** Persist an absolute `deadline` (and `startedAt`) at start, store it server-side with the attempt, and on resume compute `remaining = deadline - Date.now()`. Never add time from a draft. Reject submissions received after `deadline + grace` server-side (see H6).

---

### H3 — Force-submit is fire-and-forget, and the dashboard lies about it

**Evidence.** `LiveInvigilatorModal.tsx:871-920` sends the broadcast and immediately sets the local row to `status: 'submitted'` (`:885-894`). The only durable record is an audit event (`:907-919`). If the student's tab is closed, offline, or crashes, no `quiz_submissions` row is ever created. The same "optimistic" pattern is used for bulk actions.

**Impact.** An invigilator can close an exam believing 30 papers are in, while several were never submitted. There is no reconciliation job or "missing submission" warning.

**Fix.** Force-submit must be a server action that finalizes the last persisted draft/answers (or marks the attempt `void`/`no_submission` with a reason). The dashboard should distinguish `submit_requested`, `submitted`, `no_submission`, and `offline`; only `submitted` counts as turned in. Add a post-exam reconciliation report.

---

### H4 — Outbox items that fail are never retried again

**Evidence.**
- `quizSubmissionService.ts:48-50` — only `status === 'pending'` is flushed.
- `:692-693` — after 3 failed attempts, `saveToSubmissionOutbox(submission, 'failed', lastErr)`.
- `:213-237` — `flushSubmissionOutbox()` only iterates pending items; a failed item is never promoted back to pending.
- `PortalLandingPage.tsx:415-423` — auto-flush also checks only pending items.

**Impact.** A submission that fails its three inline retries (school Wi-Fi, laptop lid closed at the wrong moment) is **orphaned**: the portal banner won't show it, background flush won't retry it, and the student has no path back to it unless they are still on the result screen and press retry. `loadAndSyncAllSubmissions()` on the teacher dashboard can rescue it only if the teacher opens the dashboard on that same device.

**Fix.** Flush both `pending` and `failed` with exponential backoff and a bounded attempt count; add a manual "Sync now" for failed items visible on the portal; age out only after explicit success or a retention period. Consider `navigator.sendBeacon` / Background Sync on `pagehide`.

---

### H5 — The dual-write mirror loses submissions and can make them invisible to teachers

**Evidence.**
- `quizSubmissionService.ts:640-652` — every submit does a read-modify-write of the **entire** `app_config['quiz_submissions']` blob (fetch all, merge one, upsert all, capped at 200).
- `:630-649` — if the table write fails but the mirror succeeds, the outbox is marked `synced`, yet the function returns `false`, so the caller reports failure and later writes `failed`.
- `:841-888` — `fetchAllSubmissionsFromSupabase()` returns the table rows **only if `data.length > 0`**; the `app_config` fallback runs only when the table is empty/errored.
- `:894-950` — `loadAndSyncAllSubmissions()` merges and batch-writes; concurrent teacher/student devices race on the same blob.

**Impact.** With 30 candidates submitting in the same minute, each read-modify-write overwrites the others (classic lost update). A record that lands only in `app_config` is invisible to every teacher whose table query returns at least one row. Data can also be resurrected: a stale local list can batch-upsert over newer teacher edits.

**Fix.** Make `quiz_submissions` the only source of truth; drop the giant JSON mirror or replace it with an append-only `submission_events` table. If a fallback is required, query both sources and merge by `id`/`updated_at` every time. Never mark synced based on the mirror. Use a server-side sequence/version to reject stale writes.

---

### H6 — Time, identity, and score are client-asserted; there is no server receipt or deadline

**Evidence.**
- `StudentQuizRunner.tsx:1798-1828` — `submittedAt`, `durationSeconds`, `score`, `percentage`, `status` are computed in the browser.
- `:406-418, 2244-2316` — the deadline lives in `localStorage` (`targetEndTime`) and is restored from it.
- `quizSubmissionService.ts:605-628` — writes `submitted_at: submission.submittedAt` (client clock) and ignores the DB's `created_at`.
- There is no check that a submission arrived before the exam deadline, nor that the attempt token matches the quiz.

**Impact.** A candidate can change `targetEndTime` in `localStorage`, keep the tab alive past the deadline, submit after time, or submit with an arbitrary duration/score. A wrong laptop clock also reorders the live dashboard and the gradebook. The submitted record is not evidence of anything except "this browser sent this JSON".

**Fix.**
1. Issue an attempt token at start: `{ attemptId, quizId, candidateId, startedAt, deadline }` signed/MAC'd server-side.
2. Stamp `received_at = now()` server-side; reject if `now() > deadline + grace`.
3. Compute `durationSeconds` from `startedAt` server-side.
4. Store the raw answers and grade server-side (or in a trusted grader job), not the client's `score`.

---

### H7 — Answers are keyed by array index, so any test edit breaks re-grading

**Evidence.**
- `StudentQuizRunner.tsx:1822` — `rawAnswers: { ...answers }` where keys are `0`, `1`, `0_0` (see setters at `:3122-3178`).
- `QuizResultsModal.tsx:338, 346, 397, 535, 561` — re-grade reads `rawAnswers[idx]` and the composite `${idx}_${sqIdx}` key against the **current** `questions` array.
- `questionResults` does store `questionId`, but grading does not use it as the primary key.

**Impact.** If a teacher edits the test after the exam (fixes a typo, removes a question, reorders auto-assembly), every subsequent answer shifts by one. Re-grading then attributes answers to the wrong questions. The same happens if the quiz is republished with an edited question list. Re-grade results are silently wrong, which is worse than a visible failure.

**Fix.** Store `answersByQuestionId` (and `answersBySubId`) and a **question snapshot/version** at attempt start: `[ { questionId, versionHash, marks, subIds } ]`. Grade against that snapshot, not the live test. If a question changes materially, create a new version rather than mutating the old one.

---

### H8 — Session persistence is keyed by quiz code, not candidate, so a shared device bleeds one student's attempt into the next

**Evidence.**
- `StudentQuizRunner.tsx:347` — `const sessionKey = exam_sess_${testIdOrCode}`.
- `:348-356` restores `candidateName`, `answers`, `currentIndex`, `isSubmitted`, `completedSubmission` from that key.
- `:2244-2286` writes answers, candidate identity, and `studentPin` back to `localStorage` under the same key.
- The key is removed only after a **successful** cloud sync (`:1851-1853, 2058-2060`).

**Impact.** Two candidates on the same laptop (rotation, lab device, absent student's machine) share one session. If candidate A's sync fails or they close early, candidate B sees A's name, answers, PIN, and possibly A's completed submission. This is both a privacy leak and an integrity failure (B could submit A's paper, or inherit A's strikes).

**Fix.** Key the session by `(quizCode, canonicalCandidateId, attemptId)` and clear/rotate it on every identity change. Do not restore `completedSubmission` for a different canonical id. On exam entry, require a fresh identity confirmation when a previous session exists for the same quiz.

---

### H9 — Candidate identity and the one-attempt rule are weak and bypassable

**Evidence.**
- `examDraftService.ts:178-201` — attempts are matched by trimmed/lowercased **name + class**, with `student_class` fallback; `_studentPin` is accepted but ignored; only 100 rows are fetched with no ordering (`:186-189`).
- `requireStudentPin` defaults to `false` and there is no publish UI for it (`QuizManagerPage.tsx` has no `requireStudentPin`/`limitOneAttempt` control; `quizCodeService.ts:209-210`).
- `checkStudentAttemptSubmitted()` is called at **start** and **resume** only, never inside `handleSubmitExam`.
- Offline, the only blocker is a device receipt (`examDraftService.ts:215-233`).

**Impact.**
- Any student can type a classmate's name (no PIN by default) and submit as them.
- Double spaces/diacritics evade the name match.
- In a cohort with >100 submissions, `.limit(100)` can miss the candidate entirely and let a retake through.
- Clearing site data offline bypasses the one-attempt rule.
- Two same-name students in one class are conflated.

**Fix.** Use the roster `studentId` (or candidate number) as the primary key, issued/verified server-side. Enforce `UNIQUE (quiz_id, student_id)` where `limitOneAttempt`, and check it transactionally at submit. Normalize once on the server. Make `requireStudentPin` and `limitOneAttempt` real, configurable publish options.

---

### H10 — AI grading silently degrades to keyword heuristics and still marks the attempt "graded"

**Evidence.**
- `aiGradingService.ts:238-246, 313-316` — if no API key or all Gemini calls fail, `fallbackRuleBasedEvaluation()` returns `evaluatedBy: 'rule_fallback'`.
- `:148-181` — the fallback awards one mark per criterion whose keywords appear in the answer; a long answer containing the right nouns can score full marks without a correct explanation.
- `QuizResultsModal.tsx:458-466` — the submission is saved as `status: 'graded'` regardless; `gradingMethod` is stored but never surfaced in the results UI.
- The release gate only checks `status`, so a heuristic-graded paper can be released as if AI-graded.

**Impact.** A missing/expired API key, a rate limit, or a flaky network turns batch grading into a keyword game — potentially inflating or deflating marks — and the teacher has no signal. This is especially dangerous for Cambridge-style "explain/evaluate" questions.

**Fix.** Mark fallback results `graded_provisional` and require explicit confirmation. Show the `gradingMethod` breakdown (AI vs keyword vs manual) in the results table. Persist `graded_by`, `graded_at`, `grader_model`, and `rubric_version`. Never auto-release fallback-graded attempts.

---

## 5. Medium findings

### M1 — Provisional (deterministic-only) scores are averaged and exported as if final

`StudentQuizRunner.tsx:1761-1766` stores `0` + "Awaiting examiner AI evaluation" for unhandled structured answers, but the submission is still `status:'submitted'` with a numeric `score`. `QuizResultsModal.tsx:655-681` computes class averages/grade distribution over **all** submissions, and the Excel/PDF exports receive the same list. Immediately after an exam, a theory paper can show an average near 0 % until the teacher runs batch AI. **Fix:** exclude `status === 'submitted'` from analytics/exports, or label the figures "provisional"; show a clear "N awaiting grading" state instead of a numeric average.

### M2 — Result screen crashes when `completedSubmission` is null

`StudentQuizRunner.tsx:3838-3842` only special-cases `completedSubmission?.status === 'submitted'`; the main results branch then dereferences `completedSubmission.submittedAt` at `:3962` and `completedSubmission.resultPin` at `:3980`. The catch in `handleSubmitExam` (`:1863-1867`) sets `isSubmitted(true)` without a completed submission, and that state is persisted (`:2244-2261`). A throw during forensics/grading therefore leaves a permanently broken result screen after reload. **Fix:** render a "submission recorded, receipt unavailable" state when `completedSubmission` is null; never invent a score. Note also `calculateResults()` (`:3190-3219`) counts every answered question as correct in the fallback — used by the export fallbacks at `:4915`/`:4974`.

### M3 — The draft key uses two different `quizId` values, and stale drafts are never cleared on failure

- `StudentQuizRunner.tsx:2650-2652` writes the initial draft with `quizId: resolvedTestId`.
- `:2323` writes subsequent drafts with `quizId: resolvedPublishedId || resolvedTestId || testIdOrCode`.
- `examDraftService.ts:97-101` rejects a draft whose `quizId` differs from the requested one — and returns `null` without trying the cloud copy.

**Impact:** for the first 50 s of a published quiz, the draft is unrecoverable (and on another device it looks like no draft exists). Drafts are cleared only after a successful sync (`:1853`, `:2060`), so abandoned attempts keep producing the "Resume?" prompt. **Fix:** use one `effectiveDraftQuizId` everywhere; on a local mismatch, continue to the cloud; delete/finalize the draft on submit regardless of sync outcome (keep the outbox as the backup).

### M4 — Autosave writes the full session to `localStorage` on every keystroke

The persistence effect (`:2244-2316`) depends on `answers`, which changes on every `onChange` (`:3144-3168`). `JSON.stringify` of the full session (answers + flagged set + audio progress + violations + possibly `completedSubmission` with all `questionResults`/forensics) runs synchronously per keystroke. For a 40-question paper with long essay answers this is jank and unnecessary storage churn. **Fix:** debounce (e.g. 800 ms idle / 3 s max), persist only the mutable answer map in a hot path, and move large blobs to IndexedDB. Also save on `visibilitychange`/`pagehide`.

### M5 — Cloud autosave starts only after 50 s, and only every 50 s

`:2318-2350` creates the interval on mount and never does an immediate save (the initial save at `:2650` exists, but no save on answer changes). A tab crash in the first minute, or between ticks, loses up to 50 s of work; combined with H2 it also produces an artificially early resume snapshot. **Fix:** write on a short debounce plus a 15–20 s heartbeat, and on `pagehide`. Consider saving a per-answer delta rather than the whole blob.

### M6 — Submission reads are unbounded, and realtime subscriptions are unfiltered

- `quizSubmissionService.ts:844-846` — `.select('*')` on all submissions, no pagination.
- `:894-950` — merges everything into `localStorage`; quota recovery then drops older records and forensics (`:443-484`).
- `QuizResultsModal.tsx:188-203` — `postgres_changes` on the whole `quiz_submissions` table with no `filter`, so every teacher browser refreshes on every submission school-wide.

**Fix:** page/limit by quiz and status, select only required columns in list views, filter the realtime channel by `quiz_code=eq.<code>`, and stop mirroring all submissions to the student portal (C3).

### M7 — Duplicate attempts are counted as separate candidates

The invigilator "Unlock & Resume" (`StudentQuizRunner.tsx:2192-2217`) clears `isSubmitted`/`completedSubmission` without voiding the already-saved row; the student can then submit again with a new random id (`:1799`). Retrying an offline submission after clearing state does the same. `QuizResultsModal` statistics (`:655-681`) and the table do not deduplicate (the PDF class report does, at `quizReportPdfService.ts:62-86`), so a candidate can appear twice and distort averages/rankings. **Fix:** enforce `(quiz_id, candidate_id, attempt_no)`; mark a resumed attempt as superseded; dedupe by canonical candidate in all aggregations.

### M8 — Structured-question `studentAnswer` is blank in `questionResults`; forensics bloat the answer payload

- `StudentQuizRunner.tsx:1781` stores `studentAnswer: answers[idx]` for a sub-question parent; sub-answers live under `${idx}_${sIdx}`, so the parent record says "" while `subQuestionResults` hold the real text. Any consumer that reads only `studentAnswer` shows "(No response)".
- `quizSubmissionService.ts:615-618` stores `forensics` inside `raw_answers._forensics`; on read it is extracted and deleted (`:850-852`), but it inflates every row and every app_config mirror. Answer-change logs and dwell arrays grow with exam length and are copied on every save.

**Fix:** aggregate sub-answers into the parent's `studentAnswer` or make consumers always read `subQuestionResults`; move forensics to a dedicated JSONB column/table, cap the log length, and store deltas.

---

## 6. Low findings

- **L1 — Client clock vs DB clock.** `submitted_at` is the candidate's clock (`quizSubmissionService.ts:608`); `created_at` (server) is never read or displayed. A wrong laptop clock reorders the dashboard and the gradebook. Use `created_at`/server receipt for ordering and display.
- **L2 — No retention/cleanup.** Draft rows and submissions accumulate indefinitely in `app_config`/`quiz_submissions`; the only "cleanup" is the 24 h client-side draft TTL (`examDraftService.ts:102-107`) and the 200-row mirror cap. Add a scheduled purge/archive for closed exams and a GDPR-style delete path.
- **L3 — Weak PIN materials.** `generateResultPin()` uses `Math.random()` (`:242-244`) and is shown to the student (`StudentQuizRunner.tsx:3980-4020`); the roster PIN is 4 digits and stored in clear text (`studentRosterService.ts:30-32`). Use `crypto.getRandomValues`, at least 6 digits, hash at rest, and rate-limit verification (C3).
- **L4 — No regression coverage for the submission path.** There are good pure tests for proctor guards, gestures, and extraction, but nothing exercises `handleSubmitExam`, draft resume, outbox transitions, or re-grade preservation. The H1 bug and the C5 data-loss path would both be caught by a small unit test with an in-memory storage/clock harness.

---

## 7. What already works

- **Deferred grading in exam mode** keeps the submit action fast and independent of Gemini latency (`StudentQuizRunner.tsx:1690-1700`) — the right instinct, it just needs a server-side grading job.
- **Idempotent retries**: the same submission id is upserted on each attempt, so retries do not create duplicates (`quizSubmissionService.ts:589-655, 661-694`).
- **Visible sync state**: the result screen clearly distinguishes `syncing`, `synced`, and `offline_failed`, and provides a manual retry (`:3846-3930, 2106-2127`).
- **Offline escape hatches**: device receipts, `.exam` file export, and the base64 token (`:121-208`) give a last-resort recovery path.
- **Release guard**: the "Release Results" button is disabled while `status === 'submitted'` (`QuizResultsModal.tsx:1109`), so ungraded marks are not normally released.
- **Forensics**: canonical proctor id, answer-change log, dwell time, and invigilator actions add genuine audit value (`examSecurityUtils.ts:120-143`, `StudentQuizRunner.tsx:1618-1647`).
- **Deterministic MCQ / multi-select / gap-fill grading** is thorough and well-tested by construction (Arabic options, units, chemical formulas, numeric equivalence).

---

## 8. Target design (recommended)

Treat the exam as a small state machine owned by the server, with the browser as a view.

```text
POST /rpc/start_exam_attempt(code, roster_id, pin)
  -> { attempt_id, token, started_at, deadline, question_snapshot }

POST /rpc/save_exam_answers(token, answers_by_question_id, client_seq)
  -> { accepted_seq, server_time }        // used by autosave

POST /rpc/submit_exam_attempt(token, answers_by_question_id, client_seq)
  -> { submission_id, received_at, status } // server stamps time, computes score
```

Schema sketch:

```sql
-- one row per sitting, server-owned
create table exam_attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_id text not null,
  quiz_code text not null,
  candidate_id text not null,          -- roster id, not a typed name
  candidate_name text not null,
  class text,
  attempt_no int not null default 1,
  started_at timestamptz not null default now(),
  deadline timestamptz not null,
  submitted_at timestamptz,            -- server now()
  status text not null default 'in_progress', -- in_progress|submitted|grading|graded|published|void
  answers jsonb not null default '{}'::jsonb,  -- keyed by question_id / sub_id
  question_snapshot jsonb not null,    -- id, version, marks at start
  score numeric,
  total_marks numeric,
  forensics jsonb
);

create unique index exam_attempts_one_sitting
  on exam_attempts (quiz_id, candidate_id)
  where attempt_no = 1;

alter table exam_attempts enable row level security;
-- no anon policies; all access through security-definer RPCs / edge functions
```

Grading as a job: `submitted → grading` on insert, worker/Edge Function grades MCQ deterministically and descriptive with the AI grader, then `graded` with `graded_by`, `graded_at`, `grader_model`, `rubric_version`. Only `graded` can be `published`. Re-grades append to `score_history`; never overwrite without a record.

Realtime: one private channel per quiz, authenticated; commands are durable rows (`proctor_commands`) with `issued_by`, and the student applies only rows visible under RLS. `force_submit` is a server transaction, not a broadcast.

---

## 9. Remediation plan

### Phase 0 — Quick wins (1–2 days, no schema change)
1. Fix H1 (`alreadySubmitted.submitted`).
2. Fix C5: preserve unhandled marks on deterministic re-grade; scope the action.
3. Fix H4: flush `failed` items; add a portal "Sync now" for failed items.
4. Fix H2: resume from `targetEndTime`/absolute deadline, never from `timeLeftSeconds`.
5. Remove `teacherPin` from `StudentQuizRunner`'s resolved payload and `headerConfig` (C2) and use a server-verified unlock.
6. Stop calling `loadAndSyncAllSubmissions()` from the student result path (C3).
7. Guard the result screen against a null `completedSubmission` (M2).
8. Debounce localStorage persistence and add `pagehide` flush (M4/M5).

### Phase 1 — Server authority (the real fix)
1. Enable RLS; revoke anon writes; add `start_exam_attempt`, `save_exam_answers`, `submit_exam_attempt`, `get_exam_result` RPCs.
2. Candidate-facing questions view/RPC without mark schemes (C2).
3. Server receipt time + deadline enforcement + server-side score computation (C1/C3/H6).
4. Roster-based candidate identity and unique-attempt constraint (H9).
5. Private proctor channel + authenticated commands; server-side force-submit (C4/H3).

### Phase 2 — Grading integrity
1. Durable grading job with `grading` status, provenance (`graded_by`, `grader_model`, `rubric_version`), and `score_history`.
2. Surface `rule_fallback` and require acknowledgement before release (H10).
3. Grade against the question snapshot; answers keyed by question id (H7).
4. Exclude provisional rows from analytics/exports and label them (M1).

### Phase 3 — Hygiene and resilience
1. IndexedDB for drafts/outbox; per-answer delta saves; background sync (M4/M5).
2. Per-submission mirror or removal of the `app_config` blob (H5).
3. Retention/purge, hashed PINs, rate limits (L2/L3).
4. Regression tests for submit/resume/outbox/re-grade (L4).

---

## 10. Test plan (minimum)

| Test | Asserts |
| :--- | :--- |
| Start → answer → submit (mocked Supabase) | payload has server-derived time/score; no client `score` honored |
| Draft resume after 10 min | `remaining == deadline - now`, not the snapshot; resume succeeds when no prior submission |
| Attempt-limit check | uses roster id, not name; 101st candidate still blocked; same-name different-id allowed |
| Outbox: 3 failures then online | failed item is retried and eventually synced; not orphaned |
| Concurrent submits (2 writers) | neither record is lost in the mirror/table |
| Re-grade with descriptive answers | AI/manual marks preserved; only deterministic questions change |
| Re-grade after test edit | grades against the snapshot, not the shifted array |
| Result lookup with wrong PIN | server rejects; no row payload is returned to the client |
| Force submit with tab closed | server records `no_submission`/`void`, dashboard does not show `submitted` |
| Question payload | response never contains `mark_scheme`, `guidance`, `teacherPin` |

A small Node harness already exists (`scripts/register-ts.mjs`, `scripts/test-proctor-p1-p2-p3.mjs`); the pure parts of the submit/grade logic can be extracted and tested the same way.

---

## 11. Assumptions and open questions

- **Assumption:** the deployed Supabase project matches the migrations in `supabase/migrations/`. If RLS was enabled manually in production, C1's severity drops but C2/C3/C4 remain.
- **Assumption:** the product is single-tenant (one school) with no student auth. If student auth is added, many findings simplify.
- **Question:** is `app_config['quiz_submissions']` still needed as a cross-deployment fallback? If yes, it needs an append-only design and a merge-on-read, not a read-modify-write blob.
- **Question:** should `limitOneAttempt` be configurable per quiz? It is currently always true, which makes the broken resume path (H1) user-visible on every exam.
- **Question:** what is the intended result-lookup privacy model — 3-digit PIN is a convenience gate, not a secret. If reports contain answer keys, they should not be downloadable before release.

---

## Appendix — primary files reviewed

| File | Lines | Role |
| :--- | ---: | :--- |
| `src/pages/StudentQuizRunner.tsx` | 6,581 | Runner, timer, draft, submit, result screen |
| `src/services/quizSubmissionService.ts` | 1,326 | Submission model, outbox, cloud sync, result lookup |
| `src/services/examDraftService.ts` | 236 | Cloud draft, attempt check |
| `src/services/deterministicGradingService.ts` | 1,534 | Deterministic grading |
| `src/services/aiGradingService.ts` | 601 | Gemini grading + keyword fallback |
| `src/services/quizCodeService.ts` | 411 | Quiz resolution / question payload |
| `src/services/examProctorRealtimeService.ts` | 456 | Proctor channel and commands |
| `src/components/QuizResultsModal.tsx` | 2,466 | Grading, release, stats, re-grade |
| `src/components/LiveInvigilatorModal.tsx` | 2,005 | Force submit / backfill |
| `src/pages/PortalLandingPage.tsx` | 866 | Outbox and result lookup entry |
| `src/services/studentRosterService.ts` | 494 | Roster and PINs |
| `supabase/migrations/003,004,007,010` | — | RLS, submissions, PIN RPCs |
