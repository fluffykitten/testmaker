import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createClient } from '@supabase/supabase-js';

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTION-GROUNDED FULL-FIDELITY STRESS TEST HARNESS
// (170-200 Students Across 13 Live Exams ICM-1..ICM-13 + 5 Teacher Dashboards)
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
const TEACHER_LOGIN_ID = ENV.TEACHER_LOGIN_ID || '';
const TEACHER_LOGIN_PASSWORD = ENV.TEACHER_LOGIN_PASSWORD || '';

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('❌ Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env.local');
  process.exit(1);
}

// CLI flags: --students=180 (default 180, i.e. 170+), --sitting-sec=45 (default 45s compressed 1-hour sitting)
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const clean = a.replace(/^--/, '');
    const [k, v] = clean.split('=');
    return [k, v ?? 'true'];
  })
);

const TOTAL_STUDENTS = Math.max(10, Math.min(300, Number(args.students || 180)));
const SITTING_DURATION_MS = Math.max(15, Math.min(1200, Number(args['sitting-sec'] || 45))) * 1000;
const ENABLE_WEBSOCKETS = args['no-ws'] !== 'true';
const APPROVE_DELETE = args['approve-delete'] === 'true';
const RUN_TAG = Date.now().toString(36);
const WRITE_QUIZ_CODE = 'STRESS200';
const WRITE_QUIZ_ID = 'stress-realistic-exam-fixture';

// Real 13-Exam -> Class mapping in live Supabase
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
const EVENTS_LOG_PATH = path.resolve('artifacts/realistic_stress_events.jsonl');
const REPORT_PATH = path.resolve('Plan/realistic_stress_test_report.md');
const eventStream = fs.createWriteStream(EVENTS_LOG_PATH, { flags: 'w' });

const allEvents = [];
const healthSamples = [];
let inFlightRequests = 0;
let peakInFlightRequests = 0;
const inFlightByTarget = new Map();

function trackInFlight(target, delta) {
  inFlightRequests += delta;
  if (inFlightRequests > peakInFlightRequests) {
    peakInFlightRequests = inFlightRequests;
  }
  const prev = inFlightByTarget.get(target) || 0;
  const next = Math.max(0, prev + delta);
  if (next === 0) inFlightByTarget.delete(target);
  else inFlightByTarget.set(target, next);
}

function recordEvent({
  phase,
  actorRole = 'student',
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
    actorRole,
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

// ─── HTTP / Supabase Helpers with Bounded Timeout & In-Flight Telemetry ──────

async function supaFetchJson(
  target,
  url,
  { method = 'GET', body, timeoutMs = 15000, extraHeaders = {}, bearer = ANON_KEY, prefer } = {}
) {
  trackInFlight(target, 1);
  const t0 = performance.now();
  const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
  let status = 0;
  let data = null;
  let errorText = '';

  try {
    for (let transportAttempt = 0; transportAttempt < 2; transportAttempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = {
          apikey: ANON_KEY,
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        };
        if (prefer) headers.Prefer = prefer;
        const res = await fetch(url, {
          method,
          signal: controller.signal,
          headers,
          body: bodyStr,
        });
        status = res.status;
        const raw = await res.text();
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = raw;
        }
        errorText = !res.ok
          ? typeof data === 'object' && data
            ? data.message || data.code || JSON.stringify(data)
            : raw
          : '';
        break;
      } catch (err) {
        if (err?.name === 'AbortError') {
          status = 544; // Client timeout waiting on PostgREST/Postgres
          errorText = `ClientAbortTimeout(${timeoutMs}ms)`;
          break;
        }
        status = 0;
        errorText = err?.message || String(err);
        // Retry once on transient non-abort TCP/TLS socket reset under high concurrency
        if (transportAttempt === 0) {
          await sleep(150 + Math.floor(Math.random() * 250));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    trackInFlight(target, -1);
  }

  return {
    status,
    data,
    errorText,
    durationMs: performance.now() - t0,
    payloadBytes: bodyStr ? Buffer.byteLength(bodyStr, 'utf8') : 0,
  };
}

async function supaRpc(fnName, rpcArgs, opts = {}) {
  return supaFetchJson(`rpc:${fnName}`, `${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    ...opts,
    method: 'POST',
    body: rpcArgs ?? {},
  });
}

async function supaRest(tablePath, opts = {}) {
  const method = opts.method || 'GET';
  const tableName = tablePath.split('?')[0];
  return supaFetchJson(`rest:${method}:${tableName}`, `${SUPABASE_URL}/rest/v1/${tablePath}`, opts);
}

// ─── Virtual Student Cohort Builder (Mapped Across Live ICM-1..ICM-13) ───────

function buildRealisticStudents(totalCount) {
  const weightedPool = [];
  for (const c of LIVE_EXAM_COHORTS) {
    for (let w = 0; w < c.weight; w++) {
      weightedPool.push(c);
    }
  }

  const students = [];
  for (let i = 1; i <= totalCount; i++) {
    const num = String(i).padStart(3, '0');
    const studentId = `STU-${num}`;
    const assigned = weightedPool[(i - 1) % weightedPool.length];

    // Behavioral cohorts matching real exam hall distribution:
    // - 70% normal steady test-takers
    // - 15% tab-switch / fullscreen-exit violators (triggering keepalive draft flushes + proctor audit inserts + PIN unlock)
    // - 10% mid-exam page reloaders (Wi-Fi drop / browser refresh -> full boot + draft recovery)
    // - 5% homonym / shared-device candidates
    let behavior = 'normal';
    if (i % 20 === 0) behavior = 'homonym_shared_device';
    else if (i % 10 === 3) behavior = 'mid_exam_reload';
    else if (i % 7 === 0) behavior = 'violator_tab_blur';

    const isEarlySubmitter = i % 5 === 0; // 20% submit early near minute 50-55 while others still save drafts; 80% hit simultaneous hour-end expiry
    const slugClass = assigned.className
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    const studentName =
      behavior === 'homonym_shared_device'
        ? `Muhammad Rizky (${RUN_TAG})`
        : `Sim Candidate ${num} (${RUN_TAG})`;

    const slugName = studentName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    const joinPin = String(1000 + ((i * 37) % 8999));
    // Draft key scoped to the real exam code for realistic draft/lock operations
    const draftKey = `draft_${WRITE_QUIZ_CODE}_${slugName}_${num}__cls_${slugClass}`.toLowerCase();
    const draftOwnerToken = `cls:${WRITE_QUIZ_CODE}:${slugName}_${num}__cls_${slugClass}`;

    students.push({
      index: i,
      studentId,
      behavior,
      isEarlySubmitter,
      liveExamCode: assigned.quizCode,
      studentClass: assigned.className,
      studentName,
      candidateNumber: `CAND-${RUN_TAG}-${num}`,
      joinPin,
      draftKey,
      draftOwnerToken,
      submissionId: `stress_real_${RUN_TAG}_stu_${num}`,
      answers: {},
      answerChangeLogs: [],
      violations: [],
      strikeCount: 0,
      questions: [],
    });
  }
  return students;
}

// ─── Realistic Payload Builders (Full 40-Question 1-Hour Sitting + Forensics) ─

function buildNormalized40Questions(liveQuestions) {
  const base = Array.isArray(liveQuestions) ? [...liveQuestions] : [];
  if (base.length >= 40) return base.slice(0, 40);
  const padded = [...base];
  for (let idx = padded.length; idx < 40; idx++) {
    const isStruct = idx >= 30;
    const isMulti = idx >= 25 && idx < 30;
    padded.push({
      id: `sim_1hr_q_${idx + 1}`,
      question_number: String(idx + 1),
      question_text: isStruct
        ? `Question ${idx + 1}: Analyze the experimental measurements recorded across a 60-minute assessment window and show all steps.`
        : `Question ${idx + 1}: Which conclusion best aligns with the printed physical and textual evidence presented in the stimulus above?`,
      options: isStruct
        ? undefined
        : [
            'A. Option statement alpha with quantitative justification',
            'B. Option statement beta with equilibrium shift',
            'C. Option statement gamma with boundary conservation',
            'D. Option statement delta with comparative interpretation',
          ],
      marks: isStruct ? 3 : 1,
      topic: isStruct ? 'Structured Analysis & Problem Solving' : isMulti ? 'Multi-Statement Evaluation' : 'Core Assessment Concepts',
      question_style: isStruct ? 'Structured' : isMulti ? 'Multiple Select' : 'Multiple Choice',
      sub_questions: isStruct
        ? [
            { sub_id: '(a)', question_text: 'State the governing relationship and identify key variables.', marks: 1 },
            { sub_id: '(b)', question_text: 'Calculate the resulting change and explain the physical significance.', marks: 2 },
          ]
        : [],
    });
  }
  return padded;
}

function generateAnswerForQuestion(q, qIdx, studentIdx, editRound) {
  const style = q?.question_style || 'Multiple Choice';
  if (style === 'Multiple Select') {
    return editRound % 2 === 0 ? 'A, C' : 'B, D';
  }
  if (Array.isArray(q?.sub_questions) && q.sub_questions.length > 0 && style !== 'Multiple Choice') {
    const obj = {};
    q.sub_questions.forEach((sq, sIdx) => {
      obj[sIdx] = `Candidate #${studentIdx} rev ${editRound} (${sq.sub_id || sIdx + 1}): energy conservation ΔU = Q - W governs the measured state change.`;
    });
    return obj;
  }
  if (Array.isArray(q?.options) && q.options.length > 0) {
    const letters = ['A', 'B', 'C', 'D'];
    return letters[(studentIdx + qIdx + editRound) % letters.length];
  }
  return `Detailed candidate response #${studentIdx} (rev ${editRound}) covering step-by-step reasoning and unit checks.`;
}

function buildRealisticDraftPayload(student, currentIndex, timeLeftSeconds) {
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
    startTime: Date.now() - (3600 - timeLeftSeconds) * 1000,
    targetEndTime: Date.now() + timeLeftSeconds * 1000,
    flaggedIndices: [2, 14, 33],
    audioProgress: { '/audio/pilot-english-listening.wav': { currentTime: 42.5, playedCount: 2 } },
    violations: student.violations,
    isLockedByProctor: false,
    lockReason: '',
    lockTime: '',
    lastSavedAt: new Date().toISOString(),
    status: 'in_progress',
    strikeCount: student.strikeCount,
    totalPenaltySeconds: student.strikeCount > 1 ? 300 : 0,
    tierHistory: [],
    autoSubmittedBySecurity: false,
  };
}

