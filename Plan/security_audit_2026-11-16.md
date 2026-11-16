# Security Audit — 2026-11-16 (live verification)

> **Status:** Findings recorded; no fixes applied by this audit.
> **Scope:** Exam confidentiality and exam-integrity surface of the TestMaker SPA, its Supabase project, and its public media bucket.
> **Method:** Read-only. All probes used the `VITE_SUPABASE_ANON_KEY` already shipped to browsers (read from `.env.local`), plus static inspection of `src/`, `worker/`, `supabase/migrations/`, and the built `dist/`. **No writes, no mutations, no student PII was read.**
> **Related plans:** [exam_paper_download_security_plan.md](./exam_paper_download_security_plan.md) (2026-11-14), [gemini_api_key_cloudflare_proxy.md](./gemini_api_key_cloudflare_proxy.md), [phase3_deep_security_hardening_plan.md](./phase3_deep_security_hardening_plan.md).

---

## 1. Motivation & Problem Statement

The attack surface verified end-to-end centers on three live exposures: **anyone can read legacy invigilator unlock PINs and quiz metadata from `published_quizzes`, extract the Gemini API key from the JavaScript bundle, and extract the hardcoded R2 upload secret from the bundle** (none of which require authentication). Public read access to past-paper Question Paper PDFs (`SEC-02`) was reviewed and confirmed as **intended by design** for revision and citation links, so it is excluded from remediation.

The audit also confirms that the v2.5.x hardening work **did** close the earlier full-database dump: `questions`, `custom_tests`, `quiz_submissions`, `teacher_profiles` and `proctor_audit_events` are now RLS-blocked for `anon`. Ten days ago the same probes returned 1,959 question rows including `mark_scheme`; today they return 0 rows.

---

## 2. Findings Summary

| ID | Finding | Severity | Status |
| :--- | :--- | :--- | :--- |
| SEC-01 | Invigilator PIN stored in plaintext in anon-readable `published_quizzes.data` | **Critical** | Open |
| SEC-02 | Question Paper PDFs publicly listable and downloadable (58 papers) | Informational | **Intended by design (Accepted)** |
| SEC-03 | Gemini API key compiled into the public JS bundle | **Critical** | Open |
| SEC-04 | Hardcoded R2 uploader secret shipped in the client bundle | **Critical** | Open |
| SEC-05 | Published-quiz catalogue enumerable (codes, titles, schedule, settings) | High | Open |
| SEC-06 | Pilot exam answers compiled into the main bundle | High | Open |
| SEC-07 | Teacher passwords use salted SHA-256 (fast hash) | Medium | Open |
| SEC-08 | Storage `INSERT` policy documented without a role restriction | Medium | Needs dashboard check |
| SEC-09 | Pre-start submission identity is name-based when PINs are off | Medium | Partial (024 protects active drafts/PINs) |
| SEC-10 | `access_pin` seeded with RLS disabled (migration 004) | Low (historical) | Fixed by 021 |
| SEC-11 | `teacherPinHash` leaked in student exam payload | High | **Fixed — verified** |
| SEC-12 | `questions` / `quiz_submissions` / `custom_tests` readable by anon | Critical | **Fixed — verified** |

---

## 3. Detailed Findings

### SEC-01 — Invigilator PIN is readable by anyone (Critical, Open)

The remote `published_quizzes` table has an anon `SELECT` policy, and its `data` JSONB stores the unlock PIN in **plaintext**. `buildStudentQuizData()` deletes `teacherPin` from the header it hands to the UI, but the source row remains queryable. Notably, `public.published_quizzes` is not created in `supabase/migrations/` (`001`–`024`) and is not queried directly by `src/` (which stores published quizzes inside `app_config`), which is why migrations `021` and `024` missed locking it down.

**Evidence**

```
GET /rest/v1/published_quizzes?select=quiz_code,is_active,data   → 5 quizzes readable
data keys: … isExamMode, teacherPin, securityEnabled, maxViolations, questionIds, …
data.teacherPin: 4 characters, digits only, equals the default "1234"
```

**Impact** A candidate who trips a violation can read their own exam's PIN and unlock themselves, or pre-emptively read it before the exam. The server-side `verify_teacher_unlock_pin` RPC is sound — the secret in front of it is not.

**Remediation**
1. Inspect whether any trigger or external sync populates `public.published_quizzes`; stop storing plaintext `teacherPin` in it (keep only server-side hashes) and never return it.
2. Add a versioned migration enabling RLS on `public.published_quizzes` (`is_authenticated_teacher()` only), revoking `anon SELECT`; expose a narrow RPC `get_quiz_public_meta(p_code)` returning presentation metadata only if pre-lobby lookup needs it.
3. Rotate every existing PIN — they must be assumed disclosed.

