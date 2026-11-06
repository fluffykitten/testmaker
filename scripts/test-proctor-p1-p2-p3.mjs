// Verification harness for Plan/proctor_p1_p2_p3_fixes.md — offline, no Supabase.
//
//   node scripts/test-proctor-p1-p2-p3.mjs
//
// Exercises the pure guards the live invigilator now relies on, plus source tripwires for
// the transport changes that need a real WebSocket to exercise.
import fs from 'node:fs';
import {
  claimCommandId,
  clampAddTimeMinutes,
  clampTelemetry,
  checkRateLimit,
  highWaterViolations,
  isAllowedProctorCommand,
  mergeAuditEvents,
  recentViolationsSlice,
  retryBroadcast,
  sanitizeAnnouncement,
  stampHeartbeatReceipt,
} from '../src/lib/proctorGuards.ts';
import { getCanonicalProctorStudentId } from '../src/utils/examSecurityUtils.ts';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ─── P1-A: presence uses the receiver's clock ─────────────────────────────────
{
  const now = Date.now();
  const behind = stampHeartbeatReceipt({ lastHeartbeat: now - 300_000, studentName: 'behind' }, now);
  const ahead = stampHeartbeatReceipt({ lastHeartbeat: now + 3_600_000, studentName: 'ahead' }, now);

  check('P1-A heartbeat from a clock 5 min behind is stamped at receipt', behind.lastHeartbeat === now);
  check('P1-A heartbeat from a clock 1 h ahead is stamped at receipt', ahead.lastHeartbeat === now);
  check('P1-A sender clock is retained for drift diagnostics', behind.clientTimestamp === now - 300_000 && ahead.clientTimestamp === now + 3_600_000);
  // Both should be considered live while beats keep arriving, and stale after 45s of silence.
  const staleAfterSilence = now + 46_000 - behind.lastHeartbeat > 45_000;
  check('P1-A silence (not clock skew) is what marks a student offline', staleAfterSilence);
}

// ─── P1-B: one canonical candidate id ────────────────────────────────────────
{
  const base = { quizCode: 'chem-1a2b', studentName: ' Ahmad  Fauzi ', candidateNumber: '0012', studentClass: '10-A' };
  const a = getCanonicalProctorStudentId(base);
  const b = getCanonicalProctorStudentId({ ...base, quizCode: 'CHEM-1A2B' });
  const other = getCanonicalProctorStudentId({ ...base, candidateNumber: '0013' });
  const noNumber = getCanonicalProctorStudentId({ quizCode: 'CHEM-1A2B', studentName: 'Ahmad Fauzi', studentClass: '10-A' });

  check('P1-B same candidate (any casing/whitespace) resolves to one id', a === b, `${a} vs ${b}`);
  check('P1-B different candidate numbers stay distinct', a !== other);
  check('P1-B id is stable across reloads (no startTime in the seed)', a === getCanonicalProctorStudentId(base));
  check('P1-B id is prefixed and compact', a.startsWith('cand_') && a.length <= 18, a);
  check('P1-B class disambiguates when no number is issued', noNumber !== a);
}

// ─── P1-C: audit merge is idempotent and ordered ─────────────────────────────
{
  const t = (id, iso) => ({ id, createdAt: iso, detail: id });
  const remote = [t('e1', '2026-11-06T10:00:00Z'), t('e2', '2026-11-06T10:05:00Z')];
  const local = [t('e2', '2026-11-06T10:05:00Z'), t('e3', '2026-11-06T10:10:00Z')];
  const merged = mergeAuditEvents(remote, local, 250);
  check('P1-C audit merge de-duplicates by id', merged.length === 3, merged.map((e) => e.id).join(','));
  check('P1-C audit merge is newest-first', merged[0].id === 'e3' && merged[2].id === 'e1');
  check('P1-C audit merge honours the cap', mergeAuditEvents(remote, local, 2).length === 2);
}