function buildRealisticSubmissionRow(student) {
  const qs = buildNormalized40Questions(student.questions);

  const questionResults = [];
  const topicBreakdown = {};
  const answersByQuestionId = {};
  const questionTimeAnalytics = [];
  let totalMarks = 0;

  qs.forEach((q, idx) => {
    const qMarks = Number(q.marks || 1);
    totalMarks += qMarks;
    const top = q.topic || 'General';
    if (!topicBreakdown[top]) {
      topicBreakdown[top] = { totalMarks: 0, earnedMarks: 0, percentage: 0 };
    }
    topicBreakdown[top].totalMarks += qMarks;

    const ans = student.answers[idx] ?? 'A';
    answersByQuestionId[q.id || `q_${idx + 1}`] = ans;

    questionTimeAnalytics.push({
      questionIndex: idx,
      questionId: String(q.id || `q_${idx + 1}`),
      totalDwellSeconds: 50 + ((student.index * 11 + idx * 17) % 125),
      visitCount: 1 + (idx % 3),
      firstVisitElapsedSeconds: idx * 80,
      lastVisitElapsedSeconds: idx * 80 + 48,
    });

    const subResults = Array.isArray(q.sub_questions) && q.sub_questions.length > 0
      ? q.sub_questions.map((sq, sIdx) => ({
        subId: sq.sub_id || String.fromCharCode(97 + sIdx),
        questionText: sq.question_text || 'Sub-question prompt text',
        studentAnswer: typeof ans === 'object' && ans !== null ? ans[sIdx] || '' : String(ans),
        earnedMarks: 0,
        maxMarks: sq.marks || 1,
        isCorrect: false,
        feedback: 'Awaiting examiner AI evaluation',
      }))
      : undefined;

    questionResults.push({
      questionId: q.id || `q_${idx + 1}`,
      questionNumber: idx + 1,
      questionText: q.question_text || `Question ${idx + 1}`,
      options: q.options || undefined,
      topic: top,
      maxMarks: qMarks,
      earnedMarks: 0,
      isCorrect: false,
      studentAnswer: typeof ans === 'object' ? JSON.stringify(ans) : ans,
      correctAnswer: 'See mark scheme',
      misconceptions: [],
      aiFeedback: 'Awaiting examiner AI evaluation',
      gradingMethod: 'deterministic',
      subQuestionResults: subResults,
    });
  });

  const forensics = {
    answerChangeLogs: student.answerChangeLogs,
    questionTimeAnalytics,
    answersByQuestionId,
    exceededMaxViolations: false,
    proctorStudentId: `${student.liveExamCode}::${student.candidateNumber}`,
    totalPenaltySeconds: student.strikeCount > 1 ? 300 : 0,
    finalStrikeCount: student.strikeCount,
    autoSubmittedBySecurity: false,
    tierHistory: [],
    // Supplying student_pin triggers verify_roster_pin_if_enrolled inside submit_student_exam_attempt!
    studentPin: student.joinPin,
  };

  return {
    id: student.submissionId,
    quiz_id: WRITE_QUIZ_ID,
    quiz_code: WRITE_QUIZ_CODE,
    quiz_title: `Realistic 1-Hour Multi-Exam Simulation (${student.liveExamCode})`,
    subject: 'Multi-Subject 40Q Pilot',
    student_name: student.studentName,
    student_class: student.studentClass,
    candidate_number: student.candidateNumber,
    submitted_at: new Date().toISOString(),
    duration_seconds: student.isEarlySubmitter ? 2950 + (student.index % 240) : 3540 + (student.index % 60),
    score: 0,
    total_marks: totalMarks || 60,
    percentage: 0,
    violations_count: student.violations.length,
    proctoring_logs: student.violations,
    raw_answers: {
      ...student.answers,
      _forensics: forensics,
    },
    question_results: questionResults,
    topic_breakdown: topicBreakdown,
    status: 'submitted',
    teacher_adjusted_marks: 0,
    teacher_notes: '',
    result_pin: '',
    updated_at: new Date().toISOString(),
    draft_key: student.draftKey,
    draft_owner_token: student.draftOwnerToken,
    // Forces submit_student_exam_attempt to run verify_roster_pin_if_enrolled on every submission
    student_pin: student.joinPin,
  };
}

// ─── Full-Fidelity Student Browser Lifecycle Simulator ──────────────────────

async function executeStudentBootMount(student, phaseLabel, paperCacheByCode) {
  // Post-Step 2 student browser mount:
  //   - TeacherProfileProvider skips `teacher_profiles` when !hasActiveTeacherSession()
  //   - PortalLandingPage does not mount on direct /?code=ICM-1 links
  //   - StudentQuizRunner skips RLS-blocked `app_config` reads (`school_classes`, `security_tiers`, `hide_emergency_exam_button`)
  //   - StudentQuizRunner applies 0..3400ms client boot smoothing jitter before `resolveStudentQuiz`
  //     (matching Phase 3 upload smoothing jitter) so 200 cold TLS paper fetches don't collide in 0..600ms.
  //   - `get_student_exam_paper` bundles `publicRosterDirectory` & lobby settings (when Migration 036 is live);
  //     otherwise falls back to `get_public_roster_directory` ONCE per tab session (cached in memory across mid-exam reloads).
  await sleep(Math.floor(Math.random() * 3400));
  const paperRes = await supaRpc('get_student_exam_paper', { p_code: student.liveExamCode });

  if (paperRes.status === 200 && Array.isArray(paperRes.data?.questions) && paperRes.data.questions.length > 0) {
    const padded = buildNormalized40Questions(paperRes.data.questions);
    student.questions = padded;
    paperCacheByCode.set(student.liveExamCode, padded);
  } else if (paperCacheByCode.has(student.liveExamCode)) {
    student.questions = paperCacheByCode.get(student.liveExamCode);
  } else {
    student.questions = buildNormalized40Questions([]);
  }

  const paperOk =
    paperRes.status === 200 &&
    paperRes.data?.isActive === true &&
    Array.isArray(paperRes.data?.questions) &&
    paperRes.data.questions.length > 0;

  recordEvent({
    phase: phaseLabel,
    cohort: student.behavior,
    actorId: student.studentId,
    examCode: student.liveExamCode,
    action: 'get_student_exam_paper',
    target: `rpc:get_student_exam_paper`,
    durationMs: paperRes.durationMs,
    httpStatus: paperRes.status,
    outcome: paperOk ? 'ok' : 'error',
    notes: paperOk ? `q=${paperRes.data.questions.length}` : paperRes.errorText || 'inactive_or_empty',
  });

  if (Array.isArray(paperRes.data?.publicRosterDirectory)) {
    student._rosterCached = true;
  } else if (!student._rosterCached) {
    await sleep(150 + Math.floor(Math.random() * 1000));
    const rosterDirRes = await supaRpc('get_public_roster_directory', {});
    if (rosterDirRes.status === 200 && Array.isArray(rosterDirRes.data)) {
      student._rosterCached = true;
    }
    recordEvent({
      phase: phaseLabel,
      cohort: student.behavior,
      actorId: student.studentId,
      examCode: student.liveExamCode,
      action: 'get_public_roster_directory',
      target: 'rpc:get_public_roster_directory',
      durationMs: rosterDirRes.durationMs,
      httpStatus: rosterDirRes.status,
      outcome: rosterDirRes.status === 200 ? 'ok' : 'error',
      notes: rosterDirRes.errorText,
    });
  }
}

async function executeStudentLobbyTyping(student, phaseLabel) {
  // Post-Step 2 lobby draft check: fires once (1200ms debounce) only after BOTH name and class are entered
  const draftCheck1 = await supaRpc('get_student_exam_draft', {
    p_key: student.draftKey,
    p_owner_token: student.draftOwnerToken,
  });
  recordEvent({
    phase: phaseLabel,
    cohort: student.behavior,
    actorId: student.studentId,
    examCode: student.liveExamCode,
    action: 'lobby_typing_draft_probe_1',
    target: 'rpc:get_student_exam_draft',
    durationMs: draftCheck1.durationMs,
    httpStatus: draftCheck1.status,
    outcome: draftCheck1.status === 200 ? 'ok' : 'error',
    notes: draftCheck1.errorText,
  });
}

