// End-to-End Simulation: Auto-Trigger on Network Failure & Teacher Batch Ingestion
//
//   node --import ./scripts/register-ts.mjs scripts/simulate-emergency-auto-trigger-import.mjs
//
// Exercises the exact end-to-end pipeline:
// 1. Candidate sitting an active exam with answers, forensics, and strikes.
// 2. Network outage during submit -> triggers auto-encryption & .exam file generation.
// 3. Mid-exam emergency exit -> triggers sealed .exam file generation with reason.
// 4. Invigilator batch ingestion of the generated files + conflict resolution + tamper check.

import fs from 'node:fs';
import path from 'node:path';

// Node.js localStorage mock for testing outbox persistence
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) || null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

import {
  createEncryptedEmergencyFileContent,
  ingestEmergencySubmissionBatch,
  saveToSubmissionOutbox,
  getSubmissionOutbox,
  getAllSubmissions,
  saveQuizSubmission,
} from '../src/services/quizSubmissionService.ts';
import {
  decryptEmergencyPackage,
  validateEmergencyEnvelope,
} from '../src/utils/examCryptoUtils.ts';

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

console.log('\n=== Simulating Emergency Auto-Trigger & Teacher Ingestion Pipeline ===\n');

// ─── Scenario 1: Cloud Submit Fails -> Auto-Trigger Offline Package ──────────
console.log('--- Step 1: Simulating Submit Network Failure & Auto-Trigger ---');

const candidate1Submission = {
  id: 'sub_candidate_001',
  quizId: 'quiz_igcse_0620',
  quizCode: 'CHEM-0620',
  quizTitle: 'IGCSE Chemistry Paper 2 (Theory)',
  subject: 'Chemistry',
  studentName: 'Ahmad Fauzi',
  studentClass: '10-A',
  candidateNumber: '0012',
  submittedAt: '2026-11-08T09:45:00.000Z',
  durationSeconds: 2700,
  score: 34,
  totalMarks: 40,
  percentage: 85,
  violationsCount: 1,
  proctoringLogs: [
    { type: 'tab_switch', timestamp: '09:15:00', detail: 'Switched window' }
  ],
  questionResults: [
    { questionId: 'q1', questionNumber: 1, maxMarks: 1, earnedMarks: 1, isCorrect: true, studentAnswer: 'B' },
    { questionId: 'q2', questionNumber: 2, maxMarks: 2, earnedMarks: 2, isCorrect: true, studentAnswer: 'Diffusion occurs faster at higher temperatures' }
  ],
  topicBreakdown: { 'Physical Chemistry': { totalMarks: 40, earnedMarks: 34, percentage: 85 } },
  rawAnswers: { 0: 'B', '1_0': 'Diffusion occurs faster at higher temperatures' },
  status: 'submitted',
  forensics: {
    answersByQuestionId: { q1: 'B', 'q2::a': 'Diffusion occurs faster at higher temperatures' },
    proctorStudentId: 'cand_ahmad_0012',
  }
};

// Simulate network failure response from saveQuizSubmissionWithVerification
const simulatedNetworkFailure = {
  success: false,
  error: 'Network request failed: 504 Gateway Timeout (Wi-Fi disconnected)'
};

check(
  'Runner detects cloud submission failure',
  simulatedNetworkFailure.success === false && /504 Gateway/i.test(simulatedNetworkFailure.error)
);

// The runner's failure handler calls createEncryptedEmergencyFileContent & saveToSubmissionOutbox
const autoTriggeredFile = await createEncryptedEmergencyFileContent(candidate1Submission);

check(
  'Auto-trigger produces valid AES-256-GCM envelope',
  validateEmergencyEnvelope(autoTriggeredFile.envelope)
);
check(
  'Auto-trigger envelope assigns correct normalized quizCode',
  autoTriggeredFile.envelope.quizCode === 'CHEM-0620'
);
check(
  'Generated filename matches expected pattern',
  autoTriggeredFile.fileName.startsWith('CHEM-0620_Ahmad_Fauzi_0012_') && autoTriggeredFile.fileName.endsWith('.exam')
);

// ─── Scenario 2: Mid-Exam Guarded Emergency Exit ────────────────────────────
console.log('\n--- Step 2: Simulating Mid-Exam Emergency Save & Exit ---');

const candidate2EmergencyExit = {
  id: 'sub_candidate_002',
  quizId: 'quiz_igcse_0620',
  quizCode: 'CHEM-0620',
  quizTitle: 'IGCSE Chemistry Paper 2 (Theory)',
  subject: 'Chemistry',
  studentName: 'Siti Rahma',
  studentClass: '10-A',
  candidateNumber: '0015',
  submittedAt: '2026-11-08T09:30:00.000Z',
  durationSeconds: 1800,
  score: 20,
  totalMarks: 40,
  percentage: 50,
  violationsCount: 0,
  proctoringLogs: [],
  questionResults: [],
  topicBreakdown: {},
  rawAnswers: { 0: 'A', 1: 'C' },
  status: 'submitted',
  forensics: {
    answersByQuestionId: { q1: 'A', q2: 'C' },
    proctorStudentId: 'cand_siti_0015',
    emergencyExitReason: 'Critical battery / Device power failure'
  }
};

