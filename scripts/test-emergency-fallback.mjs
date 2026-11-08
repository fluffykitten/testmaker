// Automated Verification Suite for Air-Gapped Emergency Offline Fallback Pipeline
//
//   node --import ./scripts/register-ts.mjs scripts/test-emergency-fallback.mjs
//
// Validates:
// - EMERG-01: AES-256-GCM Encrypt & Decrypt Roundtrip
// - EMERG-02: Anti-Tamper Rejection (Ciphertext, Checksum, and AAD Header Binding)
// - EMERG-03: Wrong Quiz Code Protection
// - EMERG-04: Batch Ingestion Performance & Accuracy (30 Mock Files)
// - EMERG-05: Timestamp Conflict Resolution (Newest Wins + Audit Flag)
// - EMERG-06: Cross-Platform Filename Formatting & UI Wiring Tripwires

import fs from 'node:fs';
import {
  encryptEmergencyPackage,
  decryptEmergencyPackage,
  computeEnvelopeChecksum,
  validateEmergencyEnvelope,
  formatEmergencyExamFileName,
} from '../src/utils/examCryptoUtils.ts';
import {
  createEncryptedEmergencyFileContent,
  ingestEmergencySubmissionContent,
  ingestEmergencySubmissionBatch,
} from '../src/services/quizSubmissionService.ts';

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

function makeSampleSubmission(overrides = {}) {
  return {
    id: overrides.id || 'sub_test_001',
    quizId: overrides.quizId || 'quiz_chem_10a',
    quizCode: overrides.quizCode || 'CHEM-10A',
    quizTitle: overrides.quizTitle || 'IGCSE Chemistry Paper 2',
    subject: 'Chemistry',
    studentName: overrides.studentName || 'Ahmad Fauzi',
    studentClass: overrides.studentClass || '10-A',
    candidateNumber: overrides.candidateNumber || '0012',
    submittedAt: overrides.submittedAt || '2026-11-08T09:30:00.000Z',
    durationSeconds: 2400,
    score: overrides.score ?? 18,
    totalMarks: 20,
    percentage: 90,
    violationsCount: 1,
    proctoringLogs: [
      { type: 'tab_switch', timestamp: '09:12:00', detail: 'Brief focus loss' },
    ],
    questionResults: [],
    topicBreakdown: {
      'Atomic Structure': { totalMarks: 10, earnedMarks: 9, percentage: 90 },
      'Bonding': { totalMarks: 10, earnedMarks: 9, percentage: 90 },
    },
    rawAnswers: overrides.rawAnswers || {
      0: 'B',
      1: 'C',
      '2_0': 'Covalent bonding shares a pair of electrons',
    },
    status: 'submitted',
    forensics: {
      answersByQuestionId: {
        q1: 'B',
        q2: 'C',
        'q3::a': 'Covalent bonding shares a pair of electrons',
      },
      proctorStudentId: overrides.proctorStudentId || 'cand_chem10a_0012',
      ...(overrides.forensics || {}),
    },
    ...overrides,
  };
}

// ─── EMERG-01: AES-GCM-256 Encrypt & Decrypt Roundtrip ────────────────────────
{
  const original = makeSampleSubmission();
  const { envelope, serialized } = await encryptEmergencyPackage('chem-10a', original);

  check('EMERG-01 envelope validates against v2 schema', validateEmergencyEnvelope(envelope));
  check('EMERG-01 quizCode is normalized to uppercase', envelope.quizCode === 'CHEM-10A');
  check('EMERG-01 raw answers do not appear in plaintext envelope', !serialized.includes('Covalent bonding shares'));

  const decrypted = await decryptEmergencyPackage('CHEM-10A', serialized);
  check('EMERG-01 decrypted submission ID matches original', decrypted.id === original.id);
  check('EMERG-01 decrypted studentName matches original', decrypted.studentName === 'Ahmad Fauzi');
  check(
    'EMERG-01 decrypted rawAnswers match 100%',
    decrypted.rawAnswers?.['2_0'] === 'Covalent bonding shares a pair of electrons' &&
      decrypted.rawAnswers?.[0] === 'B'
  );
  check(
    'EMERG-01 decrypted answersByQuestionId matches 100%',
    decrypted.forensics?.answersByQuestionId?.['q3::a'] === 'Covalent bonding shares a pair of electrons'
  );
}