async function executeStudentClickBeginExam(student, phaseLabel, createdDrafts) {
  // Student clicks "Begin Exam Now" (handleStartExam in StudentQuizRunner.tsx:3967):
  //   1. verify_student_pin (sequential before attempt check)
  //   2. check_student_attempt_submitted (sequential before start)
  //   3. immediate initial save_student_exam_draft (StudentQuizRunner.tsx:4123)
  const pinRes = await supaRpc('verify_student_pin', {
    p_name: `Sim Join Probe ${RUN_TAG}-${student.studentId}`,
    p_class: student.studentClass,
    p_pin: student.joinPin,
  });
  recordEvent({
    phase: phaseLabel,
    cohort: student.behavior,
    actorId: student.studentId,
    examCode: student.liveExamCode,
    action: 'verify_student_pin_on_start',
    target: 'rpc:verify_student_pin',
    durationMs: pinRes.durationMs,
    httpStatus: pinRes.status,
    outcome: pinRes.status === 200 && pinRes.data && typeof pinRes.data === 'object' ? 'ok' : 'error',
    notes: pinRes.errorText,
  });

  const attemptRes = await supaRpc('check_student_attempt_submitted', {
    p_quiz_code: student.liveExamCode,
    p_student_name: student.studentName,
    p_student_class: student.studentClass,
    p_student_number: student.candidateNumber,
  });
  recordEvent({
    phase: phaseLabel,
    cohort: student.behavior,
    actorId: student.studentId,
    examCode: student.liveExamCode,
    action: 'check_student_attempt_submitted',
    target: 'rpc:check_student_attempt_submitted',
    durationMs: attemptRes.durationMs,
    httpStatus: attemptRes.status,
    outcome: attemptRes.status === 200 && attemptRes.data?.submitted === false ? 'ok' : 'error',
    notes: attemptRes.errorText,
  });

  createdDrafts.set(student.draftKey, student.draftOwnerToken);
  const initialDraftPayload = buildRealisticDraftPayload(student, 0, 1200);
  const initDraftRes = await supaRpc('save_student_exam_draft', {
    p_key: student.draftKey,
    p_value: JSON.stringify(initialDraftPayload),
    p_owner_token: student.draftOwnerToken,
  });
  recordEvent({
    phase: phaseLabel,
    cohort: student.behavior,
    actorId: student.studentId,
    examCode: student.liveExamCode,
    action: 'initial_start_save_draft',
    target: 'rpc:save_student_exam_draft',
    durationMs: initDraftRes.durationMs,
    httpStatus: initDraftRes.status,
    outcome: initDraftRes.status === 200 && initDraftRes.data === true ? 'ok' : 'error',
    payloadBytes: initDraftRes.payloadBytes,
    notes: initDraftRes.errorText,
  });
}

async function executeStudentBootAndLobby(student, phaseLabel, createdDrafts, paperCacheByCode) {
  await executeStudentBootMount(student, phaseLabel, paperCacheByCode);
  await executeStudentLobbyTyping(student, phaseLabel);
  await executeStudentClickBeginExam(student, phaseLabel, createdDrafts);
}

async function submitStudentAttemptWithRetries(student, phaseLabel, createdDrafts, submittedIds) {
  if (student._ws?.subscribed) {
    const nowIso = new Date().toISOString();
    void student._ws.ch.send({
      type: 'broadcast',
      event: 'student_heartbeat',
      payload: {
        studentId: student.candidateNumber,
        studentName: student.studentName,
        candidateNumber: student.candidateNumber,
        candidateClass: student.studentClass,
        quizCode: student.liveExamCode,
        status: 'submitted',
        answeredCount: 40,
        totalQuestions: 40,
        currentIndex: 40,
        timeLeftSeconds: 0,
        violationsCount: student.violations.length,
        lastHeartbeat: Date.now(),
      },
    });
    void student._ws.ch.send({
      type: 'broadcast',
      event: 'proctor_log_event',
      payload: {
        id: `sub_evt_${RUN_TAG}_${student.studentId}`,
        timestamp: nowIso,
        studentId: student.candidateNumber,
        studentName: student.studentName,
        candidateNumber: student.candidateNumber,
        candidateClass: student.studentClass,
        heartbeatKey: student.draftOwnerToken,
        quizCode: student.liveExamCode,
        type: 'submitted',
        detail: 'Exam submitted (40/40 answered)',
        severity: 'info',
      },
    });
  }

  const row = buildRealisticSubmissionRow(student);
  let accepted = false;
  let attempts = 0;
  let firstAttemptMs = 0;
  let totalSubmitMs = 0;
  let lastRes = null;
  const subStart = performance.now();

  for (let attempt = 1; attempt <= 3; attempt++) {
    attempts = attempt;
    const res = await supaRpc('submit_student_exam_attempt', { p_row: row }, { timeoutMs: 25000 });
    lastRes = res;
    if (attempt === 1) firstAttemptMs = res.durationMs;

    const ok = res.status === 200 && res.data === true;
    recordEvent({
      phase: phaseLabel,
      cohort: student.behavior,
      actorId: student.studentId,
      examCode: student.liveExamCode,
      action: `submit_attempt_${attempt}`,
      target: 'rpc:submit_student_exam_attempt',
      durationMs: res.durationMs,
      httpStatus: res.status,
      outcome: ok ? 'ok' : 'error',
      payloadBytes: res.payloadBytes,
      notes: ok ? `early=${student.isEarlySubmitter}` : res.errorText || String(res.data),
    });

    if (ok) {
      accepted = true;
      submittedIds.push(student.submissionId);
      break;
    }

    if (res.status === 401 || res.status === 403 || /42501|another device/i.test(res.errorText)) {
      break;
    }

    if (attempt < 3) {
      const backoffMs = Math.round(1200 * Math.pow(1.8, attempt - 1) + Math.random() * 600);
      await sleep(backoffMs);
    }
  }
  totalSubmitMs = performance.now() - subStart;

  if (accepted) {
    createdDrafts.delete(student.draftKey);
  }

  return {
    student,
    accepted,
    attempts,
    firstAttemptMs,
    totalSubmitMs,
    draftCleared: accepted,
    payloadBytes: lastRes?.payloadBytes || 0,
    errorText: lastRes?.errorText || '',
  };
}

// ─── Main Orchestrator ───────────────────────────────────────────────────────