---

### SEC-02 — Question papers are publicly downloadable (Informational → Intended by design)

The Source PDF Manager (`uploadPastPaperPdf` in `src/services/storageService.ts`) attempts Cloudflare R2 first and falls back to the **public** `exam-diagrams` Supabase bucket (and `worker/index.js` serves R2 `GET` requests publicly).

**Evidence**

```
POST /storage/v1/object/list/exam-diagrams  {"prefix":"papers/"}   → 58 objects
     papers/0620_2023_Oct_Nov_qp_11.pdf, …qp_12.pdf, …qp_13.pdf
POST /storage/v1/object/list/exam-diagrams  {"prefix":"diagrams/"} → 541 objects
GET  /storage/v1/object/public/exam-diagrams/papers/0620_2023_Oct_Nov_qp_11.pdf
     → HTTP 200 · 299 KB · application/pdf
```

Mark-scheme PDFs are **not** in the bucket (`prefix "ms/"` → 0 objects). Public downloadability of past Question Papers is **intentional** (for revision & Table of Specifications citation links), so no read-access restriction is needed; only anonymous **write/upload** permissions remain in scope under `SEC-08`.

---

### SEC-03 — Gemini API key is in the JavaScript bundle (Critical, Open)

`src/lib/gemini.ts` reads `import.meta.env.VITE_GEMINI_API_KEY` (as well as `VITE_GEMINI_PAID_API_KEY`, `VITE_GEMINI_FREE_API_KEY`, `VITE_GEMINI_API_KEY_2`, and `VITE_GEMINI_API_KEYS`); Vite inlines those `VITE_*` values at build time. The full key string is compiled into client chunks.

**Evidence**

```
Full API key compiled into client JS chunks when set at build time (`gemini-*.js`, `index-*.js`)
External use: requests to generativelanguage.googleapis.com made from Node (no Referer)
succeeded → the key is not restricted to your web origin
```

**Impact** Anyone can lift the key from page source and spend your quota, or use the project for their own prompts. The `gemini_api_key_cloudflare_proxy.md` plan exists and `worker/index.js` already implements `POST /api/gemini/generate`, but the client still hits `generativelanguage.googleapis.com` directly (the worker is only called for `/api/gemini/ping`), and the worker's `/api/gemini/generate` route currently enforces no teacher/session authentication or origin allowlist.

**Decision & Remediation**
- **Product decision:** Practice Mode student evaluations will use **local deterministic grading only** (via the existing `rule_fallback` path in `StudentQuizRunner.tsx`), so AI API calls are needed **only by signed-in teachers**.
1. **Rotate the key now** — treat it as public.
2. Route all teacher Gemini calls through the Cloudflare worker (`/api/gemini/generate`) per the existing plan, and enforce verified `x-teacher-session` authentication, CORS origin allowlisting, and rate limiting inside `worker/index.js`; keep API keys only in worker secrets.
3. Remove the client `VITE_GEMINI_*` fallback entirely for hosted builds; keep it behind a dev-only flag.
4. Add an HTTP-referrer + API restriction on the Google key as a belt-and-braces measure while (1)–(3) land.

---

### SEC-04 — R2 uploader secret is hardcoded and shipped (Critical, Open)

The R2 upload shared secret is a literal, duplicated across source and worker fallback, and it is compiled into the bundle. Additionally, `worker/index.js`'s `/api/generate-diagram` route accepts any non-empty `cf-turnstile-token` header (`Boolean(turnstileHeader)`) without verifying it with Cloudflare's `siteverify` API.

**Evidence**

```
src/lib/settings.ts:86                   r2UploadSecret: '<hardcoded default>'
src/services/storageService.ts:11        const DEFAULT_R2_SECRET = '<same literal>'
src/pages/AdvancedSettingsPage.tsx:134   fallback to '<same literal>'
worker/index.js:277,414                  expectedSecret = env.UPLOAD_SECRET || '<same literal>'
dist: literal present in AdvancedSettingsPage-*.js, gemini-*.js, and storageService-*.js
```

**Impact** With the secret (or a dummy `cf-turnstile-token` header on `/api/generate-diagram`) and the worker's `Access-Control-Allow-Origin: *` policy, anyone can push arbitrary files into the public media bucket — phishing pages or malware hosted on the school's own media domain, plus storage-cost abuse.

**Remediation**
1. Rotate `UPLOAD_SECRET` in the worker; remove every hardcoded fallback in client source and `worker/index.js`.
2. Require the admin secret only server-side; never send it to the browser. Uploads from the teacher UI should verify the teacher session or mint a short-lived signed upload URL via an authenticated RPC/worker call, and verify Turnstile tokens server-side via `siteverify`.
3. Restrict the worker upload/AI routes by method, origin allowlist, and rate limit.