// ─── EMERG-02: Anti-Tamper Rejection (Ciphertext, Checksum & AAD) ─────────────
{
  const original = makeSampleSubmission();
  const { envelope } = await encryptEmergencyPackage('CHEM-10A', original);

  // Case A: Flip 1 char in ciphertext
  const flippedChar = envelope.ciphertext[5] === 'A' ? 'B' : 'A';
  const tamperedCiphertextEnv = {
    ...envelope,
    ciphertext:
      envelope.ciphertext.slice(0, 5) + flippedChar + envelope.ciphertext.slice(6),
  };

  let caughtCipherTamper = false;
  try {
    await decryptEmergencyPackage('CHEM-10A', JSON.stringify(tamperedCiphertextEnv));
  } catch (err) {
    caughtCipherTamper = /Tamper detected/i.test(err.message);
  }
  check('EMERG-02 altering 1 character in ciphertext is rejected', caughtCipherTamper);

  // Case B: Student alters ciphertext AND recomputes outer SHA-256 checksum
  const recomputedChecksum = await computeEnvelopeChecksum({
    version: tamperedCiphertextEnv.version,
    quizCode: tamperedCiphertextEnv.quizCode,
    candidateId: tamperedCiphertextEnv.candidateId,
    exportedAt: tamperedCiphertextEnv.exportedAt,
    iv: tamperedCiphertextEnv.iv,
    ciphertext: tamperedCiphertextEnv.ciphertext,
  });
  const forgedCipherEnv = {
    ...tamperedCiphertextEnv,
    checksum: recomputedChecksum,
  };

  let caughtGcmTagFailure = false;
  try {
    await decryptEmergencyPackage('CHEM-10A', JSON.stringify(forgedCipherEnv));
  } catch (err) {
    caughtGcmTagFailure = /AES-GCM authentication tag verification failed/i.test(err.message);
  }
  check('EMERG-02 forged checksum with modified ciphertext fails AES-GCM auth tag', caughtGcmTagFailure);

  // Case C: Student modifies exportedAt timestamp in header AND recomputes outer SHA-256 checksum
  const ForgedTime = '2026-11-08T08:00:00.000Z';
  const forgedHeaderChecksum = await computeEnvelopeChecksum({
    version: envelope.version,
    quizCode: envelope.quizCode,
    candidateId: envelope.candidateId,
    exportedAt: ForgedTime,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
  });
  const forgedHeaderEnv = {
    ...envelope,
    exportedAt: ForgedTime,
    checksum: forgedHeaderChecksum,
  };

  let caughtAadFailure = false;
  try {
    await decryptEmergencyPackage('CHEM-10A', JSON.stringify(forgedHeaderEnv));
  } catch (err) {
    caughtAadFailure = /AES-GCM authentication tag verification failed/i.test(err.message);
  }
  check('EMERG-02 altering header timestamp fails AES-GCM AAD authentication', caughtAadFailure);
}

// ─── EMERG-03: Wrong Quiz Code Protection ────────────────────────────────────
{
  const mathSub = makeSampleSubmission({ quizCode: 'MATH-101' });
  const { content, fileName } = await createEncryptedEmergencyFileContent(mathSub);

  let caughtWrongQuizDecrypt = false;
  try {
    await decryptEmergencyPackage('CHEM-202', content);
  } catch (err) {
    caughtWrongQuizDecrypt = /Quiz code mismatch/i.test(err.message);
  }
  check('EMERG-03 decryptEmergencyPackage rejects wrong target quizCode', caughtWrongQuizDecrypt);

  const ingestWrongQuiz = await ingestEmergencySubmissionContent(content, {
    fileName,
    expectedQuizCode: 'CHEM-202',
    existingSubmissions: [],
    skipCloudSync: true,
  });
  check(
    'EMERG-03 ingestEmergencySubmissionContent rejects file from a different quiz',
    ingestWrongQuiz.status === 'failed' && /Wrong exam code/i.test(ingestWrongQuiz.error || '')
  );
}

// ─── EMERG-04: Batch Ingestion of 30 Encrypted Files ─────────────────────────
{
  const mockFiles = [];
  for (let i = 1; i <= 30; i++) {
    const num = String(i).padStart(4, '0');
    const sub = makeSampleSubmission({
      id: `sub_batch_${num}`,
      studentName: `Candidate ${num}`,
      candidateNumber: num,
      proctorStudentId: `cand_batch_${num}`,
      score: (i % 20) + 1,
    });
    const pkg = await createEncryptedEmergencyFileContent(sub);
    mockFiles.push({ fileName: pkg.fileName, content: pkg.content });
  }

  const startMs = performance.now();
  const summary = await ingestEmergencySubmissionBatch(mockFiles, {
    expectedQuizCode: 'CHEM-10A',
    existingSubmissions: [],
    skipCloudSync: true,
  });
  const elapsedMs = performance.now() - startMs;

  check('EMERG-04 all 30 encrypted files ingested cleanly', summary.insertedCount === 30 && summary.failedCount === 0);
  check(`EMERG-04 batch decryption of 30 files completed in < 500ms (${elapsedMs.toFixed(1)}ms)`, elapsedMs < 500);
}

