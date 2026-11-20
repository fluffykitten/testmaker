import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

// ─── Config & Environment Loading ────────────────────────────────────────────

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
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env.local');
  process.exit(1);
}

const RUN_TAG = Date.now().toString(36);
const EXAM_CODES = Array.from({ length: 13 }, (_, i) => `ICM-${i + 1}`);

fs.mkdirSync(path.resolve('artifacts'), { recursive: true });
const EVENTS_LOG_PATH = path.resolve('artifacts/icm13_stress_events.jsonl');
const REPORT_PATH = path.resolve('Plan/icm_1_to_13_stress_test_report.md');

const eventStream = fs.createWriteStream(EVENTS_LOG_PATH, { flags: 'w' });
const allEvents = [];

function recordEvent({ wave, quizCode, studentTag, action, durationMs, httpStatus, outcome, notes = '' }) {
  const entry = {
    ts: new Date().toISOString(),
    wave,
    quizCode,
    studentTag,
    action,
    durationMs: Number(durationMs.toFixed(1)),
    httpStatus,
    outcome,
    notes,
  };
  allEvents.push(entry);
  eventStream.write(`${JSON.stringify(entry)}\n`);
}

function normalizeClassLabel(cls) {
  return String(cls || '')
    .trim()
    .toUpperCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function slugify(val) {
  return String(val || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
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

async function runWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const pool = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(pool);
  return results;
}

async function supaRpc(fnName, args, { extraHeaders = {}, bearer = ANON_KEY } = {}) {
  const t0 = performance.now();
  let status = 0;
  let data = null;
  let errorText = '';
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(args ?? {}),
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
    errorText = err?.message || String(err);
  }
  return { status, data, errorText, durationMs: performance.now() - t0 };
}

async function supaRest(tablePath, { method = 'GET', body, extraHeaders = {}, bearer = ANON_KEY, prefer } = {}) {
  const t0 = performance.now();
  let status = 0;
  let data = null;
  let errorText = '';
  try {
    const headers = {
      apikey: ANON_KEY,
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${tablePath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
    errorText = err?.message || String(err);
  }
  return { status, data, errorText, durationMs: performance.now() - t0 };
}

function deepScanLeakedKeys(value, pathPrefix = '', findings = []) {
  if (value === null || value === undefined) return findings;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => deepScanLeakedKeys(item, `${pathPrefix}[${idx}]`, findings));
    return findings;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = pathPrefix ? `${pathPrefix}.${k}` : k;
      if (['correct_answer', 'acceptable_answers', 'guidance', 'common_misconceptions', 'source_pdf_url', 'metadata', 'expectedAnswers'].includes(k)) {
        findings.push(p);
      }
      if (k === 'mark_scheme' && v !== null) {
        findings.push(`${p}(non-null)`);
      }
      deepScanLeakedKeys(v, p, findings);
    }
  }
  return findings;
}

function makePart2Answers() {
  return {
    'pilot2-q1-chem': 'C: Relative atomic mass: 23.0 • Group: I (Alkali metals)',
    'pilot2-q2-phys': 'B: 374,850 J',
    'pilot2-q3-eng': 'A: Option 1 (Replace after checking "0L1 my room")',
    'pilot2-q4-bio': 'D: Chamber D • Generates high pressure to pump oxygenated blood around the whole body via the aorta',
    'pilot2-q5-geog': 'B: Lag time: 5 hours 30 minutes • Rapid surface runoff from impermeable urban surfaces',
    'pilot2-q6-econ': { a: '950', b: '20', r2_c3: '950' },
    'pilot2-q7-multi': ['A: Lowering the central bank base interest rate', 'D: Purchasing government bonds from commercial banks (quantitative easing)'],
    'pilot2-q8-cloze': { g0: 'chlorine', g1: 'hydrogen', g2: 'alkaline' },
    'pilot2-q9-arab': 'ب: السَّمَاءُ صَافِيَةٌ فَوْقَ الْمَدِينَةِ',
    'pilot2-q10-indo': 'C: Menahan abrasi pesisir sekaligus menyediakan habitat biota laut dan penyerap karbon',
    'pilot2-q11-math': { a: '43', b: 'n^2 + n + 1' },
    'pilot2-q12-reading-writing':
      'Vertical forests cool dense tropical buildings through two main mechanisms. First, broad leaf canopies physically shade glass facades and external concrete walls, blocking direct solar radiation and reducing indoor heat gain. Second, plants draw moisture from irrigated soil troughs and release water vapor through leaf pores via evapotranspiration, absorbing ambient thermal energy to lower surrounding air temperatures. Additionally, vegetated balconies filter fine traffic dust particulates along busy urban arterial roads.',
  };
}

