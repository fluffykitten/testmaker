import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  TEACHER_SESSION_TOKEN_KEY,
  getActiveTeacherSessionToken,
  hasActiveTeacherSession,
} from '../src/lib/supabase.ts';
import {
  ACTIVE_PROFILE_KEY,
  CACHED_PROFILES_KEY,
  upsertAuthenticatedTeacherProfile,
} from '../src/services/teacherProfileService.ts';

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

// 1. Migration 021 SQL schema, RPCs & RLS verification
const migration021 = fs.readFileSync(
  path.resolve('supabase/migrations/021_phase2_teacher_login_rls_and_exam_rpcs.sql'),
  'utf8'
);

check(
  '1. Migration 021 extends teacher_profiles with auth columns and unique email/username indexes',
  migration021.includes('ALTER TABLE public.teacher_profiles') &&
    migration021.includes('email TEXT') &&
    migration021.includes('username TEXT') &&
    migration021.includes('password_hash TEXT') &&
    migration021.includes('idx_teacher_profiles_email_unique') &&
    migration021.includes('idx_teacher_profiles_username_unique')
);

check(
  '2. Migration 021 creates teacher_auth_sessions with RLS locked and REVOKE ALL from anon/authenticated',
  migration021.includes('CREATE TABLE IF NOT EXISTS public.teacher_auth_sessions') &&
    migration021.includes('ALTER TABLE public.teacher_auth_sessions ENABLE ROW LEVEL SECURITY;') &&
    migration021.includes('REVOKE ALL ON public.teacher_auth_sessions FROM anon, authenticated;')
);

check(
  '3. Migration 021 defines is_authenticated_teacher() checking auth.role() or SHA-256 x-teacher-session',
  migration021.includes('CREATE OR REPLACE FUNCTION public.is_authenticated_teacher()') &&
    migration021.includes("auth.role() = 'authenticated'") &&
    migration021.includes("x-teacher-session") &&
    migration021.includes('SHA256(')
);

check(
  '4. Migration 021 defines all 4 teacher authentication RPCs (login, register/claim, reset, logout)',
  migration021.includes('CREATE OR REPLACE FUNCTION public.login_teacher_account') &&
    migration021.includes('CREATE OR REPLACE FUNCTION public.register_or_claim_teacher_account') &&
    migration021.includes('CREATE OR REPLACE FUNCTION public.reset_teacher_password_with_master_pin') &&
    migration021.includes('CREATE OR REPLACE FUNCTION public.logout_teacher_session') &&
    migration021.includes('public.verify_teacher_access_pin(p_master_pin)')
);

check(
  '5. Migration 021 defines server-side question sanitization and get_student_exam_paper RPC',
  migration021.includes('CREATE OR REPLACE FUNCTION public.sanitize_question_json_for_student') &&
    migration021.includes('CREATE OR REPLACE FUNCTION public.strip_data_tables_expected_answers') &&
    migration021.includes('CREATE OR REPLACE FUNCTION public.get_student_exam_paper') &&
    migration021.includes("- 'source_pdf_url' - 'metadata'") &&
    migration021.includes('quiz_by_code_') &&
    migration021.includes('custom_test_header_')
);

check(
  '6. Migration 021 defines draft_* scoped RPCs, submit_student_exam_attempt, and download-gated lookup_student_exam_result',
  migration021.includes('CREATE OR REPLACE FUNCTION public.save_student_exam_draft') &&
    migration021.includes('CREATE OR REPLACE FUNCTION public.get_student_exam_draft') &&
    migration021.includes('CREATE OR REPLACE FUNCTION public.delete_student_exam_draft') &&
    migration021.includes("p_key NOT LIKE 'draft_%'") &&
    migration021.includes('CREATE OR REPLACE FUNCTION public.submit_student_exam_attempt') &&
    migration021.includes('CREATE OR REPLACE FUNCTION public.lookup_student_exam_result') &&
    migration021.includes("- 'questionText' - 'correctAnswer' - 'criteriaBreakdown'")
);