// ─── P2-B / P3-1: command validation, clamping, de-duplication ───────────────
{
  check('P2-B unknown command type rejected', !isAllowedProctorCommand('self_destruct'));
  check('P2-B known command type accepted', isAllowedProctorCommand('add_time'));

  check('P2-B negative add_time clamps to +1 minute', clampAddTimeMinutes(-50) === 1);
  check('P2-B zero add_time clamps to +1 minute', clampAddTimeMinutes(0) === 1);
  check('P2-B huge add_time clamps to 120 minutes', clampAddTimeMinutes(999) === 120);
  check('P2-B NaN add_time falls back to 5', clampAddTimeMinutes('abc') === 5);
  check('P2-B fractional add_time rounds', clampAddTimeMinutes(7.6) === 8);

  check('P2-B announcement truncated to 500 chars', sanitizeAnnouncement('x'.repeat(900)).length === 500);

  const executed = new Set();
  check('P3-1 first command id is applied', claimCommandId(executed, 'cmd-1'));
  check('P3-1 replayed command id is ignored', !claimCommandId(executed, 'cmd-1'));
  check('P3-1 missing command id is ignored', !claimCommandId(executed, undefined));

  const clamped = clampTelemetry({ answeredCount: 999, timeLeftSeconds: -5, violationsCount: -3, currentIndex: 40 }, 20);
  check('P2-B answeredCount clamped to question count', clamped.answeredCount === 20);
  check('P2-B negative time clamped to zero', clamped.timeLeftSeconds === 0);
  check('P2-B negative strikes clamped to zero', clamped.violationsCount === 0);

  check('P2-B strikes never decrease without a pardon', highWaterViolations(3, 0, false) === 3);
  check('P2-B a pardon allows the strike count to drop', highWaterViolations(3, 0, true) === 0);
  check('P2-B strikes still rise normally', highWaterViolations(3, 4, false) === 4);
}

// ─── P2-C: per-student log rate limit ────────────────────────────────────────
{
  const state = new Map();
  const now = Date.now();
  let allowed = 0;
  let warned = 0;
  for (let i = 0; i < 12; i++) {
    const decision = checkRateLimit(state, 'quiz::noisy', now + i, 5, 10_000);
    if (decision.allowed) allowed++;
    if (decision.warn) warned++;
  }
  check('P2-C only 5 events accepted per 10s window', allowed === 5, `allowed=${allowed}`);
  check('P2-C exactly one throttle notice per window', warned === 1, `warned=${warned}`);
  check('P2-C a different student is unaffected', checkRateLimit(state, 'quiz::quiet', now + 5, 5, 10_000).allowed);
  check('P2-C a new window restores the allowance', checkRateLimit(state, 'quiz::noisy', now + 10_001, 5, 10_000).allowed);
}

// ─── P3-2: bounded heartbeat payload ────────────────────────────────────────
{
  const violations = Array.from({ length: 40 }, (_, i) => i);
  check('P3-2 regular heartbeat carries the last 5 violations', recentViolationsSlice(violations, false).length === 5);
  check('P3-2 regular heartbeat keeps the newest violations', recentViolationsSlice(violations, false)[4] === 39);
  check('P3-2 sync request carries the full history', recentViolationsSlice(violations, true).length === 40);
}

// ─── P2-A: retry policy ─────────────────────────────────────────────────────
{
  let attempts = 0;
  const flaky = await retryBroadcast(async () => (++attempts < 3 ? 'timed out' : 'ok'), 3, async () => {});
  check('P2-A a flaky send is retried until it succeeds', flaky && attempts === 3, `attempts=${attempts}`);

  let alwaysFail = 0;
  const failedSend = await retryBroadcast(async () => { alwaysFail++; return 'error'; }, 3, async () => {});
  check('P2-A a dead channel gives up after 3 attempts', !failedSend && alwaysFail === 3, `attempts=${alwaysFail}`);

  let threw = 0;
  const throwing = await retryBroadcast(async () => { threw++; throw new Error('socket closed'); }, 2, async () => {});
  check('P2-A a throwing send is retried, not propagated', !throwing && threw === 2);
}

// ─── Source tripwires for the transport-only fixes ──────────────────────────
{
  const service = fs.readFileSync('src/services/examProctorRealtimeService.ts', 'utf8');
  check('P2-A student sends are queued until SUBSCRIBED', /pendingStudentPayloads/.test(service) && /flushStudentQueue/.test(service));
  check('P2-A host commands are queued until SUBSCRIBED', /pendingHostCommands/.test(service) && /flushHostQueue/.test(service));
  check('P3-3 a violation cannot cross onto another quiz channel', /violation dropped: channel\/quiz mismatch/.test(service));
  check('P3-4 teardown is scoped to the owning session', /export function leaveProctorSession\(expectedToken\?: string\)/.test(service) && /expectedToken !== activeSessionToken/.test(service));

  const modal = fs.readFileSync('src/components/LiveInvigilatorModal.tsx', 'utf8');
  check('P1-A dashboard stamps receipt time on the heartbeat', /lastHeartbeat: Date\.now\(\)/.test(modal));
  check('P1-C teacher interventions are written to the audit log', (modal.match(/recordProctorAuditEvent\(/g) || []).length >= 4);
  check('P1-C audit log is rehydrated on mount', /loadProctorAuditEvents\(codes\)/.test(modal));

  const runner = fs.readFileSync('src/pages/StudentQuizRunner.tsx', 'utf8');
  check('P1-B runner emits the canonical id', /getCanonicalProctorStudentId\(\{/.test(runner) && /proctorStudentId: sessionHash/.test(runner));
  check('P3-2 heartbeat history is bounded by default', /sendCurrentHeartbeatRef\.current\(true\)/.test(runner));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
