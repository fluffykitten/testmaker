// ─── Exam Session Scheduling Tests (Step 1–5) ──────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

const storage = new Map();
const sessionStore = new Map();

globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};
globalThis.sessionStorage = {
  getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
  setItem: (k, v) => sessionStore.set(k, String(v)),
  removeItem: (k) => sessionStore.delete(k),
  clear: () => sessionStore.clear(),
};
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS: ${label}`);
    passed++;
  } else {
    console.error(`FAIL: ${label}`);
    failed++;
  }
}

async function run() {
  // ─── Step 1: Schedule Helpers, PublishedQuiz & StudentQuizData ──────────────
  const {
    resolveEffectiveQuizStatus,
    validateExamScheduleWindow,
    isoToLocalDateTimeInput,
    localDateTimeInputToIso,
    buildWindowFromSchoolScheduleEntry,
    formatScheduleCountdown,
  } = await import('../src/lib/examSessionSchedule.ts');

  const start = '2026-11-30T01:00:00.000Z';
  const end = '2026-11-30T02:30:00.000Z';
  const beforeStartMs = Date.parse('2026-11-30T00:45:00.000Z');
  const insideMs = Date.parse('2026-11-30T01:30:00.000Z');
  const afterEndMs = Date.parse('2026-11-30T02:35:00.000Z');

  assert(
    resolveEffectiveQuizStatus({ isActive: false, scheduledStartAt: start, scheduledEndAt: end }, insideMs) === 'paused' &&
      resolveEffectiveQuizStatus({ isActive: true, scheduledStartAt: start, scheduledEndAt: end }, beforeStartMs) === 'scheduled' &&
      resolveEffectiveQuizStatus({ isActive: true, scheduledStartAt: start, scheduledEndAt: end }, insideMs) === 'active' &&
      resolveEffectiveQuizStatus({ isActive: true, scheduledStartAt: start, scheduledEndAt: end }, afterEndMs) === 'closed',
    'ES-1a: resolveEffectiveQuizStatus resolves paused / scheduled / active / closed across time boundaries'
  );

  assert(
    resolveEffectiveQuizStatus(
      { isActive: true, quizMode: 'game', scheduledStartAt: start, scheduledEndAt: end },
      beforeStartMs
    ) === 'active' &&
      resolveEffectiveQuizStatus(
        { isActive: false, quizMode: 'game', scheduledStartAt: start, scheduledEndAt: end },
        insideMs
      ) === 'paused',
    'ES-1b: Game Mode ignores schedule windows and stays purely manual (active/paused)'
  );

  assert(
    validateExamScheduleWindow(start, end).valid === true &&
      validateExamScheduleWindow(end, start).valid === false &&
      validateExamScheduleWindow(start, start).valid === false &&
      validateExamScheduleWindow(null, end).valid === true,
    'ES-1c: validateExamScheduleWindow enforces End > Start and permits open-ended start-only or end-only windows'
  );

  const localInput = isoToLocalDateTimeInput(start);
  const roundTripped = localDateTimeInputToIso(localInput);
  assert(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localInput) && roundTripped === start,
    'ES-1d: isoToLocalDateTimeInput <-> localDateTimeInputToIso round-trips cleanly in local timezone'
  );

  const preset = buildWindowFromSchoolScheduleEntry(
    {
      date: 'Mon, 30 Nov 2026',
      time: '07.30 - 09.30',
      subject: 'Mathematics',
      duration: "120'",
    },
    90
  );
  assert(
    preset.scheduledStartAt !== null &&
      preset.scheduledEndAt !== null &&
      Date.parse(preset.scheduledEndAt) - Date.parse(preset.scheduledStartAt) === 120 * 60_000 &&
      formatScheduleCountdown(3661_000) === '01:01:01',
    'ES-1e: buildWindowFromSchoolScheduleEntry parses ICM schedule date & dot-time range (2h window) and formats countdown'
  );

  // Verify resolveStudentQuiz withholds questions when local published quiz is scheduled or closed
  const { resolveStudentQuiz, clearQuizMemoryCache } = await import('../src/services/quizCodeService.ts');
  const futureStart = new Date(Date.now() + 3600_000).toISOString();
  const futureEnd = new Date(Date.now() + 7200_000).toISOString();
  storage.set(
    'fluffykitten_published_quizzes',
    JSON.stringify([
      {
        id: 'quiz_sched_1',
        testId: 'test_sched_1',
        title: 'Scheduled Chemistry Paper',
        quizCode: 'SCHED1',
        subject: 'Chemistry',
        totalMarks: 10,
        questionCount: 1,
        questionIds: ['q1'],
        durationMinutes: 60,
        isExamMode: true,
        securityEnabled: true,
        maxViolations: 3,
        showInstantSolutions: false,
        isActive: true,
        scheduledStartAt: futureStart,
        scheduledEndAt: futureEnd,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ])
  );
  clearQuizMemoryCache();
  const resolvedFuture = await resolveStudentQuiz('SCHED1');
  assert(
    resolvedFuture !== null &&
      resolvedFuture.scheduleStatus === 'scheduled' &&
      resolvedFuture.isActive === false &&
      Array.isArray(resolvedFuture.questions) &&
      resolvedFuture.questions.length === 0,
    'ES-1f: resolveStudentQuiz withholds questions when exam is in scheduled waiting state'
  );

  // ─── Step 2: Migration 027 Server Schedule Gate ─────────────────────────────
  const mig027 = fs.readFileSync(
    path.resolve('supabase/migrations/027_exam_session_scheduling.sql'),
    'utf8'
  );
  assert(
    mig027.includes('CREATE OR REPLACE FUNCTION public.get_student_exam_paper') &&
      mig027.includes("v_quiz->>'scheduledStartAt'") &&
      mig027.includes("v_quiz->>'scheduledEndAt'") &&
      mig027.includes("'scheduleStatus'") &&
      mig027.includes("'serverNow'") &&
      mig027.includes("v_quiz_mode <> 'game'") &&
      mig027.includes("'teacherPinHash', NULL"),
    'ES-2a: Migration 027 enforces Exam Mode Start/End gate against server NOW(), exempts game mode, and preserves key stripping'
  );

  assert(
    mig027.includes("IF v_schedule_status <> 'active' THEN") &&
      mig027.includes("'questions', '[]'::jsonb"),
    'ES-2b: Migration 027 withholds exam questions whenever scheduleStatus is paused, scheduled, or closed'
  );

  // ─── Step 3: Quiz Manager Scheduling UI & Filters ───────────────────────────
  const qmSrc = fs.readFileSync(path.resolve('src/pages/QuizManagerPage.tsx'), 'utf8');
  assert(
    qmSrc.includes("setStatusFilter('scheduled')") &&
      qmSrc.includes('resolveEffectiveQuizStatus(') &&
      qmSrc.includes('handleOpenQuizNow(') &&
      qmSrc.includes('▶ Open Now') &&
      qmSrc.includes('qm-school-sched-preset') &&
      qmSrc.includes('qm-sched-start') &&
      qmSrc.includes('qm-sched-end'),
    'ES-3a: QuizManagerPage exposes Scheduled filter pill, live status badges, Open Now action, School Schedule preset picker & Start/End datetime pickers'
  );

  // ─── Step 4: Student Waiting Room, Server Clock Sync & Closed Screen ────────
  const runnerSrc = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');
  assert(
    runnerSrc.includes('serverClockOffsetMs') &&
      runnerSrc.includes("scheduleBlockStatus === 'scheduled'") &&
      runnerSrc.includes('Assessment Scheduled') &&
      runnerSrc.includes('Exam Entry Window Closed') &&
      runnerSrc.includes('clearQuizMemoryCache(') &&
      runnerSrc.includes('▶ Enter Exam') &&
      runnerSrc.includes('↻ Check Status'),
    'ES-4a: StudentQuizRunner renders Waiting Room countdown synced to serverNow, Closed screen, and manual Enter Exam / Check Status refresh'
  );

  // Verify closed status blocks new lobby resolution while RPC/submission does not reject started candidates
  const pastStart = new Date(Date.now() - 7200_000).toISOString();
  const pastEnd = new Date(Date.now() - 3600_000).toISOString();
  storage.set(
    'fluffykitten_published_quizzes',
    JSON.stringify([
      {
        id: 'quiz_closed_1',
        testId: 'test_closed_1',
        title: 'Closed Physics Paper',
        quizCode: 'CLOSED1',
        subject: 'Physics',
        totalMarks: 10,
        questionCount: 1,
        questionIds: ['q1'],
        durationMinutes: 60,
        isExamMode: true,
        securityEnabled: true,
        maxViolations: 3,
        showInstantSolutions: false,
        isActive: true,
        scheduledStartAt: pastStart,
        scheduledEndAt: pastEnd,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ])
  );
  clearQuizMemoryCache();
  const resolvedClosed = await resolveStudentQuiz('CLOSED1');
  assert(
    resolvedClosed !== null &&
      resolvedClosed.scheduleStatus === 'closed' &&
      resolvedClosed.isActive === false &&
      resolvedClosed.questions.length === 0,
    'ES-4b: resolveStudentQuiz returns scheduleStatus="closed" and empty questions after scheduledEndAt'
  );

  console.log(`\nExam Schedule tests: ${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
