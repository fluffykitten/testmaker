import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createClient } from '@supabase/supabase-js';

function loadEnvLocal() {
  const envPath = path.resolve('.env.local');
  const loaded = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      loaded[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
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
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env.local');
  process.exit(1);
}

const clientsArg = process.argv.find((a) => a.startsWith('--clients='));
const REALTIME_STUDENTS = clientsArg ? Math.max(10, Math.min(198, Number(clientsArg.split('=')[1]) || 150)) : 150;
const RUN_TAG = Date.now().toString(36).toUpperCase();
const DIAG_CODE = `DIAG${RUN_TAG}`;
const READ_QUIZ_CODE = 'ICM170';

function calcPercentiles(values) {
  if (!values.length) return { count: 0, min: 0, p50: 0, p95: 0, max: 0, avg: 0 };
  const s = [...values].sort((a, b) => a - b);
  const pick = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    count: s.length,
    min: Number(s[0].toFixed(1)),
    p50: Number(pick(50).toFixed(1)),
    p95: Number(pick(95).toFixed(1)),
    max: Number(s[s.length - 1].toFixed(1)),
    avg: Number((s.reduce((a, b) => a + b, 0) / s.length).toFixed(1)),
  };
}

async function restCall(urlPath, { method = 'GET', body, extraHeaders = {}, bearer = ANON_KEY, prefer } = {}) {
  const t0 = performance.now();
  const headers = {
    apikey: ANON_KEY,
    Authorization: `Bearer ${bearer}`,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data, text, durationMs: performance.now() - t0 };
}

function makeFreshClient() {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });
}

function subscribeChannel(channel, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ status: 'TIMED_OUT', ms: performance.now() - t0 });
    }, timeoutMs);
    channel.subscribe((status) => {
      if (settled) return;
      if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        settled = true;
        clearTimeout(timer);
        resolve({ status, ms: performance.now() - t0 });
      }
    });
  });
}

const findings = [];
function logDiag(id, status, title, detail) {
  findings.push({ id, status, title, detail });
  const icon = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️' : '❌';
  console.log(`${icon} [${id}] ${status}: ${title}`);
  if (detail) console.log(`   ${detail}`);
}

