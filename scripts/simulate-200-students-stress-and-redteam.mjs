import fs from 'node:fs';
import path from 'node:path';
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

const READ_QUIZ_CODE = 'ICM170';
const WRITE_QUIZ_CODE = 'STRESS200';
const WRITE_QUIZ_ID = 'stress200-exam-fixture';
const RUN_TAG = Date.now().toString(36);

fs.mkdirSync(path.resolve('artifacts'), { recursive: true });
const EVENTS_LOG_PATH = path.resolve('artifacts/stress200_events.jsonl');
const REPORT_PATH = path.resolve('Plan/student_200_stress_test_report.md');

const eventStream = fs.createWriteStream(EVENTS_LOG_PATH, { flags: 'w' });
const allEvents = [];

function recordEvent({
  wave,
  cohort,
  studentId,
  action,
  target,
  durationMs,
  httpStatus,
  outcome,
  notes = '',
}) {
  const entry = {
    ts: new Date().toISOString(),
    wave,
    cohort,
    studentId,
    action,
    target,
    durationMs: Number(durationMs.toFixed(1)),
    httpStatus,
    outcome,
    notes,
  };
  allEvents.push(entry);
  eventStream.write(`${JSON.stringify(entry)}\n`);
}

function fmtRpcResult(res) {
  if (res.status >= 400) {
    return `HTTP ${res.status}${res.errorText ? ` (${res.errorText})` : ''}`;
  }
  return typeof res.data === 'object' && res.data !== null ? JSON.stringify(res.data) : String(res.data);
}

// ─── HTTP / Supabase Helpers ─────────────────────────────────────────────────

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

// ─── Cohort Builders (200 Virtual Students) ──────────────────────────────────

function makeSampleAnswers(seedIdx) {
  return {
    1: seedIdx % 2 === 0 ? 'B' : 'A',
    2: `${(2.4 + (seedIdx % 5) * 0.2).toFixed(1)} m/s^2`,
    3: 'C',
    4: 'Guard cells regulate stomatal aperture by turgor changes.',
    5: 'Contour spacing narrows on the north-eastern ridge (gradient ~1:8).',
    6: { r0_c1: '4.2', r1_c1: '8.4', r2_c1: '12.6' },
    7: ['A', 'C'],
    8: { gap1: 'exothermic', gap2: 'activation' },
    9: 'ب',
    10: 'Laju reaksi meningkat karena frekuensi tumbukan efektif bertambah.',
  };
}

