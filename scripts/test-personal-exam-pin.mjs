import fs from 'node:fs';

// Minimal DOM storage & window shims for Node ESM testing
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
globalThis.window = {
  localStorage: globalThis.localStorage,
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
};
globalThis.document = {
  documentElement: {
    style: { setProperty: () => {} },
    setAttribute: () => {},
    classList: { add: () => {}, remove: () => {} },
    dataset: {},
  },
};

const { saveSettings, getSavedSettings, DEFAULT_SETTINGS } = await import(
  '../src/lib/settings.ts'
);
const { createDraftFromTest } = await import(
  '../src/services/quizManagerService.ts'
);
const {
  assignMissingPins,
  regenerateAllPins,
  planRosterExcelImport,
  verifyStudentPin,
} = await import('../src/services/studentRosterService.ts');
const { supabase } = await import('../src/lib/supabase.ts');
const { applyMaskedPinInput } = await import('../src/utils/examSecurityUtils.ts');
const {
  buildStudentDraftIdentifier,
  getDraftLockCredentials,
  saveExamDraft,
  fetchExamDraft,
} = await import('../src/services/examDraftService.ts');

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS: ${label}`);
    passed++;
  } else {
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ── Step 1 Tests: School Default & Toggle Wiring for requireStudentPin ──────

saveSettings({ ...DEFAULT_SETTINGS, defaultRequireStudentPin: false });
const baseTest = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Biology Mock',
  total_marks: 50,
  question_ids: ['q1'],
  header_config: { title: 'Biology Mock', subject: 'Biology', durationMinutes: 45 },
};

const draftDefaultOff = createDraftFromTest(baseTest);
check(
  'SP-1a: createDraftFromTest defaults requireStudentPin to false when school default is false',
  draftDefaultOff.requireStudentPin === false
);

saveSettings({ ...getSavedSettings(), defaultRequireStudentPin: true });
const draftDefaultOn = createDraftFromTest(baseTest);
check(
  'SP-1b: createDraftFromTest inherits defaultRequireStudentPin=true from school settings',
  draftDefaultOn.requireStudentPin === true
);

const draftOverrideOff = createDraftFromTest(baseTest, undefined, undefined, {
  ...draftDefaultOn,
  requireStudentPin: false,
});
check(
  'SP-1c: Editing existing quiz preserves explicit requireStudentPin=false override',
  draftOverrideOff.requireStudentPin === false
);

const qmSrc = fs.readFileSync(new URL('../src/pages/QuizManagerPage.tsx', import.meta.url), 'utf8');
check(
  'SP-1d: QuizManagerPage exposes Require Personal Candidate PIN UI toggle & preserves it on edit/save',
  qmSrc.includes('Require Personal Candidate PIN') &&
    /checked=\{activeQuizDraft\.requireStudentPin\s*\?\?\s*false\}/.test(qmSrc) &&
    /requireStudentPin:\s*Boolean\(activeQuizDraft\.requireStudentPin\)/.test(qmSrc)
);

// ── Step 2 Tests: School-Wide Global 4-Digit PIN Uniqueness ─────────────────

const simulatedRoster166 = Array.from({ length: 166 }, (_, i) => ({
  id: `cand-${i + 1}`,
  name: `Candidate ${i + 1}`,
  class: ['X IPA 1', 'X IPA 2', 'X IPA 3', 'X IPS 1', 'X IPS 2', 'XI IPA 1', 'XI IPA 2', 'XI IPS 1', 'XI IPS 2', 'XII IPA 1', 'XII IPA 2', 'XII IPS 1', 'XII IPS 2'][i % 13],
  candidateNumber: `2627${String(i + 1).padStart(5, '0')}`,
  pin: '',
}));

let all100RunsUnique = true;
for (let trial = 0; trial < 100; trial++) {
  const assigned = assignMissingPins(simulatedRoster166);
  const regenerated = regenerateAllPins(assigned);
  if (
    new Set(assigned.map((s) => s.pin)).size !== 166 ||
    new Set(regenerated.map((s) => s.pin)).size !== 166
  ) {
    all100RunsUnique = false;
    break;
  }
}
check(
  'SP-2a: assignMissingPins & regenerateAllPins guarantee 0 cross-class collisions across 100 runs of 166 candidates',
  all100RunsUnique
);

const collidingExisting = [
  { id: '1', name: 'Student One', class: 'X IPA 1', candidateNumber: '1001', pin: '6428' },
  { id: '2', name: 'Student Two', class: 'XI IPS 2', candidateNumber: '1002', pin: '6428' },
  { id: '3', name: 'Student Three', class: 'X IPA 2', candidateNumber: '1003', pin: '9102' },
];
const dedupPlan = planRosterExcelImport(collidingExisting, ['X IPA 1', 'XI IPS 2', 'X IPA 2'], {
  format: 'tabular',
  detectedClasses: ['X IPA 1', 'XI IPS 2', 'X IPA 2'],
  students: collidingExisting.map((s) => ({ ...s, pin: '0000' })),
});
const dedupPins = dedupPlan.syncedRosterPruned.map((s) => s.pin);
check(
  'SP-2b: planRosterExcelImport preserves unique existing PINs while re-rolling any pre-existing cross-class duplicate',
  dedupPins[0] === '6428' &&
    dedupPins[2] === '9102' &&
    dedupPins[1] !== '6428' &&
    new Set(dedupPins).size === 3 &&
    dedupPlan.preservedPinCount === 2,
  `pins=${JSON.stringify(dedupPins)}, preserved=${dedupPlan.preservedPinCount}`
);

// ── Step 3 Tests: Composite Draft Identifier & Anti-Leakage Guard ───────────

const identA = buildStudentDraftIdentifier('Student Alpha', '6428');
const identB = buildStudentDraftIdentifier('Student Beta', '6428');
const lockA = getDraftLockCredentials('CHEM101', 'Student Alpha', '6428');
const lockB = getDraftLockCredentials('CHEM101', 'Student Beta', '6428');

check(
  'SP-3a: Two candidates sharing PIN 6428 get distinct draftKey & ownerToken values',
  identA !== identB &&
    lockA.draftKey !== lockB.draftKey &&
    lockA.ownerToken !== lockB.ownerToken,
  JSON.stringify({ lockA, lockB })
);

await saveExamDraft({
  quizCode: 'CHEM101',
  quizId: 'quiz-chem-101',
  studentName: 'Student Alpha',
  studentPin: '6428',
  answers: { 0: 'B' },
  currentIndex: 1,
  timeLeftSeconds: 1800,
  startTime: Date.now(),
  lastSavedAt: new Date().toISOString(),
  status: 'in_progress',
});

const leakCheckSameIdentWrongName = await fetchExamDraft('CHEM101', 'quiz-chem-101', identA, {
  studentPin: '6428',
  expectedStudentName: 'Student Beta',
});
const betaLookup = await fetchExamDraft('CHEM101', 'quiz-chem-101', identB, {
  studentPin: '6428',
  expectedStudentName: 'Student Beta',
});
const alphaLookup = await fetchExamDraft('CHEM101', 'quiz-chem-101', identA, {
  studentPin: '6428',
  expectedStudentName: 'Student Alpha',
});

check(
  'SP-3b: fetchExamDraft prevents cross-student draft leakage while recovering matching student draft',
  leakCheckSameIdentWrongName === null &&
    betaLookup === null &&
    alphaLookup !== null &&
    alphaLookup.answers[0] === 'B'
);

// ── Step 4 Tests: Class Normalization, Masked Input Mid-Edit & Mig 025 Guards ─

const capturedRpcCalls = [];
const origRpc = supabase.rpc.bind(supabase);
supabase.rpc = async (fn, args) => {
  if (fn === 'verify_student_pin') {
    capturedRpcCalls.push(args);
    return {
      data: {
        valid: args.p_class === 'X IPA 3' && args.p_pin === '7390',
        student: { id: '2', name: args.p_name, class: 'X IPA 3' },
      },
      error: null,
    };
  }
  return origRpc(fn, args);
};
const normPinRes = await verifyStudentPin('ALVIRA NAUROH SAAJIDAH', 'X IPA3', '7390');
check(
  'SP-4a: verifyStudentPin normalizes "X IPA3" -> "X IPA 3" before server RPC call',
  normPinRes.valid === true && capturedRpcCalls[0]?.p_class === 'X IPA 3'
);

// Verify offline empty-roster fallback returns explicit connectivity message
supabase.rpc = async () => ({ data: null, error: { message: 'offline' } });
supabase.functions.invoke = async () => ({ data: null, error: { message: 'offline' } });
const emptyOfflineRes = await verifyStudentPin('ALVIRA', 'X IPA 3', '7390');
check(
  'SP-4b: verifyStudentPin returns clear connectivity/cache guidance when offline cache is empty',
  emptyOfflineRes.valid === false &&
    /offline roster is cached/i.test(emptyOfflineRes.error || '')
);
supabase.rpc = origRpc;

let masked = '';
masked = applyMaskedPinInput('4', masked, 4);
masked = applyMaskedPinInput('•8', masked, 4);
masked = applyMaskedPinInput('••2', masked, 4);
masked = applyMaskedPinInput('•••1', masked, 4);
const midReplace = applyMaskedPinInput('••9•', masked, 4);
const midInsert = applyMaskedPinInput('••9••', masked, 4);
const endBackspace = applyMaskedPinInput('•••', masked, 4);
const fullPaste = applyMaskedPinInput('9876', masked, 4);
check(
  'SP-4c: applyMaskedPinInput handles sequential typing, paste, backspace, mid-replace, and mid-insert cleanly',
  masked === '4821' &&
    midReplace === '4891' &&
    midInsert === '4892' &&
    endBackspace === '482' &&
    fullPaste === '9876',
  JSON.stringify({ masked, midReplace, midInsert, endBackspace, fullPaste })
);

const mig025Sql = fs.readFileSync(
  new URL('../supabase/migrations/025_personal_exam_pin_hardening.sql', import.meta.url),
  'utf8'
);
const edgePinSrc = fs.readFileSync(
  new URL('../supabase/functions/verify-student-pin/index.ts', import.meta.url),
  'utf8'
);
check(
  'SP-4d: Migration 025 & Edge Function normalize class spacing and enforce strict unregistered-student rejection when requireStudentPin=TRUE',
  mig025Sql.includes('normalize_roster_class_label') &&
    mig025Sql.includes('p_require_enrolled BOOLEAN DEFAULT FALSE') &&
    mig025Sql.includes('RETURN NOT p_require_enrolled;') &&
    /verify_roster_pin_if_enrolled\([^)]*v_require_student_pin\)/.test(mig025Sql) &&
    edgePinSrc.includes('normalizeClass')
);

console.log(`\nPersonal PIN tests: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
