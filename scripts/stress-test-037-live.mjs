import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createClient } from '@supabase/supabase-js';

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE MIGRATION 037 + PRE-WARM STRESS TEST (170 Students Across ICM-1..ICM-13)
// - Reads live pre-warmed `ICM-1..ICM-13` papers WITHOUT invalidating cache
// - Tests `enter_student_exam_session` security (PIN enforcement + flag tamper reject)
// - Tests 170-student staggered boot (0..6s), unified Start RPC, mid-exam autosaves,
//   and timer-expiry submission wave (0..15s jitter) against `STRESS200` fixture
// - Never mutates real `ICM-1..ICM-13` submissions, drafts, or schedules
// ═══════════════════════════════════════════════════════════════════════════════

function loadEnvLocal() {
  const envPath = path.resolve('.env.local');
  const loaded = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      loaded[k] = v;
    }
  }
  return { ...loaded, ...process.env };
}

const ENV = loadEnvLocal();
const SUPABASE_URL = ENV.VITE_SUPABASE_URL;
const ANON_KEY = ENV.VITE_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY || '';
const TEACHER_SESSION_TOKEN = ENV.TEACHER_SESSION_TOKEN || '';

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('❌ Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env.local');
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const clean = a.replace(/^--/, '');
    const [k, v] = clean.split('=');
    return [k, v ?? 'true'];
  })
);

const TOTAL_STUDENTS = Math.max(10, Math.min(300, Number(args.students || 170)));
const SITTING_DURATION_MS = Math.max(10, Math.min(300, Number(args['sitting-sec'] || 25))) * 1000;
const ENABLE_WEBSOCKETS = args['no-ws'] !== 'true';
const RUN_TAG = Date.now().toString(36);
const WRITE_QUIZ_CODE = 'STRESS200';
const WRITE_QUIZ_ID = 'stress-realistic-exam-fixture';

const LIVE_EXAM_COHORTS = [
  { quizCode: 'ICM-1', className: 'X IPA 1', weight: 18 },
  { quizCode: 'ICM-2', className: 'X IPA 2', weight: 11 },
  { quizCode: 'ICM-3', className: 'X IPA 3', weight: 11 },
  { quizCode: 'ICM-4', className: 'X IPS 1', weight: 19 },
  { quizCode: 'ICM-5', className: 'X IPS 2', weight: 7 },
  { quizCode: 'ICM-6', className: 'XI IPA 1', weight: 12 },
  { quizCode: 'ICM-7', className: 'XI IPA 2', weight: 13 },
  { quizCode: 'ICM-8', className: 'XI IPS 1', weight: 6 },
  { quizCode: 'ICM-9', className: 'XI IPS 2', weight: 11 },
  { quizCode: 'ICM-10', className: 'XII IPA 1', weight: 17 },
  { quizCode: 'ICM-11', className: 'XII IPA 2', weight: 18 },
  { quizCode: 'ICM-12', className: 'XII IPS 1', weight: 17 },
  { quizCode: 'ICM-13', className: 'XII IPS 2', weight: 6 },
];

fs.mkdirSync(path.resolve('artifacts'), { recursive: true });
const EVENTS_LOG_PATH = path.resolve('artifacts/stress_037_events.jsonl');
const REPORT_PATH = path.resolve('Plan/stress_test_037_report.md');
const eventStream = fs.createWriteStream(EVENTS_LOG_PATH, { flags: 'w' });

const allEvents = [];
const healthSamples = [];
let inFlightRequests = 0;
let peakInFlightRequests = 0;

