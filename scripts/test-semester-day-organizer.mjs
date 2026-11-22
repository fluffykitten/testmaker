import fs from 'node:fs';
import path from 'node:path';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
globalThis.sessionStorage = {
  getItem: (k) => (mem.has(`sess:${k}`) ? mem.get(`sess:${k}`) : null),
  setItem: (k, v) => mem.set(`sess:${k}`, String(v)),
  removeItem: (k) => mem.delete(`sess:${k}`),
  clear: () => {},
};
globalThis.window = {
  localStorage: globalThis.localStorage,
  sessionStorage: globalThis.sessionStorage,
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

const { supabase } = await import('../src/lib/supabase.ts');
const { ICM_SEMESTER1_2026_2027_SCHEDULE } = await import('../src/lib/examSchedule.ts');
const {
  UNSCHEDULED_DAY_KEY,
  normalizeExamDayKey,
  resolveQuizExamDayKey,
  formatExamDayDateLabel,
  extractScheduleDayPresets,
  groupQuizzesByExamDay,
  resolveQuizExamTimeInfo,
  getWarmedQuizTimestamps,
  recordWarmedQuizCodes,
  clearWarmedQuizCodes,
  computeDayWarmSummary,
} = await import('../src/lib/semesterDayOrganizer.ts');
const {
  getPublishedQuizzes,
  assignQuizzesToExamDay,
  activateExamDayQuizzes,
  pauseQuizzesBatch,
} = await import('../src/services/quizManagerService.ts');

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

const origRpc = supabase.rpc.bind(supabase);
const origFrom = supabase.from.bind(supabase);

// ── 1. Local Date Normalization (Zero UTC Rollback Bug) ─────────────────────
const localMidnightIso = new Date(2026, 10, 30, 0, 15, 0).toISOString();
check(
  'SDO-1a: normalizeExamDayKey preserves local calendar date across ISO timestamps near midnight',
  normalizeExamDayKey(localMidnightIso) === '2026-11-30' &&
    normalizeExamDayKey('2026-12-01') === '2026-12-01' &&
    normalizeExamDayKey('Mon, 30 Nov 2026') === '2026-11-30' &&
    normalizeExamDayKey('1 Dec 2026') === '2026-12-01' &&
    normalizeExamDayKey('2026-02-30') === null &&
    normalizeExamDayKey('') === null &&
    normalizeExamDayKey(UNSCHEDULED_DAY_KEY) === null
);

check(
  'SDO-1b: formatExamDayDateLabel outputs crisp human date matching ICM format',
  formatExamDayDateLabel('2026-11-30') === 'Mon, 30 Nov 2026',
  formatExamDayDateLabel('2026-11-30')
);

check(
  'SDO-1c: resolveQuizExamDayKey prefers manual examDay over scheduledStartAt',
  resolveQuizExamDayKey({ examDay: '2026-12-02', scheduledStartAt: new Date(2026, 10, 30, 7, 30).toISOString() }) ===
    '2026-12-02' &&
    resolveQuizExamDayKey({ scheduledStartAt: new Date(2026, 10, 30, 7, 30).toISOString() }) === '2026-11-30' &&
    resolveQuizExamDayKey({}) === null
);

const presets = extractScheduleDayPresets(ICM_SEMESTER1_2026_2027_SCHEDULE);
check(
  'SDO-1d: extractScheduleDayPresets deduplicates schedule dates chronologically with aggregated subjects',
  presets.length > 0 &&
    presets[0].dayKey === '2026-11-23' &&
    presets.some((p) => p.dayKey === '2026-12-01' && p.subjects.includes('Chemistry') && p.subjects.includes('English')) &&
    presets.some(
      (p) =>
        p.dayKey === '2026-12-01' &&
        p.sessions.some((s) => s.subject === 'Chemistry' && s.time === '07.30 - 09.30') &&
        p.sessions.some((s) => s.subject === 'English' && s.time === '10.00 - 12.00')
    )
);

// ── 2. Grouping Across Subjects, Excluding Games & Numeric Code Sort ────────
function makeQuiz(id, code, subj, opts = {}) {
  return {
    id,
    testId: `test_${id}`,
    title: `${subj} ${code}`,
    quizCode: code,
    subject: subj,
    totalMarks: 30,
    questionCount: 10,
    questionIds: [],
    durationMinutes: opts.durationMinutes ?? 60,
    isExamMode: true,
    securityEnabled: true,
    maxViolations: 3,
    showInstantSolutions: false,
    isActive: opts.isActive ?? false,
    scheduledStartAt: opts.scheduledStartAt ?? null,
    scheduledEndAt: opts.scheduledEndAt ?? null,
    examDay: opts.examDay ?? null,
    quizMode: opts.quizMode ?? 'exam',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };
}

const sampleQuizzes = [
  makeQuiz('q10', 'ICM-10', 'Chemistry', { scheduledStartAt: new Date(2026, 11, 1, 7, 30).toISOString() }),
  makeQuiz('q2', 'ICM-2', 'Chemistry', { scheduledStartAt: new Date(2026, 11, 1, 7, 30).toISOString() }),
  makeQuiz('q1', 'ICM-1', 'Chemistry', { scheduledStartAt: new Date(2026, 11, 1, 7, 30).toISOString() }),
  makeQuiz('qm', 'MATH-1', 'Mathematics', { scheduledStartAt: new Date(2026, 10, 30, 7, 30).toISOString(), isActive: true }),
  makeQuiz('qu', 'BIO-UN', 'Biology', {}),
  makeQuiz('qg', 'GAME-1', 'Chemistry', { quizMode: 'game', scheduledStartAt: new Date(2026, 10, 30, 7, 30).toISOString() }),
];

const grouped = groupQuizzesByExamDay(sampleQuizzes, ICM_SEMESTER1_2026_2027_SCHEDULE, ['2026-12-03']);
check(
  'SDO-2: groupQuizzesByExamDay excludes games, sorts days chronologically, orders quizCodes numerically & preserves custom days',
  grouped.days.length === 3 &&
    grouped.days[0].dayNumber === 1 &&
    grouped.days[0].dayKey === '2026-11-30' &&
    grouped.days[0].quizzes.length === 1 &&
    grouped.days[1].dayNumber === 2 &&
    grouped.days[1].dayKey === '2026-12-01' &&
    grouped.days[1].quizzes.map((q) => q.quizCode).join(',') === 'ICM-1,ICM-2,ICM-10' &&
    grouped.days[1].scheduleSubjects.includes('Chemistry') &&
    grouped.days[2].dayNumber === 3 &&
    grouped.days[2].dayKey === '2026-12-03' &&
    grouped.days[2].quizzes.length === 0 &&
    grouped.unscheduled.quizzes.map((q) => q.quizCode).join(',') === 'BIO-UN',
  JSON.stringify(grouped.days.map((d) => ({ dayKey: d.dayKey, codes: d.quizzes.map((q) => q.quizCode) })))
);

// ── 3. Batch Activate + Warm, Pause Batch & Bulk Assign Exam Day (<=2 Writes) ─
const day13Quizzes = Array.from({ length: 13 }, (_, idx) =>
  makeQuiz(`icm_${idx + 1}`, `ICM-${idx + 1}`, 'Chemistry', {
    isActive: false,
    scheduledStartAt: new Date(2026, 11, 1, 7, 30).toISOString(),
  })
);
const extraQuiz = makeQuiz('makeup_1', 'MATH-M1', 'Mathematics', {
  isActive: true,
  examDay: '2026-11-30',
});
let cloudPublishedQuizzes = [...day13Quizzes, extraQuiz];

mem.clear();
localStorage.setItem('fluffykitten_published_quizzes', JSON.stringify(cloudPublishedQuizzes));

let upsertCalls = 0;
let upsertRowCounts = [];
let prewarmRpcCalls = 0;
let lastPrewarmCodes = [];

supabase.from = (table) => {
  if (table === 'app_config') {
    return {
      select() {
        return this;
      },
      eq(_col, val) {
        this._eqKey = val;
        return this;
      },
      in() {
        return { data: [], error: null };
      },
      async maybeSingle() {
        if (this._eqKey === 'published_quizzes') {
          return { data: { value: JSON.stringify(cloudPublishedQuizzes) }, error: null };
        }
        return { data: null, error: null };
      },
      async upsert(payload) {
        upsertCalls++;
        if (Array.isArray(payload)) {
          upsertRowCounts.push(payload.length);
        } else {
          upsertRowCounts.push(1);
          if (payload?.key === 'published_quizzes' && typeof payload?.value === 'string') {
            cloudPublishedQuizzes = JSON.parse(payload.value);
          }
        }
        return { error: null };
      },
    };
  }
  return origFrom(table);
};

supabase.rpc = async (fn, args) => {
  if (fn === 'prewarm_exam_paper_cache') {
    prewarmRpcCalls++;
    lastPrewarmCodes = args?.p_quiz_codes || [];
    return {
      data: {
        warmedCodes: lastPrewarmCodes,
        skippedCodes: [],
        missingCodes: [],
        warmedCount: lastPrewarmCodes.length,
        ttlMinutes: 90,
        cachedAt: new Date().toISOString(),
      },
      error: null,
    };
  }
  return { data: null, error: null };
};

const day13Ids = day13Quizzes.map((q) => q.id);
const actRes = await activateExamDayQuizzes(day13Ids, '2026-12-01');
const savedAfterActivate = getPublishedQuizzes();
const activatedSet = savedAfterActivate.filter((q) => day13Ids.includes(q.id));
const untouchedMakeup = savedAfterActivate.find((q) => q.id === 'makeup_1');

check(
  'SDO-3a: activateExamDayQuizzes opens 13 exams in 2 batched app_config upserts, preserves examDay, clears scheduledStartAt, and leaves other Days untouched',
  actRes.batch.ok &&
    actRes.warm.ok &&
    actRes.warm.warmedCount === 13 &&
    upsertCalls === 2 &&
    prewarmRpcCalls === 1 &&
    upsertRowCounts[0] === 13 &&
    upsertRowCounts[1] === 1 &&
    activatedSet.every((q) => q.isActive === true && q.scheduledStartAt === null && q.examDay === '2026-12-01') &&
    untouchedMakeup?.isActive === true &&
    untouchedMakeup?.examDay === '2026-11-30',
  JSON.stringify({ upsertCalls, upsertRowCounts, prewarmRpcCalls, ok: actRes.batch.ok })
);

const warmMapAfterAct = getWarmedQuizTimestamps();
check(
  'SDO-3b: activateExamDayQuizzes records local warm timestamps for all 13 warmed codes',
  day13Quizzes.every((q) => Number(warmMapAfterAct[q.quizCode]) > 0)
);

upsertCalls = 0;
upsertRowCounts = [];
const pauseRes = await pauseQuizzesBatch(day13Ids);
const pausedSet = pauseRes.quizzes.filter((q) => day13Ids.includes(q.id));
const warmMapAfterPause = getWarmedQuizTimestamps();

check(
  'SDO-3c: pauseQuizzesBatch pauses all 13 exams in 2 batch upserts and clears local warm timestamps without pausing other Days',
  pauseRes.ok &&
    upsertCalls === 2 &&
    pausedSet.every((q) => q.isActive === false && q.examDay === '2026-12-01') &&
    pauseRes.quizzes.find((q) => q.id === 'makeup_1')?.isActive === true &&
    day13Quizzes.every((q) => warmMapAfterPause[q.quizCode] === undefined)
);

upsertCalls = 0;
const unschedRes = await assignQuizzesToExamDay(['icm_1'], null);
const bulkActInPlaceRes = await activateExamDayQuizzes(['icm_1', 'makeup_1'], null);
const movedFromUnschedRes = await assignQuizzesToExamDay(['icm_1'], '2026-12-03');
const movedToDayRes = await assignQuizzesToExamDay(['icm_1', 'icm_2'], '2026-12-02');
const clearRes = await assignQuizzesToExamDay(['icm_2'], null);
check(
  'SDO-3d: activateExamDayQuizzes(ids, null) activates in-place (keeps Unscheduled unscheduled & Day-assigned on its Day), and Move to Day moves cleanly to Day & back to Unscheduled',
  unschedRes.ok &&
    bulkActInPlaceRes.batch.ok &&
    bulkActInPlaceRes.batch.quizzes.find((q) => q.id === 'icm_1')?.isActive === true &&
    bulkActInPlaceRes.batch.quizzes.find((q) => q.id === 'icm_1')?.examDay === null &&
    bulkActInPlaceRes.batch.quizzes.find((q) => q.id === 'makeup_1')?.isActive === true &&
    bulkActInPlaceRes.batch.quizzes.find((q) => q.id === 'makeup_1')?.examDay === '2026-11-30' &&
    movedFromUnschedRes.ok &&
    movedFromUnschedRes.quizzes.find((q) => q.id === 'icm_1')?.examDay === '2026-12-03' &&
    movedToDayRes.ok &&
    movedToDayRes.quizzes.find((q) => q.id === 'icm_1')?.examDay === '2026-12-02' &&
    clearRes.ok &&
    clearRes.quizzes.find((q) => q.id === 'icm_2')?.examDay === null &&
    clearRes.quizzes.find((q) => q.id === 'icm_2')?.scheduledStartAt === null
);

// ── 4. Warm-Cache 90-Minute Expiry Computation ──────────────────────────────
mem.clear();
const t0 = 1_760_000_000_000;
recordWarmedQuizCodes(['ICM-1', 'ICM-2'], t0);
const warmAll = computeDayWarmSummary(['ICM-1', 'ICM-2'], getWarmedQuizTimestamps(), t0 + 10 * 60_000, 90);
const warmPartial = computeDayWarmSummary(['ICM-1', 'ICM-2', 'ICM-3'], getWarmedQuizTimestamps(), t0 + 10 * 60_000, 90);
const warmExpired = computeDayWarmSummary(['ICM-1', 'ICM-2'], getWarmedQuizTimestamps(), t0 + 91 * 60_000, 90);
clearWarmedQuizCodes(['ICM-1']);
const afterSingleClear = computeDayWarmSummary(['ICM-1', 'ICM-2'], getWarmedQuizTimestamps(), t0 + 10 * 60_000, 90);

check(
  'SDO-4: computeDayWarmSummary evaluates warm/partial/cold states and expires cleanly after 90 min',
  warmAll.status === 'warm' &&
    warmAll.minutesRemaining === 80 &&
    warmPartial.status === 'partial' &&
    warmPartial.warmedCount === 2 &&
    warmExpired.status === 'cold' &&
    afterSingleClear.status === 'partial' &&
    afterSingleClear.warmedCount === 1
);

// ── 5. UI & Scope Guardrail Checks ──────────────────────────────────────────
const qmSrc = fs.readFileSync(path.resolve('src/pages/QuizManagerPage.tsx'), 'utf8');
const modalSrc = fs.readFileSync(path.resolve('src/components/SemesterDayOrganizerModal.tsx'), 'utf8');
const planExists = fs.existsSync(path.resolve('Plan/semester_day_organizer_plan.md'));

const configModalSlice = qmSrc.slice(qmSrc.indexOf('isConfigModalOpen &&'));
const modalCssSrc = fs.readFileSync(path.resolve('src/components/SemesterDayOrganizerModal.css'), 'utf8');

const sameDayStart = new Date(2026, 10, 30, 7, 30).toISOString();
const sameDayEnd = new Date(2026, 10, 30, 9, 30).toISOString();
const scheduledTimeInfo = resolveQuizExamTimeInfo(
  makeQuiz('t_sched', 'M-1', 'Mathematics', {
    scheduledStartAt: sameDayStart,
    scheduledEndAt: sameDayEnd,
    durationMinutes: 120,
  }),
  '2026-11-30',
  ICM_SEMESTER1_2026_2027_SCHEDULE
);
const manualDayTimeInfo = resolveQuizExamTimeInfo(
  makeQuiz('t_manual', 'M-2', 'Mathematics', {
    scheduledStartAt: null,
    scheduledEndAt: null,
    durationMinutes: 120,
  }),
  '2026-11-30',
  ICM_SEMESTER1_2026_2027_SCHEDULE
);

check(
  'SDO-5: QuizManagerPage wires SemesterDayOrganizerModal cleanly, Exam Time & wider layout render properly, and Move to Day allows moving to Unscheduled',
  planExists &&
    qmSrc.includes('SemesterDayOrganizerModal') &&
    qmSrc.includes('Semester Days') &&
    qmSrc.includes('setIsDayOrganizerOpen(true)') &&
    !configModalSlice.includes('examDay') &&
    modalSrc.includes('activateExamDayQuizzes') &&
    modalSrc.includes('activateExamDayQuizzes(ids, null)') &&
    modalSrc.includes('hasInitializedBulkTarget') &&
    modalSrc.includes('handleMoveQuizzesToDay(Array.from(selectedIds), bulkTargetDay, true)') &&
    modalSrc.includes('pauseQuizzesBatch') &&
    modalSrc.includes('assignQuizzesToExamDay') &&
    modalSrc.includes('prewarmExamPaperCache') &&
    modalSrc.includes('<th>Exam Time</th>') &&
    modalSrc.includes('resolveQuizExamTimeInfo') &&
    modalCssSrc.includes('max-width: 1280px') &&
    scheduledTimeInfo.hasExplicitWindow === true &&
    scheduledTimeInfo.windowLabel === '07:30 – 09:30' &&
    scheduledTimeInfo.durationLabel === '120 min' &&
    manualDayTimeInfo.hasExplicitWindow === false &&
    manualDayTimeInfo.windowLabel === 'Open (No window)' &&
    manualDayTimeInfo.timetableHint === 'Timetable: 07.30 - 09.30'
);

supabase.rpc = origRpc;
supabase.from = origFrom;

console.log(`\nSemester Exam Day Organizer tests: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