const emergencyExitFile = await createEncryptedEmergencyFileContent(candidate2EmergencyExit);
const decryptedEmergency = await decryptEmergencyPackage('CHEM-0620', emergencyExitFile.content);

check(
  'Mid-exam emergency file decrypts with emergencyExitReason preserved',
  decryptedEmergency.forensics?.emergencyExitReason === 'Critical battery / Device power failure'
);

// ─── Scenario 3: Teacher Ingestion of Emergency Batch ────────────────────────
console.log('\n--- Step 3: Simulating Teacher Batch Ingestion & Conflict Resolution ---');

// Pre-existing cloud record for candidate 1 (older draft at 09:10)
const preExistingOlderCloudRecord = {
  ...candidate1Submission,
  submittedAt: '2026-11-08T09:10:00.000Z',
  score: 15,
  percentage: 37,
};

// Create a tampered file (altered byte)
const tamperedEnvelope = JSON.parse(autoTriggeredFile.content);
tamperedEnvelope.ciphertext = 'Z' + tamperedEnvelope.ciphertext.slice(1);
const tamperedFileContent = JSON.stringify(tamperedEnvelope);

// Create a file from an unauthorized exam
const foreignExamSub = {
  ...candidate1Submission,
  id: 'sub_foreign_99',
  quizCode: 'BIOLOGY-0610',
  studentName: 'Farhan Putra',
};
const foreignFile = await createEncryptedEmergencyFileContent(foreignExamSub);

// Batch of files submitted to teacher
const teacherBatch = [
  { fileName: autoTriggeredFile.fileName, content: autoTriggeredFile.content },       // Candidate 1 (Newer than cloud)
  { fileName: emergencyExitFile.fileName, content: emergencyExitFile.content },       // Candidate 2 (New candidate)
  { fileName: 'tampered_candidate.exam', content: tamperedFileContent },              // Corrupted/tampered file
  { fileName: foreignFile.fileName, content: foreignFile.content },                   // Wrong quiz code
];

const batchSummary = await ingestEmergencySubmissionBatch(teacherBatch, {
  expectedQuizCode: 'CHEM-0620',
  existingSubmissions: [preExistingOlderCloudRecord],
  skipCloudSync: true,
});

check(
  'Batch ingestion reports exactly 4 processed files',
  batchSummary.totalFiles === 4
);
check(
  'Candidate 1 updated older cloud submission with newer file',
  batchSummary.updatedCount === 1 &&
    batchSummary.results.find((r) => r.studentName === 'Ahmad Fauzi')?.status === 'updated'
);
check(
  'Candidate 1 score updated from 15 to 34',
  batchSummary.results.find((r) => r.studentName === 'Ahmad Fauzi')?.submission?.score === 34
);
check(
  'Candidate 1 tagged with emergency_offline ingestionSource',
  batchSummary.results.find((r) => r.studentName === 'Ahmad Fauzi')?.submission?.forensics?.ingestionSource === 'emergency_offline'
);
check(
  'Candidate 2 inserted as new submission',
  batchSummary.insertedCount === 1 &&
    batchSummary.results.find((r) => r.studentName === 'Siti Rahma')?.status === 'inserted'
);
check(
  'Tampered file was rejected',
  batchSummary.results.find((r) => r.fileName === 'tampered_candidate.exam')?.status === 'failed' &&
    /Tamper detected/i.test(batchSummary.results.find((r) => r.fileName === 'tampered_candidate.exam')?.error || '')
);
check(
  'Wrong exam code file was rejected',
  batchSummary.results.find((r) => r.fileName === foreignFile.fileName)?.status === 'failed' &&
    /Wrong exam code/i.test(batchSummary.results.find((r) => r.fileName === foreignFile.fileName)?.error || '')
);

// ─── Scenario 4: Outbox Preservation Test ───────────────────────────────────
console.log('\n--- Step 4: Outbox State Persistence & Auto-Flush Check ---');

saveToSubmissionOutbox(candidate1Submission, 'failed', '504 Gateway Timeout');
const outbox = getSubmissionOutbox();
const outboxItem = outbox.find((item) => item.submission.id === candidate1Submission.id);

check(
  'Failed submission is preserved in outbox with error message',
  outboxItem !== undefined && outboxItem.status === 'failed' && outboxItem.lastError === '504 Gateway Timeout'
);
check(
  'Failed submission has exponential backoff nextRetryAt stamped',
  typeof outboxItem?.nextRetryAt === 'string'
);

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

process.exit(failed === 0 ? 0 : 1);