async function main() {
  console.log(`\n🔎 Live Proctoring Diagnostic Harness (run=${RUN_TAG}, diagCode=${DIAG_CODE}, rtStudents=${REALTIME_STUDENTS})`);
  console.log(`   Target Supabase: ${SUPABASE_URL}\n`);

  const createdClients = [];
  let createdDiagAuditId = null;

  try {
    // ─── D1: Realtime Command Authentication (023 ECDSA) & Guard Wiring ─────
    {
      const studentClient = makeFreshClient();
      const attackerClient = makeFreshClient();
      createdClients.push(studentClient, attackerClient);

      const receivedCmds = [];
      const chStudent = studentClient.channel(`exam_proctor:${DIAG_CODE}`, { config: { broadcast: { self: false } } });
      chStudent.on('broadcast', { event: 'proctor_cmd' }, ({ payload }) => {
        receivedCmds.push(payload);
      });
      const chAttacker = attackerClient.channel(`exam_proctor:${DIAG_CODE}`, { config: { broadcast: { self: false } } });

      const [subS, subA] = await Promise.all([subscribeChannel(chStudent), subscribeChannel(chAttacker)]);
      if (subS.status === 'SUBSCRIBED' && subA.status === 'SUBSCRIBED') {
        await chAttacker.send({
          type: 'broadcast',
          event: 'proctor_cmd',
          payload: { id: `spoof-add-${RUN_TAG}`, targetStudentId: 'ALL', type: 'add_time', minutes: -30, timestamp: Date.now() },
        });
        await chAttacker.send({
          type: 'broadcast',
          event: 'proctor_cmd',
          payload: { id: `spoof-unlock-${RUN_TAG}`, targetStudentId: 'ALL', type: 'unlock', timestamp: Date.now() },
        });
        await new Promise((r) => setTimeout(r, 800));
      }

      // Live DB 023 RPC checks: anon cannot register public key (must fail 401/42501), lookup RPC is live (200)
      const anonRegRes = await restCall('rpc/register_proctor_public_key', {
        method: 'POST',
        body: {
          p_quiz_code: DIAG_CODE,
          p_key_id: 'diag_spoof_key_1234',
          p_public_jwk: { kty: 'EC', crv: 'P-256', x: 'diag_x', y: 'diag_y' },
        },
      });
      const keyLookupRes = await restCall('rpc/get_proctor_public_key', {
        method: 'POST',
        body: { p_quiz_code: DIAG_CODE, p_key_id: 'diag_spoof_key_1234' },
      });

      const runnerSrc = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');
      const rtSrc = fs.readFileSync(path.resolve('src/services/examProctorRealtimeService.ts'), 'utf8');
      const authSrc = fs.readFileSync(path.resolve('src/lib/proctorCommandAuth.ts'), 'utf8');
      const verifiesSignature =
        /verifyProctorCommandSignature/.test(rtSrc) &&
        /get_proctor_public_key/.test(rtSrc) &&
        /(?:crypto\.subtle|subtle)\.verify/.test(authSrc);
      const wiresGuards = /clampAddTimeMinutes/.test(runnerSrc) && /claimCommandId/.test(runnerSrc) && /isAllowedProctorCommand/.test(runnerSrc);
      const rpcLive = keyLookupRes.status === 200 && (anonRegRes.status === 401 || anonRegRes.status === 403);

      logDiag(
        'D1',
        verifiesSignature && wiresGuards && rpcLive ? 'PASS' : 'VULNERABLE',
        'Realtime Command Authentication (023 ECDSA) & Client Guard Wiring',
        `Raw unsigned socket frames=${receivedCmds.length}/2; live anon register_proctor_public_key=${anonRegRes.status} (${anonRegRes.data?.code || 'blocked'}); get_proctor_public_key=${keyLookupRes.status} (${JSON.stringify(keyLookupRes.data)}); client verifies ECDSA=${verifiesSignature}; runner wires proctorGuards=${wiresGuards}`
      );
      await Promise.allSettled([studentClient.removeAllChannels(), attackerClient.removeAllChannels()]);
      studentClient.realtime?.disconnect?.();
      attackerClient.realtime?.disconnect?.();
    }

    // ─── D2: verify_teacher_unlock_pin Parity vs get_student_exam_paper ──────
    {
      const paperRes = await restCall('rpc/get_student_exam_paper', { method: 'POST', body: { p_code: READ_QUIZ_CODE } });
      const rawPinExposed = Boolean(paperRes.data?.publishedQuiz?.teacherPin || paperRes.data?.headerConfig?.teacherPin || paperRes.data?.teacherPin);
      const hasPinHashInPaper = Boolean(paperRes.data?.teacherPinHash) || JSON.stringify(paperRes.data || {}).includes('sha256:');
      const pinWrongRes = await restCall('rpc/verify_teacher_unlock_pin', {
        method: 'POST',
        body: { p_quiz_code: READ_QUIZ_CODE, p_pin: '__DIAG_WRONG_PIN__' },
      });

      const mig023 = fs.readFileSync(path.resolve('supabase/migrations/023_proctor_security_and_pin_parity.sql'), 'utf8');
      const pinChecksQuizByCode = /quiz_by_code_/.test(mig023);
      const pinChecksPrevCodes = /previousCodes/.test(mig023);
      const pinChecksHeaderCfg = /headerConfig/.test(mig023);
      const quizCodeSrc = fs.readFileSync(path.resolve('src/services/quizCodeService.ts'), 'utf8');
      const fallsBackOnRpcFalse = !/if\s*\(!error\s*&&\s*typeof data\s*===\s*'boolean'\)\s*return data;/.test(quizCodeSrc);

      logDiag(
        'D2',
        rawPinExposed || hasPinHashInPaper || !pinChecksQuizByCode || !pinChecksPrevCodes || !pinChecksHeaderCfg || !fallsBackOnRpcFalse ? 'ISSUE' : 'PASS',
        'verify_teacher_unlock_pin Parity (023 vs 022)',
        `Live paper ok=${paperRes.ok} (rawPinExposed=${rawPinExposed}, teacherPinHashPresent=${hasPinHashInPaper}); verify_teacher_unlock_pin wrong-pin=${pinWrongRes.data} (HTTP ${pinWrongRes.status}); 023 checks quiz_by_code_=${pinChecksQuizByCode}, previousCodes=${pinChecksPrevCodes}, headerConfig=${pinChecksHeaderCfg}; offline expectedHash fallback on RPC false=${fallsBackOnRpcFalse}`
      );
    }

    // ─── D3: Closed-Dashboard Audit Persistence & ProctorLogEvent ID Drift ───
    {
      const runnerSrc = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');
      const modalSrc = fs.readFileSync(path.resolve('src/components/LiveInvigilatorModal.tsx'), 'utf8');
      const rtSrc = fs.readFileSync(path.resolve('src/services/examProctorRealtimeService.ts'), 'utf8');

      const studentWritesDbAudit = /recordProctorAuditEvent/.test(runnerSrc);
      const logEventCarriesStudentId = /interface ProctorLogEvent[\s\S]*?studentId\?:/.test(rtSrc);
      const bulkUnlockMatch = modalSrc.match(/const handleScopedUnlock = useCallback[\s\S]*?\r?\n  \}, \[/);
      const bulkAddTimeMatch = modalSrc.match(/const handleScopedAddTime = useCallback[\s\S]*?\r?\n    \[/);
      const bulkUnlockAudits = bulkUnlockMatch ? /recordProctorAuditEvent/.test(bulkUnlockMatch[0]) : false;
      const bulkAddTimeAudits = bulkAddTimeMatch ? /recordProctorAuditEvent/.test(bulkAddTimeMatch[0]) : false;

      logDiag(
        'D3',
        !studentWritesDbAudit || !logEventCarriesStudentId || !bulkUnlockAudits || !bulkAddTimeAudits ? 'ISSUE' : 'PASS',
        'Closed-Dashboard Audit Loss, ID Drift & Bulk Action Gaps',
        `Student calls recordProctorAuditEvent=${studentWritesDbAudit}; ProctorLogEvent carries studentId/candidateClass=${logEventCarriesStudentId}; bulk handleScopedUnlock audits=${bulkUnlockAudits}; bulk handleScopedAddTime audits=${bulkAddTimeAudits}`
      );
    }

    // ─── D4: 022 Audit Guard Trigger & 021 RLS (.upsert trap vs .insert) ──────
    {
      const testId = `diag-evt-${RUN_TAG}`;
      const invRes = await restCall('proctor_audit_events', {
        method: 'POST',
        body: {
          id: testId,
          quiz_code: DIAG_CODE,
          student_id: 'cand_diag_01',
          student_name: 'Diag Student',
          event_type: 'unlocked',
          severity: 'info',
          detail: 'Spoofed invigilator actor',
          actor: 'invigilator',
          created_at: new Date().toISOString(),
        },
      });
      const bigDetailRes = await restCall('proctor_audit_events', {
        method: 'POST',
        body: {
          id: `${testId}-big`,
          quiz_code: DIAG_CODE,
          student_id: 'cand_diag_01',
          student_name: 'Diag Student',
          event_type: 'tab_switch',
          severity: 'warning',
          detail: 'X'.repeat(1025),
          actor: 'student',
          created_at: new Date().toISOString(),
        },
      });
      const okStudentInsert = await restCall('proctor_audit_events', {
        method: 'POST',
        body: {
          id: `${testId}-ok`,
          quiz_code: DIAG_CODE,
          student_id: 'cand_diag_01',
          student_name: 'Diag Student',
          event_type: 'tab_switch',
          severity: 'warning',
          detail: 'Diagnostic valid student event (safe cleanup marker)',
          actor: 'student',
          created_at: new Date().toISOString(),
        },
      });
      if (okStudentInsert.ok) createdDiagAuditId = `${testId}-ok`;

      const dupPlainInsert = await restCall('proctor_audit_events', {
        method: 'POST',
        body: {
          id: `${testId}-ok`,
          quiz_code: DIAG_CODE,
          student_id: 'cand_diag_01',
          student_name: 'Diag Student',
          event_type: 'tab_switch',
          severity: 'warning',
          detail: 'Duplicate plain insert test',
          actor: 'student',
          created_at: new Date().toISOString(),
        },
      });
      const upsertIgnoreDup = await restCall('proctor_audit_events?on_conflict=id', {
        method: 'POST',
        prefer: 'resolution=ignore-duplicates',
        body: {
          id: `${testId}-ok`,
          quiz_code: DIAG_CODE,
          student_id: 'cand_diag_01',
          student_name: 'Diag Student',
          event_type: 'tab_switch',
          severity: 'warning',
          detail: 'Upsert test from student anon',
          actor: 'student',
          created_at: new Date().toISOString(),
        },
      });

      const auditSvcSrc = fs.readFileSync(path.resolve('src/services/proctorAuditLogService.ts'), 'utf8');
      const clampsUtf8 = /TextEncoder|byteLength|clampUtf8/.test(auditSvcSrc);

      logDiag(
        'D4',
        invRes.status === 401 || invRes.status === 403
          ? bigDetailRes.status === 400
            ? clampsUtf8
              ? 'PASS'
              : 'PASS (with Client Gap)'
            : 'ISSUE'
          : 'VULNERABLE',
        '022 Audit Guard Trigger & 021 RLS (.upsert vs .insert)',
        `anon invigilator=${invRes.status}; 1025B detail=${bigDetailRes.status} (${(bigDetailRes.data?.code || '')}); valid student insert=${okStudentInsert.status}; plain dup insert=${dupPlainInsert.status} (${dupPlainInsert.data?.code || ''}); student .upsert()=${upsertIgnoreDup.status} (${upsertIgnoreDup.data?.code || ''}); client UTF-8 byte clamping=${clampsUtf8}`
      );
    }

    // ─── D5: Expired Teacher Session Silent Failure Probe ────────────────────
    {
      const badHeaders = { 'x-teacher-session': 'expired-invalid-session-000' };
      const authCheck = await restCall('rpc/is_authenticated_teacher', {
        method: 'POST',
        body: {},
        extraHeaders: badHeaders,
      });
      const auditRead = await restCall(`proctor_audit_events?quiz_code=eq.${READ_QUIZ_CODE}&select=id&limit=5`, {
        extraHeaders: badHeaders,
      });
      const modalSrc = fs.readFileSync(path.resolve('src/components/LiveInvigilatorModal.tsx'), 'utf8');
      const hasSessionCheckBanner = /is_authenticated_teacher|hasActiveTeacherSession|session expired/i.test(modalSrc);

      logDiag(
        'D5',
        !hasSessionCheckBanner ? 'ISSUE' : 'PASS',
        'Expired Teacher Session Silent-Empty-State Check',
        `Expired header -> is_authenticated_teacher()=${authCheck.data} (HTTP ${authCheck.status}); SELECT proctor_audit_events returned HTTP ${auditRead.status} rows=${Array.isArray(auditRead.data) ? auditRead.data.length : 'non-array'}; LiveInvigilatorModal checks/warns on session expiry=${hasSessionCheckBanner}`
      );
    }

    // ─── D6: High-Concurrency Realtime Fan-Out & request_sync Spike ──────────
    {
      const dashClient = makeFreshClient();
      createdClients.push(dashClient);

      let hbCount = 0;
      let syncReplyCount = 0;
      let syncPhase = false;
      const hbSeenStudents = new Set();
      const syncSeenStudents = new Set();

      const chDash = dashClient.channel(`exam_proctor:${DIAG_CODE}`, { config: { broadcast: { self: false } } });
      chDash.on('broadcast', { event: 'student_heartbeat' }, ({ payload }) => {
        if (!syncPhase) {
          hbCount++;
          if (payload?.studentId) hbSeenStudents.add(payload.studentId);
        } else {
          syncReplyCount++;
          if (payload?.studentId) syncSeenStudents.add(payload.studentId);
        }
      });

      const dashSub = await subscribeChannel(chDash);
      const studentChannels = [];
      const subTimes = [];
      let subOk = 0;
      let subErr = 0;
      let syncReceivedByStudents = 0;
      let restFallbackWarnings = 0;
      const origWarn = console.warn;
      console.warn = (...args) => {
        if (String(args[0] || '').includes('falling back to REST API')) {
          restFallbackWarnings++;
          return;
        }
        origWarn(...args);
      };

      try {
        for (let batchStart = 0; batchStart < REALTIME_STUDENTS; batchStart += 30) {
          const batch = [];
          for (let i = batchStart; i < Math.min(REALTIME_STUDENTS, batchStart + 30); i++) {
            const client = makeFreshClient();
            createdClients.push(client);
            const sid = `cand_diag_${String(i + 1).padStart(3, '0')}`;
            const ch = client.channel(`exam_proctor:${DIAG_CODE}`, { config: { broadcast: { self: false } } });
            ch.on('broadcast', { event: 'proctor_sync_request' }, () => {
              syncReceivedByStudents++;
              const jitter = 200 + Math.floor(Math.random() * 7800);
              setTimeout(() => {
                void ch.send({
                  type: 'broadcast',
                  event: 'student_heartbeat',
                  payload: { studentId: sid, status: 'active', answeredCount: 5, timeLeftSeconds: 2400, lastHeartbeat: Date.now() },
                });
              }, jitter);
            });
            studentChannels.push({ sid, ch });
            batch.push(
              subscribeChannel(ch, 15000).then((r) => {
                subTimes.push(r.ms);
                if (r.status === 'SUBSCRIBED') subOk++;
                else subErr++;
              })
            );
          }
          await Promise.all(batch);
          await new Promise((r) => setTimeout(r, 150));
        }

        // Baseline beats spread across ~5s so we don't trip WS bursts before sync test
        await Promise.all(
          studentChannels.map(({ sid, ch }, idx) =>
            new Promise((resolve) =>
              setTimeout(async () => {
                await ch.send({
                  type: 'broadcast',
                  event: 'student_heartbeat',
                  payload: { studentId: sid, status: 'active', answeredCount: 4, timeLeftSeconds: 2500, lastHeartbeat: Date.now() },
                });
                resolve();
              }, (idx % 50) * 100)
            )
          )
        );
        await new Promise((r) => setTimeout(r, 1000));

        const joinedBeforeSync = studentChannels.filter((x) => x.ch.state === 'joined').length;
        syncPhase = true;
        const syncSendStatus = await chDash.send({
          type: 'broadcast',
          event: 'proctor_sync_request',
          payload: { requestedAt: Date.now() },
        });
        await new Promise((r) => setTimeout(r, 9000));

        const subStats = calcPercentiles(subTimes);
        const dropRatio = subOk > 0 ? Number((((subOk - syncSeenStudents.size) / subOk) * 100).toFixed(1)) : 100;
        logDiag(
          'D6',
          subErr > 0 || dropRatio > 5 || restFallbackWarnings > 0 ? 'WARN' : 'PASS',
          `Realtime Broadcast Fan-Out (${REALTIME_STUDENTS} students + 1 dashboard)`,
          `dash=${dashSub.status} (${chDash.state}); student SUBSCRIBED=${subOk}/${REALTIME_STUDENTS} (joinedBeforeSync=${joinedBeforeSync}, p50=${subStats.p50}ms, max=${subStats.max}ms); baseline receipts=${hbSeenStudents.size}/${subOk}; syncSend=${syncSendStatus} -> rxByStudents=${syncReceivedByStudents}/${subOk} -> dashSyncReceipts=${syncSeenStudents.size}/${subOk} (loss=${dropRatio}%, restFallbacks=${restFallbackWarnings})`
        );
      } finally {
        console.warn = origWarn;
      }
    }

    // ─── D7: Static Stale Closure & Source Audit ─────────────────────────────
    {
      const runnerSrc = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');
      const cmdBlock = runnerSrc.match(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?const handleCommand = \(cmd: ProctorCommand\)[\s\S]*?return \(\) => \{\s*leaveProctorSession\(\);\s*\};\s*\}, \[([^\]]+)\]\);/);
      const deps = cmdBlock ? cmdBlock[1].trim() : 'unknown';
      const usesLatestCommandRef = /latestCommandStateRef|isFinalSecurityLockRef\.current/.test(
        runnerSrc.match(/const handleCommand = \(cmd: ProctorCommand\) => \{[\s\S]*?joinProctorSession/)?.[0] || ''
      );

      logDiag(
        'D7',
        !usesLatestCommandRef ? 'ISSUE' : 'PASS',
        'handleCommand Stale Closure Check (StudentQuizRunner.tsx)',
        `joinProctorSession effect deps=[${deps}]; handleCommand reads live refs (latestCommandStateRef / isFinalSecurityLockRef)=${usesLatestCommandRef}`
      );
    }
  } finally {
    // Cleanup temporary audit row if cleanup key available
    if (createdDiagAuditId) {
      if (SERVICE_ROLE_KEY) {
        await restCall(`proctor_audit_events?id=eq.${createdDiagAuditId}`, {
          method: 'DELETE',
          bearer: SERVICE_ROLE_KEY,
          extraHeaders: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY },
        });
      } else if (TEACHER_SESSION_TOKEN) {
        await restCall(`proctor_audit_events?id=eq.${createdDiagAuditId}`, {
          method: 'DELETE',
          extraHeaders: { 'x-teacher-session': TEACHER_SESSION_TOKEN },
        });
      }
    }
    await Promise.allSettled(createdClients.map(async (c) => {
      await c.removeAllChannels();
      c.realtime?.disconnect?.();
    }));
    console.log('\n📋 Diagnostic Summary:');
    findings.forEach((f) => console.log(`  - ${f.id}: ${f.status} — ${f.title}`));
    console.log('');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal diagnostic error:', err);
    process.exit(1);
  });