---

### SEC-05 — Published-quiz catalogue is enumerable (High, Open)

```
GET /rest/v1/published_quizzes?select=id,quiz_code,title,subject,is_active,data&limit=5 → 5 rows
```

Every published quiz's code, title, subject, active flag, duration, question count and security settings are readable. This leaks the exam schedule and the codes for papers not yet sat — a student can look up an upcoming paper's code ahead of time (and with SEC-01, its PIN).

**Remediation** Revoke anon SELECT; students should resolve a code through an RPC that returns only presentation data and requires the exact code as input (no listing).

---

### SEC-06 — Pilot exam answers are in the bundle (High, Open)

`src/data/pilotExam170Data.ts` embeds `mark_scheme.marking_points` and `acceptable_answers` (e.g. `'A'`, `'C'`, `'375,000 J'`) and `PILOT_TEACHER_PIN` for the 170-student pilot, and because it is statically imported by `quizCodeService.ts`, `quizManagerService.ts`, and `testBuilderService.ts`, it compiles into the main `index-*.js` bundle (`public/pilot_exam_170_package.json` itself already omits answer keys and PINs).

**Impact** Limited to the pilot exam, but for that exam the answers are public to any candidate who reads the bundle.

**Decision & Remediation** Since **`ICM170` is already live in Supabase**, remove the hardcoded question answers and `PILOT_TEACHER_PIN` fallback from `src/data/pilotExam170Data.ts` (keeping only non-sensitive metadata/IDs on the client, or resolving live via `get_student_exam_paper`).

---

### SEC-07 — Teacher password hashing is fast (Medium, Open)

`login_teacher_account` stores `v_salt || ':' || SHA256(salt || '::' || password)` (migration 021 deliberately avoided `pgcrypto`). Salted SHA-256 is a fast hash: if `teacher_profiles` ever leaks, GPU cracking is cheap.

**Remediation** Enable `pgcrypto`, migrate to bcrypt (`crypt(password, gen_salt('bf'))` — schema-qualified if installed under `extensions` since auth RPCs set `search_path = public`), and rehash transparently on next successful login.

---

### SEC-08 — Storage INSERT policy may allow anonymous uploads (Medium, verify)

`supabase/storage_setup.md` defines:

```sql
CREATE POLICY "Service role upload for exam diagrams"
ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'exam-diagrams');
```

There is no `TO` clause, so the policy applies to `PUBLIC` — `anon` included. That grants anonymous upload into the bucket if the policy is still active in the project.

**Remediation** Restrict to authenticated uploads via backend/service role (`... FOR INSERT TO service_role ...`) and verify live policies with:

```sql
SELECT policyname, roles, cmd FROM pg_policies WHERE schemaname='storage' AND tablename='objects';
```

---

### SEC-09 — Pre-start exam identity is name-based when PINs are disabled (Medium, Partially Mitigated by 024)

As of Migration 024, active sessions are protected by `exam_draft_locks.owner_token_hash` (blocking cross-device draft overwrites and hijack submissions with SQLSTATE `42501`) and `verify_roster_pin_if_enrolled` when `requireStudentPin` is enabled. However, when `requireStudentPin = false` and before the real candidate acquires a draft lock, a classmate can still submit first under someone else's name (`student_name` + `quiz_code`) and consume their single-attempt slot.

**Remediation** Enforce `requireStudentPin = true` with school roster PINs for high-stakes sittings, or pre-issue per-candidate one-time exam codes server-side (note: a token returned by anonymous `get_student_exam_paper` alone does not prevent pre-start impersonation).

---

### SEC-10 — `access_pin` was seeded with RLS disabled (Low, historical)

Migration `004_app_config.sql` runs `ALTER TABLE app_config DISABLE ROW LEVEL SECURITY;` and seeds a plaintext school access PIN. Migration 021 re-enables RLS with an 8-key anon allow-list, which is why the PIN is no longer readable today.

**Risk** Any environment that replays migrations 004–020 without 021 exposes the PIN **and** allows anonymous writes to `app_config` (including security tiers). Make 021+ mandatory when provisioning.

---

### SEC-11 — `teacherPinHash` leak (High → Fixed, verified)

`phase3_deep_security_hardening_plan.md` (VULN-P3-03) flagged `sha256(CODE::PIN)` in the student payload as offline-crackable. Live check today:

```
POST /rest/v1/rpc/get_student_exam_paper {"p_code": "…"} → teacherPinHash: null
```

The RPC still returns the key, but its value is `null` — the vector is closed. Migration 024 covers this; no action needed beyond keeping it null.

---

### SEC-12 — Anon database dump (Critical → Fixed, verified)