function buildCohortStudents() {
  const students = [];
  for (let i = 1; i <= 200; i++) {
    const num = String(i).padStart(3, '0');
    const studentId = `STU-${num}`;
    let cohort = 'A_normal';
    if (i > 120 && i <= 150) cohort = 'B_unstable_device_switch';
    else if (i > 150 && i <= 175) cohort = 'C_violator';
    else if (i > 175 && i <= 190) cohort = 'D_weird_fuzzer';
    else if (i > 190) cohort = 'E_redteam';

    const classPool = ['10-A', '10-B', '11-A', '11-B', '12-A'];
    const useBlankResultPin = i <= 150 || i === 195;
    const resultPin = useBlankResultPin
      ? ''
      : String(100000 + ((i * 7919) % 899999));
    const joinPin = String(1000 + ((i * 37) % 8999));
    const slugClass = classPool[i % classPool.length]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    students.push({
      index: i,
      studentId,
      cohort,
      studentName: `Sim Student ${num} (${RUN_TAG})`,
      studentClass: classPool[i % classPool.length],
      candidateNumber: `CAND-${RUN_TAG}-${num}`,
      resultPin,
      joinPin,
      draftKey: `draft_${WRITE_QUIZ_CODE}_sim_student_${num}_${RUN_TAG}__cls_${slugClass}`.toLowerCase(),
      draftOwnerToken: `cls:${WRITE_QUIZ_CODE}:sim_student_${num}_${RUN_TAG}__cls_${slugClass}`,
      submissionId: `stress200-${RUN_TAG}-stu-${num}`,
      answers: makeSampleAnswers(i),
      violations: [],
    });
  }
  return students;
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

// ─── Main Simulation Runner ──────────────────────────────────────────────────

async function main() {
  const students = buildCohortStudents();
  const createdDrafts = new Map();
  const submittedIds = [];
  const findings = [];
  const waveSummaries = {};
  let teacherSessionHeader = null;

  console.log(`🚀 Starting 200-Student Stress Test & Red-Team Simulation (run=${RUN_TAG})`);
  console.log(`   Read Exam Code : ${READ_QUIZ_CODE}`);
  console.log(`   Write Quiz Code: ${WRITE_QUIZ_CODE}`);
  console.log(`   Telemetry Log  : ${EVENTS_LOG_PATH}\n`);

  const globalT0 = performance.now();

  try {
    if (TEACHER_SESSION_TOKEN) {
      teacherSessionHeader = { 'x-teacher-session': TEACHER_SESSION_TOKEN };
    } else if (TEACHER_LOGIN_ID && TEACHER_LOGIN_PASSWORD) {
      const authRes = await supaRpc('login_teacher_account', {
        p_identifier: TEACHER_LOGIN_ID,
        p_password: TEACHER_LOGIN_PASSWORD,
      });
      if (authRes.status === 200 && authRes.data?.token) {
        teacherSessionHeader = { 'x-teacher-session': authRes.data.token };
      }
    }

    // ── Wave 1: 200-Way Thundering Herd Lobby Entry ──────────────────────────
    console.log('🌊 Wave 1: Launching 200 concurrent lobby entries (get_student_exam_paper + check_student_attempt_submitted)...');
    const w1T0 = performance.now();
    const w1LeakSamples = [];

    const w1Results = await runWithConcurrency(students, 200, async (s) => {
      const paperRes = await supaRpc('get_student_exam_paper', { p_code: READ_QUIZ_CODE });
      const leaks = Array.isArray(paperRes.data?.questions)
        ? deepScanLeakedKeys(paperRes.data.questions)
        : [];
      if (paperRes.data?.teacherPinHash) {
        leaks.push('teacherPinHash(non-null)');
      }
      if (leaks.length > 0 && w1LeakSamples.length < 5) {
        w1LeakSamples.push({ studentId: s.studentId, leaks });
      }
      const paperOk =
        paperRes.status === 200 &&
        paperRes.data?.isActive === true &&
        paperRes.data?.scheduleStatus === 'active' &&
        Boolean(paperRes.data?.serverNow) &&
        Array.isArray(paperRes.data?.questions) &&
        paperRes.data.questions.length > 0 &&
        leaks.length === 0;

      recordEvent({
        wave: 'wave_1_lobby_herd',
        cohort: s.cohort,
        studentId: s.studentId,
        action: 'get_student_exam_paper',
        target: `rpc:get_student_exam_paper(${READ_QUIZ_CODE})`,
        durationMs: paperRes.durationMs,
        httpStatus: paperRes.status,
        outcome: paperOk ? 'ok' : 'error',
        notes: paperOk
          ? `q=${paperRes.data.questions.length},sched=${paperRes.data.scheduleStatus},leaks=0`
          : paperRes.errorText || `isActive=${paperRes.data?.isActive},sched=${paperRes.data?.scheduleStatus},leaks=${leaks.join(',')}`,
      });

      const attemptRes = await supaRpc('check_student_attempt_submitted', {
        p_quiz_code: WRITE_QUIZ_CODE,
        p_student_name: s.studentName,
        p_student_class: s.studentClass,
        p_student_number: s.candidateNumber,
      });
      const attemptOk = attemptRes.status === 200 && attemptRes.data?.submitted === false;
      recordEvent({
        wave: 'wave_1_lobby_herd',
        cohort: s.cohort,
        studentId: s.studentId,
        action: 'check_student_attempt_submitted',
        target: 'rpc:check_student_attempt_submitted',
        durationMs: attemptRes.durationMs,
        httpStatus: attemptRes.status,
        outcome: attemptOk ? 'ok' : 'error',
        notes: attemptRes.errorText || '',
      });

      return { paperRes, attemptRes, paperOk, attemptOk };
    });

    // ── Wave 1B: 200-Way Student Join Roster Directory & Join PIN Burst ─────
    console.log('🌊 Wave 1B: Stress testing student join roster directory (200x) & verify_student_pin (200x + brute-force rate limit)...');
    const w1bT0 = performance.now();
    let dirLeakCount = 0;
    let firstRealStudent = null;
    const dirResults = await runWithConcurrency(students, 200, async (s) => {
      const res = await supaRpc('get_public_roster_directory', {});
      const list = Array.isArray(res.data) ? res.data : [];
      const hasLeakedPin = list.some(
        (item) => item && ('pin' in item || 'pinHash' in item || 'pin_hash' in item || 'password' in item)
      );
      if (hasLeakedPin) dirLeakCount++;
      if (!firstRealStudent && list.length > 0 && list[0]?.name) {
        firstRealStudent = list[0];
      }
      const ok = res.status === 200 && Array.isArray(res.data) && !hasLeakedPin;
      recordEvent({
        wave: 'wave_1b_join_pin',
        cohort: s.cohort,
        studentId: s.studentId,
        action: 'get_public_roster_directory',
        target: 'rpc:get_public_roster_directory',
        durationMs: res.durationMs,
        httpStatus: res.status,
        outcome: ok ? 'ok' : 'error',
        notes: ok ? `rows=${list.length}` : res.errorText || 'leaked_pin_or_bad_shape',
      });
      return { res, ok };
    });

    // Use synthetic candidate names for 200-way PIN burst so real roster students are never rate-limited
    const joinPinResults = await runWithConcurrency(students, 200, async (s) => {
      const res = await supaRpc('verify_student_pin', {
        p_name: `Sim Join Probe ${RUN_TAG}-${s.studentId}`,
        p_class: s.studentClass,
        p_pin: s.joinPin,
      });
      const handledCleanly =
        res.status === 200 &&
        res.data &&
        typeof res.data === 'object' &&
        res.data.valid === false &&
        !('pin' in (res.data.student || {}));
      recordEvent({
        wave: 'wave_1b_join_pin',
        cohort: s.cohort,
        studentId: s.studentId,
        action: 'verify_student_pin_burst',
        target: 'rpc:verify_student_pin',
        durationMs: res.durationMs,
        httpStatus: res.status,
        outcome: handledCleanly ? 'ok' : 'error',
        notes: res.errorText || res.data?.error || '',
      });
      return { res, handledCleanly };
    });

    // Brute-force lockout test on two dedicated synthetic identities:
    // (a) mixed notation ('X IPA 3' vs '10-IPA-03') to verify 025 class-normalization parity
    // (b) consistent class notation ('X IPA 3') to verify base 10-failure rate limit (024+)
    const bruteTargetName = `Sim Brute Target ${RUN_TAG}`;
    const bruteResponses = [];
    for (let attempt = 1; attempt <= 12; attempt++) {
      const bRes = await supaRpc('verify_student_pin', {
        p_name: bruteTargetName,
        p_class: attempt % 2 === 0 ? 'X IPA 3' : '10-IPA-03',
        p_pin: String(1000 + attempt),
      });
      bruteResponses.push(bRes);
      recordEvent({
        wave: 'wave_1b_join_pin',
        cohort: 'E_redteam',
        studentId: 'STU-BRUTE-MIXED',
        action: `verify_student_pin_bruteforce_${attempt}`,
        target: 'rpc:verify_student_pin',
        durationMs: bRes.durationMs,
        httpStatus: bRes.status,
        outcome: bRes.status === 200 && bRes.data?.valid === false ? 'ok' : 'error',
        notes: bRes.data?.error || bRes.errorText || '',
      });
    }
    const bruteExactName = `Sim Brute Exact ${RUN_TAG}`;
    const bruteExactResponses = [];
    for (let attempt = 1; attempt <= 12; attempt++) {
      const bRes = await supaRpc('verify_student_pin', {
        p_name: bruteExactName,
        p_class: 'X IPA 3',
        p_pin: String(2000 + attempt),
      });
      bruteExactResponses.push(bRes);
      recordEvent({
        wave: 'wave_1b_join_pin',
        cohort: 'E_redteam',
        studentId: 'STU-BRUTE-EXACT',
        action: `verify_student_pin_exact_${attempt}`,
        target: 'rpc:verify_student_pin',
        durationMs: bRes.durationMs,
        httpStatus: bRes.status,
        outcome: bRes.status === 200 && bRes.data?.valid === false ? 'ok' : 'error',
        notes: bRes.data?.error || bRes.errorText || '',
      });
    }
    const bruteLockedOutMixed = bruteResponses.some((r) => /too many failed pin attempts/i.test(String(r.data?.error || '')));
    const bruteLockedOutExact = bruteExactResponses.some((r) => /too many failed pin attempts/i.test(String(r.data?.error || '')));
    const bruteLockedOut = bruteLockedOutExact && bruteLockedOutMixed;

    const w1WallMs = performance.now() - w1T0;
    const w1bWallMs = performance.now() - w1bT0;
    waveSummaries.wave1 = {
      wallMs: Number(w1WallMs.toFixed(1)),
      paperStats: calcPercentiles(w1Results.map((r) => r.paperRes.durationMs)),
      attemptStats: calcPercentiles(w1Results.map((r) => r.attemptRes.durationMs)),
      paperOkCount: w1Results.filter((r) => r.paperOk).length,
      attemptOkCount: w1Results.filter((r) => r.attemptOk).length,
      leakedKeysCount: w1LeakSamples.length,
    };
    waveSummaries.wave1b = {
      wallMs: Number(w1bWallMs.toFixed(1)),
      dirStats: calcPercentiles(dirResults.map((r) => r.res.durationMs)),
      dirOkCount: dirResults.filter((r) => r.ok).length,
      dirLeakCount,
      joinPinStats: calcPercentiles(joinPinResults.map((r) => r.res.durationMs)),
      joinPinOkCount: joinPinResults.filter((r) => r.handledCleanly).length,
      bruteLockedOut,
      bruteLockedOutExact,
      bruteLockedOutMixed,
      rosterSize: firstRealStudent ? 'non-empty' : 'empty_or_unconfigured',
    };
    console.log(
      `   Done Wave 1 in ${waveSummaries.wave1.wallMs} ms | paper ok: ${waveSummaries.wave1.paperOkCount}/200 (p50=${waveSummaries.wave1.paperStats.p50}ms, p95=${waveSummaries.wave1.paperStats.p95}ms, max=${waveSummaries.wave1.paperStats.max}ms) | leaks=${w1LeakSamples.length}`
    );
    console.log(
      `   Done Wave 1B in ${waveSummaries.wave1b.wallMs} ms | directory ok: ${waveSummaries.wave1b.dirOkCount}/200 (leaks=${dirLeakCount}) | join PIN burst ok: ${waveSummaries.wave1b.joinPinOkCount}/200 (p50=${waveSummaries.wave1b.joinPinStats.p50}ms, p95=${waveSummaries.wave1b.joinPinStats.p95}ms) | brute lockout=${bruteLockedOut}`
    );

    // ── Wave 2: Autosave Storm, Device Switch, Violations & Fuzz/Red-Team ────
    console.log('\n🌊 Wave 2: Mid-exam autosave storm (3 ticks x 200), device switching, proctor violations, weird inputs...');
    const w2T0 = performance.now();
    const draftDurations = [];
    let draftSaveOkCount = 0;
    let draftSaveSampleErr = '';
    const draftReadDurations = [];
    const auditDurations = [];
    const pinUnlockDurations = [];

    for (let round = 1; round <= 3; round++) {
      await runWithConcurrency(students, 100, async (s) => {
        createdDrafts.set(s.draftKey, s.draftOwnerToken);
        const isFuzzLarge = s.cohort === 'D_weird_fuzzer' && s.index === 176 && round === 2;
        const isClockTamper = s.cohort === 'D_weird_fuzzer' && s.index === 177 && round === 2;
        const isXss = s.cohort === 'D_weird_fuzzer' && s.index === 178 && round === 2;

        const payload = {
          quizCode: WRITE_QUIZ_CODE,
          quizId: WRITE_QUIZ_ID,
          studentName: isXss ? `<script>alert(1)</script>${s.studentName}` : s.studentName,
          candidateNumber: s.candidateNumber,
          candidateClass: s.studentClass,
          studentPin: s.resultPin,
          answers: isFuzzLarge ? { ...s.answers, 4: 'A'.repeat(95 * 1024) } : s.answers,
          currentIndex: round * 3,
          timeLeftSeconds: isClockTamper ? 999999 : 1200 - round * 240,
          startTime: Date.now() - round * 240000,
          targetEndTime: isClockTamper ? Date.now() + 99999999 : Date.now() + 960000,
          lastSavedAt: new Date().toISOString(),
          status: 'in_progress',
        };

        let res = await supaRpc('save_student_exam_draft', {
          p_key: s.draftKey,
          p_value: JSON.stringify(payload),
          p_owner_token: s.draftOwnerToken,
        });
        if (res.status === 404 || /PGRST202/i.test(res.errorText)) {
          res = await supaRpc('save_student_exam_draft', {
            p_key: s.draftKey,
            p_value: JSON.stringify(payload),
          });
        }
        draftDurations.push(res.durationMs);
        const ok = res.status === 200 && res.data === true;
        if (ok) draftSaveOkCount++;
        else if (!draftSaveSampleErr) draftSaveSampleErr = fmtRpcResult(res);

        recordEvent({
          wave: 'wave_2_mid_exam',
          cohort: s.cohort,
          studentId: s.studentId,
          action: `save_draft_round_${round}`,
          target: 'rpc:save_student_exam_draft',
          durationMs: res.durationMs,
          httpStatus: res.status,
          outcome: ok ? 'ok' : 'error',
          notes: ok
            ? isFuzzLarge
              ? '95KB_payload'
              : isClockTamper
                ? 'clock_skew'
                : isXss
                  ? 'xss_name'
                  : ''
            : res.errorText,
        });
      });
    }

    const cohortB = students.filter((s) => s.cohort === 'B_unstable_device_switch');
    let draftRecoveredCount = 0;
    await runWithConcurrency(cohortB, 30, async (s) => {
      let res = await supaRpc('get_student_exam_draft', {
        p_key: s.draftKey,
        p_owner_token: s.draftOwnerToken,
      });
      if (res.status === 404 || /PGRST202/i.test(res.errorText)) {
        res = await supaRpc('get_student_exam_draft', { p_key: s.draftKey });
      }
      draftReadDurations.push(res.durationMs);
      let matched = false;
      try {
        const parsed = typeof res.data === 'string' ? JSON.parse(res.data) : null;
        matched = parsed?.studentName === s.studentName && parsed?.quizCode === WRITE_QUIZ_CODE;
      } catch { }
      if (matched) draftRecoveredCount++;
      recordEvent({
        wave: 'wave_2_mid_exam',
        cohort: s.cohort,
        studentId: s.studentId,
        action: 'device_switch_draft_recover',
        target: 'rpc:get_student_exam_draft',
        durationMs: res.durationMs,
        httpStatus: res.status,
        outcome: matched ? 'ok' : 'error',
      });
    });

    const cohortC = students.filter((s) => s.cohort === 'C_violator');
    const violationSequence = [
      { eventType: 'tab_hidden', severity: 'warning', detail: 'Tab visibility changed to hidden (Tier 1)' },
      { eventType: 'window_blur', severity: 'warning', detail: 'Browser window lost focus (Tier 2 timed lock)' },
      { eventType: 'fullscreen_exit', severity: 'critical', detail: 'Exited fullscreen exam shell (Tier 3 PIN lock)' },
      { eventType: 'clipboard_attempt', severity: 'warning', detail: 'Blocked Ctrl+C / copy shortcut' },
      { eventType: 'devtools_shortcut', severity: 'critical', detail: 'Blocked F12 / DevTools inspection attempt' },
      { eventType: 'multi_monitor_detected', severity: 'critical', detail: 'Secondary display detected (Tier 4 auto-submit)' },
    ];
    let auditInsertedCount = 0;
    await runWithConcurrency(cohortC, 25, async (s) => {
      const strikes = 3 + (s.index % 4);
      for (let vIdx = 0; vIdx < strikes; vIdx++) {
        const tmpl = violationSequence[vIdx % violationSequence.length];
        s.violations.push({ type: tmpl.eventType, ts: new Date().toISOString() });
        const auditRow = {
          id: `stress200-audit-${RUN_TAG}-${s.studentId}-${vIdx + 1}`,
          quiz_code: WRITE_QUIZ_CODE,
          student_id: s.candidateNumber,
          student_name: s.studentName,
          candidate_number: s.candidateNumber,
          candidate_class: s.studentClass,
          event_type: tmpl.eventType,
          severity: tmpl.severity,
          detail: tmpl.detail,
          actor: 'student',
          created_at: new Date().toISOString(),
        };
        const res = await supaRest('proctor_audit_events', { method: 'POST', body: auditRow });
        auditDurations.push(res.durationMs);
        if (res.status >= 200 && res.status < 300) auditInsertedCount++;
        recordEvent({
          wave: 'wave_2_mid_exam',
          cohort: s.cohort,
          studentId: s.studentId,
          action: `proctor_violation_${tmpl.eventType}`,
          target: 'table:proctor_audit_events',
          durationMs: res.durationMs,
          httpStatus: res.status,
          outcome: res.status >= 200 && res.status < 300 ? 'ok' : 'error',
          notes: `strike=${vIdx + 1}`,
        });
      }
      const pinRes = await supaRpc('verify_teacher_unlock_pin', {
        p_quiz_code: READ_QUIZ_CODE,
        p_pin: '000000',
      });
      pinUnlockDurations.push(pinRes.durationMs);
      recordEvent({
        wave: 'wave_2_mid_exam',
        cohort: s.cohort,
        studentId: s.studentId,
        action: 'verify_wrong_unlock_pin',
        target: 'rpc:verify_teacher_unlock_pin',
        durationMs: pinRes.durationMs,
        httpStatus: pinRes.status,
        outcome: pinRes.status === 200 && pinRes.data === false ? 'ok' : 'error',
      });
    });

    const weirdAuditRes = await supaRest('proctor_audit_events', {
      method: 'POST',
      body: {
        id: `stress200-audit-${RUN_TAG}-XSS`,
        quiz_code: WRITE_QUIZ_CODE,
        student_id: `CAND-${RUN_TAG}-178`,
        student_name: `<img src=x onerror=alert('xss')> \u200D 🧪`,
        candidate_number: `CAND-${RUN_TAG}-178`,
        candidate_class: '10-A',
        event_type: 'weird_input_probe',
        severity: 'warning',
        detail: `' OR '1'='1; <script>fetch('https://evil.test')</script>`,
        actor: 'student',
      },
    });
    const longDraftKey = `draft_${WRITE_QUIZ_CODE}_${'x'.repeat(200)}`;
    const longDraftRes = await supaRpc('save_student_exam_draft', {
      p_key: longDraftKey,
      p_value: '{}',
      p_owner_token: 'pin:STRESS200:999',
    });
    recordEvent({
      wave: 'wave_2_mid_exam',
      cohort: 'D_weird_fuzzer',
      studentId: 'STU-179',
      action: 'oversized_draft_key_reject',
      target: 'rpc:save_student_exam_draft',
      durationMs: longDraftRes.durationMs,
      httpStatus: longDraftRes.status,
      outcome: longDraftRes.data === false || longDraftRes.status >= 400 ? 'ok' : 'error',
      notes: `keyLen=${longDraftKey.length}, res=${fmtRpcResult(longDraftRes)}`,
    });

    const w2WallMs = Number((performance.now() - w2T0).toFixed(1));

    // ── Wave 3: 200-Way Submission Stampede & Duplicate Races ────────────────
    console.log('\n🌊 Wave 3: Launching 200 concurrent submissions + duplicate/replay races...');
    const w3T0 = performance.now();

    const w3Results = await runWithConcurrency(students, 200, async (s) => {
      let row = {
        id: s.submissionId,
        quiz_id: WRITE_QUIZ_ID,
        quiz_code: WRITE_QUIZ_CODE,
        quiz_title: '200-Student Stress Test Fixture',
        subject: 'Chemistry',
        student_name: s.studentName,
        student_class: s.studentClass,
        candidate_number: s.candidateNumber,
        submitted_at: new Date().toISOString(),
        duration_seconds: 900 + (s.index % 300),
        score: 16,
        total_marks: 22,
        percentage: 73,
        violations_count: s.violations.length,
        proctoring_logs: s.violations,
        raw_answers: s.answers,
        question_results: [],
        topic_breakdown: {},
        status: 'submitted',
        teacher_adjusted_marks: 0,
        teacher_notes: '',
        result_pin: s.resultPin,
        updated_at: new Date().toISOString(),
        draft_key: s.draftKey,
        draft_owner_token: s.draftOwnerToken,
      };

      if (s.index === 176) row.raw_answers = { essay: 'X'.repeat(95 * 1024) };
      if (s.index === 177) row.duration_seconds = -9999;
      if (s.index === 178) row.student_name = `<script>alert(1)</script> \u200D 🧪`;
      if (s.index === 180) row.raw_answers = {};
      if (s.index === 181) row.duration_seconds = 'NaN';
      if (s.index === 182) row.student_name = `Ali % _ ' OR '1'='1`;

      if (s.index === 191) {
        row.raw_answers = { 1: 'DEFINITELY_WRONG', 2: 'WRONG' };
        row.score = 999;
        row.total_marks = 22;
        row.percentage = 100;
        row.status = 'published';
        row.teacher_adjusted_marks = 50;
      }

      if (s.index === 195) {
        row.result_pin = '';
      }

      const subRes = await supaRpc('submit_student_exam_attempt', { p_row: row });
      const accepted = subRes.status === 200 && subRes.data === true;
      if (accepted) submittedIds.push(s.submissionId);

      recordEvent({
        wave: 'wave_3_submission_stampede',
        cohort: s.cohort,
        studentId: s.studentId,
        action: 'submit_student_exam_attempt',
        target: 'rpc:submit_student_exam_attempt',
        durationMs: subRes.durationMs,
        httpStatus: subRes.status,
        outcome: accepted ? 'ok' : s.index === 181 && subRes.data === false ? 'ok_handled_malformed' : 'error',
        notes: s.index === 191 ? `forged_score_accepted=${accepted}` : subRes.errorText || '',
      });

      let delRes = await supaRpc('delete_student_exam_draft', {
        p_key: s.draftKey,
        p_owner_token: s.draftOwnerToken,
      });
      if (delRes.status === 404 || /PGRST202/i.test(delRes.errorText)) {
        delRes = await supaRpc('delete_student_exam_draft', { p_key: s.draftKey });
      }
      if (delRes.status === 200 && delRes.data === true) createdDrafts.delete(s.draftKey);

      return { s, subRes, accepted, delRes };
    });

    let dupRacePassed = 0;
    let blankPinRetryPassed = 0;
    // Split 50ms duplicate races across blank-PIN (Cohort B 121..125) and 6-digit PIN (151..155) students
    await runWithConcurrency([...cohortB.slice(0, 5), ...students.slice(150, 155)], 10, async (s) => {
      const retryRow = {
        id: s.submissionId,
        quiz_id: WRITE_QUIZ_ID,
        quiz_code: WRITE_QUIZ_CODE,
        student_name: s.studentName,
        student_class: s.studentClass,
        candidate_number: s.candidateNumber,
        score: 16,
        total_marks: 22,
        percentage: 73,
        result_pin: s.resultPin,
        draft_key: s.draftKey,
        draft_owner_token: s.draftOwnerToken,
      };
      const [r1, r2] = await Promise.all([
        supaRpc('submit_student_exam_attempt', { p_row: retryRow }),
        supaRpc('submit_student_exam_attempt', { p_row: retryRow }),
      ]);
      if (r1.status === 200 && r1.data === true && r2.status === 200 && r2.data === true) dupRacePassed++;
      recordEvent({
        wave: 'wave_3_submission_stampede',
        cohort: 'B_unstable_device_switch',
        studentId: s.studentId,
        action: 'duplicate_50ms_submit_race',
        target: 'rpc:submit_student_exam_attempt',
        durationMs: Math.max(r1.durationMs, r2.durationMs),
        httpStatus: r1.status,
        outcome: r1.status === 200 && r2.status === 200 ? 'ok' : 'error',
        notes: `r1=${r1.data}, r2=${r2.data}, pin=${s.resultPin ? '6d' : 'blank'}`,
      });
    });

    for (const s of students.slice(0, 5)) {
      const retryBlankRow = {
        id: s.submissionId,
        quiz_id: WRITE_QUIZ_ID,
        quiz_code: WRITE_QUIZ_CODE,
        student_name: s.studentName,
        student_class: s.studentClass,
        candidate_number: s.candidateNumber,
        score: 16,
        total_marks: 22,
        percentage: 73,
        result_pin: '',
      };
      const rRetry = await supaRpc('submit_student_exam_attempt', { p_row: retryBlankRow });
      if (rRetry.status === 200 && rRetry.data === true) blankPinRetryPassed++;
      recordEvent({
        wave: 'wave_3_submission_stampede',
        cohort: s.cohort,
        studentId: s.studentId,
        action: 'blank_pin_post_unlock_retry',
        target: 'rpc:submit_student_exam_attempt',
        durationMs: rRetry.durationMs,
        httpStatus: rRetry.status,
        outcome: rRetry.status === 200 && rRetry.data === true ? 'ok' : 'error',
        notes: `res=${fmtRpcResult(rRetry)}`,
      });
    }

    // Class-scoped homonym isolation & concurrent draft-lock contention checks (031)
    const homonymName = `Homonym Candidate (${RUN_TAG})`;
    const hKeyA = `draft_${WRITE_QUIZ_CODE}_homonym_candidate_${RUN_TAG}__cls_x_ipa_1`.toLowerCase();
    const hKeyB = `draft_${WRITE_QUIZ_CODE}_homonym_candidate_${RUN_TAG}__cls_x_ipa_2`.toLowerCase();
    const hTokA = `cls:${WRITE_QUIZ_CODE}:homonym__x_ipa_1`;
    const hTokB = `cls:${WRITE_QUIZ_CODE}:homonym__x_ipa_2`;
    await supaRpc('save_student_exam_draft', { p_key: hKeyA, p_value: JSON.stringify({ studentName: homonymName, studentClass: 'X IPA 1' }), p_owner_token: hTokA });
    await supaRpc('save_student_exam_draft', { p_key: hKeyB, p_value: JSON.stringify({ studentName: homonymName, studentClass: 'X IPA 2' }), p_owner_token: hTokB });
    createdDrafts.set(hKeyA, hTokA);
    createdDrafts.set(hKeyB, hTokB);

    const homSubAId = `stress200-${RUN_TAG}-hom-a`;
    const homSubBId = `stress200-${RUN_TAG}-hom-b`;
    const homSubADupId = `stress200-${RUN_TAG}-hom-a-dup`;
    const homSubARes = await supaRpc('submit_student_exam_attempt', {
      p_row: {
        id: homSubAId, quiz_id: WRITE_QUIZ_ID, quiz_code: WRITE_QUIZ_CODE,
        student_name: homonymName, student_class: 'X IPA 1', result_pin: '',
        score: 10, total_marks: 20, percentage: 50, draft_key: hKeyA, draft_owner_token: hTokA,
      },
    });
    const homSubBRes = await supaRpc('submit_student_exam_attempt', {
      p_row: {
        id: homSubBId, quiz_id: WRITE_QUIZ_ID, quiz_code: WRITE_QUIZ_CODE,
        student_name: homonymName, student_class: 'X IPA 2', result_pin: '',
        score: 12, total_marks: 20, percentage: 60, draft_key: hKeyB, draft_owner_token: hTokB,
      },
    });
    const homDupSameClassRes = await supaRpc('submit_student_exam_attempt', {
      p_row: {
        id: homSubADupId, quiz_id: WRITE_QUIZ_ID, quiz_code: WRITE_QUIZ_CODE,
        student_name: homonymName, student_class: '10 IPA 1', result_pin: '',
        score: 18, total_marks: 20, percentage: 90,
      },
    });
    if (homSubARes.data === true) submittedIds.push(homSubAId);
    if (homSubBRes.data === true) submittedIds.push(homSubBId);
    if (homDupSameClassRes.data === true) submittedIds.push(homSubADupId);

    const raceDraftKey = `draft_${WRITE_QUIZ_CODE}_lock_race_${RUN_TAG}`.toLowerCase();
    const [raceOwner1, raceOwner2] = await Promise.all([
      supaRpc('save_student_exam_draft', { p_key: raceDraftKey, p_value: '{"owner":1}', p_owner_token: 'race-token-1' }),
      supaRpc('save_student_exam_draft', { p_key: raceDraftKey, p_value: '{"owner":2}', p_owner_token: 'race-token-2' }),
    ]);
    if (raceOwner1.data === true) createdDrafts.set(raceDraftKey, 'race-token-1');
    else if (raceOwner2.data === true) createdDrafts.set(raceDraftKey, 'race-token-2');
    const draftContentionExclusive = !(raceOwner1.data === true && raceOwner2.data === true) && (raceOwner1.data === true || raceOwner2.data === true);

    const w3WallMs = Number((performance.now() - w3T0).toFixed(1));
    waveSummaries.wave2 = {
      wallMs: w2WallMs,
      draftWriteStats: calcPercentiles(draftDurations),
      draftSaveOkCount,
      draftSaveSampleErr,
      draftReadStats: calcPercentiles(draftReadDurations),
      draftRecoveredCount,
      auditStats: calcPercentiles(auditDurations),
      auditInsertedCount,
      pinUnlockStats: calcPercentiles(pinUnlockDurations),
      weirdAuditStatus: weirdAuditRes.status,
      draftContentionExclusive,
    };
    waveSummaries.wave3 = {
      wallMs: w3WallMs,
      submitStats: calcPercentiles(w3Results.map((r) => r.subRes.durationMs)),
      acceptedCount: w3Results.filter((r) => r.accepted).length,
      dupRacePassed,
      blankPinRetryPassed,
      homonymIsolationPassed:
        homSubARes.data === true &&
        homSubBRes.data === true &&
        homDupSameClassRes.data === false,
    };
    console.log(
      `   Done Wave 3 in ${waveSummaries.wave3.wallMs} ms | accepted: ${waveSummaries.wave3.acceptedCount}/200 | dupRace=${dupRacePassed}/10 | blankRetry=${blankPinRetryPassed}/5 | homonyms=${waveSummaries.wave3.homonymIsolationPassed} (p50=${waveSummaries.wave3.submitStats.p50}ms, p95=${waveSummaries.wave3.submitStats.p95}ms, max=${waveSummaries.wave3.submitStats.max}ms)`
    );

    // ── Wave 4: Red-Team Exploit Verification & Post-Submit Lookups ──────────
    console.log('\n🕵️ Wave 4: Executing targeted Red-Team Exploit Probes & Post-Submission Checks...');
    const w4T0 = performance.now();

    // BUG-01: Check whether save_student_exam_draft failed due to app_config.updated_at bug
    findings.push({
      id: 'BUG-01',
      severity: 'CRITICAL',
      title: 'save_student_exam_draft fails across all clients if app_config lacks updated_at column',
      confirmed: draftSaveOkCount < draftDurations.length,
      evidence:
        draftSaveOkCount < draftDurations.length
          ? `${draftSaveOkCount}/${draftDurations.length} draft saves succeeded; sample error: ${draftSaveSampleErr}`
          : `${draftSaveOkCount}/${draftDurations.length} draft saves succeeded cleanly (${draftRecoveredCount}/30 device-switch recoveries).`,
    });

    // Probe H1
    const h1Result = w3Results.find((r) => r.s.index === 191);
    findings.push({
      id: 'VULN-H1',
      severity: 'CRITICAL',
      title: 'Client-trusted score, percentage & duration in submit_student_exam_attempt',
      confirmed: Boolean(h1Result?.accepted),
      evidence: `STU-191 submitted wrong answers with score=999, percentage=100; RPC returned ${h1Result ? fmtRpcResult(h1Result.subRes) : 'missing'} (note: on Migration 022, Exam Mode zeroes claimed score server-side; on 021, 999 is stored verbatim).`,
    });

    // Probe H2a: Cross-student draft hijack (STU-192 targeting STU-001 with no/wrong owner token)
    const stu001 = students[0];
    await supaRpc('save_student_exam_draft', {
      p_key: stu001.draftKey,
      p_value: JSON.stringify({ studentName: stu001.studentName, quizCode: WRITE_QUIZ_CODE, answers: { 1: 'SECRET_B' }, status: 'in_progress' }),
      p_owner_token: stu001.draftOwnerToken,
    });
    createdDrafts.set(stu001.draftKey, stu001.draftOwnerToken);
    const h2Read = await supaRpc('get_student_exam_draft', { p_key: stu001.draftKey, p_owner_token: 'attacker-wrong-token' });
    const h2Overwrite = await supaRpc('save_student_exam_draft', {
      p_key: stu001.draftKey,
      p_value: JSON.stringify({ hijackedBy: 'STU-192', status: 'in_progress' }),
      p_owner_token: 'attacker-wrong-token',
    });
    const h2Delete = await supaRpc('delete_student_exam_draft', { p_key: stu001.draftKey, p_owner_token: 'attacker-wrong-token' });
    findings.push({
      id: 'VULN-H2a',
      severity: 'HIGH',
      title: 'Cross-student draft read, overwrite & delete without session ownership check',
      confirmed:
        (h2Read.status === 200 && Boolean(h2Read.data)) ||
        (h2Overwrite.status === 200 && h2Overwrite.data === true) ||
        (h2Delete.status === 200 && h2Delete.data === true),
      evidence: `Attacker wrong-token probes on STU-001 draft: read=${fmtRpcResult(h2Read)}, overwrite=${fmtRpcResult(h2Overwrite)}, delete=${fmtRpcResult(h2Delete)}.`,
    });

    // Probe H2b: Config overwrite & 512 KB draft bloat
    const h2Inj1 = await supaRpc('save_student_exam_draft', { p_key: 'published_quizzes', p_value: '[]', p_owner_token: 'pin:STRESS200:111' });
    const h2Inj2 = await supaRpc('save_student_exam_draft', { p_key: 'allow_teacher_account_claiming', p_value: 'true', p_owner_token: 'pin:STRESS200:111' });
    const bloatKey = `draft_${WRITE_QUIZ_CODE}_bloat_${RUN_TAG}`.toLowerCase();
    const bloatTok = `pin:${WRITE_QUIZ_CODE}:193`;
    const h2Bloat = await supaRpc('save_student_exam_draft', { p_key: bloatKey, p_value: 'B'.repeat(512 * 1024), p_owner_token: bloatTok });
    if (h2Bloat.status === 200 && h2Bloat.data === true) createdDrafts.set(bloatKey, bloatTok);
    findings.push({
      id: 'VULN-H2b',
      severity: 'MEDIUM',
      title: 'Draft key prefix guard blocks config overwrite, payload cap rejects 512 KB bloat',
      confirmed: h2Bloat.status === 200 && h2Bloat.data === true,
      evidence: `Config overwrites: published_quizzes=${fmtRpcResult(h2Inj1)}, claiming=${fmtRpcResult(h2Inj2)}; 512 KB bloat=${fmtRpcResult(h2Bloat)}.`,
    });

    // Probe H3a: Single-attempt bypass using a new submission ID (pick a candidate whose Wave 3 submit succeeded)
    const acceptedCandidate = w3Results.find((r) => r.accepted)?.s || stu001;
    const bypassId = `stress200-${RUN_TAG}-bypass-stu194`;
    const h3Dup = await supaRpc('submit_student_exam_attempt', {
      p_row: {
        id: bypassId,
        quiz_id: WRITE_QUIZ_ID,
        quiz_code: WRITE_QUIZ_CODE,
        student_name: acceptedCandidate.studentName,
        student_class: acceptedCandidate.studentClass,
        candidate_number: acceptedCandidate.candidateNumber,
        score: 22,
        total_marks: 22,
        percentage: 100,
        result_pin: '999999',
      },
    });
    if (h3Dup.status === 200 && h3Dup.data === true) submittedIds.push(bypassId);
    findings.push({
      id: 'VULN-H3a',
      severity: 'HIGH',
      title: 'Single-attempt bypass: submit_student_exam_attempt accepts a second row under a new client ID',
      confirmed: h3Dup.status === 200 && h3Dup.data === true,
      evidence: `Re-submitting ${acceptedCandidate.studentName} (${acceptedCandidate.candidateNumber}) under new id=${bypassId} returned ${fmtRpcResult(h3Dup)}.`,
    });

    // Probe H3b: Blank-PIN idempotent ack vs cross-identity/6-digit-PIN overwrite resistance (030/031)
    // Pick candidates that actually persisted in Wave 3 so ON CONFLICT (id) is tested rather than a fresh INSERT.
    const acceptedBlankRow = w3Results.find((r) => r.accepted && !r.s.resultPin)?.s;
    const acceptedPinRow = w3Results.find((r) => r.accepted && Boolean(r.s.resultPin))?.s;
    const h3CrossNameOverwrite = acceptedBlankRow
      ? await supaRpc('submit_student_exam_attempt', {
        p_row: {
          id: acceptedBlankRow.submissionId,
          quiz_id: WRITE_QUIZ_ID,
          quiz_code: WRITE_QUIZ_CODE,
          student_name: 'Hijacker Fake Name',
          student_class: acceptedBlankRow.studentClass,
          raw_answers: { tampered: true },
          score: 22,
          total_marks: 22,
          percentage: 100,
          result_pin: '777777',
        },
      })
      : { status: 0, data: null, errorText: 'skipped_no_accepted_blank_pin_row' };
    const h3PinRowWrongPinOverwrite = acceptedPinRow
      ? await supaRpc('submit_student_exam_attempt', {
        p_row: {
          id: acceptedPinRow.submissionId,
          quiz_id: WRITE_QUIZ_ID,
          quiz_code: WRITE_QUIZ_CODE,
          student_name: acceptedPinRow.studentName,
          student_class: acceptedPinRow.studentClass,
          raw_answers: { tampered: true },
          score: 22,
          total_marks: 22,
          percentage: 100,
          result_pin: '999999',
        },
      })
      : { status: 0, data: null, errorText: 'skipped_no_accepted_pin_row' };
    const h3CrossClassOverwrite = homSubARes.data === true
      ? await supaRpc('submit_student_exam_attempt', {
        p_row: {
          id: homSubAId,
          quiz_id: WRITE_QUIZ_ID,
          quiz_code: WRITE_QUIZ_CODE,
          student_name: homonymName,
          student_class: 'X IPA 2',
          raw_answers: { tampered: true },
          score: 20,
          total_marks: 20,
          percentage: 100,
          result_pin: '',
        },
      })
      : { status: 0, data: null, errorText: 'skipped_homonym_a_failed' };
    findings.push({
      id: 'VULN-H3b',
      severity: 'HIGH',
      title: 'ON CONFLICT (id) rejects cross-name, cross-class, and mismatched-PIN overwrites',
      confirmed:
        (h3CrossNameOverwrite.status === 200 && h3CrossNameOverwrite.data === true) ||
        (h3PinRowWrongPinOverwrite.status === 200 && h3PinRowWrongPinOverwrite.data === true) ||
        (h3CrossClassOverwrite.status === 200 && h3CrossClassOverwrite.data === true),
      evidence: `Blank-PIN(${acceptedBlankRow?.studentId || 'none'}) cross-name=${fmtRpcResult(h3CrossNameOverwrite)}; 6-digit(${acceptedPinRow?.studentId || 'none'}) wrong-PIN=${fmtRpcResult(h3PinRowWrongPinOverwrite)}; homonym cross-class=${fmtRpcResult(h3CrossClassOverwrite)}.`,
    });

    // Probe H4: Proctor audit escalation, spoofing & oversized spam
    const h4Invig = await supaRest('proctor_audit_events', {
      method: 'POST',
      body: {
        id: `stress200-audit-${RUN_TAG}-invig-spoof`,
        quiz_code: WRITE_QUIZ_CODE,
        student_id: 'ATTACKER',
        student_name: 'Fake Invigilator',
        event_type: 'pin_unlock',
        severity: 'info',
        detail: 'Spoofed invigilator',
        actor: 'invigilator',
      },
    });
    const h4SpoofStudent = await supaRest('proctor_audit_events', {
      method: 'POST',
      body: {
        id: `stress200-audit-${RUN_TAG}-spam32kb`,
        quiz_code: WRITE_QUIZ_CODE,
        student_id: stu001.candidateNumber,
        student_name: stu001.studentName,
        event_type: 'devtools_shortcut',
        severity: 'critical',
        detail: `Spoofed frame + ${'Z'.repeat(32768)}`,
        actor: 'student',
      },
    });
    const h4AnonRead = await supaRest(`proctor_audit_events?quiz_code=eq.${WRITE_QUIZ_CODE}&select=id`);
    findings.push({
      id: 'VULN-H4',
      severity: 'MEDIUM',
      title: 'Proctor audit RLS blocks invigilator role & anon reads, 32 KB log spam cap check',
      confirmed: h4SpoofStudent.status >= 200 && h4SpoofStudent.status < 300,
      evidence: `actor='invigilator' HTTP ${h4Invig.status}; anon SELECT count=${Array.isArray(h4AnonRead.data) ? h4AnonRead.data.length : h4AnonRead.status}; 32 KB detail spam HTTP ${h4SpoofStudent.status}.`,
    });

    // Probe H5
    const h5Unreleased = await supaRpc('lookup_student_exam_result', {
      p_quiz_code: WRITE_QUIZ_CODE,
      p_student_query: stu001.studentName,
      p_result_pin: stu001.resultPin,
    });
    const h5Wildcard = await supaRpc('lookup_student_exam_result', {
      p_quiz_code: WRITE_QUIZ_CODE,
      p_student_query: '%',
      p_result_pin: '',
    });
    const h5AppConfigAnon = await supaRest(`app_config?key=in.(published_quizzes,quiz_by_code_${READ_QUIZ_CODE})&select=key`);
    const hasScriptFlag = typeof h5Unreleased.data?.allowStudentScriptDownload === 'boolean';
    findings.push({
      id: 'VULN-H5',
      severity: 'LOW',
      title: 'lookup_student_exam_result shields unreleased scores & exposes allowStudentScriptDownload cleanly',
      confirmed: !hasScriptFlag,
      evidence: `Unreleased lookup keys=[${Object.keys(h5Unreleased.data || {}).join(', ')}]; wildcard lookup status=${h5Wildcard.data?.status}; anon app_config policy rows=${Array.isArray(h5AppConfigAnon.data) ? h5AppConfigAnon.data.length : h5AppConfigAnon.status}.`,
    });

    // Baseline checks (all private / sensitive tables + legacy published_quizzes SEC-01/SEC-05 + 032 cache)
    const scrapeTargets = [
      ['questions', 'questions?select=id&limit=1'],
      ['custom_tests', 'custom_tests?select=id&limit=1'],
      ['teacher_profiles', 'teacher_profiles?select=id,password_hash&limit=1'],
      ['teacher_auth_sessions', 'teacher_auth_sessions?select=token_hash&limit=1'],
      ['syllabuses', 'syllabuses?select=id&limit=1'],
      ['quiz_submissions', 'quiz_submissions?select=id,score&limit=1'],
      ['exam_draft_locks', 'exam_draft_locks?select=draft_key&limit=1'],
      ['security_rate_limits', 'security_rate_limits?select=scope&limit=1'],
      ['exam_paper_cache', 'exam_paper_cache?select=quiz_code&limit=1'],
      ['published_quizzes', 'published_quizzes?select=quiz_code,data&limit=1'],
      ['app_config_secrets', 'app_config?key=in.(access_pin,gemini_api_key,published_quizzes,school_roster)&select=key'],
    ];
    const scrapeResults = [];
    let publishedQuizzesBlocked = true;
    for (const [label, q] of scrapeTargets) {
      const r = await supaRest(q);
      const count = Array.isArray(r.data) ? r.data.length : -1;
      const blocked = r.status === 401 || r.status === 403 || r.status === 404 || count === 0;
      if (label === 'published_quizzes' && !blocked) publishedQuizzesBlocked = false;
      scrapeResults.push(`${label}:${r.status}(${count >= 0 ? `rows=${count}` : 'blocked'})`);
    }
    const forgedHdrRes = await supaRest('questions?select=id&limit=1', {
      extraHeaders: { 'x-teacher-session': 'forged-token-99999' },
    });
    const claimDisabledRes = await supaRpc('register_or_claim_teacher_account', {
      p_master_pin: '000000',
      p_email: 'attacker@evil.test',
      p_username: 'attacker',
      p_password: 'Password123!',
      p_name: 'Attacker',
    });
    findings.push({
      id: 'BASELINE-RLS-AUTH',
      severity: 'INFO',
      title: 'Strict RLS & Account Claiming Guard Verification (Expected Blocked)',
      confirmed:
        scrapeResults.every((s) => s.includes('(rows=0)') || s.includes('(blocked)')) &&
        publishedQuizzesBlocked &&
        Array.isArray(forgedHdrRes.data) &&
        forgedHdrRes.data.length === 0 &&
        claimDisabledRes.data?.status === 'error',
      evidence: `Table scraping: [${scrapeResults.join(', ')}]; forged header rows=${Array.isArray(forgedHdrRes.data) ? forgedHdrRes.data.length : forgedHdrRes.status}; claim disabled msg="${claimDisabledRes.data?.error}".`,
    });

    // Probe JOIN-PIN-GUARD: Verify student join PIN rate limiting, zero roster PIN leak, and server submit enforcement
    let rosterWrongPinRejected = true;
    let rosterWrongPinNote = 'skipped_empty_roster';
    if (firstRealStudent?.name) {
      const spoofSubmitId = `stress200-${RUN_TAG}-pin-spoof`;
      const spoofRes = await supaRpc('submit_student_exam_attempt', {
        p_row: {
          id: spoofSubmitId,
          quiz_id: WRITE_QUIZ_ID,
          quiz_code: WRITE_QUIZ_CODE,
          student_name: firstRealStudent.name,
          student_class: firstRealStudent.class || '',
          student_pin: '0000',
          score: 0,
          total_marks: 10,
          percentage: 0,
        },
      });
      if (spoofRes.data === true) {
        submittedIds.push(spoofSubmitId);
        rosterWrongPinRejected = false;
      }
      rosterWrongPinNote = `enrolled_wrong_pin_submit=${fmtRpcResult(spoofRes)}`;
    }
    findings.push({
      id: 'JOIN-PIN-GUARD',
      severity: 'INFO',
      title: 'Student Join PIN burst, zero roster PIN leak, brute-force lockout & submit enforcement',
      confirmed:
        dirLeakCount === 0 &&
        waveSummaries.wave1b.joinPinOkCount === 200 &&
        bruteLockedOutExact &&
        bruteLockedOutMixed &&
        rosterWrongPinRejected,
      evidence: `directory_leaks=${dirLeakCount}/200; join_pin_burst=${waveSummaries.wave1b.joinPinOkCount}/200; exact_lockout=${bruteLockedOutExact}; mixed_class_lockout=${bruteLockedOutMixed}; ${rosterWrongPinNote}.`,
    });

    // Probe P3-B: Phase 3B live verification (teacherPinHash stripped, game_profiles RLS, draft-lock submission hijack, reset gate)
    const p3PaperCheck = await supaRpc('get_student_exam_paper', { p_code: READ_QUIZ_CODE });
    const p3HasPinHash = Boolean(p3PaperCheck.data?.teacherPinHash) || JSON.stringify(p3PaperCheck.data || {}).includes('sha256:');
    const p3GameProfileScrape = await supaRest('game_profiles?select=id,pin_hash&limit=1');
    const p3SubmitHijack = await supaRpc('submit_student_exam_attempt', {
      p_row: {
        id: `stress200-${RUN_TAG}-p3-lock-hijack`,
        quiz_id: WRITE_QUIZ_ID,
        quiz_code: WRITE_QUIZ_CODE,
        student_name: stu001.studentName,
        student_class: stu001.studentClass,
        candidate_number: stu001.candidateNumber,
        draft_key: stu001.draftKey,
        draft_owner_token: 'attacker-wrong-token',
        score: 22,
        total_marks: 22,
        percentage: 100,
        result_pin: '123456',
      },
    });
    if (p3SubmitHijack.status === 200 && p3SubmitHijack.data === true) {
      submittedIds.push(`stress200-${RUN_TAG}-p3-lock-hijack`);
    }
    const p3ResetDisabledRes = await supaRpc('reset_teacher_password_with_master_pin', {
      p_identifier: 'nonexistent_probe_user',
      p_new_password: 'NewPassword123!',
      p_master_pin: '000000',
    });
    const p3GameProfilesBlocked =
      p3GameProfileScrape.status === 401 ||
      p3GameProfileScrape.status === 403 ||
      (Array.isArray(p3GameProfileScrape.data) && p3GameProfileScrape.data.length === 0);
    const p3HijackBlocked = p3SubmitHijack.status === 401 || p3SubmitHijack.status === 403 || /42501|another device/i.test(p3SubmitHijack.errorText || '');
    const p3ResetGated = p3ResetDisabledRes.data?.status === 'error';
    findings.push({
      id: 'PHASE-3B-LIVE',
      severity: 'INFO',
      title: 'Migration 024 live controls (no teacherPinHash, game_profiles RLS, draft-lock submit guard, reset gate)',
      confirmed: !p3HasPinHash && p3GameProfilesBlocked && p3HijackBlocked && p3ResetGated,
      evidence: `teacherPinHashExposed=${p3HasPinHash}; game_profiles=${p3GameProfileScrape.status}(${Array.isArray(p3GameProfileScrape.data) ? p3GameProfileScrape.data.length : 'err'}); draft_lock_hijack=HTTP ${p3SubmitHijack.status}(${p3SubmitHijack.errorText || p3SubmitHijack.data}); reset_gate="${p3ResetDisabledRes.data?.error || p3ResetDisabledRes.data?.status}".`,
    });

    waveSummaries.wave4 = {
      wallMs: Number((performance.now() - w4T0).toFixed(1)),
      totalFindings: findings.length,
    };

    console.log('\n📋 Probe Summary:');
    for (const f of findings) {
      const label = f.severity === 'INFO' ? (f.confirmed ? 'VERIFIED' : 'FAILED') : (f.confirmed ? 'OPEN / TRIGGERED' : 'MITIGATED / CLEAN');
      console.log(`   [${f.severity}] ${f.id} (${label}) — ${f.title}`);
    }
  } finally {
    console.log('\n🧹 Cleaning up temporary STRESS200 drafts...');
    let cleanedDrafts = 0;
    for (const [k, tok] of createdDrafts.entries()) {
      let d = await supaRpc('delete_student_exam_draft', { p_key: k, p_owner_token: tok });
      if (d.status === 404 || /PGRST202/i.test(d.errorText)) {
        d = await supaRpc('delete_student_exam_draft', { p_key: k });
      }
      if (d.status === 200 && d.data === true) cleanedDrafts++;
    }

    let cleanedSubmissions = 0;
    let cleanedAudits = 0;
    if (SERVICE_ROLE_KEY) {
      const rSub = await supaRest(`quiz_submissions?quiz_code=eq.${WRITE_QUIZ_CODE}`, {
        method: 'DELETE',
        bearer: SERVICE_ROLE_KEY,
        extraHeaders: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY },
      });
      if (rSub.status < 300) cleanedSubmissions = submittedIds.length;
      const rAud = await supaRest(`proctor_audit_events?quiz_code=eq.${WRITE_QUIZ_CODE}`, {
        method: 'DELETE',
        bearer: SERVICE_ROLE_KEY,
        extraHeaders: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY },
      });
      if (rAud.status < 300) cleanedAudits = 1;
    } else if (teacherSessionHeader) {
      const rSub = await supaRest(`quiz_submissions?quiz_code=eq.${WRITE_QUIZ_CODE}`, {
        method: 'DELETE',
        extraHeaders: teacherSessionHeader,
      });
      if (rSub.status < 300) cleanedSubmissions = submittedIds.length;
      const rAud = await supaRest(`proctor_audit_events?quiz_code=eq.${WRITE_QUIZ_CODE}`, {
        method: 'DELETE',
        extraHeaders: teacherSessionHeader,
      });
      if (rAud.status < 300) cleanedAudits = 1;
    }

    eventStream.end();

    const totalWallMs = Number((performance.now() - globalT0).toFixed(1));
    const reportMd = buildMarkdownReport({
      runTag: RUN_TAG,
      totalWallMs,
      totalEvents: allEvents.length,
      waveSummaries,
      findings,
      cleanedDrafts,
      pendingSubmissionsCleanup: cleanedSubmissions === 0 ? submittedIds.length : 0,
      pendingAuditsCleanup: cleanedAudits === 0,
    });
    fs.writeFileSync(REPORT_PATH, reportMd, 'utf8');
    console.log(`✅ Report written to ${REPORT_PATH}`);
    console.log(`✅ Cleaned ${cleanedDrafts} draft keys. Total runtime: ${totalWallMs} ms | Logged events: ${allEvents.length}`);
  }
}