// ─── EMERG-05: Timestamp Conflict Resolution (Newest Wins + Audit Flag) ──────
{
  const existingCloud = makeSampleSubmission({
    id: 'cloud_canonical_id_99',
    studentName: 'Siti Rahma',
    candidateNumber: '0045',
    proctorStudentId: 'cand_siti_0045',
    submittedAt: '2026-11-08T10:30:00.000Z',
    score: 16,
    teacherNotes: 'Verified by invigilator',
  });

  // Scenario A: Older offline draft (10:15) uploaded when cloud already has 10:30
  const olderOffline = makeSampleSubmission({
    id: 'offline_temp_id_1',
    studentName: 'Siti Rahma',
    candidateNumber: '0045',
    proctorStudentId: 'cand_siti_0045',
    submittedAt: '2026-11-08T10:15:00.000Z',
    score: 12,
  });

  const olderPkg = await createEncryptedEmergencyFileContent(olderOffline);
  const olderRes = await ingestEmergencySubmissionContent(olderPkg.content, {
    fileName: olderPkg.fileName,
    expectedQuizCode: 'CHEM-10A',
    existingSubmissions: [existingCloud],
    skipCloudSync: true,
  });

  check('EMERG-05 older offline file is skipped when cloud record is newer', olderRes.status === 'skipped_older');
  check('EMERG-05 skipped conflict preserves newer cloud score (16, not 12)', olderRes.submission?.score === 16);

  // Scenario B: Newer offline final submission (10:45) uploaded when cloud only had partial (10:30)
  const newerOffline = makeSampleSubmission({
    id: 'offline_temp_id_2',
    studentName: 'Siti Rahma',
    candidateNumber: '0045',
    proctorStudentId: 'cand_siti_0045',
    submittedAt: '2026-11-08T10:45:00.000Z',
    score: 19,
  });

  const newerPkg = await createEncryptedEmergencyFileContent(newerOffline);
  const newerRes = await ingestEmergencySubmissionContent(newerPkg.content, {
    fileName: newerPkg.fileName,
    expectedQuizCode: 'CHEM-10A',
    existingSubmissions: [existingCloud],
    skipCloudSync: true,
  });

  check('EMERG-05 newer offline file updates existing record', newerRes.status === 'updated');
  check('EMERG-05 updated record preserves canonical database ID', newerRes.submission?.id === 'cloud_canonical_id_99');
  check('EMERG-05 updated record reflects newer score (19)', newerRes.submission?.score === 19);
  check('EMERG-05 updated record preserves existing teacherNotes', newerRes.submission?.teacherNotes === 'Verified by invigilator');
  check(
    'EMERG-05 updated record is tagged with ingestionSource = emergency_offline',
    newerRes.submission?.forensics?.ingestionSource === 'emergency_offline' &&
      Boolean(newerRes.submission?.forensics?.ingestedAt)
  );
}

// ─── EMERG-06: Filename Formatting ───────────────────────────────────────────
{
  const sub = makeSampleSubmission({
    quizCode: 'phys-0625',
    studentName: 'Budi Santoso',
    candidateNumber: '0088',
    submittedAt: '2026-11-08T14:22:00.000Z',
  });
  const fileName = formatEmergencyExamFileName(sub);
  check(
    'EMERG-06 filename follows [QuizCode]_[Candidate]_[Timestamp].exam format',
    fileName === 'PHYS-0625_Budi_Santoso_0088_20261108-1422.exam',
    fileName
  );
}

// ─── EMERG-07: Component Wiring & Integration Tripwires ──────────────────────
{
  const runnerSrc = fs.readFileSync('src/pages/StudentQuizRunner.tsx', 'utf8');
  check(
    'EMERG-07 StudentQuizRunner includes guarded Mid-Exam Emergency Save & Exit handler',
    /handleEmergencySaveAndExit/.test(runnerSrc) && /showEmergencyExitModal/.test(runnerSrc)
  );
  check(
    'EMERG-07 StudentQuizRunner auto-exports encrypted .exam on failed cloud submit',
    /exportSubmissionToFile\(submission\)\.catch/.test(runnerSrc)
  );

  const resultsModalSrc = fs.readFileSync('src/components/QuizResultsModal.tsx', 'utf8');
  check(
    'EMERG-07 QuizResultsModal supports multi-file batch drag-and-drop ingestion',
    /ingestEmergencySubmissionBatch/.test(resultsModalSrc) && /handleBatchFilesProcess/.test(resultsModalSrc)
  );
  check(
    'EMERG-07 QuizResultsModal renders Offline Ingested audit badge',
    /Offline Ingested/.test(resultsModalSrc)
  );

  const cockpitSrc = fs.readFileSync('src/components/LiveInvigilatorModal.tsx', 'utf8');
  check(
    'EMERG-07 LiveInvigilatorModal wires Ingest Emergency Papers shortcut & roster reconciliation',
    /handleEmergencyFilesIngest/.test(cockpitSrc) && /Ingest Emergency Papers/.test(cockpitSrc)
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