async function main() {
  const students = buildRealisticStudents(TOTAL_STUDENTS);
  const createdDrafts = new Map();
  const submittedIds = [];
  const paperCacheByCode = new Map();
  const activeSockets = [];
  let teacherSessionHeader = null;

  console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  PRODUCTION-GROUNDED REALISTIC EXAM SITTING STRESS TEST (${String(TOTAL_STUDENTS).padStart(3)} STUDENTS + 5 PROCTORS) ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════════════════╝`);
  console.log(`  • Run ID               : ${RUN_TAG}`);
  console.log(`  • Live Exam Codes      : ICM-1 .. ICM-13 (13 Simultaneous Class Assessments)`);
  console.log(`  • Virtual Students     : ${TOTAL_STUDENTS} (70% normal, 15% violators, 10% reloaders, 5% homonyms)`);
  console.log(`  • Teacher Dashboards   : 3 Live Invigilator Cockpits + 2 Live Results Watchers`);
  console.log(`  • Active Sitting Window: ${(SITTING_DURATION_MS / 1000).toFixed(0)}s (overlapping WebSockets + DB writes + health probe)`);
  console.log(`  • Telemetry JSONL      : ${EVENTS_LOG_PATH}\n`);

  const globalT0 = performance.now();
  let healthProbeRunning = true;

  // Authenticate teacher session if credentials provided
  if (TEACHER_SESSION_TOKEN) {
    teacherSessionHeader = { 'x-teacher-session': TEACHER_SESSION_TOKEN };
    console.log('  🔐 Teacher Auth        : Using provided TEACHER_SESSION_TOKEN');
  } else if (TEACHER_LOGIN_ID && TEACHER_LOGIN_PASSWORD) {
    const authRes = await supaRpc('login_teacher_account', {
      p_identifier: TEACHER_LOGIN_ID,
      p_password: TEACHER_LOGIN_PASSWORD,
    });
    if (authRes.status === 200 && authRes.data?.token) {
      teacherSessionHeader = { 'x-teacher-session': authRes.data.token };
      const teacherName = authRes.data?.profile?.name || TEACHER_LOGIN_ID;
      console.log(`  🔐 Teacher Auth        : Authenticated as "${teacherName}" (${authRes.durationMs.toFixed(1)}ms)`);
    } else {
      console.warn(`  ⚠️ Teacher Auth        : login_teacher_account failed (HTTP ${authRes.status}: ${authRes.data?.error || authRes.errorText || 'unknown error'})`);
    }
  }
  console.log(`  🛡️ Delete Approval Gate: ${APPROVE_DELETE ? 'ENABLED (--approve-delete=true)' : 'SAFE MODE (NO automatic DB deletes)'}\n`);

  // ── Start Continuous 2-Second Supabase Health Probe ─────────────────────────
  const healthProbeLoop = (async () => {
    let tick = 0;
    while (healthProbeRunning) {
      tick++;
      const elapsedSec = Number(((performance.now() - globalT0) / 1000).toFixed(1));
      const [rpcPing, restPing] = await Promise.all([
        supaRpc('check_student_attempt_submitted', {
          p_quiz_code: 'ICM-1',
          p_student_name: `__health_probe_${RUN_TAG}__`,
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
        healthy:
          rpcPing.status === 200 &&
          restPing.status === 200 &&
          rpcPing.durationMs < 3000 &&
          restPing.durationMs < 3000,
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

  // ── Start 5 Concurrent Teacher / Invigilator Dashboards ─────────────────────
  let invigilatorHeartbeatsReceived = 0;
  let invigilatorLogsReceived = 0;
  let invigilatorDuplicateAuditsSent = 0;
  let resultsWatcherTriggers = 0;
  const teacherClients = [];
  const teacherMountPromises = [];
  const proctorRoomChannels = new Map();
  const proctorKeyId = `proctor_key_${RUN_TAG}`;
  let proctorPublicJwk = null;

  if (teacherSessionHeader) {
    try {
      const kp = await webcrypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
      );
      const jwk = await webcrypto.subtle.exportKey('jwk', kp.publicKey);
      proctorPublicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true };
    } catch { }
  }

  if (ENABLE_WEBSOCKETS) {
    console.log('👩‍🏫 Starting 3 Live Invigilator Cockpits (all 13 exam channels + cache pre-warm) + 2 Live Results Modal Watchers...');
    for (let tIdx = 1; tIdx <= 3; tIdx++) {
      const tClient = createClient(SUPABASE_URL, ANON_KEY);
      teacherClients.push(tClient);

      // Mount queries executed by LiveInvigilatorModal.tsx
      const watchedCohorts = LIVE_EXAM_COHORTS.filter((_, cIdx) => cIdx % 3 === (tIdx - 1));
      teacherMountPromises.push(
        Promise.all([
          supaRest('app_config?select=value&key=eq.school_classes'),
          supaRest('app_config?select=value&key=eq.school_roster'),
          supaRpc('is_authenticated_teacher', {}, { extraHeaders: teacherSessionHeader || {} }),
        ]).then(([cRes, rRes, aRes]) => {
          recordEvent({
            phase: 'phase_0_teacher_mount',
            actorRole: 'invigilator',
            cohort: 'teacher_cockpit',
            actorId: `INVIG-${tIdx}`,
            examCode: 'ALL-13',
            action: 'invigilator_mount_queries',
            target: 'rpc:is_authenticated_teacher+app_config',
            durationMs: Math.max(cRes.durationMs, rRes.durationMs, aRes.durationMs),
            httpStatus: aRes.status,
            outcome: aRes.status === 200 ? 'ok' : 'error',
          });
        })
      );

      // Staggered pre-warm of exam_paper_cache matching LiveInvigilatorModal.tsx (idx * 80ms)
      watchedCohorts.forEach((c, cIdx) => {
        teacherMountPromises.push(
          sleep(cIdx * 80).then(async () => {
            const warmRes = await supaRpc('get_student_exam_paper', { p_code: c.quizCode });
            if (warmRes.status === 200 && Array.isArray(warmRes.data?.questions) && warmRes.data.questions.length > 0) {
              paperCacheByCode.set(c.quizCode, buildNormalized40Questions(warmRes.data.questions));
            }
            recordEvent({
              phase: 'phase_0_teacher_mount',
              actorRole: 'invigilator',
              cohort: 'teacher_cockpit',
              actorId: `INVIG-${tIdx}`,
              examCode: c.quizCode,
              action: 'invigilator_prewarm_paper',
              target: 'rpc:get_student_exam_paper',
              durationMs: warmRes.durationMs,
              httpStatus: warmRes.status,
              outcome: warmRes.status === 200 ? 'ok' : 'error',
            });

            if (teacherSessionHeader && proctorPublicJwk && APPROVE_DELETE && tIdx === 1 && cIdx === 0) {
              const keyRes = await supaRpc(
                'register_proctor_public_key',
                { p_quiz_code: WRITE_QUIZ_CODE, p_key_id: proctorKeyId, p_public_jwk: proctorPublicJwk },
                { extraHeaders: teacherSessionHeader }
              );
              recordEvent({
                phase: 'phase_0_teacher_mount',
                actorRole: 'invigilator',
                cohort: 'teacher_cockpit',
                actorId: `INVIG-${tIdx}`,
                examCode: WRITE_QUIZ_CODE,
                action: 'invigilator_register_proctor_key',
                target: 'rpc:register_proctor_public_key',
                durationMs: keyRes.durationMs,
                httpStatus: keyRes.status,
                outcome: keyRes.status === 200 && keyRes.data === true ? 'ok' : 'error',
                notes: keyRes.errorText,
              });
            }
          })
        );
      });

      // Subscribe to exam_proctor:ICM-1..ICM-13 (sampled across the 3 proctors)
      for (const c of watchedCohorts) {
        const ch = tClient.channel(`exam_proctor:${c.quizCode}`, {
          config: { broadcast: { self: false } },
        });
        ch.on('broadcast', { event: 'student_heartbeat' }, () => {
          invigilatorHeartbeatsReceived++;
        });
        ch.on('broadcast', { event: 'proctor_log_event' }, () => {
          invigilatorLogsReceived++;
          // LiveInvigilatorModal calls recordProctorAuditEvent(..., { localOnly: true })
          // so incoming WebSocket broadcasts never trigger duplicate DB audit inserts.
        });
        ch.subscribe();
        proctorRoomChannels.set(c.quizCode, { ch, subscribed: true });
        activeSockets.push({ client: tClient, ch });
      }
    }

    // 2 QuizResultsModal Watchers subscribed to postgres_changes on quiz_submissions
    // Mirrors QuizResultsModal.tsx:390-408: filters by quizCode & debounces refreshSubmissions by 2500ms
    const watcherTimers = [];
    for (let rIdx = 1; rIdx <= 2; rIdx++) {
      const rClient = createClient(SUPABASE_URL, ANON_KEY);
      teacherClients.push(rClient);
      let refreshTimer = null;
      const timerEntry = { clear: () => { if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; } } };
      watcherTimers.push(timerEntry);
      const ch = rClient
        .channel(`quiz_results_${WRITE_QUIZ_CODE}_${rIdx}_${Date.now()}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'quiz_submissions' },
          (payload) => {
            const row = payload?.new || payload?.old;
            if (row && row.quiz_code && String(row.quiz_code).toUpperCase() !== WRITE_QUIZ_CODE) {
              return;
            }
            resultsWatcherTriggers++;
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => {
              refreshTimer = null;
              void supaRest(
                `quiz_submissions?quiz_code=eq.${WRITE_QUIZ_CODE}&select=id,quiz_id,quiz_code,student_name,student_class,score,total_marks,status,submitted_at&order=submitted_at.desc&limit=250`,
                { extraHeaders: teacherSessionHeader || {} }
              ).then((res) => {
                recordEvent({
                  phase: 'teacher_results_watcher',
                  actorRole: 'teacher_results',
                  cohort: 'results_modal',
                  actorId: `RESULTS-${rIdx}`,
                  examCode: WRITE_QUIZ_CODE,
                  action: 'results_modal_refresh_submissions',
                  target: 'table:quiz_submissions(select)',
                  durationMs: res.durationMs,
                  httpStatus: res.status,
                  outcome: res.status === 200 ? 'ok' : 'error',
                  notes: res.errorText,
                });
              });
            }, 2500);
          }
        )
        .subscribe();
      activeSockets.push({ client: rClient, ch, timerEntry });
    }

    // Wait for Phase 0 Invigilator Cockpits to mount & pre-warm caches before instructing students to open links
    await Promise.all(teacherMountPromises);
  }

  let dbForensics = {
    mode: SERVICE_ROLE_KEY ? 'service_role' : teacherSessionHeader ? 'teacher_session' : 'anon_rpc_sample',
    persistedSubmissionCount: null,
    totalStressSubmissionCount: null,
    persistedAuditCount: null,
    totalStressAuditCount: null,
    orphanedAppConfigDraftKeys: null,
    totalStressDraftKeys: null,
    sampleAttemptChecksOk: 0,
    sampleAttemptChecksTotal: 0,
    sampleResultLookupsOk: 0,
    sampleDraftOrphansFound: 0,
    sampleProctorKeyLookupsOk: 0,
  };

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 1: Synchronized Exam Hall Arrival ("Open Link!" -> "Fill Form!" -> "Click Begin Exam!")
    // ══════════════════════════════════════════════════════════════════════════
    console.log(`\n🌊 PHASE 1A: Proctor says "Open the exam link!" (${TOTAL_STUDENTS} students open over 0..1200ms stratified + 0..3400ms client boot jitter)...`);
    const p1T0 = performance.now();

    await Promise.all(
      students.map(async (student) => {
        await sleep(Math.floor(((student.index - 1) / TOTAL_STUDENTS) * 1200));
        await executeStudentBootMount(student, 'phase_1a_boot_mount', paperCacheByCode);
      })
    );
    console.log(`   ✔ Phase 1A boot mount completed at ${((performance.now() - p1T0) / 1000).toFixed(2)}s (peakInFlight=${peakInFlightRequests})`);

    console.log(`🌊 PHASE 1B: Students enter name, class & 4-digit PIN (debounced get_student_exam_draft probe)...`);
    await Promise.all(
      students.map(async (student) => {
        await sleep(Math.floor(Math.random() * 600));
        await executeStudentLobbyTyping(student, 'phase_1b_lobby_typing');
      })
    );

    console.log(`🌊 PHASE 1C: Proctor says "Click Begin Exam Now!" (${TOTAL_STUDENTS} students fire verify_student_pin + check_attempt + initial save_draft + 13 pooled room WebSockets in 0..600ms)...`);
    const studentWsByExamCode = new Map();
    await Promise.all(
      students.map(async (student) => {
        await sleep(Math.floor(Math.random() * 600));
        await executeStudentClickBeginExam(student, 'phase_1c_begin_exam', createdDrafts);

        if (ENABLE_WEBSOCKETS) {
          let wsState = studentWsByExamCode.get(student.liveExamCode);
          if (!wsState) {
            const sClient = createClient(SUPABASE_URL, ANON_KEY);
            const sCh = sClient.channel(`exam_proctor:${student.liveExamCode}`, {
              config: { broadcast: { self: false } },
            });
            wsState = { client: sClient, ch: sCh, subscribed: false, pendingHeartbeats: [] };
            studentWsByExamCode.set(student.liveExamCode, wsState);
            activeSockets.push(wsState);
            sCh.subscribe((status) => {
              wsState.subscribed = status === 'SUBSCRIBED';
              if (status === 'SUBSCRIBED') {
                while (wsState.pendingHeartbeats.length > 0) {
                  void sCh.send(wsState.pendingHeartbeats.shift());
                }
              }
            });
          }
          student._ws = wsState;
          const heartbeatMsg = {
            type: 'broadcast',
            event: 'student_heartbeat',
            payload: {
              studentId: student.candidateNumber,
              studentName: student.studentName,
              candidateNumber: student.candidateNumber,
              candidateClass: student.studentClass,
              quizCode: student.liveExamCode,
              status: 'active',
              answeredCount: 0,
              totalQuestions: 40,
              currentIndex: 1,
              timeLeftSeconds: 3600,
              violationsCount: 0,
              lastHeartbeat: Date.now(),
            },
          };
          if (wsState.subscribed) {
            void wsState.ch.send(heartbeatMsg);
          } else {
            wsState.pendingHeartbeats.push(heartbeatMsg);
          }
        }
      })
    );

    const p1WallMs = Number((performance.now() - p1T0).toFixed(1));
    console.log(`   ✔ Phase 1 completed in ${(p1WallMs / 1000).toFixed(2)}s (inFlight=${inFlightRequests}, peakInFlight=${peakInFlightRequests})`);

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2: Compressed 1-Hour Active Multi-Exam Sitting (6 x 10-Min Checkpoints)
    //          40 Questions, ~48 Answer Logs, Tab-Blur Violations, Mid-Exam Reloads,
    //          Invigilator Mid-Exam Broadcast Command, & 20% Early Finishers
    // ══════════════════════════════════════════════════════════════════════════
    console.log(`\n🌊 PHASE 2: Running ${(SITTING_DURATION_MS / 1000).toFixed(0)}s compressed 1-hour sitting (6 checkpoints, 40 Qs, ~45 KB payloads) across ICM-1..ICM-13...`);
    const p2T0 = performance.now();
    const earlySubmitResults = [];
    let midExamBroadcastTriggered = false;
    const verifiedRoomKeyCodes = new Set();

    await Promise.all(
      students.map(async (student) => {
        const numQuestions = 40;
        const rounds = 6;
        const intervalMs = Math.floor(SITTING_DURATION_MS / (rounds + 1));

        // Deterministic stratified offset + jitter mirroring StudentQuizRunner's 12..18s cloud draft debounce
        const stratifiedOffsetMs = Math.floor(((student.index - 1) / TOTAL_STUDENTS) * intervalMs);
        await sleep(stratifiedOffsetMs + Math.floor(Math.random() * 1800));

        for (let r = 1; r <= rounds; r++) {
          await sleep(intervalMs + Math.floor(Math.random() * 2500));

          // At Round 3 (Minute 30), invigilators broadcast proctor_sync_request + add_time command
          // and student rooms check get_proctor_public_key cleanly once per room
          if (r === 3 && !midExamBroadcastTriggered && ENABLE_WEBSOCKETS) {
            midExamBroadcastTriggered = true;
            for (const c of LIVE_EXAM_COHORTS) {
              const room = proctorRoomChannels.get(c.quizCode);
              if (room?.ch) {
                void room.ch.send({
                  type: 'broadcast',
                  event: 'proctor_sync_request',
                  payload: { quizCode: c.quizCode, requestedAt: Date.now() },
                });
                void room.ch.send({
                  type: 'broadcast',
                  event: 'proctor_cmd',
                  payload: {
                    id: `cmd_${RUN_TAG}_${c.quizCode}`,
                    type: 'announcement',
                    targetStudentId: 'ALL',
                    detail: 'Halfway mark (30 mins elapsed). Check your diagrams and calculations.',
                    keyId: proctorKeyId,
                    issuedAt: Date.now(),
                  },
                });
              }
            }
          }

          if (r === 3 && !verifiedRoomKeyCodes.has(student.liveExamCode)) {
            verifiedRoomKeyCodes.add(student.liveExamCode);
            const keyLookupRes = await supaRpc('get_proctor_public_key', {
              p_quiz_code: student.liveExamCode,
              p_key_id: proctorKeyId,
            });
            const lookupOk = keyLookupRes.status === 200 && keyLookupRes.data && typeof keyLookupRes.data === 'object';
            if (lookupOk) dbForensics.sampleProctorKeyLookupsOk++;
            recordEvent({
              phase: 'phase_2_active_sitting',
              cohort: student.behavior,
              actorId: student.studentId,
              examCode: student.liveExamCode,
              action: 'get_proctor_public_key',
              target: 'rpc:get_proctor_public_key',
              durationMs: keyLookupRes.durationMs,
              httpStatus: keyLookupRes.status,
              outcome: lookupOk ? 'ok' : 'error',
              notes: keyLookupRes.errorText,
            });
          }

          // Answer/revise 7 questions per round across all 40 questions (42 changes by Round 6)
          const qsPerRound = 7;
          for (let qOffset = 0; qOffset < qsPerRound; qOffset++) {
            const qIdx = ((r - 1) * qsPerRound + qOffset) % numQuestions;
            const qObj = student.questions[qIdx];
            const prevAns = student.answers[qIdx];
            const nextAns = generateAnswerForQuestion(qObj, qIdx, student.index, r);
            student.answers[qIdx] = nextAns;
            student.answerChangeLogs.push({
              questionIndex: qIdx,
              questionId: String(qObj?.id || `q_${qIdx + 1}`),
              previousAnswer: prevAns !== undefined ? prevAns : '',
              newAnswer: nextAns,
              timestamp: new Date().toISOString(),
              elapsedExamSeconds: r * 540 + qOffset * 45,
              timeSinceLastActionMs: 3800 + qOffset * 900,
            });
          }

          const answeredNow = Object.keys(student.answers).length;
          const timeLeftSec = Math.max(60, 3600 - r * 540);

          // Emit WebSocket heartbeat
          if (student._ws?.subscribed) {
            void student._ws.ch.send({
              type: 'broadcast',
              event: 'student_heartbeat',
              payload: {
                studentId: student.candidateNumber,
                studentName: student.studentName,
                candidateNumber: student.candidateNumber,
                candidateClass: student.studentClass,
                quizCode: student.liveExamCode,
                status: student.strikeCount > 0 ? 'warning' : 'active',
                answeredCount: answeredNow,
                totalQuestions: numQuestions,
                currentIndex: Math.min(numQuestions, r * qsPerRound),
                timeLeftSeconds: timeLeftSec,
                violationsCount: student.violations.length,
                strikeCount: student.strikeCount,
                lastHeartbeat: Date.now(),
              },
            });
          }

          // Early finishers (20% of hall) submit right near Round 6 while remaining 80% keep saving drafts
          if (r === rounds && student.isEarlySubmitter) {
            const res = await submitStudentAttemptWithRetries(
              student,
              'phase_2_early_submit',
              createdDrafts,
              submittedIds
            );
            earlySubmitResults.push(res);
            continue;
          }

          // Debounced dirty-checked cloud draft sync (grows toward ~25-45 KB as 40 Qs fill in)
          const draftPayload = buildRealisticDraftPayload(student, Math.min(numQuestions - 1, answeredNow - 1), timeLeftSec);
          const draftRes = await supaRpc('save_student_exam_draft', {
            p_key: student.draftKey,
            p_value: JSON.stringify(draftPayload),
            p_owner_token: student.draftOwnerToken,
          });
          recordEvent({
            phase: 'phase_2_active_sitting',
            cohort: student.behavior,
            actorId: student.studentId,
            examCode: student.liveExamCode,
            action: `periodic_save_draft_r${r}`,
            target: 'rpc:save_student_exam_draft',
            durationMs: draftRes.durationMs,
            httpStatus: draftRes.status,
            outcome: draftRes.status === 200 && draftRes.data === true ? 'ok' : 'error',
            payloadBytes: draftRes.payloadBytes,
            notes: draftRes.errorText,
          });

          // Cohort Behavior A: Tab-switch / Fullscreen-exit violators (15% of students, Rounds 2 & 4)
          if (student.behavior === 'violator_tab_blur' && ((student.index % 2 === 0 && (r === 2 || r === 4)) || (student.index % 2 === 1 && (r === 3 || r === 5)))) {
            await sleep(500 + Math.floor(Math.random() * 1800));
            student.strikeCount += 1;
            const vType = r <= 3 ? 'tab_switch' : 'fullscreen_exit';
            const vDetail =
              r <= 3
                ? 'Tab visibility changed to hidden (Tier 1 Warning Lock)'
                : 'Exited fullscreen exam shell (Tier 2 Penalty Lock)';
            const nowIso = new Date().toISOString();
            student.violations.push({
              type: vType,
              timestamp: nowIso,
              detail: vDetail,
              elapsedExamSeconds: r * 540,
            });

            const eventId = `evt_${RUN_TAG}_${student.studentId}_r${r}`;
            if (student._ws?.subscribed) {
              void student._ws.ch.send({
                type: 'broadcast',
                event: 'proctor_log_event',
                payload: {
                  id: eventId,
                  timestamp: nowIso,
                  studentId: student.candidateNumber,
                  studentName: student.studentName,
                  candidateNumber: student.candidateNumber,
                  candidateClass: student.studentClass,
                  heartbeatKey: student.draftOwnerToken,
                  quizCode: student.liveExamCode,
                  type: vType,
                  detail: vDetail,
                  severity: 'critical',
                },
              });
            }

            const [keepaliveDraftRes, auditRes, unlockPinRes] = await Promise.all([
              supaRpc('save_student_exam_draft', {
                p_key: student.draftKey,
                p_value: JSON.stringify(buildRealisticDraftPayload(student, Math.min(39, r * 6), Math.max(60, timeLeftSec - 20))),
                p_owner_token: student.draftOwnerToken,
              }),
              supaRest('proctor_audit_events', {
                method: 'POST',
                body: {
                  id: eventId,
                  quiz_code: WRITE_QUIZ_CODE,
                  student_id: student.candidateNumber,
                  student_name: student.studentName,
                  candidate_number: student.candidateNumber,
                  candidate_class: student.studentClass,
                  event_type: vType,
                  severity: 'critical',
                  detail: vDetail,
                  actor: 'student',
                  created_at: nowIso,
                },
              }),
              supaRpc('verify_teacher_unlock_pin', {
                p_quiz_code: student.liveExamCode,
                p_pin: '2026',
              }),
            ]);

            recordEvent({
              phase: 'phase_2_active_sitting',
              cohort: student.behavior,
              actorId: student.studentId,
              examCode: student.liveExamCode,
              action: 'visibilitychange_keepalive_draft_flush',
              target: 'rpc:save_student_exam_draft',
              durationMs: keepaliveDraftRes.durationMs,
              httpStatus: keepaliveDraftRes.status,
              outcome: keepaliveDraftRes.status === 200 && keepaliveDraftRes.data === true ? 'ok' : 'error',
              payloadBytes: keepaliveDraftRes.payloadBytes,
              notes: keepaliveDraftRes.errorText,
            });
            recordEvent({
              phase: 'phase_2_active_sitting',
              cohort: student.behavior,
              actorId: student.studentId,
              examCode: student.liveExamCode,
              action: 'student_violation_audit_insert',
              target: 'table:proctor_audit_events',
              durationMs: auditRes.durationMs,
              httpStatus: auditRes.status,
              outcome: auditRes.status >= 200 && auditRes.status < 300 ? 'ok' : 'error',
              notes: auditRes.errorText,
            });
            recordEvent({
              phase: 'phase_2_active_sitting',
              cohort: student.behavior,
              actorId: student.studentId,
              examCode: student.liveExamCode,
              action: 'verify_teacher_unlock_pin',
              target: 'rpc:verify_teacher_unlock_pin',
              durationMs: unlockPinRes.durationMs,
              httpStatus: unlockPinRes.status,
              outcome: unlockPinRes.status === 200 ? 'ok' : 'error',
              notes: unlockPinRes.errorText,
            });
          }

          // Cohort Behavior B: Mid-exam browser refresh / Wi-Fi reconnect (10% of students in round 4)
          if (student.behavior === 'mid_exam_reload' && r === 4) {
            await executeStudentBootAndLobby(student, 'phase_2_mid_exam_reload', createdDrafts, paperCacheByCode);
          }
        }
      })
    );

    const p2WallMs = Number((performance.now() - p2T0).toFixed(1));
    console.log(`   ✔ Phase 2 completed in ${(p2WallMs / 1000).toFixed(2)}s (earlySubmitters=${earlySubmitResults.length}, peakInFlight=${peakInFlightRequests})`);

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 3: End-of-Hour Timer-Expiry Submission Wave (Remaining ~80% of Hall)
    // ══════════════════════════════════════════════════════════════════════════
    const timerExpiryStudents = students.filter((s) => !s.isEarlySubmitter);
    console.log(`\n🌊 PHASE 3: Hour-end timer expires ("Everyone click Submit Exam Now!" — ${timerExpiryStudents.length} remaining students submit in 0..800ms + 0..4500ms jitter)...`);
    const p3T0 = performance.now();

    const waveSubmitResults = await Promise.all(
      timerExpiryStudents.map(async (student) => {
        const submitDelayMs = Math.floor(Math.random() * 800) + Math.floor(Math.random() * 4500);
        await sleep(submitDelayMs);
        return submitStudentAttemptWithRetries(student, 'phase_3_submission_wave', createdDrafts, submittedIds);
      })
    );

    const submitResults = [...earlySubmitResults, ...waveSubmitResults];
    const p3WallMs = Number((performance.now() - p3T0).toFixed(1));
    console.log(`   ✔ Phase 3 completed in ${(p3WallMs / 1000).toFixed(2)}s`);

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 3B: Post-Submit Student Verification & Pre-Cleanup DB Audit
    // ══════════════════════════════════════════════════════════════════════════
    console.log(`\n🔍 PHASE 3B: Verifying post-submit RPC state (30-student sample) & inline draft-lock cleanup in Supabase...`);
    const sampleStudents = students.filter((_, idx) => idx % Math.max(1, Math.floor(students.length / 30)) === 0).slice(0, 30);
    dbForensics.sampleAttemptChecksTotal = sampleStudents.length;

    await Promise.all(
      sampleStudents.map(async (student) => {
        const [attemptVerifyRes, lookupVerifyRes, orphanDraftRes] = await Promise.all([
          supaRpc('check_student_attempt_submitted', {
            p_quiz_code: WRITE_QUIZ_CODE,
            p_student_name: student.studentName,
            p_student_class: student.studentClass,
            p_student_number: student.candidateNumber,
          }),
          supaRpc('lookup_student_exam_result', {
            p_quiz_code: WRITE_QUIZ_CODE,
            p_student_query: student.studentName,
            p_result_pin: '',
          }),
          supaRpc('get_student_exam_draft', {
            p_key: student.draftKey,
            p_owner_token: student.draftOwnerToken,
          }),
        ]);

        const attemptOk = attemptVerifyRes.status === 200 && attemptVerifyRes.data?.submitted === true;
        const lookupOk = lookupVerifyRes.status === 200 && lookupVerifyRes.data && typeof lookupVerifyRes.data === 'object';
        const draftCleaned = orphanDraftRes.status === 200 && (orphanDraftRes.data === null || orphanDraftRes.data === '');
        if (attemptOk) dbForensics.sampleAttemptChecksOk++;
        if (lookupOk) dbForensics.sampleResultLookupsOk++;
        if (!draftCleaned) dbForensics.sampleDraftOrphansFound++;

        recordEvent({
          phase: 'phase_3b_post_submit_audit',
          cohort: student.behavior,
          actorId: student.studentId,
          examCode: WRITE_QUIZ_CODE,
          action: 'post_submit_verify_attempt',
          target: 'rpc:check_student_attempt_submitted',
          durationMs: attemptVerifyRes.durationMs,
          httpStatus: attemptVerifyRes.status,
          outcome: attemptOk ? 'ok' : 'error',
        });
        recordEvent({
          phase: 'phase_3b_post_submit_audit',
          cohort: student.behavior,
          actorId: student.studentId,
          examCode: WRITE_QUIZ_CODE,
          action: 'post_submit_lookup_result',
          target: 'rpc:lookup_student_exam_result',
          durationMs: lookupVerifyRes.durationMs,
          httpStatus: lookupVerifyRes.status,
          outcome: lookupOk ? 'ok' : 'error',
        });
        recordEvent({
          phase: 'phase_3b_post_submit_audit',
          cohort: student.behavior,
          actorId: student.studentId,
          examCode: WRITE_QUIZ_CODE,
          action: 'post_submit_draft_orphan_probe',
          target: 'rpc:get_student_exam_draft',
          durationMs: orphanDraftRes.durationMs,
          httpStatus: orphanDraftRes.status,
          outcome: draftCleaned ? 'ok' : 'error',
          notes: draftCleaned ? 'cleaned_inline' : 'orphan_remaining',
        });
      })
    );

    if (SERVICE_ROLE_KEY || teacherSessionHeader) {
      const readAuth = SERVICE_ROLE_KEY
        ? {
            bearer: SERVICE_ROLE_KEY,
            extraHeaders: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY },
          }
        : { extraHeaders: teacherSessionHeader };
      const [subRowsRes, auditRowsRes, orphanCfgRes] = await Promise.all([
        supaRest(`quiz_submissions?quiz_code=eq.${WRITE_QUIZ_CODE}&select=id,status&limit=5000`, readAuth),
        supaRest(`proctor_audit_events?quiz_code=eq.${WRITE_QUIZ_CODE}&select=id,event_type&limit=5000`, readAuth),
        supaRest(`app_config?key=like.draft_stress200_%25&select=key&limit=5000`, readAuth),
      ]);
      if (subRowsRes.status === 200 && Array.isArray(subRowsRes.data)) {
        dbForensics.totalStressSubmissionCount = subRowsRes.data.length;
        dbForensics.persistedSubmissionCount = subRowsRes.data.filter((r) => String(r.id || '').includes(RUN_TAG)).length;
      }
      if (auditRowsRes.status === 200 && Array.isArray(auditRowsRes.data)) {
        dbForensics.totalStressAuditCount = auditRowsRes.data.length;
        dbForensics.persistedAuditCount = auditRowsRes.data.filter((r) => String(r.id || '').includes(RUN_TAG)).length;
      }
      if (orphanCfgRes.status === 200 && Array.isArray(orphanCfgRes.data)) {
        dbForensics.totalStressDraftKeys = orphanCfgRes.data.length;
        dbForensics.orphanedAppConfigDraftKeys = orphanCfgRes.data.filter((r) => String(r.key || '').includes(RUN_TAG)).length;
      }
    }

    // Allow trailing Realtime/audit settles
    await sleep(1500);
    healthProbeRunning = false;
    await healthProbeLoop;

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 4: Compute Telemetry, Bottleneck Attribution & Strict SLO Gates
    // ══════════════════════════════════════════════════════════════════════════
    const countByAction = (actionPrefix) => {
      const matching = allEvents.filter((e) => e.action.startsWith(actionPrefix));
      const ok = matching.filter((e) => e.outcome === 'ok').length;
      const http544Or5xx = matching.filter((e) => e.httpStatus >= 500 || e.httpStatus === 0).length;
      return {
        total: matching.length,
        ok,
        http544Or5xx,
        stats: calcPercentiles(matching.map((e) => e.durationMs)),
      };
    };

    const summary = {
      bootTeacherProfiles: countByAction('boot_teacher_profiles'),
      bootAppConfig: countByAction('load_'),
      invigilatorKeyReg: countByAction('invigilator_register_proctor_key'),
      getPaper: countByAction('get_student_exam_paper'),
      rosterDir: countByAction('get_public_roster_directory'),
      lobbyDraftProbes: countByAction('lobby_typing_draft_probe'),
      verifyPinOnStart: countByAction('verify_student_pin_on_start'),
      checkAttempt: countByAction('check_student_attempt_submitted'),
      initialDraftSave: countByAction('initial_start_save_draft'),
      periodicDraftSave: countByAction('periodic_save_draft'),
      keepaliveDraftFlush: countByAction('visibilitychange_keepalive_draft_flush'),
      studentAuditInserts: countByAction('student_violation_audit_insert'),
      invigilatorMirrorAudits: countByAction('invigilator_mirror_audit_insert'),
      unlockPinChecks: countByAction('verify_teacher_unlock_pin'),
      proctorKeyLookup: countByAction('get_proctor_public_key'),
      submitAttempt1: countByAction('submit_attempt_1'),
      submitAllAttempts: countByAction('submit_attempt_'),
      postSubmitVerify: countByAction('post_submit_verify_attempt'),
      postSubmitLookup: countByAction('post_submit_lookup_result'),
      postSubmitOrphanProbe: countByAction('post_submit_draft_orphan_probe'),
    };

    const acceptedSubmissions = submitResults.filter((r) => r.accepted).length;
    const firstTrySubmissions = submitResults.filter((r) => r.accepted && r.attempts === 1).length;
    const retriedSubmissions = submitResults.filter((r) => r.accepted && r.attempts > 1).length;
    const failedSubmissions = submitResults.filter((r) => !r.accepted);
    const clearedDraftsOnSubmit = submitResults.filter((r) => r.draftCleared).length;
    const avgSubmitPayloadKB = Number(
      (
        submitResults.reduce((acc, r) => acc + r.payloadBytes, 0) /
        Math.max(1, submitResults.length) /
        1024
      ).toFixed(1)
    );
    const totalPayloadMB = Number(
      (allEvents.reduce((acc, e) => acc + (e.payloadBytes || 0), 0) / (1024 * 1024)).toFixed(2)
    );

    const statusCounts = {};
    for (const e of allEvents) {
      const k = String(e.httpStatus);
      statusCounts[k] = (statusCounts[k] || 0) + 1;
    }

    const total5xxOrTimeoutEvents = allEvents.filter((e) => e.httpStatus >= 500 || e.httpStatus === 0);
    const unhealthyProbeSamples = healthSamples.filter((h) => !h.healthy);
    const healthRpcStats = calcPercentiles(healthSamples.map((h) => h.rpcMs));
    const healthRestStats = calcPercentiles(healthSamples.map((h) => h.restMs));

    // Strict Production SLO Gates
    const sloChecks = [
      {
        id: 'SLO-1',
        name: 'Zero HTTP 544 / 5xx / Client Timeouts across all requests',
        target: '0 errors',
        actual: `${total5xxOrTimeoutEvents.length} errors across ${allEvents.length} requests`,
        passed: total5xxOrTimeoutEvents.length === 0,
      },
      {
        id: 'SLO-2',
        name: '100% Final Exam Submission Delivery (Early Finishers + Hour-End Wave)',
        target: `${TOTAL_STUDENTS}/${TOTAL_STUDENTS} (100%)`,
        actual: `${acceptedSubmissions}/${TOTAL_STUDENTS} (${((acceptedSubmissions / TOTAL_STUDENTS) * 100).toFixed(1)}%) — 1st try: ${firstTrySubmissions}, retried: ${retriedSubmissions}`,
        passed: acceptedSubmissions === TOTAL_STUDENTS,
      },
      {
        id: 'SLO-3',
        name: '40-Question Submission RPC Latency (p50 < 1,200 ms, p95 < 4,500 ms)',
        target: 'p50 < 1200ms, p95 < 4500ms',
        actual: `p50=${summary.submitAllAttempts.stats.p50}ms, p95=${summary.submitAllAttempts.stats.p95}ms, max=${summary.submitAllAttempts.stats.max}ms (payload ~${avgSubmitPayloadKB} KB)`,
        passed:
          summary.submitAllAttempts.stats.p50 < 1200 &&
          summary.submitAllAttempts.stats.p95 < 4500,
      },
      {
        id: 'SLO-4',
        name: 'Lobby Exam Paper Resolution Latency (p95 < 2,000 ms)',
        target: 'p95 < 2000ms',
        actual: `p50=${summary.getPaper.stats.p50}ms, p95=${summary.getPaper.stats.p95}ms, max=${summary.getPaper.stats.max}ms`,
        passed: summary.getPaper.stats.p95 < 2000 && summary.getPaper.ok === summary.getPaper.total,
      },
      {
        id: 'SLO-5',
        name: 'Cloud Draft Autosave Latency & Reliability across 6 Checkpoints (100% ok, p95 < 1,500 ms)',
        target: '100% ok, p95 < 1500ms',
        actual: `${summary.periodicDraftSave.ok}/${summary.periodicDraftSave.total} ok, p50=${summary.periodicDraftSave.stats.p50}ms, p95=${summary.periodicDraftSave.stats.p95}ms`,
        passed:
          summary.periodicDraftSave.ok === summary.periodicDraftSave.total &&
          summary.periodicDraftSave.stats.p95 < 1500,
      },
      {
        id: 'SLO-6',
        name: 'Continuous 2s Health Probe Stability (0 degraded ticks > 3,000 ms)',
        target: '0 degraded ticks, max < 3000ms',
        actual: `${unhealthyProbeSamples.length}/${healthSamples.length} degraded ticks (rpc p95=${healthRpcStats.p95}ms, max=${healthRpcStats.max}ms; rest p95=${healthRestStats.p95}ms, max=${healthRestStats.max}ms)`,
        passed: unhealthyProbeSamples.length === 0,
      },
      {
        id: 'SLO-7',
        name: 'Post-Submit Attempt Verification & Zero Orphaned Cloud Drafts (30-Student Sample)',
        target: '30/30 verified, 0 orphans',
        actual: `verified=${dbForensics.sampleAttemptChecksOk}/${dbForensics.sampleAttemptChecksTotal}, resultLookups=${dbForensics.sampleResultLookupsOk}/${dbForensics.sampleAttemptChecksTotal}, orphans=${dbForensics.sampleDraftOrphansFound}`,
        passed:
          dbForensics.sampleAttemptChecksOk === dbForensics.sampleAttemptChecksTotal &&
          dbForensics.sampleResultLookupsOk === dbForensics.sampleAttemptChecksTotal &&
          dbForensics.sampleDraftOrphansFound === 0,
      },
    ];

    console.log(`\n══════════════════════════════════════════════════════════════════════════════════`);
    console.log(`  REALISTIC 1-HOUR STRESS TEST RESULTS & STRICT SLO VERDICT`);
    console.log(`══════════════════════════════════════════════════════════════════════════════════`);
    for (const s of sloChecks) {
      console.log(`  ${s.passed ? '✅ PASS' : '❌ FAIL'} [${s.id}] ${s.name}`);
      console.log(`          Target: ${s.target} | Actual: ${s.actual}`);
    }
    console.log(`──────────────────────────────────────────────────────────────────────────────────`);
    console.log(`  • Total HTTP Requests Logged              : ${allEvents.length} (${totalPayloadMB} MB payload written)`);
    console.log(`  • HTTP Status Breakdown                   : ${JSON.stringify(statusCounts)}`);
    console.log(`  • Peak Concurrent In-Flight HTTP Requests : ${peakInFlightRequests}`);
    console.log(`  • Avg 40-Question Submission Payload      : ${avgSubmitPayloadKB} KB`);
    console.log(`  • WebSocket Heartbeats Received by Proctor: ${invigilatorHeartbeatsReceived} (logs=${invigilatorLogsReceived})`);
    console.log(`  • Post-Submit Draft Locks Cleaned Inline  : ${clearedDraftsOnSubmit}/${acceptedSubmissions} (orphans=${dbForensics.sampleDraftOrphansFound})`);
    console.log(`══════════════════════════════════════════════════════════════════════════════════\n`);

    const reportMd = buildRealisticReportMarkdown({
      runTag: RUN_TAG,
      totalStudents: TOTAL_STUDENTS,
      sittingSec: SITTING_DURATION_MS / 1000,
      p1WallMs,
      p2WallMs,
      p3WallMs,
      totalWallMs: Number((performance.now() - globalT0).toFixed(1)),
      totalRequests: allEvents.length,
      totalPayloadMB,
      statusCounts,
      peakInFlightRequests,
      invigilatorHeartbeatsReceived,
      invigilatorLogsReceived,
      invigilatorDuplicateAuditsSent,
      resultsWatcherTriggers,
      avgSubmitPayloadKB,
      earlySubmitCount: earlySubmitResults.length,
      waveSubmitCount: waveSubmitResults.length,
      dbForensics,
      summary,
      sloChecks,
      healthSamples,
      failedSubmissions,
    });
    fs.writeFileSync(REPORT_PATH, reportMd, 'utf8');
    console.log(`📄 Detailed Markdown Report written to: ${REPORT_PATH}`);

    const anySloFailed = sloChecks.some((s) => !s.passed);
    process.exitCode = anySloFailed ? 1 : 0;
  } finally {
    healthProbeRunning = false;

    // Disconnect all WebSockets cleanly & clear any pending watcher debounce timers
    for (const sock of activeSockets) {
      if (sock.timerEntry) sock.timerEntry.clear();
    }
    if (activeSockets.length > 0) {
      console.log(`🧹 Disconnecting ${activeSockets.length} active Realtime WebSocket channels...`);
      await Promise.all(
        activeSockets.map(async ({ client, ch }) => {
          try {
            await client.removeChannel(ch);
          } catch { }
        })
      );
    }

    // Clean up any leftover draft locks ONLY when --approve-delete=true is explicitly passed
    if (createdDrafts.size > 0) {
      if (APPROVE_DELETE) {
        console.log(`🧹 Cleaning up ${createdDrafts.size} remaining temporary draft keys...`);
        const entries = Array.from(createdDrafts.entries());
        for (let i = 0; i < entries.length; i += 25) {
          const chunk = entries.slice(i, i + 25);
          await Promise.all(
            chunk.map(([k, tok]) =>
              supaRpc('delete_student_exam_draft', { p_key: k, p_owner_token: tok })
            )
          );
        }
      } else {
        console.log(`🛡️ Safe Mode: Skipping deletion of ${createdDrafts.size} remaining temporary draft keys (pass --approve-delete=true to clean up).`);
      }
    }

    // Clean up STRESS200 submissions & audit rows ONLY if --approve-delete=true is explicitly passed
    if (SERVICE_ROLE_KEY || teacherSessionHeader) {
      if (APPROVE_DELETE) {
        console.log(`🧹 Cleaning up ${WRITE_QUIZ_CODE} rows from quiz_submissions and proctor_audit_events (--approve-delete=true)...`);
        const authOpts = SERVICE_ROLE_KEY
          ? {
            method: 'DELETE',
            bearer: SERVICE_ROLE_KEY,
            extraHeaders: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY },
          }
          : {
            method: 'DELETE',
            extraHeaders: teacherSessionHeader,
          };
        const [delSubRes, delAuditRes] = await Promise.all([
          supaRest(`quiz_submissions?quiz_code=eq.${WRITE_QUIZ_CODE}`, authOpts),
          supaRest(`proctor_audit_events?quiz_code=eq.${WRITE_QUIZ_CODE}`, authOpts),
        ]);
        const readHeaders = SERVICE_ROLE_KEY
          ? { bearer: SERVICE_ROLE_KEY, extraHeaders: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY } }
          : { extraHeaders: teacherSessionHeader };
        const [remSubRes, remAuditRes] = await Promise.all([
          supaRest(`quiz_submissions?quiz_code=eq.${WRITE_QUIZ_CODE}&select=id&limit=10`, readHeaders),
          supaRest(`proctor_audit_events?quiz_code=eq.${WRITE_QUIZ_CODE}&select=id&limit=10`, readHeaders),
        ]);
        const remSubs = Array.isArray(remSubRes.data) ? remSubRes.data.length : `err(${remSubRes.status})`;
        const remAudits = Array.isArray(remAuditRes.data) ? remAuditRes.data.length : `err(${remAuditRes.status})`;
        console.log(`   ✔ Cleanup result: quiz_submissions DELETE=${delSubRes.status} (remaining=${remSubs}), proctor_audit_events DELETE=${delAuditRes.status} (remaining=${remAudits})`);
      } else {
        console.log(`🛡️ Safe Mode: NO rows deleted from quiz_submissions or proctor_audit_events (pass --approve-delete=true after reviewing counts to remove synthetic ${WRITE_QUIZ_CODE} rows).`);
      }
    }

    if (teacherSessionHeader && TEACHER_LOGIN_ID) {
      await supaRpc('logout_teacher_session', {}, { extraHeaders: teacherSessionHeader }).catch(() => { });
    }

    eventStream.end();
  }
}