| Table | 2026-11-06 | 2026-11-16 |
| :--- | :--- | :--- |
| `questions` | 1,959 rows (incl. `mark_scheme`) | 0 rows |
| `custom_tests` | readable | 0 rows |
| `quiz_submissions` | readable | 0 rows |
| `teacher_profiles` | readable | 0 rows |
| `proctor_audit_events` | readable | 0 rows |
| `game_profiles` | — | HTTP 401 |
| `app_config` | all keys | 6 public UI keys only |

The student exam path now goes through the `SECURITY DEFINER` `get_student_exam_paper` RPC, which strips answer keys server-side. Exam-mode submissions force `score := 0` server-side and reject client score claims (migration 022) — score forgery is not possible.

---

## 4. Remediation Plan (ordered)

| Step | Action | Closes | Effort |
| :--- | :--- | :--- | :--- |
| 1 | **Rotate** the Gemini keys and the R2 `UPLOAD_SECRET`; revoke old values | SEC-03, SEC-04 | Minutes |
| 2 | Add migration locking `public.published_quizzes` via RLS (`is_authenticated_teacher()`); strip `teacherPin`; rotate all existing PINs | SEC-01, SEC-05 | ~half day |
| 3 | Route teacher Gemini calls through `worker/index.js` (`/api/gemini/generate`) with `x-teacher-session` auth, origin allowlist, and rate limit; Practice Mode uses deterministic grading only; delete client `VITE_GEMINI_*` fallback in hosted builds | SEC-03 | Follow [gemini_api_key_cloudflare_proxy.md](./gemini_api_key_cloudflare_proxy.md) + Worker Auth |
| 4 | Remove hardcoded R2 upload secret from client & `worker/index.js`; enforce `x-teacher-session` + real Turnstile `siteverify` on worker uploads/diagram generation; scope Supabase storage `INSERT` to `service_role` | SEC-04, SEC-08 | ~half day |
| 5 | Remove `ICM170` pilot answers and `PILOT_TEACHER_PIN` from `src/data/pilotExam170Data.ts` (`ICM170` already served live from Supabase) | SEC-06 | ~half day |
| 6 | `pgcrypto` bcrypt for teacher passwords (transparent upgrade on next login) | SEC-07 | ~half day |
| 7 | Defer / Discuss later: enforce `requireStudentPin` / pre-issued per-student codes for high-stakes sittings | SEC-09 | Deferred |

---

## 5. Verification & Testing Strategy

Re-run these after each fix. All are read-only and use only the public anon key.

```powershell
$P = (Select-String .env.local -Pattern '^VITE_SUPABASE_ANON_KEY=' ).Line -replace '^VITE_SUPABASE_ANON_KEY=',''
$U = (Select-String .env.local -Pattern '^VITE_SUPABASE_URL='     ).Line -replace '^VITE_SUPABASE_URL=',''
$H = @{ apikey = $P; Authorization = "Bearer $P" }

# SEC-01 / SEC-05 — must return 0 rows (or 401) after the fix
Invoke-RestMethod "$U/rest/v1/published_quizzes?select=quiz_code,data&limit=1" -Headers $H

# SEC-12 — must stay at 0 rows
Invoke-RestMethod "$U/rest/v1/questions?select=id&limit=1" -Headers $H
```

```powershell
# SEC-03 / SEC-04 — bundle must not contain any VITE_GEMINI_* key or R2 secret
$keys = (Select-String .env.local -Pattern '^VITE_GEMINI_[^=]+=').Line | ForEach-Object { ($_ -split '=', 2)[1].Trim() } | Where-Object { $_ }
foreach ($k in $keys) {
  Get-ChildItem dist -Recurse -Include *.js | Where-Object { [IO.File]::ReadAllText($_.FullName).Contains($k) }
}
Get-ChildItem dist -Recurse -Include *.js | Where-Object { [IO.File]::ReadAllText($_.FullName).Contains('<R2 secret literal>') }
# Both checks must return nothing.
```

Pass criteria: `published_quizzes` and `questions` return zero rows or 4xx, neither credential nor pilot answers appear in `dist/`, and `pg_policies` for `storage.objects` (`SEC-08`) lists no policy granting `INSERT` to `public`/`anon`.

---

## 6. Appendix — Audit Notes

- The audit deliberately did **not** attempt writes, sign-in bypasses on live accounts, or reads of identifiable student data. Row counts only.
- `dist/` reflects the last local build (v2.5.x); the deployed bundle should be re-checked after the next deploy, since it is what students actually download.
- `SEC-02` (public read access to Question Paper PDFs) is intentional by design and marked **Accepted**. Active open priorities are SEC-01/03/04/05/06/07/08 (`SEC-09` deferred for later discussion).
