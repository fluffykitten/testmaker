import fs from 'node:fs';
import path from 'node:path';
import {
  generateProctorSigningSession,
  signProctorCommand,
  verifyProctorCommandSignature,
} from '../src/lib/proctorCommandAuth.ts';
import { clampUtf8Bytes } from '../src/services/proctorAuditLogService.ts';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('🛡️ Verifying Proctoring Hardening (Phase A + Phase B / 023)...\n');

// ─── 1. ECDSA P-256 Command Signing & Verification ───────────────────────────
{
  const session = await generateProctorSigningSession();
  check('1. Generates ephemeral ECDSA P-256 signing session', Boolean(session?.keyId && session?.publicJwk?.x && session?.publicJwk?.y && !('d' in session.publicJwk)));

  if (session) {
    const keyStore = new Map([[`ICM170::${session.keyId}`, session.publicJwk]]);
    const liveResolver = async (code, keyId) => {
      const hit = keyStore.get(`${code.toUpperCase()}::${keyId}`);
      return hit ? { found: true, publicJwk: hit } : { found: false };
    };
    const missingRpcResolver = async () => ({ found: false, rpcUnavailable: true });

    const now = Date.now();
    const signed = await signProctorCommand(
      session,
      { id: 'cmd-1', type: 'add_time', quizCode: 'icm170', targetStudentId: 'cand_abc', minutes: 10 },
      now
    );

    const vOk = await verifyProctorCommandSignature(signed, 'ICM170', liveResolver, now + 1500);
    check('2. Valid signed proctor command passes verification', vOk.status === 'valid', JSON.stringify(vOk));

    const vTamperedMins = await verifyProctorCommandSignature({ ...signed, minutes: 120 }, 'ICM170', liveResolver, now + 1500);
    check('3. Tampering signed command minutes is rejected', vTamperedMins.status === 'invalid', JSON.stringify(vTamperedMins));

    const vTamperedCode = await verifyProctorCommandSignature(signed, 'OTHER99', liveResolver, now + 1500);
    check('4. Cross-quiz replay fails quiz_code check', vTamperedCode.status === 'invalid', JSON.stringify(vTamperedCode));

    const vExpired = await verifyProctorCommandSignature(signed, 'ICM170', liveResolver, now + 6 * 60 * 1000);
    check('5. Stale command (>5 min old) is rejected', vExpired.status === 'invalid', JSON.stringify(vExpired));

    const vUnsignedStrict = await verifyProctorCommandSignature(
      { id: 'cmd-spoof', type: 'unlock', targetStudentId: 'ALL' },
      'ICM170',
      liveResolver,
      now
    );
    check('6. Unsigned spoofed command rejected when 023 RPC is live', vUnsignedStrict.status === 'invalid', JSON.stringify(vUnsignedStrict));

    const vUnsignedLegacy = await verifyProctorCommandSignature(
      { id: 'cmd-legacy', type: 'unlock', targetStudentId: 'ALL' },
      'ICM170',
      missingRpcResolver,
      now
    );
    check('7. Unsigned command falls back cleanly ONLY when 023 RPC is missing', vUnsignedLegacy.status === 'legacy_fallback', JSON.stringify(vUnsignedLegacy));

    const vForgedLegacy = await verifyProctorCommandSignature(signed, 'ICM170', missingRpcResolver, now);
    check('8. Signed command cannot bypass invalid/missing RPC key lookup', vForgedLegacy.status === 'invalid', JSON.stringify(vForgedLegacy));
  }
}

// ─── 2. UTF-8 Audit Detail Byte Clamping & Plain INSERT Check ────────────────
{
  const emojiBurst = '🚨'.repeat(300); // 1200 bytes UTF-8
  const clamped = clampUtf8Bytes(emojiBurst, 960);
  const clampedBytes = new TextEncoder().encode(clamped).length;
  check('9. clampUtf8Bytes caps detail <= 960 bytes without invalid UTF-8 sequences', clampedBytes <= 960 && !clamped.includes('\uFFFD'), `bytes=${clampedBytes}`);

  const auditSvc = fs.readFileSync(path.resolve('src/services/proctorAuditLogService.ts'), 'utf8');
  check('10. proctorAuditLogService keeps plain .insert() (never .upsert()) and ignores 23505', auditSvc.includes('.insert(') && !auditSvc.includes('.upsert(') && auditSvc.includes("'23505'"));
}

// ─── 3. Migration 023 & Client Hardening Parity Checks ───────────────────────
{
  const mig023 = fs.readFileSync(path.resolve('supabase/migrations/023_proctor_security_and_pin_parity.sql'), 'utf8');
  check(
    '11. Migration 023 aligns verify_teacher_unlock_pin across quiz_by_code_, published_quizzes, previousCodes, headerConfig',
    mig023.includes("'quiz_by_code_' || v_code") &&
      mig023.includes("'published_quizzes'") &&
      mig023.includes("'previousCodes'") &&
      mig023.includes("'headerConfig'")
  );
  check(
    '12. Migration 023 secures proctor_channel_keys and gates register_proctor_public_key behind is_authenticated_teacher()',
    mig023.includes('REVOKE ALL ON public.proctor_channel_keys FROM anon, authenticated;') &&
      mig023.includes('IF NOT public.is_authenticated_teacher() THEN') &&
      mig023.includes("p_public_jwk ? 'd'")
  );

  const runner = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');
  check(
    '13. StudentQuizRunner wires proctorGuards, latestCommandStateRef, and direct student audit persistence',
    runner.includes('latestCommandStateRef') &&
      runner.includes('claimCommandId(executedCommandIdsRef.current') &&
      runner.includes('clampAddTimeMinutes(') &&
      runner.includes('sanitizeAnnouncement(') &&
      runner.includes('recordProctorAuditEvent(')
  );

  const modal = fs.readFileSync(path.resolve('src/components/LiveInvigilatorModal.tsx'), 'utf8');
  check(
    '14. LiveInvigilatorModal checks is_authenticated_teacher, renders auth banner, and audits bulk actions with non-null studentId',
    modal.includes('is_authenticated_teacher') &&
      modal.includes('cloudAuthWarning') &&
      modal.includes("`ALL::${targetClass}`")
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