function buildRealisticReportMarkdown({
  runTag,
  totalStudents,
  sittingSec,
  p1WallMs,
  p2WallMs,
  p3WallMs,
  totalWallMs,
  totalRequests,
  totalPayloadMB,
  statusCounts,
  peakInFlightRequests,
  invigilatorHeartbeatsReceived,
  invigilatorLogsReceived,
  invigilatorDuplicateAuditsSent,
  resultsWatcherTriggers,
  avgSubmitPayloadKB,
  earlySubmitCount,
  waveSubmitCount,
  dbForensics,
  summary,
  sloChecks,
  healthSamples,
  failedSubmissions,
}) {
  const rowFmt = (label, item) =>
    `| **${label}** | ${item.total} | ${item.ok}/${item.total} | ${item.http544Or5xx} | ${item.stats.min} | ${item.stats.p50} | ${item.stats.p95} | ${item.stats.p99} | ${item.stats.max} |`;

  return `# Realistic 1-Hour Multi-Exam Sitting Stress Test Report (\`ICM-1\`..\`ICM-13\`)

- **Run ID**: \`${runTag}\`
- **Simulated Cohort**: **${totalStudents} Concurrent Students** distributed across **13 Live Exams (\`ICM-1\`..\`ICM-13\`)** + **3 Live Invigilator Cockpits** + **2 Live Results Watchers**
- **1-Hour Exam Model**: 40 questions per paper, 6 checkpoints (Minutes 10–60), **${earlySubmitCount} early finishers** submitting during active draft traffic + **${waveSubmitCount} simultaneous hour-end expiry submissions**
- **Runtime**: ${sittingSec}s active sitting window (${(totalWallMs / 1000).toFixed(1)}s total runtime; Phase 1: ${(p1WallMs / 1000).toFixed(1)}s, Phase 2: ${(p2WallMs / 1000).toFixed(1)}s, Phase 3: ${(p3WallMs / 1000).toFixed(1)}s)
- **HTTP Volume & Concurrency**: **${totalRequests} HTTP requests** (**${totalPayloadMB} MB** write payload, **${(totalRequests / Math.max(1, totalWallMs / 1000)).toFixed(1)} avg RPS**), **Peak Concurrent In-Flight Requests: ${peakInFlightRequests}**
- **HTTP Status Distribution**: \`${JSON.stringify(statusCounts)}\`
- **Average 40Q Submission Payload Size**: **${avgSubmitPayloadKB} KB** (40 questions + sub-questions + 42 answer change logs)
- **Realtime Proctor Telemetry**: ${invigilatorHeartbeatsReceived} heartbeats received, ${invigilatorLogsReceived} \`proctor_log_event\` broadcasts received, **${invigilatorDuplicateAuditsSent} duplicate invigilator audit DB inserts**, ${resultsWatcherTriggers} \`postgres_changes\` triggers

---

## 1. Strict Production SLO Verdict

| SLO ID | Production Requirement | Target | Observed Actual | Verdict |
| :--- | :--- | :--- | :--- | :---: |
${sloChecks
      .map(
        (s) =>
          `| **${s.id}** | ${s.name} | \`${s.target}\` | ${s.actual} | ${s.passed ? '✅ **PASS**' : '❌ **FAIL**'} |`
      )
      .join('\n')}

---

## 2. End-to-End Operation Latency & Error Breakdown

| Phase & Operation | Requests | Success | 5xx / Timeouts | Min (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
${rowFmt('Phase 0: `register_proctor_public_key`', summary.invigilatorKeyReg)}
${rowFmt('Lobby: `get_student_exam_paper(ICM-1..13)`', summary.getPaper)}
${rowFmt('Lobby: `get_public_roster_directory`', summary.rosterDir)}
${rowFmt('Lobby Typing: `get_student_exam_draft`', summary.lobbyDraftProbes)}
${rowFmt('Begin Exam: `verify_student_pin`', summary.verifyPinOnStart)}
${rowFmt('Begin Exam: `check_student_attempt_submitted`', summary.checkAttempt)}
${rowFmt('Begin Exam: Initial `save_student_exam_draft`', summary.initialDraftSave)}
${rowFmt('Mid-Exam: Periodic `save_student_exam_draft` (6 rounds)', summary.periodicDraftSave)}
${rowFmt('Mid-Exam: `visibilitychange` Keepalive Draft Flush', summary.keepaliveDraftFlush)}
${rowFmt('Mid-Exam: Student `proctor_audit_events` Insert', summary.studentAuditInserts)}
${rowFmt('Mid-Exam: `verify_teacher_unlock_pin(ICM-1..13)`', summary.unlockPinChecks)}
${rowFmt('Mid-Exam: `get_proctor_public_key` Room Verification', summary.proctorKeyLookup)}
${rowFmt('Submit Wave: `submit_student_exam_attempt` (Attempt 1)', summary.submitAttempt1)}
${rowFmt('Submit Wave: `submit_student_exam_attempt` (All Attempts)', summary.submitAllAttempts)}
${rowFmt('Post-Submit: `check_student_attempt_submitted` Sample', summary.postSubmitVerify)}
${rowFmt('Post-Submit: `lookup_student_exam_result` Sample', summary.postSubmitLookup)}
${rowFmt('Post-Submit: `get_student_exam_draft` Orphan Probe', summary.postSubmitOrphanProbe)}

---

## 3. Continuous 2-Second Supabase Health Probe Timeline

| Tick | Elapsed (s) | In-Flight Reqs | RPC Ping (ms) | RPC HTTP | REST Ping (ms) | REST HTTP | Status |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
${healthSamples
      .map(
        (h) =>
          `| ${h.tick} | ${h.elapsedSec}s | ${h.inFlight} | ${h.rpcMs} | ${h.rpcStatus} | ${h.restMs} | ${h.restStatus} | ${h.healthy ? '🟢 Healthy' : '🔴 **DEGRADED**'} |`
      )
      .join('\n')}

---

## 4. Supabase Server-Side State & Pre-Cleanup Database Forensics

- **Verification Access Mode**: \`${dbForensics.mode}\`
- **Post-Submit RPC Attempt Checks (30-student sample)**: **${dbForensics.sampleAttemptChecksOk}/${dbForensics.sampleAttemptChecksTotal}** confirmed \`submitted=true\`
- **Post-Submit Result Lookups (30-student sample)**: **${dbForensics.sampleResultLookupsOk}/${dbForensics.sampleAttemptChecksTotal}** returned clean HTTP 200 JSON responses
- **Inline Cloud Draft Cleanup Probe (30-student sample)**: **${dbForensics.sampleDraftOrphansFound}** orphaned draft keys left behind in Postgres \`app_config\`
- **Privileged Table Row Counts (\`quiz_submissions\` / \`proctor_audit_events\` / \`app_config\`)**: ${
    dbForensics.persistedSubmissionCount !== null
      ? `this_run_submissions=${dbForensics.persistedSubmissionCount} (total_${WRITE_QUIZ_CODE}=${dbForensics.totalStressSubmissionCount}), this_run_audit_events=${dbForensics.persistedAuditCount} (total_${WRITE_QUIZ_CODE}=${dbForensics.totalStressAuditCount}), this_run_remaining_drafts=${dbForensics.orphanedAppConfigDraftKeys} (total_draft_stress200=${dbForensics.totalStressDraftKeys})`
      : 'Skipped direct table SELECT (no `SUPABASE_SERVICE_ROLE_KEY` or `TEACHER_SESSION_TOKEN` in env — verified via scoped RPCs above).'
  }
${failedSubmissions.length > 0
      ? `\n---\n\n## 5. Failed Submission Samples (${failedSubmissions.length} total)\n\n` +
      failedSubmissions
        .slice(0, 15)
        .map(
          (f) =>
            `- \`${f.student.studentId}\` (\`${f.student.liveExamCode}\` / \`${f.student.studentClass}\`): failed after ${f.attempts} attempts (${f.totalSubmitMs.toFixed(0)} ms) — \`${f.errorText || 'rejected'}\``
        )
        .join('\n')
      : ''
    }
`;
}

main().catch((err) => {
  console.error('❌ Fatal error in realistic stress test:', err);
  process.exit(1);
});