function trackInFlight(delta) {
  inFlightRequests = Math.max(0, inFlightRequests + delta);
  if (inFlightRequests > peakInFlightRequests) {
    peakInFlightRequests = inFlightRequests;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function recordEvent({
  phase,
  cohort,
  actorId,
  examCode,
  action,
  target,
  durationMs,
  httpStatus,
  outcome,
  payloadBytes = 0,
  notes = '',
}) {
  const entry = {
    ts: new Date().toISOString(),
    phase,
    cohort,
    actorId,
    examCode,
    action,
    target,
    durationMs: Number(durationMs.toFixed(1)),
    httpStatus,
    outcome,
    payloadBytes,
    inFlight: inFlightRequests,
    notes,
  };
  allEvents.push(entry);
  eventStream.write(`${JSON.stringify(entry)}\n`);
}

function calcPercentiles(values) {
  if (!values.length) {
    return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, avg: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: Number(sorted[0].toFixed(1)),
    p50: Number(pick(50).toFixed(1)),
    p95: Number(pick(95).toFixed(1)),
    p99: Number(pick(99).toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1)),
    avg: Number((sum / sorted.length).toFixed(1)),
  };
}

async function supaFetchJson(url, { method = 'GET', body = undefined, bearer = ANON_KEY, extraHeaders = {}, timeoutMs = 15000 } = {}) {
  const payloadStr = body !== undefined ? JSON.stringify(body) : undefined;
  const payloadBytes = payloadStr ? Buffer.byteLength(payloadStr, 'utf8') : 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  trackInFlight(1);
  let status = 0;
  let data = null;
  let errorText = '';
  try {
    const res = await fetch(url, {
      method,
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${bearer}`,
        ...(payloadStr ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: payloadStr,
      signal: controller.signal,
    });
    status = res.status;
    const raw = await res.text();
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw;
    }
    if (!res.ok) {
      errorText = typeof data === 'object' && data ? data.message || JSON.stringify(data) : raw;
    }
  } catch (err) {
    errorText = err?.name === 'AbortError' ? `timeout(${timeoutMs}ms)` : err?.message || String(err);
  } finally {
    clearTimeout(timer);
    trackInFlight(-1);
  }
  return {
    status,
    data,
    errorText,
    durationMs: performance.now() - t0,
    payloadBytes,
  };
}

async function supaRpc(fnName, rpcArgs, opts = {}) {
  return supaFetchJson(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    ...opts,
    method: 'POST',
    body: rpcArgs ?? {},
  });
}

async function supaRest(tablePath, opts = {}) {
  return supaFetchJson(`${SUPABASE_URL}/rest/v1/${tablePath}`, opts);
}

function buildStudents(totalCount) {
  const weightedPool = [];
  for (const c of LIVE_EXAM_COHORTS) {
    for (let w = 0; w < c.weight; w++) {
      weightedPool.push(c);
    }
  }

  const students = [];
  for (let i = 1; i <= totalCount; i++) {
    const num = String(i).padStart(3, '0');
    const assigned = weightedPool[(i - 1) % weightedPool.length];
    const slugClass = assigned.className
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const studentName = `Sim037 Candidate ${num} (${RUN_TAG})`;
    const slugName = studentName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const joinPin = String(1000 + ((i * 37) % 8999));
    const draftKey = `draft_${WRITE_QUIZ_CODE}_${slugName}__cls_${slugClass}`.toLowerCase();
    const draftOwnerToken = `cls:${WRITE_QUIZ_CODE}:${slugName}__cls_${slugClass}`;

    students.push({
      index: i,
      studentId: `STU037-${num}`,
      cohort: i % 10 === 3 ? 'reloader' : i % 7 === 0 ? 'violator' : 'steady',
      liveExamCode: assigned.quizCode,
      studentClass: assigned.className,
      studentName,
      candidateNumber: `C037-${RUN_TAG}-${num}`,
      joinPin,
      draftKey,
      draftOwnerToken,
      submissionId: `stress037_${RUN_TAG}_${num}`,
      answers: {},
      questions: [],
      violations: [],
    });
  }
  return students;
}

function buildDraftPayload(student, currentIndex, timeLeftSeconds) {
  return {
    quizCode: WRITE_QUIZ_CODE,
    quizId: WRITE_QUIZ_ID,
    studentName: student.studentName,
    candidateNumber: student.candidateNumber,
    candidateClass: student.studentClass,
    studentPin: student.joinPin,
    answers: student.answers,
    currentIndex,
    timeLeftSeconds,
    startTime: Date.now() - 60_000,
    targetEndTime: Date.now() + timeLeftSeconds * 1000,
    flaggedIndices: [1, 4],
    violations: student.violations,
    lastSavedAt: new Date().toISOString(),
    status: 'in_progress',
  };
}

function buildSubmissionRow(student) {
  const qs =
    student.questions.length > 0
      ? student.questions
      : Array.from({ length: 12 }, (_, idx) => ({
          id: `fallback_q_${idx + 1}`,
          question_number: String(idx + 1),
          question_text: `IGCSE Question ${idx + 1} stem`,
          options: ['A', 'B', 'C', 'D'],
          marks: 2,
          topic: 'Chemistry',
        }));

  const questionResults = qs.map((q, idx) => ({
    questionId: q.id || `q_${idx + 1}`,
    questionNumber: idx + 1,
    questionText: q.question_text || `Question ${idx + 1}`,
    options: q.options || undefined,
    topic: q.topic || 'General',
    maxMarks: Number(q.marks || 2),
    earnedMarks: 0,
    isCorrect: false,
    studentAnswer: student.answers[idx] ?? 'A',
    correctAnswer: 'See mark scheme',
    misconceptions: [],
    aiFeedback: 'Awaiting examiner AI evaluation',
    gradingMethod: 'deterministic',
  }));

  return {
    id: student.submissionId,
    quiz_id: WRITE_QUIZ_ID,
    quiz_code: WRITE_QUIZ_CODE,
    quiz_title: `Live 037 Stress Check (${student.liveExamCode})`,
    subject: 'Chemistry',
    student_name: student.studentName,
    student_class: student.studentClass,
    candidate_number: student.candidateNumber,
    submitted_at: new Date().toISOString(),
    duration_seconds: 900 + (student.index % 120),
    score: 0,
    total_marks: qs.reduce((acc, q) => acc + Number(q.marks || 2), 0) || 24,
    percentage: 0,
    violations_count: student.violations.length,
    proctoring_logs: student.violations,
    raw_answers: { ...student.answers },
    question_results: questionResults,
    topic_breakdown: { Chemistry: { totalMarks: 24, earnedMarks: 0, percentage: 0 } },
    status: 'submitted',
    teacher_adjusted_marks: 0,
    teacher_notes: '',
    result_pin: '',
    updated_at: new Date().toISOString(),
    draft_key: student.draftKey,
    draft_owner_token: student.draftOwnerToken,
  };
}

async function main() {
  const students = buildStudents(TOTAL_STUDENTS);
  const createdDrafts = new Map();
  const activeSockets = [];
  const paperCacheByCode = new Map();
  let healthProbeRunning = true;
  const globalT0 = performance.now();

  console.log(`\n🚀 Starting Live 037 Pre-Warm + 170-Student Stress Test (run=${RUN_TAG}, students=${TOTAL_STUDENTS})`);
  console.log(`   Reading live pre-warmed ICM-1..ICM-13 papers; isolated draft/submission writes target ${WRITE_QUIZ_CODE}.\n`);

  // Continuous 2s Supabase health probe
  const healthProbeLoop = (async () => {
    let tick = 0;
    while (healthProbeRunning) {
      tick++;
      const elapsedSec = Number(((performance.now() - globalT0) / 1000).toFixed(1));
      const [rpcPing, restPing] = await Promise.all([
        supaRpc('check_student_attempt_submitted', {
          p_quiz_code: 'ICM-1',
          p_student_name: `__health_037_${RUN_TAG}__`,
          p_student_class: 'X IPA 1',
        }, { timeoutMs: 10000 }),
        supaRest('app_config?select=value&key=eq.hide_emergency_exam_button', { timeoutMs: 10000 }),
      ]);
      const sample = {
        tick,
        elapsedSec,
        inFlight: inFlightRequests,
        rpcStatus: rpcPing.status,
        rpcMs: Number(rpcPing.durationMs.toFixed(1)),
        restStatus: restPing.status,
        restMs: Number(restPing.durationMs.toFixed(1)),
        healthy: rpcPing.status === 200 && restPing.status === 200 && rpcPing.durationMs < 3000 && restPing.durationMs < 3000,
      };
      healthSamples.push(sample);
      if (!sample.healthy) {
        console.warn(
          `  ⚠️ [HealthProbe t=${elapsedSec}s] DEGRADED: rpc=${sample.rpcMs}ms (HTTP ${sample.rpcStatus}), rest=${sample.restMs}ms (HTTP ${sample.restStatus}), inFlight=${sample.inFlight}`
        );
      }
      await sleep(2000);
    }
  })();

  try {
    // ── Phase 0: Security Verification on Migration 037 RPCs ──────────────────
    console.log('🔒 Phase 0: Verifying Migration 037 security boundaries (anon prewarm block + server PIN tamper check)...');
    const [anonPrewarmRes, spoofPinRes] = await Promise.all([
      supaRpc('prewarm_exam_paper_cache', { p_quiz_codes: ['ICM-1'] }),
      supaRpc('enter_student_exam_session', {
        p_payload: {
          quiz_code: 'ICM-1',
          student_name: `__spoof_probe_${RUN_TAG}__`,
          student_class: 'X IPA 1',
          student_pin: '0000',
          draft_key: `draft_ICM-1_spoof_${RUN_TAG}`,
          draft_owner_token: `spoof_${RUN_TAG}`,
          // Deliberately pass false to prove server enforces ICM-1's authoritative requireStudentPin=true
          require_student_pin: false,
          limit_one_attempt: true,
        },
      }),
    ]);

    const anonBlocked = anonPrewarmRes.status === 401 || anonPrewarmRes.status === 403 || anonPrewarmRes.status === 400 || /42501|authentication required/i.test(anonPrewarmRes.errorText);
    const spoofRejected = spoofPinRes.status === 200 && spoofPinRes.data?.valid === false && spoofPinRes.data?.status === 'invalid_pin';
    console.log(
      `   ✔ Anon prewarm blocked: ${anonBlocked} (HTTP ${anonPrewarmRes.status}) | Server ignored spoofed require_student_pin=false on ICM-1: ${spoofRejected} (status=${spoofPinRes.data?.status})`
    );
    if (!anonBlocked || !spoofRejected) {
      throw new Error(`Migration 037 security gate check failed: anonBlocked=${anonBlocked}, spoofRejected=${spoofRejected}`);
    }

    // ── Phase 1: 170 Simultaneous Code Entries (0..6000ms Boot Jitter -> Pre-Warmed ICM-1..ICM-13) ─
    console.log(`\n🌊 Phase 1: ${TOTAL_STUDENTS} students open exam links simultaneously across ICM-1..ICM-13 (0..6s client bootJitterMs, hitting Admin-prewarmed cache)...`);
    const p1T0 = performance.now();
    await Promise.all(
      students.map(async (student) => {
        await sleep(Math.floor(Math.random() * 6000));
        const res = await supaRpc('get_student_exam_paper', { p_code: student.liveExamCode });
        const questions = Array.isArray(res.data?.questions) ? res.data.questions : [];
        const hasLeakedSecrets =
          Boolean(res.data?.teacherPinHash) ||
          Boolean(res.data?.publishedQuiz?.teacherPin) ||
          Boolean(res.data?.publishedQuiz?.headerConfig?.teacherPin) ||
          questions.some((q) => q?.mark_scheme || q?.acceptable_answers);
        const ok =
          res.status === 200 &&
          res.data?.isActive === true &&
          questions.length > 0 &&
          Array.isArray(res.data?.publicRosterDirectory) &&
          !hasLeakedSecrets;

        if (ok) {
          student.questions = questions;
          paperCacheByCode.set(student.liveExamCode, questions);
        } else if (paperCacheByCode.has(student.liveExamCode)) {
          student.questions = paperCacheByCode.get(student.liveExamCode);
        }

        recordEvent({
          phase: 'phase_1_prewarmed_paper_load',
          cohort: student.cohort,
          actorId: student.studentId,
          examCode: student.liveExamCode,
          action: 'get_student_exam_paper',
          target: 'rpc:get_student_exam_paper',
          durationMs: res.durationMs,
          httpStatus: res.status,
          outcome: ok ? 'ok' : 'error',
          payloadBytes: res.payloadBytes,
          notes: hasLeakedSecrets ? 'SECRET_LEAK' : res.errorText || `q=${questions.length}`,
        });
      })
    );
    const p1WallMs = performance.now() - p1T0;
    console.log(`   ✔ Phase 1 completed in ${(p1WallMs / 1000).toFixed(2)}s (peakInFlight=${peakInFlightRequests})`);

    // ── Phase 2: 170 Students Click "Start Examination" -> Unified `enter_student_exam_session` ─
    console.log(`\n🌊 Phase 2: ${TOTAL_STUDENTS} students click Start simultaneously (0 lobby draft RPCs; 1 unified enter_student_exam_session RPC each + staggered initial draft save 1.5..5s)...`);
    const p2T0 = performance.now();
    const wsByCode = new Map();

    await Promise.all(
      students.map(async (student) => {
        await sleep(Math.floor(Math.random() * 800));
        const entryRes = await supaRpc('enter_student_exam_session', {
          p_payload: {
            quiz_code: WRITE_QUIZ_CODE,
            student_name: student.studentName,
            student_class: student.studentClass,
            candidate_number: student.candidateNumber,
            student_pin: student.joinPin,
            draft_key: student.draftKey,
            draft_owner_token: student.draftOwnerToken,
            require_student_pin: false,
            limit_one_attempt: true,
            acquire_lock: true,
          },
        });
        const entryOk =
          entryRes.status === 200 &&
          entryRes.data?.valid === true &&
          entryRes.data?.submitted === false &&
          entryRes.data?.status === 'ready';

        if (entryOk) {
          createdDrafts.set(student.draftKey, student.draftOwnerToken);
        }

        recordEvent({
          phase: 'phase_2_unified_start',
          cohort: student.cohort,
          actorId: student.studentId,
          examCode: student.liveExamCode,
          action: 'enter_student_exam_session',
          target: 'rpc:enter_student_exam_session',
          durationMs: entryRes.durationMs,
          httpStatus: entryRes.status,
          outcome: entryOk ? 'ok' : 'error',
          notes: entryRes.errorText || String(entryRes.data?.status || ''),
        });

        if (ENABLE_WEBSOCKETS) {
          let wsState = wsByCode.get(student.liveExamCode);
          if (!wsState) {
            const client = createClient(SUPABASE_URL, ANON_KEY);
            const ch = client.channel(`exam_proctor:${student.liveExamCode}`, {
              config: { broadcast: { self: false } },
            });
            wsState = { client, ch, subscribed: false };
            wsByCode.set(student.liveExamCode, wsState);
            activeSockets.push(wsState);
            ch.subscribe((status) => {
              wsState.subscribed = status === 'SUBSCRIBED';
            });
          }
          student._ws = wsState;
        }

        // Staggered initial draft save (1.5..5.0s after start, matching updated StudentQuizRunner.tsx)
        await sleep(1500 + Math.floor(Math.random() * 3500));
        student.answers = { 0: 'A', 1: 'B', 2: 'C' };
        const initDraftRes = await supaRpc('save_student_exam_draft', {
          p_key: student.draftKey,
          p_value: JSON.stringify(buildDraftPayload(student, 2, 2400)),
          p_owner_token: student.draftOwnerToken,
        });
        recordEvent({
          phase: 'phase_2_unified_start',
          cohort: student.cohort,
          actorId: student.studentId,
          examCode: student.liveExamCode,
          action: 'staggered_initial_draft_save',
          target: 'rpc:save_student_exam_draft',
          durationMs: initDraftRes.durationMs,
          httpStatus: initDraftRes.status,
          outcome: initDraftRes.status === 200 && initDraftRes.data === true ? 'ok' : 'error',
          payloadBytes: initDraftRes.payloadBytes,
          notes: initDraftRes.errorText,
        });
      })
    );
    const p2WallMs = performance.now() - p2T0;
    console.log(`   ✔ Phase 2 completed in ${(p2WallMs / 1000).toFixed(2)}s (peakInFlight=${peakInFlightRequests})`);

    // ── Phase 3: Active Mid-Exam Sitting (2 autosave rounds + crash-reload cloud recovery via enter_student_exam_session) ─
    console.log(`\n🌊 Phase 3: Active sitting (${(SITTING_DURATION_MS / 1000).toFixed(0)}s window: 2x draft saves + crash-reload atomic recovery checks)...`);
    const p3T0 = performance.now();
    await Promise.all(
      students.map(async (student) => {
        for (let round = 1; round <= 2; round++) {
          await sleep(Math.floor((SITTING_DURATION_MS / 2) * (0.4 + Math.random() * 0.6)));
          student.answers[round + 2] = round === 1 ? 'D' : 'B';
          const saveRes = await supaRpc('save_student_exam_draft', {
            p_key: student.draftKey,
            p_value: JSON.stringify(buildDraftPayload(student, round + 2, 1800)),
            p_owner_token: student.draftOwnerToken,
          });
          recordEvent({
            phase: 'phase_3_active_sitting',
            cohort: student.cohort,
            actorId: student.studentId,
            examCode: student.liveExamCode,
            action: 'periodic_save_draft',
            target: 'rpc:save_student_exam_draft',
            durationMs: saveRes.durationMs,
            httpStatus: saveRes.status,
            outcome: saveRes.status === 200 && saveRes.data === true ? 'ok' : 'error',
            payloadBytes: saveRes.payloadBytes,
            notes: saveRes.errorText,
          });
        }

        // Crash reloader students verify atomic cloud draft recovery via enter_student_exam_session
        if (student.cohort === 'reloader') {
          const recRes = await supaRpc('enter_student_exam_session', {
            p_payload: {
              quiz_code: WRITE_QUIZ_CODE,
              student_name: student.studentName,
              student_class: student.studentClass,
              candidate_number: student.candidateNumber,
              student_pin: student.joinPin,
              draft_key: student.draftKey,
              draft_owner_token: student.draftOwnerToken,
              require_student_pin: false,
              limit_one_attempt: true,
              acquire_lock: true,
            },
          });
          const recOk =
            recRes.status === 200 &&
            recRes.data?.status === 'draft_found' &&
            typeof recRes.data?.draftJson === 'string' &&
            recRes.data.draftJson.includes('"in_progress"');
          recordEvent({
            phase: 'phase_3_active_sitting',
            cohort: student.cohort,
            actorId: student.studentId,
            examCode: student.liveExamCode,
            action: 'crash_reload_enter_session',
            target: 'rpc:enter_student_exam_session',
            durationMs: recRes.durationMs,
            httpStatus: recRes.status,
            outcome: recOk ? 'ok' : 'error',
            notes: recRes.errorText || String(recRes.data?.status || ''),
          });
        }
      })
    );
    const p3WallMs = performance.now() - p3T0;
    console.log(`   ✔ Phase 3 completed in ${(p3WallMs / 1000).toFixed(2)}s`);

    // ── Phase 4: Synchronized 170-Student Timer Expiry Auto-Submit (0..15s Jitter, 4 Retries) ─
    console.log(`\n🌊 Phase 4: Simultaneous countdown expiry across all ${TOTAL_STUDENTS} students (0..15s auto-submit jitter -> submit_student_exam_attempt)...`);
    const p4T0 = performance.now();
    const submitResults = await Promise.all(
      students.map(async (student) => {
        await sleep(Math.floor(Math.random() * 15000));
        const row = buildSubmissionRow(student);
        let accepted = false;
        let attempts = 0;

        for (let attempt = 1; attempt <= 4; attempt++) {
          attempts = attempt;
          const res = await supaRpc('submit_student_exam_attempt', { p_row: row }, { timeoutMs: 20000 });
          const ok = res.status === 200 && res.data === true;
          recordEvent({
            phase: 'phase_4_timer_submit',
            cohort: student.cohort,
            actorId: student.studentId,
            examCode: student.liveExamCode,
            action: `submit_attempt_${attempt}`,
            target: 'rpc:submit_student_exam_attempt',
            durationMs: res.durationMs,
            httpStatus: res.status,
            outcome: ok ? 'ok' : 'error',
            payloadBytes: res.payloadBytes,
            notes: ok ? 'ok' : res.errorText || String(res.data),
          });
          if (ok) {
            accepted = true;
            createdDrafts.delete(student.draftKey);
            break;
          }
          if (res.status === 401 || res.status === 403 || /42501|another device/i.test(res.errorText)) {
            break;
          }
          if (attempt < 4) {
            await sleep(Math.round(1800 * Math.pow(1.85, attempt - 1) + Math.random() * 1400));
          }
        }
        return { student, accepted, attempts };
      })
    );
    const p4WallMs = performance.now() - p4T0;
    console.log(`   ✔ Phase 4 completed in ${(p4WallMs / 1000).toFixed(2)}s (peakInFlight=${peakInFlightRequests})`);

    healthProbeRunning = false;
    await healthProbeLoop;

    const countByAction = (prefix) => {
      const matching = allEvents.filter((e) => e.action.startsWith(prefix));
      const ok = matching.filter((e) => e.outcome === 'ok').length;
      const errs = matching.filter((e) => e.httpStatus >= 500 || e.httpStatus === 0 || e.outcome !== 'ok').length;
      return { total: matching.length, ok, errs, stats: calcPercentiles(matching.map((e) => e.durationMs)) };
    };

    const sPaper = countByAction('get_student_exam_paper');
    const sEnter = countByAction('enter_student_exam_session');
    const sInitDraft = countByAction('staggered_initial_draft_save');
    const sPeriodicDraft = countByAction('periodic_save_draft');
    const sReload = countByAction('crash_reload_enter_session');
    const sSubmit = countByAction('submit_attempt_');

    const totalHttp5xxOrTimeout = allEvents.filter((e) => e.httpStatus >= 500 || e.httpStatus === 0).length;
    const acceptedCount = submitResults.filter((r) => r.accepted).length;
    const degradedTicks = healthSamples.filter((h) => !h.healthy).length;
    const hRpc = calcPercentiles(healthSamples.map((h) => h.rpcMs));
    const hRest = calcPercentiles(healthSamples.map((h) => h.restMs));

    const slos = [
      {
        id: 'SLO-1',
        name: 'Zero HTTP 5xx / 522 / Timeout errors',
        actual: `${totalHttp5xxOrTimeout} errors`,
        passed: totalHttp5xxOrTimeout === 0,
      },
      {
        id: 'SLO-2',
        name: 'Pre-warmed Lobby Paper Load (`get_student_exam_paper` p95 < 1000 ms, 100% ok)',
        actual: `${sPaper.ok}/${sPaper.total} ok, p50=${sPaper.stats.p50}ms, p95=${sPaper.stats.p95}ms, max=${sPaper.stats.max}ms`,
        passed: sPaper.ok === sPaper.total && sPaper.stats.p95 < 1000,
      },
      {
        id: 'SLO-3',
        name: 'Unified Start RPC (`enter_student_exam_session` p95 < 1000 ms, 100% ok)',
        actual: `${sEnter.ok}/${sEnter.total} ok, p50=${sEnter.stats.p50}ms, p95=${sEnter.stats.p95}ms, max=${sEnter.stats.max}ms`,
        passed: sEnter.ok === sEnter.total && sEnter.stats.p95 < 1000,
      },
      {
        id: 'SLO-4',
        name: '100% Final Submission Delivery (0..15s timer jitter, p95 < 1500 ms)',
        actual: `${acceptedCount}/${TOTAL_STUDENTS} accepted, p50=${sSubmit.stats.p50}ms, p95=${sSubmit.stats.p95}ms, max=${sSubmit.stats.max}ms`,
        passed: acceptedCount === TOTAL_STUDENTS && sSubmit.stats.p95 < 1500,
      },
      {
        id: 'SLO-5',
        name: 'Zero Degraded 2s Supabase Health Probe Ticks (< 3000 ms)',
        actual: `${degradedTicks}/${healthSamples.length} degraded (rpc p95=${hRpc.p95}ms, rest p95=${hRest.p95}ms)`,
        passed: degradedTicks === 0,
      },
    ];

    console.log('\n═══════════════════════════════════════════════════════════════════════════');
    console.log('  LIVE 037 STRESS TEST RESULTS & STRICT SLO VERDICT');
    console.log('═══════════════════════════════════════════════════════════════════════════');
    for (const s of slos) {
      console.log(`  ${s.passed ? '✅ PASS' : '❌ FAIL'} [${s.id}] ${s.name}`);
      console.log(`          Actual: ${s.actual}`);
    }
    console.log(`  • Crash recovery (enter_student_exam_session): ${sReload.ok}/${sReload.total} ok (p50=${sReload.stats.p50}ms)`);
    console.log(`  • Staggered initial draft saves: ${sInitDraft.ok}/${sInitDraft.total} ok (p50=${sInitDraft.stats.p50}ms, p95=${sInitDraft.stats.p95}ms)`);
    console.log(`  • Mid-exam periodic draft saves: ${sPeriodicDraft.ok}/${sPeriodicDraft.total} ok (p50=${sPeriodicDraft.stats.p50}ms, p95=${sPeriodicDraft.stats.p95}ms)`);
    console.log(`  • Peak In-Flight HTTP Requests: ${peakInFlightRequests}`);
    console.log('═══════════════════════════════════════════════════════════════════════════\n');

    const md = [
      `# Live Migration 037 & Admin Pre-Warm Stress Test Report (\`ICM-1\`..\`ICM-13\`)`,
      '',
      `- **Run Tag**: \`${RUN_TAG}\``,
      `- **Simulated Students**: **${TOTAL_STUDENTS}** across **13 Live Exams (\`ICM-1\`..\`ICM-13\`)** + isolated \`${WRITE_QUIZ_CODE}\` write fixture`,
      `- **Total Wall Time**: **${((performance.now() - globalT0) / 1000).toFixed(1)}s**`,
      `- **Peak Concurrent In-Flight Requests**: **${peakInFlightRequests}**`,
      '',
      '## Strict SLO Verdict',
      '',
      '| SLO | Check | Actual | Verdict |',
      '| :--- | :--- | :--- | :---: |',
      ...slos.map((s) => `| **${s.id}** | ${s.name} | ${s.actual} | ${s.passed ? '✅ PASS' : '❌ FAIL'} |`),
      '',
      '## Phase Breakdown',
      '',
      '| Operation | Count | Ok | Errors | p50 (ms) | p95 (ms) | Max (ms) |',
      '| :--- | :---: | :---: | :---: | :---: | :---: | :---: |',
      `| **Pre-warmed Lobby Paper Load (\`get_student_exam_paper\`)** | ${sPaper.total} | ${sPaper.ok} | ${sPaper.errs} | ${sPaper.stats.p50} | ${sPaper.stats.p95} | ${sPaper.stats.max} |`,
      `| **Unified Start (\`enter_student_exam_session\`)** | ${sEnter.total} | ${sEnter.ok} | ${sEnter.errs} | ${sEnter.stats.p50} | ${sEnter.stats.p95} | ${sEnter.stats.max} |`,
      `| **Staggered Initial Draft (\`save_student_exam_draft\`)** | ${sInitDraft.total} | ${sInitDraft.ok} | ${sInitDraft.errs} | ${sInitDraft.stats.p50} | ${sInitDraft.stats.p95} | ${sInitDraft.stats.max} |`,
      `| **Mid-Exam Autosave (\`save_student_exam_draft\`)** | ${sPeriodicDraft.total} | ${sPeriodicDraft.ok} | ${sPeriodicDraft.errs} | ${sPeriodicDraft.stats.p50} | ${sPeriodicDraft.stats.p95} | ${sPeriodicDraft.stats.max} |`,
      `| **Crash Reload Recovery (\`enter_student_exam_session\`)** | ${sReload.total} | ${sReload.ok} | ${sReload.errs} | ${sReload.stats.p50} | ${sReload.stats.p95} | ${sReload.stats.max} |`,
      `| **Timer-Expiry Submit (\`submit_student_exam_attempt\`)** | ${sSubmit.total} | ${sSubmit.ok} | ${sSubmit.errs} | ${sSubmit.stats.p50} | ${sSubmit.stats.p95} | ${sSubmit.stats.max} |`,
      '',
      `Security probes verified in Phase 0: anonymous \`prewarm_exam_paper_cache\` blocked (${anonPrewarmRes.status}) and server rejected spoofed \`require_student_pin=false\` on \`ICM-1\` (\`status=${spoofPinRes.data?.status}\`).`,
      '',
    ].join('\n');

    fs.writeFileSync(REPORT_PATH, md, 'utf8');
    console.log(`📄 Report saved to ${REPORT_PATH}`);
    process.exitCode = slos.some((s) => !s.passed) ? 1 : 0;
  } finally {
    healthProbeRunning = false;
    if (activeSockets.length > 0) {
      await Promise.all(
        activeSockets.map(async ({ client, ch }) => {
          try {
            await client.removeChannel(ch);
          } catch {}
        })
      );
    }
    if (createdDrafts.size > 0) {
      const entries = Array.from(createdDrafts.entries());
      for (let i = 0; i < entries.length; i += 25) {
        await Promise.all(
          entries.slice(i, i + 25).map(([k, tok]) =>
            supaRpc('delete_student_exam_draft', { p_key: k, p_owner_token: tok })
          )
        );
      }
    }
    if (SERVICE_ROLE_KEY || TEACHER_SESSION_TOKEN) {
      const authHeaders = SERVICE_ROLE_KEY
        ? { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY }
        : { 'x-teacher-session': TEACHER_SESSION_TOKEN };
      await supaRest(`quiz_submissions?quiz_code=eq.${WRITE_QUIZ_CODE}`, {
        method: 'DELETE',
        bearer: SERVICE_ROLE_KEY || ANON_KEY,
        extraHeaders: authHeaders,
      });
    }
    eventStream.end();
  }
}

main()
  .catch((err) => {
    console.error('❌ Stress test failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });
