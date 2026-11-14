import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const memLocal = new Map();
const memSession = new Map();
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (k) => (memLocal.has(k) ? memLocal.get(k) : null),
    setItem: (k, v) => memLocal.set(k, String(v)),
    removeItem: (k) => memLocal.delete(k),
    clear: () => memLocal.clear(),
  };
}
if (!globalThis.sessionStorage) {
  globalThis.sessionStorage = {
    getItem: (k) => (memSession.has(k) ? memSession.get(k) : null),
    setItem: (k, v) => memSession.set(k, String(v)),
    removeItem: (k) => memSession.delete(k),
    clear: () => memSession.clear(),
  };
}
if (!globalThis.window) {
  globalThis.window = {
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { origin: 'http://localhost', href: 'http://localhost/' },
  };
}

const { generateResultPin } = await import('../src/services/quizSubmissionService.ts');
const {
  computeStudentHeartbeatKey,
  getActiveStudentHeartbeatProof,
  getDraftLockCredentials,
} = await import('../src/services/examDraftService.ts');
const { verifyAndBindStudentHeartbeatProof } = await import('../src/lib/proctorGuards.ts');
const {
  generateProctorSigningSession,
  signGameBroadcastFrame,
  verifyGameBroadcastFrame,
} = await import('../src/lib/proctorCommandAuth.ts');

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

const mig024 = fs.readFileSync(
  path.resolve('supabase/migrations/024_phase3_deep_rls_ratelimit_and_game_security.sql'),
  'utf8'
);
const quizCodeSrc = fs.readFileSync(path.resolve('src/services/quizCodeService.ts'), 'utf8');
const gameProfileSrc = fs.readFileSync(path.resolve('src/services/gameProfileService.ts'), 'utf8');
const gameRtSrc = fs.readFileSync(path.resolve('src/services/gameRealtimeService.ts'), 'utf8');
const gameRunnerSrc = fs.readFileSync(path.resolve('src/pages/GameQuizRunner.tsx'), 'utf8');
const submissionSrc = fs.readFileSync(path.resolve('src/services/quizSubmissionService.ts'), 'utf8');
const studentRunnerSrc = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');
const invigilatorSrc = fs.readFileSync(path.resolve('src/components/LiveInvigilatorModal.tsx'), 'utf8');
const diagSrc = fs.readFileSync(path.resolve('scripts/diagnose-proctoring-system.mjs'), 'utf8');

// ── P3-T3: Strip teacherPinHash from get_student_exam_paper ────────────────
check(
  'P3-T3a: Migration 024 zeroes out teacherPinHash inside get_student_exam_paper',
  /'teacherPinHash',\s*NULL/i.test(mig024) &&
    /CREATE OR REPLACE FUNCTION public\.get_student_exam_paper/i.test(mig024)
);
check(
  'P3-T3b: quizCodeService clears teacherPinHash when building quiz paper from live RPC',
  /teacherPinHash:\s*''/.test(quizCodeSrc) &&
    /rawPinExposed\s*\|\|\s*hasPinHashInPaper/.test(diagSrc)
);

// ── P3-T4: game_profiles RLS, pin_hash redaction & bounded rewards ─────────
check(
  'P3-T4a: Migration 024 enables strict RLS on public.game_profiles and revokes anon table grants',
  /ALTER TABLE public\.game_profiles ENABLE ROW LEVEL SECURITY/i.test(mig024) &&
    /REVOKE ALL ON TABLE public\.game_profiles FROM anon, authenticated/i.test(mig024) &&
    /CREATE POLICY "Teacher full access game_profiles"/i.test(mig024)
);
check(
  'P3-T4b: Migration 024 strips pin_hash from game profile RPC JSON payloads',
  /to_jsonb\(v_profile\)\s*-\s*'pin_hash'/i.test(mig024) &&
    /CREATE OR REPLACE FUNCTION public\.update_game_profile_student/i.test(mig024)
);
check(
  'P3-T4c: Migration 024 enforces server-side caps on coins (<=500) and XP (<=1000)',
  /LEAST\(GREATEST\(COALESCE\(p_coins,\s*0\),\s*0\),\s*500\)/.test(mig024) &&
    /LEAST\(GREATEST\(COALESCE\(p_xp,\s*0\),\s*0\),\s*1000\)/.test(mig024) &&
    /COALESCE\(p_coins,\s*0\)\s*<\s*0/.test(mig024)
);

const studentGameBlock = gameProfileSrc.slice(
  gameProfileSrc.indexOf('export async function loginGameProfile'),
  gameProfileSrc.indexOf('export async function fetchClassGameProfiles')
);
const studentMutationsUseRpcsOnly =
  studentGameBlock.length > 0 &&
  /auth_game_profile/.test(studentGameBlock) &&
  /update_game_profile_student/.test(studentGameBlock) &&
  /sync_game_match_rewards/.test(studentGameBlock) &&
  !/\.from\('game_profiles'/.test(studentGameBlock);
check(
  'P3-T4d: gameProfileService delegates student auth/profile/rewards exclusively through RPCs',
  studentMutationsUseRpcsOnly
);

// ── P3-T5: Rate limiting, teacher reset gate & 6-digit CSPRNG result PIN ──
check(
  'P3-T5a: Migration 024 creates security_rate_limits and rate-limits all auth/PIN/result RPCs',
  /CREATE TABLE IF NOT EXISTS public\.security_rate_limits/i.test(mig024) &&
    /CREATE OR REPLACE FUNCTION public\.check_rate_limit/i.test(mig024) &&
    /check_rate_limit\(v_scope,\s*5,\s*900\)/.test(mig024) &&
    /check_rate_limit\(v_scope,\s*8,\s*600\)/.test(mig024) &&
    /check_rate_limit\(v_scope,\s*10,\s*600\)/.test(mig024)
);
check(
  'P3-T5b: reset_teacher_password_with_master_pin is gated by allow_teacher_account_claiming or teacher session',
  /CREATE OR REPLACE FUNCTION public\.reset_teacher_password_with_master_pin/i.test(mig024) &&
    /allow_teacher_account_claiming/.test(mig024) &&
    /Master PIN password resets are disabled while account claiming is locked/i.test(mig024)
);

const generatedPins = Array.from({ length: 25 }, () => generateResultPin());
check(
  'P3-T5c: generateResultPin generates 6-digit CSPRNG PINs in [100000, 999999]',
  generatedPins.every((pin) => /^[1-9]\d{5}$/.test(pin)) && new Set(generatedPins).size > 15
);

// ── P3-T6: Student identity & draft-lock binding on exam submission ────────
check(
  'P3-T6a: Migration 024 adds verify_roster_pin_if_enrolled and enforces draft lock owner_token_hash in submit_student_exam_attempt',
  /CREATE OR REPLACE FUNCTION public\.verify_roster_pin_if_enrolled/i.test(mig024) &&
    /v_owner_token_hash <> v_lock_hash/.test(mig024) &&
    /Active exam session belongs to another device/i.test(mig024)
);
check(
  'P3-T6b: quizSubmissionService attaches draft_key, draft_owner_token & student_pin and halts fallback on 42501 conflict',
  /draft_key:\s*lockCreds\.draftKey/.test(submissionSrc) &&
    /draft_owner_token:\s*lockCreds\.ownerToken/.test(submissionSrc) &&
    /errCode === '42501'/.test(submissionSrc) &&
    /studentPin:\s*studentPinInput\s*\|\|\s*undefined/.test(studentRunnerSrc)
);

// ── P3-T8: Game paper sanitization, answer-check RPC & signed host frames ──
check(
  'P3-T8a: Migration 024 strips game answer keys in get_student_exam_paper and provides check_game_question_answer',
  /CREATE OR REPLACE FUNCTION public\.get_student_game_paper/i.test(mig024) &&
    /CREATE OR REPLACE FUNCTION public\.check_game_question_answer/i.test(mig024) &&
    /LOWER\(COALESCE\(v_quiz->>'quizMode',\s*''\)\)\s*=\s*'game'/.test(mig024) &&
    /check_game_question_answer/.test(gameRunnerSrc)
);
check(
  'P3-T8b: gameRealtimeService registers ephemeral host keys and signs/verifies game broadcasts',
  /register_proctor_public_key/.test(gameRtSrc) &&
    /signGameBroadcastFrame/.test(gameRtSrc) &&
    /verifyGameBroadcastFrame/.test(gameRtSrc)
);

const hostKeys = await generateProctorSigningSession();
assert(Boolean(hostKeys), 'WebCrypto P-256 signing session must initialize');
const resolver = async (quizCode, keyId) => {
  if (quizCode === 'GAME42' && keyId === hostKeys.keyId) {
    return { found: true, publicJwk: hostKeys.publicJwk };
  }
  return { found: false };
};

const signedReveal = await signGameBroadcastFrame(hostKeys, 'GAME42', {
  type: 'answer_reveal',
  questionIndex: 2,
  correctAnswer: 'B',
  distribution: { B: 14 },
});
assert(Boolean(signedReveal.sig && signedReveal.keyId), 'Signed host game frame must carry sig and keyId');

const validVerify = await verifyGameBroadcastFrame(signedReveal, 'GAME42', resolver);
const tamperedVerify = await verifyGameBroadcastFrame(
  { ...signedReveal, correctAnswer: 'D' },
  'GAME42',
  resolver
);
const wrongQuizVerify = await verifyGameBroadcastFrame(signedReveal, 'OTHER99', resolver);
const unsignedVerify = await verifyGameBroadcastFrame(
  { type: 'answer_reveal', questionIndex: 2, correctAnswer: 'C', distribution: {} },
  'GAME42',
  resolver
);

check(
  'P3-T8c: verifyGameBroadcastFrame accepts authentic signed frames and rejects tampered, cross-quiz & unsigned frames',
  validVerify.status === 'valid' &&
    tamperedVerify.status === 'invalid' &&
    wrongQuizVerify.status === 'invalid' &&
    unsignedVerify.status === 'invalid'
);

// ── P3-T10: Student proctor heartbeat proof binding & anti-spoofing ────────
const credA = getDraftLockCredentials('BIO101', 'Alice Tan', '1234');
const credB = getDraftLockCredentials('BIO101', 'Bob Lim', '5678');
const proofA = await getActiveStudentHeartbeatProof('BIO101', 'Alice Tan', '1234');
const keyB = await computeStudentHeartbeatKey('BIO101', credB.draftKey, credB.ownerToken);

assert.equal(proofA.draftKey, credA.draftKey);
assert.notEqual(proofA.heartbeatKey, keyB);

const boundMap = {};
const rowKey = 'BIO101::cand_alice_01';

const firstAccept = verifyAndBindStudentHeartbeatProof(boundMap, rowKey, proofA);
const secondAccept = verifyAndBindStudentHeartbeatProof(boundMap, rowKey, proofA);
const forgedWrongKey = verifyAndBindStudentHeartbeatProof(boundMap, rowKey, {
  draftKey: proofA.draftKey,
  heartbeatKey: keyB,
});
const forgedAltDraft = verifyAndBindStudentHeartbeatProof(boundMap, rowKey, {
  draftKey: 'draft_BIO101_evil',
  heartbeatKey: 'forged_key_value',
});
const forgedMissingKey = verifyAndBindStudentHeartbeatProof(boundMap, rowKey, {});

const legacyMap = {};
const legacyAccept = verifyAndBindStudentHeartbeatProof(legacyMap, 'BIO101::legacy_student', {});

check(
  'P3-T10a: verifyAndBindStudentHeartbeatProof binds first proof key and drops mismatched, swapped-draft, or stripped spoofs',
  firstAccept.accepted === true &&
    secondAccept.accepted === true &&
    forgedWrongKey.accepted === false &&
    forgedAltDraft.accepted === false &&
    forgedMissingKey.accepted === false &&
    legacyAccept.accepted === true
);

check(
  'P3-T10b: StudentQuizRunner attaches heartbeatKey and LiveInvigilatorModal enforces binding on heartbeats & log events',
  /getActiveStudentHeartbeatProof/.test(studentRunnerSrc) &&
    /heartbeatKey:\s*heartbeatProofRef\.current\.heartbeatKey/.test(studentRunnerSrc) &&
    /verifyAndBindStudentHeartbeatProof\(/.test(invigilatorSrc) &&
    /boundHeartbeatKeysRef/.test(invigilatorSrc)
);

console.log(`\nPhase 3B Deep Security summary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
