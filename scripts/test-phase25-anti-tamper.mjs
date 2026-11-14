import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`✅ ${label}`);
    passed++;
  } else {
    console.error(`❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const migration022 = fs.readFileSync(
  path.resolve('supabase/migrations/022_exam_anti_tamper_and_rate_guards.sql'),
  'utf8'
);

check(
  '1. Migration 022 fixes app_config.updated_at schema error in save_student_exam_draft',
  migration022.includes('INSERT INTO public.app_config (key, value)') &&
    !migration022.includes('INSERT INTO public.app_config (key, value, updated_at)')
);

check(
  '2. Migration 022 adds exam_draft_locks table, drops overloaded draft signatures, and caps payloads at 256 KB',
  migration022.includes('CREATE TABLE IF NOT EXISTS public.exam_draft_locks') &&
    migration022.includes('REVOKE ALL ON public.exam_draft_locks FROM anon, authenticated;') &&
    migration022.includes('DROP FUNCTION IF EXISTS public.save_student_exam_draft(TEXT, TEXT);') &&
    migration022.includes('DROP FUNCTION IF EXISTS public.get_student_exam_draft(TEXT);') &&
    migration022.includes('DROP FUNCTION IF EXISTS public.delete_student_exam_draft(TEXT);') &&
    migration022.includes('OCTET_LENGTH(COALESCE(p_value, \'\')) > 262144')
);

check(
  '3. Migration 022 zeroes client-claimed Exam Mode scores, rejects forged out-of-range claims, enforces single-attempt lock, and blocks blank-PIN overwrites',
  migration022.includes('v_score := 0;') &&
    migration022.includes('v_percentage := 0;') &&
    migration022.includes("COALESCE(NULLIF(p_row->>'teacher_adjusted_marks', '')::numeric, 0) <> 0") &&
    migration022.includes('IF v_limit_one_attempt AND v_norm_name <> \'\' THEN') &&
    migration022.includes('AND NULLIF(TRIM(public.quiz_submissions.result_pin), \'\') IS NOT NULL') &&
    migration022.includes('GET DIAGNOSTICS v_affected = ROW_COUNT;')
);

check(
  '4. Migration 022 exposes allowStudentScriptDownload from lookup_student_exam_result',
  migration022.includes("'allowStudentScriptDownload', v_allow_download")
);

check(
  '5. Migration 022 upgrades get_student_exam_paper to set-based unnest + LEFT JOIN with safe CASE UUID cast',
  migration022.includes('FROM unnest(v_qids) WITH ORDINALITY') &&
    migration022.includes('LEFT JOIN public.questions q') &&
    migration022.includes('CASE') &&
    migration022.includes('ELSE NULL')
);

check(
  '6. Migration 022 enforces proctor_audit_events size and per-student rate limits via BEFORE INSERT trigger',
  migration022.includes('CREATE OR REPLACE FUNCTION public.enforce_proctor_audit_guard()') &&
    migration022.includes('CREATE TRIGGER trg_enforce_proctor_audit_guard') &&
    migration022.includes('1024') &&
    migration022.includes('v_recent_count >= 60')
);

const examDraftTs = fs.readFileSync(path.resolve('src/services/examDraftService.ts'), 'utf8');
check(
  '7. Client examDraftService.ts resolves per-student draft owner tokens and falls back cleanly',
  examDraftTs.includes('resolveDraftOwnerToken') &&
    examDraftTs.includes('p_owner_token: ownerToken') &&
    examDraftTs.includes('LOCAL_DRAFT_SECRET_PREFIX')
);

const subServiceTs = fs.readFileSync(path.resolve('src/services/quizSubmissionService.ts'), 'utf8');
const resultModalTsx = fs.readFileSync(path.resolve('src/components/StudentResultModal.tsx'), 'utf8');
check(
  '8. Client fetchStudentResultsCloud & StudentResultModal read allowStudentScriptDownload from lookup RPC',
  subServiceTs.includes('allowStudentScriptDownload?: boolean') &&
    subServiceTs.includes('data.allowStudentScriptDownload') &&
    resultModalTsx.includes('rpcAllowScriptDownload')
);

const runnerTsx = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');
check(
  '9. Crash/shutdown draft persistence: keepalive exit flush + decoupled 25s interval + 2.5s edit debounce',
  examDraftTs.includes('keepalive: true') &&
    runnerTsx.includes("window.addEventListener('beforeunload', flushOnExit)") &&
    runnerTsx.includes("window.addEventListener('pagehide', flushOnExit)") &&
    runnerTsx.includes('flushCloudDraftRef.current(true)') &&
    runnerTsx.includes('flushCloudDraftRef.current(false)') &&
    runnerTsx.includes('25000')
);

assert.equal(failed, 0, `${failed} check(s) failed`);
console.log(`\nPassed ${passed}/${passed} checks.`);