async function main() {
  const globalT0 = performance.now();
  const createdDrafts = new Map();
  const submittedIds = [];
  const auditIds = [];
  let teacherHeaders = null;

  console.log(`Starting ICM-1..ICM-13 Class-Scoped Stress Test With Student PINs (run=${RUN_TAG})\n`);

  try {
    // ── Pre-flight 1: Authenticate teacher session for roster PIN read & guaranteed cleanup ─
    if (TEACHER_SESSION_TOKEN) {
      teacherHeaders = { 'x-teacher-session': TEACHER_SESSION_TOKEN };
    } else if (TEACHER_LOGIN_ID && TEACHER_LOGIN_PASSWORD) {
      const authRes = await supaRpc('login_teacher_account', {
        p_identifier: TEACHER_LOGIN_ID,
        p_password: TEACHER_LOGIN_PASSWORD,
      });
      if (authRes.status === 200 && authRes.data?.status === 'ok' && authRes.data?.token) {
        teacherHeaders = { 'x-teacher-session': authRes.data.token };
      } else {
        throw new Error(`Teacher login failed: ${authRes.data?.error || authRes.errorText || `HTTP ${authRes.status}`}`);
      }
    }

    const adminAuthHeaders = SERVICE_ROLE_KEY
      ? { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY }
      : teacherHeaders;

    if (!adminAuthHeaders) {
      throw new Error(
        'Requires TEACHER_LOGIN_ID + TEACHER_LOGIN_PASSWORD (or TEACHER_SESSION_TOKEN / SUPABASE_SERVICE_ROLE_KEY) in environment to verify real student PINs and clean up test submissions.'
      );
    }

    // ── Pre-flight 2: Load exam configs ICM-1..ICM-13 & roster (with real PINs in memory only) ─
    const [rosterRes, ...examResponses] = await Promise.all([
      supaRest('app_config?key=eq.school_roster&select=value', {
        extraHeaders: teacherHeaders || {},
        bearer: SERVICE_ROLE_KEY || ANON_KEY,
      }),
      ...EXAM_CODES.map((code) => supaRpc('get_student_exam_paper', { p_code: code })),
    ]);

    if (rosterRes.status >= 400 || !Array.isArray(rosterRes.data) || !rosterRes.data[0]?.value) {
      throw new Error(`Failed to fetch school_roster: HTTP ${rosterRes.status} ${rosterRes.errorText}`);
    }

    const fullRoster = JSON.parse(rosterRes.data[0].value);
    if (!Array.isArray(fullRoster) || fullRoster.length === 0) {
      throw new Error('school_roster is empty');
    }

    const examByClassNorm = new Map();
    const examMetaByCode = new Map();

    for (let idx = 0; idx < EXAM_CODES.length; idx++) {
      const code = EXAM_CODES[idx];
      const res = examResponses[idx];
      const pq = res.data?.publishedQuiz;
      if (res.status !== 200 || !pq || res.data?.scheduleStatus !== 'active') {
        throw new Error(`Exam ${code} not active (status=${res.status}, sched=${res.data?.scheduleStatus})`);
      }
      const normCls = normalizeClassLabel(pq.targetClass);
      const info = {
        quizCode: code,
        quizId: pq.id,
        testId: pq.testId,
        targetClass: pq.targetClass,
        normClass: normCls,
        requireStudentPin: Boolean(pq.requireStudentPin),
        totalMarks: pq.totalMarks || 30,
        questionCount: Array.isArray(res.data.questions) ? res.data.questions.length : 0,
      };
      examMetaByCode.set(code, info);
      examByClassNorm.set(normCls, info);
    }

    // Snapshot any existing submissions on ICM-1..ICM-13 so we skip students with real submissions (zero conflict)
    const preSubRes = await supaRest(
      `quiz_submissions?quiz_code=in.(${EXAM_CODES.join(',')})&select=quiz_code,student_name,student_class,id`,
      { extraHeaders: adminAuthHeaders, bearer: SERVICE_ROLE_KEY || ANON_KEY }
    );
    const existingSubmittedSet = new Set();
    if (preSubRes.status === 200 && Array.isArray(preSubRes.data)) {
      for (const r of preSubRes.data) {
        if (!String(r.id || '').startsWith('icm13stress-')) {
          existingSubmittedSet.add(
            `${String(r.quiz_code || '').toUpperCase()}::${normalizeClassLabel(r.student_name)}::${normalizeClassLabel(r.student_class)}`
          );
        }
      }
    }

    const matchedStudents = [];
    const unmatchedClasses = [];
    const perClassCounters = new Map();

    for (const raw of fullRoster) {
      const normCls = normalizeClassLabel(raw.class);
      const exam = examByClassNorm.get(normCls);
      if (!exam) {
        unmatchedClasses.push(raw.class || '(blank)');
        continue;
      }
      const nextNum = (perClassCounters.get(exam.quizCode) || 0) + 1;
      perClassCounters.set(exam.quizCode, nextNum);

      const safeTag = `${exam.quizCode}_${String(nextNum).padStart(2, '0')}`;
      const realPin = String(raw.pin || '').trim();
      const slugName = slugify(raw.name);
      const draftKey = `draft_${exam.quizCode}_${slugName}__${slugify(realPin)}`.toLowerCase();
      const ownerToken = `stress13_${RUN_TAG}_${crypto.randomBytes(6).toString('hex')}`;
      const dedupKey = `${exam.quizCode}::${normalizeClassLabel(raw.name)}::${normCls}`;

      matchedStudents.push({
        index: matchedStudents.length + 1,
        quizCode: exam.quizCode,
        quizId: exam.quizId,
        targetClass: exam.targetClass,
        studentTag: safeTag,
        name: String(raw.name || '').trim(),
        className: String(raw.class || '').trim(),
        candidateNumber: String(raw.candidateNumber || '').trim(),
        pin: realPin,
        draftKey,
        ownerToken,
        submissionId: `icm13stress-${RUN_TAG}-${safeTag}`,
        alreadyHasRealSubmission: existingSubmittedSet.has(dedupKey),
        answers: makePart2Answers(),
      });
    }

    console.log(
      `Pre-flight OK: ${EXAM_CODES.length} exams active | ${matchedStudents.length}/${fullRoster.length} roster students matched to classes | pre-existing real submissions=${existingSubmittedSet.size}`
    );

    // ── Wave 1: 166-Way Class-Matched Lobby & Exam Paper Burst ───────────────
    console.log('\nWave 1: Concurrent 166-way lobby entry across ICM-1..ICM-13...');
    const w1T0 = performance.now();
    const w1Leaks = [];
    let w1PaperOk = 0;
    let w1DirOk = 0;
    let w1AttemptOk = 0;
    const w1PaperDurations = [];
    const w1DirDurations = [];
    const w1AttemptDurations = [];

    await runWithConcurrency(matchedStudents, 166, async (s) => {
      const [paperRes, dirRes, attemptRes] = await Promise.all([
        supaRpc('get_student_exam_paper', { p_code: s.quizCode }),
        supaRpc('get_public_roster_directory', {}),
        supaRpc('check_student_attempt_submitted', {
          p_quiz_code: s.quizCode,
          p_student_name: s.name,
          p_student_class: s.className,
          p_student_number: s.candidateNumber,
        }),
      ]);

      w1PaperDurations.push(paperRes.durationMs);
      w1DirDurations.push(dirRes.durationMs);
      w1AttemptDurations.push(attemptRes.durationMs);

      const qLeaks = Array.isArray(paperRes.data?.questions)
        ? deepScanLeakedKeys(paperRes.data.questions)
        : [];
      if (paperRes.data?.teacherPinHash) qLeaks.push('teacherPinHash');
      if (qLeaks.length > 0 && w1Leaks.length < 5) {
        w1Leaks.push(`${s.quizCode}:${qLeaks.join(',')}`);
      }

      const paperOk =
        paperRes.status === 200 &&
        paperRes.data?.isActive === true &&
        paperRes.data?.scheduleStatus === 'active' &&
        Array.isArray(paperRes.data?.questions) &&
        paperRes.data.questions.length === 12 &&
        normalizeClassLabel(paperRes.data?.publishedQuiz?.targetClass) === normalizeClassLabel(s.className) &&
        paperRes.data?.publishedQuiz?.requireStudentPin === true &&
        qLeaks.length === 0;
      if (paperOk) w1PaperOk++;

      const dirList = Array.isArray(dirRes.data) ? dirRes.data : [];
      const dirHasPin = dirList.some((x) => x && ('pin' in x || 'pinHash' in x || 'pin_hash' in x));
      const dirOk = dirRes.status === 200 && dirList.length >= matchedStudents.length && !dirHasPin;
      if (dirOk) w1DirOk++;
      if (!dirOk && w1Leaks.length < 5 && dirHasPin) w1Leaks.push(`${s.quizCode}:roster_pin_leak`);

      const attemptOk =
        attemptRes.status === 200 &&
        typeof attemptRes.data?.submitted === 'boolean' &&
        (s.alreadyHasRealSubmission ? true : attemptRes.data.submitted === false);
      if (attemptOk) w1AttemptOk++;

      recordEvent({
        wave: 'wave_1_lobby',
        quizCode: s.quizCode,
        studentTag: s.studentTag,
        action: 'lobby_entry_bundle',
        durationMs: Math.max(paperRes.durationMs, dirRes.durationMs, attemptRes.durationMs),
        httpStatus: paperRes.status,
        outcome: paperOk && dirOk && attemptOk ? 'ok' : 'error',
        notes: `paper=${paperOk},dir=${dirOk},attempt=${attemptOk}`,
      });
    });

    const w1WallMs = performance.now() - w1T0;
    console.log(
      `   Done Wave 1 in ${w1WallMs.toFixed(1)} ms | paper=${w1PaperOk}/${matchedStudents.length} | dir=${w1DirOk}/${matchedStudents.length} | attempt=${w1AttemptOk}/${matchedStudents.length} | leaks=${w1Leaks.length}`
    );

    // ── Wave 2: 166-Way Real Student PIN Verification Burst + Negative PIN Guards ─
    console.log('\nWave 2: Concurrent 166-way REAL student PIN verification + mixed class variants + negative PIN probes...');
    const w2T0 = performance.now();
    const w2PinDurations = [];
    let w2RealPinOk = 0;
    let w2NormalizedVariantOk = 0;
    let w2NormalizedVariantTotal = 0;
    const w2SampleErrors = [];

    await runWithConcurrency(matchedStudents, 166, async (s) => {
      // Every 5th student also tests mixed-notation class variant (e.g. "x-ipa-1") with REAL PIN
      const testMixed = s.index % 5 === 0;
      const classInput = testMixed ? s.className.toLowerCase().replace(/\s+/g, '-') : s.className;
      if (testMixed) w2NormalizedVariantTotal++;

      const res = await supaRpc('verify_student_pin', {
        p_name: s.name,
        p_class: classInput,
        p_pin: s.pin,
      });
      w2PinDurations.push(res.durationMs);

      const ok =
        res.status === 200 &&
        res.data?.valid === true &&
        normalizeClassLabel(res.data?.student?.class) === normalizeClassLabel(s.className);
      if (ok) {
        w2RealPinOk++;
        if (testMixed) w2NormalizedVariantOk++;
      } else if (w2SampleErrors.length < 5) {
        w2SampleErrors.push(`${s.studentTag}: status=${res.status}, err=${res.data?.error || res.errorText}`);
      }

      recordEvent({
        wave: 'wave_2_real_pin',
        quizCode: s.quizCode,
        studentTag: s.studentTag,
        action: testMixed ? 'verify_student_pin_norm_class' : 'verify_student_pin_exact',
        durationMs: res.durationMs,
        httpStatus: res.status,
        outcome: ok ? 'ok' : 'error',
      });
    });

    // Negative PIN checks strictly on synthetic identities (never increments real student lockout!)
    let negWrongClassOk = 0;
    await runWithConcurrency(EXAM_CODES, 13, async (code, i) => {
      const exam = examMetaByCode.get(code);
      const rWrong = await supaRpc('verify_student_pin', {
        p_name: `Stress Synthetic Probe ${RUN_TAG} ${i + 1}`,
        p_class: exam.targetClass,
        p_pin: '9999',
      });
      if (rWrong.status === 200 && rWrong.data?.valid === false) negWrongClassOk++;
    });

    // Synthetic brute-force lockout across normalized class variants
    const bruteTarget = `Stress Brute Probe ${RUN_TAG}`;
    const bruteResList = [];
    for (let k = 1; k <= 12; k++) {
      const r = await supaRpc('verify_student_pin', {
        p_name: bruteTarget,
        p_class: k % 2 === 0 ? 'X IPA 1' : 'x-ipa-1',
        p_pin: String(1000 + k),
      });
      bruteResList.push(r);
    }
    const bruteLockoutTriggered = bruteResList.some((r) =>
      /too many failed pin attempts/i.test(String(r.data?.error || ''))
    );

    const w2WallMs = performance.now() - w2T0;
    console.log(
      `   Done Wave 2 in ${w2WallMs.toFixed(1)} ms | real PIN ok=${w2RealPinOk}/${matchedStudents.length} | class-variant ok=${w2NormalizedVariantOk}/${w2NormalizedVariantTotal} | neg probes=${negWrongClassOk}/13 | lockout=${bruteLockoutTriggered}`
    );

    // ── Wave 3: 166-Way Autosave Storm (2x) + Lock Hijack Guard + Audit Trail ─
    console.log('\nWave 3: 166-way autosave storm (2 rounds x 166) + device lock hijack guard + proctor audits...');
    const w3T0 = performance.now();
    const w3DraftDurations = [];
    let w3DraftOk = 0;

    for (let round = 1; round <= 2; round++) {
      await runWithConcurrency(matchedStudents, 100, async (s) => {
        createdDrafts.set(s.draftKey, s.ownerToken);
        const payload = {
          quizCode: s.quizCode,
          quizId: s.quizId,
          studentName: s.name,
          candidateNumber: s.candidateNumber,
          candidateClass: s.className,
          answers: s.answers,
          currentIndex: round * 4,
          timeLeftSeconds: 1800 - round * 120,
          lastSavedAt: new Date().toISOString(),
          status: 'in_progress',
        };
        const res = await supaRpc('save_student_exam_draft', {
          p_key: s.draftKey,
          p_value: JSON.stringify(payload),
          p_owner_token: s.ownerToken,
        });
        w3DraftDurations.push(res.durationMs);
        const ok = res.status === 200 && res.data === true;
        if (ok) w3DraftOk++;

        recordEvent({
          wave: 'wave_3_autosave',
          quizCode: s.quizCode,
          studentTag: s.studentTag,
          action: `save_draft_r${round}`,
          durationMs: res.durationMs,
          httpStatus: res.status,
          outcome: ok ? 'ok' : 'error',
          notes: ok ? '' : res.errorText,
        });
      });
    }

    // Device recovery + hijack rejection on 1 student per exam (13 checks)
    let recoveryOk = 0;
    let draftHijackBlocked = 0;
    for (const code of EXAM_CODES) {
      const sample = matchedStudents.find((s) => s.quizCode === code);
      if (!sample) continue;
      const [recRes, hijackRes] = await Promise.all([
        supaRpc('get_student_exam_draft', { p_key: sample.draftKey, p_owner_token: sample.ownerToken }),
        supaRpc('save_student_exam_draft', {
          p_key: sample.draftKey,
          p_value: '{"hijacked":true}',
          p_owner_token: 'attacker-wrong-token',
        }),
      ]);
      if (recRes.status === 200 && typeof recRes.data === 'string' && recRes.data.includes(sample.quizCode)) {
        recoveryOk++;
      }
      if (hijackRes.status >= 400 || hijackRes.data === false) {
        draftHijackBlocked++;
      }
    }

    // Discrete proctor audit burst across 26 students (2 per exam)
    let auditOk = 0;
    const auditSample = EXAM_CODES.flatMap((c) => matchedStudents.filter((s) => s.quizCode === c).slice(0, 2));
    await runWithConcurrency(auditSample, 26, async (s) => {
      const auditId = `icm13stress-${RUN_TAG}-audit-${s.studentTag}`;
      auditIds.push(auditId);
      const res = await supaRest('proctor_audit_events', {
        method: 'POST',
        body: {
          id: auditId,
          quiz_code: s.quizCode,
          student_id: s.candidateNumber,
          student_name: s.name,
          candidate_number: s.candidateNumber,
          candidate_class: s.className,
          event_type: 'tab_hidden',
          severity: 'warning',
          detail: 'Simulated stress test blur event',
          actor: 'student',
          created_at: new Date().toISOString(),
        },
      });
      if (res.status >= 200 && res.status < 300) auditOk++;
    });

    const w3WallMs = performance.now() - w3T0;
    console.log(
      `   Done Wave 3 in ${w3WallMs.toFixed(1)} ms | drafts=${w3DraftOk}/${matchedStudents.length * 2} | recovery=${recoveryOk}/13 | hijackBlocked=${draftHijackBlocked}/13 | audit=${auditOk}/${auditSample.length}`
    );

    // ── Wave 4: 166-Way Live Exam Submissions With Real Student PINs + Negative Guards ─
    console.log('\nWave 4: Concurrent live submissions across ICM-1..ICM-13 with real student PINs...');
    const w4T0 = performance.now();
    const submitDurations = [];
    const perExamSubmitCounts = new Map(EXAM_CODES.map((c) => [c, { expected: 0, ok: 0 }]));
    const submitCandidates = matchedStudents.filter((s) => !s.alreadyHasRealSubmission);

    await runWithConcurrency(submitCandidates, 166, async (s) => {
      const bucket = perExamSubmitCounts.get(s.quizCode);
      bucket.expected++;
      const exam = examMetaByCode.get(s.quizCode);

      const row = {
        id: s.submissionId,
        quiz_id: exam.quizId,
        quiz_code: s.quizCode,
        student_name: s.name,
        student_class: s.className,
        candidate_number: s.candidateNumber,
        student_pin: s.pin,
        submitted_at: new Date().toISOString(),
        duration_seconds: 900 + (s.index % 300),
        score: 26,
        total_marks: exam.totalMarks,
        percentage: 87,
        violations_count: 0,
        proctoring_logs: [],
        raw_answers: s.answers,
        question_results: [],
        topic_breakdown: {},
        status: 'submitted',
        teacher_adjusted_marks: 0,
        teacher_notes: '',
        result_pin: '654321',
        updated_at: new Date().toISOString(),
        draft_key: s.draftKey,
        draft_owner_token: s.ownerToken,
      };

      const subRes = await supaRpc('submit_student_exam_attempt', { p_row: row });
      submitDurations.push(subRes.durationMs);
      const accepted = subRes.status === 200 && subRes.data === true;
      if (accepted) {
        submittedIds.push(s.submissionId);
        bucket.ok++;
      }

      recordEvent({
        wave: 'wave_4_submit',
        quizCode: s.quizCode,
        studentTag: s.studentTag,
        action: 'submit_student_exam_attempt',
        durationMs: subRes.durationMs,
        httpStatus: subRes.status,
        outcome: accepted ? 'ok' : 'error',
        notes: accepted ? '' : subRes.errorText,
      });

      const delRes = await supaRpc('delete_student_exam_draft', {
        p_key: s.draftKey,
        p_owner_token: s.ownerToken,
      });
      if (delRes.status === 200 && delRes.data === true) {
        createdDrafts.delete(s.draftKey);
      }
    });

    // Server security checks on accepted ICM-1..ICM-13 exams:
    // 1. Wrong/unregistered student PIN submit rejection (synthetic probe per exam)
    let submitWrongPinBlocked = 0;
    await runWithConcurrency(EXAM_CODES, 13, async (code, i) => {
      const exam = examMetaByCode.get(code);
      const r = await supaRpc('submit_student_exam_attempt', {
        p_row: {
          id: `icm13stress-${RUN_TAG}-negpin-${i}`,
          quiz_id: exam.quizId,
          quiz_code: code,
          student_name: `Unregistered Probe ${RUN_TAG}`,
          student_class: exam.targetClass,
          student_pin: '0000',
          score: 0,
          total_marks: 30,
          percentage: 0,
        },
      });
      if (r.status >= 400 || r.data === false) submitWrongPinBlocked++;
      else submittedIds.push(`icm13stress-${RUN_TAG}-negpin-${i}`);
    });

    // 2. Duplicate second-attempt block check under new ID for 1 accepted candidate
    const acceptedSample = submitCandidates.find((s) => submittedIds.includes(s.submissionId));
    let duplicateBlocked = false;
    if (acceptedSample) {
      const dupId = `icm13stress-${RUN_TAG}-dup-probe`;
      const dupRes = await supaRpc('submit_student_exam_attempt', {
        p_row: {
          id: dupId,
          quiz_id: examMetaByCode.get(acceptedSample.quizCode).quizId,
          quiz_code: acceptedSample.quizCode,
          student_name: acceptedSample.name,
          student_class: acceptedSample.className,
          candidate_number: acceptedSample.candidateNumber,
          student_pin: acceptedSample.pin,
          score: 30,
          total_marks: 30,
          percentage: 100,
        },
      });
      duplicateBlocked = dupRes.status >= 400 || dupRes.data === false;
      if (!duplicateBlocked) submittedIds.push(dupId);
    }

    const w4WallMs = performance.now() - w4T0;
    console.log(
      `   Done Wave 4 in ${w4WallMs.toFixed(1)} ms | submitted=${submittedIds.length}/${submitCandidates.length} | wrongPinBlocked=${submitWrongPinBlocked}/13 | duplicateAttemptBlocked=${duplicateBlocked}`
    );

    // ── Write Telemetry Summary before finally cleanup checks ──────────────
    const summaryData = {
      matchedCount: matchedStudents.length,
      unmatchedCount: unmatchedClasses.length,
      w1WallMs,
      w1PaperOk,
      w1DirOk,
      w1AttemptOk,
      w1LeakCount: w1Leaks.length,
      w1PaperStats: calcPercentiles(w1PaperDurations),
      w1DirStats: calcPercentiles(w1DirDurations),
      w2WallMs,
      w2RealPinOk,
      w2NormalizedVariantOk,
      w2NormalizedVariantTotal,
      w2PinStats: calcPercentiles(w2PinDurations),
      negWrongClassOk,
      bruteLockoutTriggered,
      w3WallMs,
      w3DraftOk,
      w3DraftTotal: matchedStudents.length * 2,
      w3DraftStats: calcPercentiles(w3DraftDurations),
      recoveryOk,
      draftHijackBlocked,
      auditOk,
      auditTotal: auditSample.length,
      w4WallMs,
      submitAcceptedCount: submittedIds.length,
      submitExpectedCount: submitCandidates.length,
      submitStats: calcPercentiles(submitDurations),
      perExamSubmitCounts,
      submitWrongPinBlocked,
      duplicateBlocked,
    };

    // Stash for report in finally
    main._summary = summaryData;
  } finally {
    console.log('\nWave 5: Zero-residue cleanup of temporary stress drafts, submissions & audit logs...');
    let cleanedDrafts = 0;
    for (const [k, tok] of createdDrafts.entries()) {
      const d = await supaRpc('delete_student_exam_draft', { p_key: k, p_owner_token: tok });
      if (d.status === 200 && d.data === true) cleanedDrafts++;
    }

    const adminAuthHeaders = SERVICE_ROLE_KEY
      ? { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY }
      : teacherHeaders;

    let residualSubsCount = -1;
    let residualAuditsCount = -1;
    if (adminAuthHeaders) {
      await supaRest(`quiz_submissions?id=like.icm13stress-${RUN_TAG}-*`, {
        method: 'DELETE',
        extraHeaders: adminAuthHeaders,
        bearer: SERVICE_ROLE_KEY || ANON_KEY,
      });
      await supaRest(`proctor_audit_events?id=like.icm13stress-${RUN_TAG}-*`, {
        method: 'DELETE',
        extraHeaders: adminAuthHeaders,
        bearer: SERVICE_ROLE_KEY || ANON_KEY,
      });

      const [chkSub, chkAud] = await Promise.all([
        supaRest(`quiz_submissions?id=like.icm13stress-${RUN_TAG}-*&select=id`, {
          extraHeaders: adminAuthHeaders,
          bearer: SERVICE_ROLE_KEY || ANON_KEY,
        }),
        supaRest(`proctor_audit_events?id=like.icm13stress-${RUN_TAG}-*&select=id`, {
          extraHeaders: adminAuthHeaders,
          bearer: SERVICE_ROLE_KEY || ANON_KEY,
        }),
      ]);
      residualSubsCount = Array.isArray(chkSub.data) ? chkSub.data.length : -1;
      residualAuditsCount = Array.isArray(chkAud.data) ? chkAud.data.length : -1;
    }

    eventStream.end();
    const totalWallMs = Number((performance.now() - globalT0).toFixed(1));

    if (main._summary) {
      const s = main._summary;
      const perExamRows = EXAM_CODES.map((c) => {
        const meta = s.perExamSubmitCounts.get(c);
        return `| \`${c}\` | ${meta?.expected ?? 0} | ${meta?.ok ?? 0}/${meta?.expected ?? 0} |`;
      }).join('\n');

      const md = `# ICM-1 to ICM-13 Class-Scoped + Student PIN Stress Test Report

- **Run ID**: \`${RUN_TAG}\`
- **Timestamp**: ${new Date().toISOString()}
- **Target**: Live Supabase (\`${SUPABASE_URL}\`)
- **Total Wall-Clock Runtime**: ${totalWallMs} ms
- **Logged Events**: ${allEvents.length} JSONL entries (\`artifacts/icm13_stress_events.jsonl\`, student names & PINs redacted)
- **Zero-Residue Cleanup**: Remaining test drafts cleaned=${cleanedDrafts}; residual test submissions=${residualSubsCount}; residual test audits=${residualAuditsCount}

---

## 1. Concurrency & Latency Telemetry (166 Real Students Across 13 Classes)

| Wave / Operation | Volume | Pass Rate | p50 (ms) | p95 (ms) | max (ms) | Wall (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Wave 1 — \`get_student_exam_paper\` (\`ICM-1..ICM-13\`)** | ${s.matchedCount} | ${s.w1PaperOk}/${s.matchedCount} | ${s.w1PaperStats.p50} | ${s.w1PaperStats.p95} | ${s.w1PaperStats.max} | ${s.w1WallMs.toFixed(1)} |
| **Wave 1 — \`get_public_roster_directory\`** | ${s.matchedCount} | ${s.w1DirOk}/${s.matchedCount} | ${s.w1DirStats.p50} | ${s.w1DirStats.p95} | ${s.w1DirStats.max} | — |
| **Wave 2 — \`verify_student_pin\` (Real Student PINs)** | ${s.matchedCount} | ${s.w2RealPinOk}/${s.matchedCount} | ${s.w2PinStats.p50} | ${s.w2PinStats.p95} | ${s.w2PinStats.max} | ${s.w2WallMs.toFixed(1)} |
| **Wave 3 — \`save_student_exam_draft\` (2x burst)** | ${s.w3DraftTotal} | ${s.w3DraftOk}/${s.w3DraftTotal} | ${s.w3DraftStats.p50} | ${s.w3DraftStats.p95} | ${s.w3DraftStats.max} | ${s.w3WallMs.toFixed(1)} |
| **Wave 4 — \`submit_student_exam_attempt\` (With PINs)** | ${s.submitExpectedCount} | ${s.submitAcceptedCount}/${s.submitExpectedCount} | ${s.submitStats.p50} | ${s.submitStats.p95} | ${s.submitStats.max} | ${s.w4WallMs.toFixed(1)} |

---

## 2. Per-Exam Class Submission Results (\`ICM-1\` .. \`ICM-13\`)

| Quiz Code | Enrolled Cohort Tested | Accepted With Real PIN |
| :--- | :---: | :---: |
${perExamRows}

---

## 3. Security & Integrity Verification

- **Key / Answer / PIN Leakage Scan**: \`${s.w1LeakCount}\` leaked key/PIN fields across all 166 \`get_student_exam_paper\` + \`get_public_roster_directory\` payloads.
- **Class Notation Parity (\`normalize_roster_class_label\`)**: \`${s.w2NormalizedVariantOk}/${s.w2NormalizedVariantTotal}\` passed with hyphenated/lowercase class notation + real PIN.
- **Brute-Force PIN Lockout**: Synthetic probe wrong-PIN rejection = \`${s.negWrongClassOk}/13\`; 12-attempt mixed-class brute-force lockout triggered = \`${s.bruteLockoutTriggered}\`.
- **Draft Lock & Hijack Resistance**: Recovery = \`${s.recoveryOk}/13\`; cross-token hijack blocked = \`${s.draftHijackBlocked}/13\`; audit inserts = \`${s.auditOk}/${s.auditTotal}\`.
- **Submission Gate Enforcement**: Unregistered/wrong-PIN submit rejected = \`${s.submitWrongPinBlocked}/13\`; duplicate second-attempt blocked = \`${s.duplicateBlocked}\`.
`;
      fs.writeFileSync(REPORT_PATH, md, 'utf8');
      console.log(`Report saved to ${REPORT_PATH}`);
    }
    console.log(
      `Cleanup complete: residual_submissions=${residualSubsCount}, residual_audits=${residualAuditsCount}, wall=${totalWallMs} ms`
    );
  }
}

main().catch((err) => {
  console.error('Stress test fatal error:', err);
  process.exit(1);
});