const rlsTables = [
  'syllabuses',
  'questions',
  'custom_tests',
  'app_config',
  'quiz_submissions',
  'teacher_profiles',
  'proctor_audit_events',
];
check(
  '7. Migration 021 enables strict RLS on all 7 workspace tables and drops legacy policies',
  rlsTables.every((t) => migration021.includes(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`)) &&
    migration021.includes('FROM pg_policies') &&
    migration021.includes('Public read non-sensitive ui app_config') &&
    migration021.includes('Student insert audit events only')
);

// 2. Client plumbing & runtime checks
const supabaseTs = fs.readFileSync(path.resolve('src/lib/supabase.ts'), 'utf8');
check(
  '8. src/lib/supabase.ts injects x-teacher-session via custom fetch and guards sessionStorage for Node',
  supabaseTs.includes("headers.set('x-teacher-session', token)") &&
    supabaseTs.includes('TEACHER_SESSION_TOKEN_KEY') &&
    supabaseTs.includes('hasActiveTeacherSession')
);

assert.equal(getActiveTeacherSessionToken(), '');
assert.equal(hasActiveTeacherSession(), false);
check('9. hasActiveTeacherSession() safely returns false when sessionStorage is unavailable in Node', true);

// Test runtime session & profile hash scrubbing with simulated browser storage
const mockSession = new Map();
const mockLocal = new Map();
globalThis.sessionStorage = {
  getItem: (k) => mockSession.get(k) ?? null,
  setItem: (k, v) => mockSession.set(k, String(v)),
  removeItem: (k) => mockSession.delete(k),
};
globalThis.localStorage = {
  getItem: (k) => mockLocal.get(k) ?? null,
  setItem: (k, v) => mockLocal.set(k, String(v)),
  removeItem: (k) => mockLocal.delete(k),
};

const savedProfile = upsertAuthenticatedTeacherProfile(
  {
    id: 'teacher-test-uuid',
    name: 'Dr. Budi Santoso',
    title: 'Dr.',
    email: 'budi@icm.sch.id',
    username: 'dr.budi',
    role: 'teacher',
    has_password: true,
    subject: 'Chemistry',
    subject_code: '0620',
    pin_hash: 'secret-should-be-stripped',
    password_hash: 'salt:secret-should-be-stripped',
    default_classes: ['10-A'],
    preferences: {
      autoEnablePeriodicTable: true,
      defaultCalculator: 'scientific',
      showOtherSubjects: false,
    },
    created_at: new Date().toISOString(),
  },
  'test-session-token-123'
);

assert.equal(hasActiveTeacherSession(), true);
assert.equal(mockSession.get(TEACHER_SESSION_TOKEN_KEY), 'test-session-token-123');
assert.equal(mockLocal.get(ACTIVE_PROFILE_KEY), 'teacher-test-uuid');
const cachedJson = mockLocal.get(CACHED_PROFILES_KEY) || '';
assert.equal(savedProfile.pin_hash, null);
assert.equal(cachedJson.includes('secret-should-be-stripped'), false);
assert.equal(cachedJson.includes('password_hash'), false);
check('10. upsertAuthenticatedTeacherProfile activates workspace, stores token, and strips pin/password hashes', true);

// Clear mock sessionStorage before inspecting source files
mockSession.clear();
mockLocal.clear();

// 3. Teacher service, context, PinGate UI & App sign-out wiring
const teacherServiceTs = fs.readFileSync(path.resolve('src/services/teacherProfileService.ts'), 'utf8');
const contextTsx = fs.readFileSync(path.resolve('src/contexts/TeacherProfileContext.tsx'), 'utf8');
const pinGateTsx = fs.readFileSync(path.resolve('src/components/PinGate.tsx'), 'utf8');
const appTsx = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');

check(
  '11. teacherProfileService.ts provides login/register/reset/logout RPCs and gates cloud fetch on hasActiveTeacherSession()',
  teacherServiceTs.includes(".rpc('login_teacher_account'") &&
    teacherServiceTs.includes(".rpc('register_or_claim_teacher_account'") &&
    teacherServiceTs.includes(".rpc('reset_teacher_password_with_master_pin'") &&
    teacherServiceTs.includes(".rpc('logout_teacher_session'") &&
    teacherServiceTs.includes('if (hasActiveTeacherSession())')
);

check(
  '12. TeacherProfileContext.tsx reloads profiles on teacher_session_authenticated event',
  contextTsx.includes('teacher_session_authenticated')
);

check(
  '13. PinGate.tsx implements unified 3-view Educator Login (signin, register/claim with Master PIN, reset) & Turnstile check',
  pinGateTsx.includes('loginTeacherAccount') &&
    pinGateTsx.includes('registerOrClaimTeacherAccount') &&
    pinGateTsx.includes('resetTeacherPasswordWithMasterPin') &&
    pinGateTsx.includes('upsertAuthenticatedTeacherProfile') &&
    pinGateTsx.includes('verifyTurnstileToken') &&
    pinGateTsx.includes('setup_required')
);

check(
  '14. App.tsx revokes server session and clears TEACHER_SESSION_TOKEN_KEY on handleLockApp',
  appTsx.includes('logoutTeacherSession') && appTsx.includes('TEACHER_SESSION_TOKEN_KEY')
);

// 4. Student services RPC wiring
const quizCodeTs = fs.readFileSync(path.resolve('src/services/quizCodeService.ts'), 'utf8');
const draftTs = fs.readFileSync(path.resolve('src/services/examDraftService.ts'), 'utf8');
const submissionTs = fs.readFileSync(path.resolve('src/services/quizSubmissionService.ts'), 'utf8');

check(
  '15. quizCodeService.ts fetches unauthenticated student exams via get_student_exam_paper RPC',
  quizCodeTs.includes(".rpc('get_student_exam_paper'") && quizCodeTs.includes('hasActiveTeacherSession()')
);

check(
  '16. examDraftService.ts uses save/get/delete_student_exam_draft RPCs',
  draftTs.includes(".rpc('save_student_exam_draft'") &&
    draftTs.includes(".rpc('get_student_exam_draft'") &&
    draftTs.includes(".rpc('delete_student_exam_draft'")
);

check(
  '17. quizSubmissionService.ts uses submit_student_exam_attempt RPC for students and blocks app_config mirror writes',
  submissionTs.includes(".rpc('submit_student_exam_attempt'") &&
    submissionTs.includes('if (!tableSuccess && hasActiveTeacherSession())')
);

const settingsTs = fs.readFileSync(path.resolve('src/lib/settings.ts'), 'utf8');
const advSettingsTsx = fs.readFileSync(path.resolve('src/pages/AdvancedSettingsPage.tsx'), 'utf8');
check(
  '18. Account claiming is disabled by default and gated via Admin Settings + Migration 021 + PinGate',
  settingsTs.includes('allowTeacherAccountClaiming: false') &&
    migration021.includes("'allow_teacher_account_claiming'") &&
    advSettingsTsx.includes('handleToggleTeacherAccountClaiming') &&
    pinGateTsx.includes('allowAccountClaiming &&')
);

console.log(`\nPhase 2 Auth/RLS/RPC Verification Summary: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}