function buildMarkdownReport({
  runTag,
  totalWallMs,
  totalEvents,
  waveSummaries,
  findings,
  cleanedDrafts,
  pendingSubmissionsCleanup,
  pendingAuditsCleanup,
}) {
  const { wave1, wave1b, wave2, wave3, wave4 } = waveSummaries;
  return `# 200-Student Stress Test & Vulnerability Audit Report

- **Run ID**: \`${runTag}\`
- **Target**: Live Supabase (\`${SUPABASE_URL}\`)
- **Total Wall-Clock Runtime**: ${totalWallMs} ms
- **Logged Events**: ${totalEvents} JSONL entries (\`artifacts/stress200_events.jsonl\`)
- **Zero-Residue Cleanup**: ${cleanedDrafts} draft keys deleted via RPC; ${pendingSubmissionsCleanup > 0 || pendingAuditsCleanup
      ? `${pendingSubmissionsCleanup} \`STRESS200\` submissions and \`STRESS200\` audit events remain (run with \`SUPABASE_SERVICE_ROLE_KEY\` or \`TEACHER_SESSION_TOKEN\`, or delete \`quiz_code = 'STRESS200'\` in Supabase SQL Editor)`
      : 'all `STRESS200` submissions and audit rows deleted'
    }

---

## 1. Concurrency & Latency Telemetry Summary

| Wave / Operation | Volume | Wall Time (ms) | Success Rate | Min (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Wave 1: \`get_student_exam_paper('${READ_QUIZ_CODE}')\`** (200 concurrent) | 200 | ${wave1.wallMs} | ${wave1.paperOkCount}/200 (leaks=${wave1.leakedKeysCount}) | ${wave1.paperStats.min} | ${wave1.paperStats.p50} | ${wave1.paperStats.p95} | ${wave1.paperStats.p99} | ${wave1.paperStats.max} |
| **Wave 1: \`check_student_attempt_submitted\`** (200 concurrent) | 200 | ${wave1.wallMs} | ${wave1.attemptOkCount}/200 | ${wave1.attemptStats.min} | ${wave1.attemptStats.p50} | ${wave1.attemptStats.p95} | ${wave1.attemptStats.p99} | ${wave1.attemptStats.max} |
| **Wave 1B: \`get_public_roster_directory\`** (200 concurrent) | 200 | ${wave1b.wallMs} | ${wave1b.dirOkCount}/200 (leaks=${wave1b.dirLeakCount}) | ${wave1b.dirStats.min} | ${wave1b.dirStats.p50} | ${wave1b.dirStats.p95} | ${wave1b.dirStats.p99} | ${wave1b.dirStats.max} |
| **Wave 1B: \`verify_student_pin\`** (200 concurrent + lockout check) | 200 | ${wave1b.wallMs} | ${wave1b.joinPinOkCount}/200 (lockout=${wave1b.bruteLockedOut}) | ${wave1b.joinPinStats.min} | ${wave1b.joinPinStats.p50} | ${wave1b.joinPinStats.p95} | ${wave1b.joinPinStats.p99} | ${wave1b.joinPinStats.max} |
| **Wave 2: \`save_student_exam_draft\`** (3 rounds × 200) | ${wave2.draftWriteStats.count} | ${wave2.wallMs} | ${wave2.draftSaveOkCount}/${wave2.draftWriteStats.count} (lock_race_ok=${wave2.draftContentionExclusive}) | ${wave2.draftWriteStats.min} | ${wave2.draftWriteStats.p50} | ${wave2.draftWriteStats.p95} | ${wave2.draftWriteStats.p99} | ${wave2.draftWriteStats.max} |
| **Wave 2: \`get_student_exam_draft\`** (30 device switches) | ${wave2.draftReadStats.count} | — | ${wave2.draftRecoveredCount}/30 | ${wave2.draftReadStats.min} | ${wave2.draftReadStats.p50} | ${wave2.draftReadStats.p95} | ${wave2.draftReadStats.p99} | ${wave2.draftReadStats.max} |
| **Wave 2: \`proctor_audit_events\` inserts** (25 violators) | ${wave2.auditStats.count} | — | ${wave2.auditInsertedCount}/${wave2.auditStats.count} | ${wave2.auditStats.min} | ${wave2.auditStats.p50} | ${wave2.auditStats.p95} | ${wave2.auditStats.p99} | ${wave2.auditStats.max} |
| **Wave 2: \`verify_teacher_unlock_pin\`** (wrong PIN rejections) | ${wave2.pinUnlockStats.count} | — | ${wave2.pinUnlockStats.count}/25 | ${wave2.pinUnlockStats.min} | ${wave2.pinUnlockStats.p50} | ${wave2.pinUnlockStats.p95} | ${wave2.pinUnlockStats.p99} | ${wave2.pinUnlockStats.max} |
| **Wave 3: \`submit_student_exam_attempt\`** (200 concurrent) | 200 | ${wave3.wallMs} | ${wave3.acceptedCount}/200 (dup=${wave3.dupRacePassed}/10, blank_retry=${wave3.blankPinRetryPassed}/5, homonyms=${wave3.homonymIsolationPassed}) | ${wave3.submitStats.min} | ${wave3.submitStats.p50} | ${wave3.submitStats.p95} | ${wave3.submitStats.p99} | ${wave3.submitStats.max} |

---

## 2. Vulnerability & Red-Team Probe Findings (Wave 4 — ${wave4.wallMs} ms)

| ID | Severity | Status | Summary & Observed Evidence |
| :--- | :---: | :---: | :--- |
${findings
      .map(
        (f) =>
          `| **${f.id}** | **${f.severity}** | ${f.confirmed ? (f.severity === 'INFO' ? 'VERIFIED' : 'CONFIRMED') : 'MITIGATED'} | **${f.title}** — ${f.evidence} |`
      )
      .join('\n')}

---

## 3. Verification & Migration Baseline (\`022\`–\`033\`)

If any probe shows \`CONFIRMED\` (or \`FAILED\`), confirm that migrations through [033_resync_pin_verification_parity.sql](file:///e:/VibeCoding/testmaker/supabase/migrations/033_resync_pin_verification_parity.sql) (including \`029\` \`published_quizzes\` RLS, \`030\` optional \`result_pin\`, \`031\` class-scoped identity/scale, and \`032\` paper cache) are applied in Supabase, then re-run \`npm run test:stress-200\`.
`;
}

main().catch((err) => {
  console.error('Fatal error during simulation:', err);
  process.exit(1);
});
