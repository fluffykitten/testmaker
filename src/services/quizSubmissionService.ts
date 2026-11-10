// ─── Quiz Submission Service ──────────────────────────────────────────────────
// Stores and tracks student quiz attempts, responses, scores, and proctoring audit logs.
// Supports Excel (.xlsx) exports for individual candidates and class-wide gradebooks.

import { supabase } from '../lib/supabase';
import {
  exportAllSubmissionsExcelICM,
  exportSingleSubmissionExcelICM,
} from './icmExcelExportService';
import {
  computeNextRetryAt,
  isOutboxRetryable,
  normalizeIdentityPart,
} from '../lib/examSubmissionGuards';
import type { SecurityTierEvent } from '../lib/securityTiers';
import {
  encryptEmergencyPackage,
  decryptEmergencyPackage,
  validateEmergencyEnvelope,
  formatEmergencyExamFileName,
  resolveEmergencySubmissionConflict,
  normalizeEmergencyQuizCode,
  type EmergencyPackageEnvelope,
} from '../utils/examCryptoUtils';
import { getCanonicalProctorStudentId } from '../utils/examSecurityUtils';
import { recordProctorAuditEvent } from './proctorAuditLogService';

export type SubmissionStatus = 'submitted' | 'grading' | 'graded' | 'published';

export interface SubmissionOutboxItem {
  submission: StudentSubmission;
  status: 'pending' | 'synced' | 'failed';
  queuedAt: string;
  retryCount: number;
  lastError?: string;
  /** Earliest time a failed item may be retried (exponential backoff). */
  nextRetryAt?: string;
}

const OUTBOX_STORAGE_KEY = 'fluffykitten_submission_outbox';

export interface DeviceExamReceipt {
  quizCode: string;
  quizTitle: string;
  studentName: string;
  candidateNumber?: string;
  submittedAt: string;
  resultPin?: string;
}

/**
 * Retrieves all queued outbox submissions.
 */
export function getSubmissionOutbox(): SubmissionOutboxItem[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('Failed to load submission outbox:', err);
    return [];
  }
}

/**
 * Retrieves only retryable (un-synced) outbox submissions. Failed items are
 * included until they exhaust their attempt budget and backoff window.
 */
export function getPendingOutboxSubmissions(): SubmissionOutboxItem[] {
  const now = Date.now();
  return getSubmissionOutbox().filter((item) => isOutboxRetryable(item, now));
}

function pruneOutbox(outbox: SubmissionOutboxItem[]): SubmissionOutboxItem[] {
  const now = Date.now();
  const retained = outbox.filter((item) => {
    if (item.status !== 'synced') return true;
    const ageHrs = (now - new Date(item.queuedAt).getTime()) / (1000 * 60 * 60);
    return ageHrs < 24;
  });
  // Never let a synced history crowd out an unsynced paper.
  const unsynced = retained.filter((item) => item.status !== 'synced');
  const synced = retained.filter((item) => item.status === 'synced').slice(0, 50);
  return [...unsynced, ...synced].slice(0, 500);
}

/**
 * Saves or updates a submission in the offline outbox.
 */
export function saveToSubmissionOutbox(
  submission: StudentSubmission,
  status: 'pending' | 'synced' | 'failed' = 'pending',
  lastError?: string
): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const outbox = getSubmissionOutbox();
    const now = Date.now();
    const existingIdx = outbox.findIndex((item) => item.submission.id === submission.id);

    if (existingIdx >= 0) {
      const existing = outbox[existingIdx];
      const retryCount = status === 'failed'
        ? (Number(existing.retryCount) || 0) + 1
        : (Number(existing.retryCount) || 0);
      outbox[existingIdx] = {
        submission,
        status,
        queuedAt: existing.queuedAt || new Date().toISOString(),
        retryCount,
        lastError: status === 'failed' ? (lastError || existing.lastError) : lastError,
        nextRetryAt: status === 'failed' ? computeNextRetryAt(retryCount, now) : undefined,
      };
    } else {
      const retryCount = status === 'failed' ? 1 : 0;
      outbox.unshift({
        submission,
        status,
        queuedAt: new Date().toISOString(),
        retryCount,
        lastError,
        nextRetryAt: status === 'failed' ? computeNextRetryAt(retryCount, now) : undefined,
      });
    }

    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(pruneOutbox(outbox)));
  } catch (err) {
    console.warn('Could not save to submission outbox:', err);
  }
}

/**
 * Marks a submission as verified synced in the outbox.
 */
export function markOutboxSynced(submissionId: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const outbox = getSubmissionOutbox();
    const updated = outbox.map((item) =>
      item.submission.id === submissionId
        ? { ...item, status: 'synced' as const, retryCount: 0, lastError: undefined, nextRetryAt: undefined }
        : item
    );

    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(pruneOutbox(updated)));
  } catch (err) {
    console.warn('Could not mark outbox item synced:', err);
  }
}

/**
 * Creates a tamper-evident AES-256-GCM encrypted `.exam` emergency file package.
 */
export async function createEncryptedEmergencyFileContent(
  submission: StudentSubmission
): Promise<{
  fileName: string;
  content: string;
  envelope: EmergencyPackageEnvelope;
}> {
  const canonicalId =
    submission.forensics?.proctorStudentId ||
    getCanonicalProctorStudentId({
      quizCode: submission.quizCode,
      studentName: submission.studentName,
      candidateNumber: submission.candidateNumber,
      studentClass: submission.studentClass,
    });

  const enrichedSubmission: StudentSubmission = {
    ...submission,
    forensics: {
      ...(submission.forensics || {}),
      proctorStudentId: canonicalId,
    },
  };

  const { envelope, serialized } = await encryptEmergencyPackage(
    enrichedSubmission.quizCode,
    enrichedSubmission
  );
  const fileName = formatEmergencyExamFileName(enrichedSubmission);

  return {
    fileName,
    content: serialized,
    envelope,
  };
}

/**
 * Exports a student submission to a tamper-evident AES-256-GCM encrypted downloadable `.exam` file
 * for air-gapped emergency offline hand-in.
 */
export async function exportSubmissionToFile(submission: StudentSubmission): Promise<string> {
  try {
    const { fileName, content } = await createEncryptedEmergencyFileContent(submission);

    if (typeof document !== 'undefined' && typeof URL !== 'undefined') {
      const blob = new Blob([content], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
    return content;
  } catch (err) {
    console.error('Failed to export encrypted submission file:', err);
    return '';
  }
}

/**
 * Encodes a student submission into a compact base64 token string for easy copying / manual submission.
 */
export function exportSubmissionToken(submission: StudentSubmission): string {
  try {
    const payload = {
      _f: 'fke_v1',
      s: submission,
      t: Date.now(),
    };
    const jsonStr = JSON.stringify(payload);
    // Universal utf-8 safe base64 encoding
    const b64 = btoa(encodeURIComponent(jsonStr).replace(/%([0-9A-F]{2})/g, (_, p1) =>
      String.fromCharCode(parseInt(p1, 16))
    ));
    return `EXAM_TOKEN:${b64}`;
  } catch (err) {
    console.error('Failed to generate submission token:', err);
    return '';
  }
}

export interface EmergencyFileIngestionItemResult {
  fileName: string;
  status: 'inserted' | 'updated' | 'skipped_older' | 'failed';
  studentName?: string;
  candidateNumber?: string;
  candidateClass?: string;
  quizCode?: string;
  submittedAt?: string;
  score?: number;
  totalMarks?: number;
  submission?: StudentSubmission;
  reason?: string;
  error?: string;
}

export interface BatchEmergencyIngestionSummary {
  totalFiles: number;
  insertedCount: number;
  updatedCount: number;
  skippedOlderCount: number;
  failedCount: number;
  results: EmergencyFileIngestionItemResult[];
}

/**
 * Finds an existing submission for the same candidate within the same quiz cohort.
 */
function findMatchingCandidateSubmission(
  cohort: StudentSubmission[],
  incoming: StudentSubmission
): StudentSubmission | undefined {
  const incomingCode = normalizeEmergencyQuizCode(incoming.quizCode);
  const incomingCanonicalId =
    incoming.forensics?.proctorStudentId ||
    getCanonicalProctorStudentId({
      quizCode: incomingCode,
      studentName: incoming.studentName,
      candidateNumber: incoming.candidateNumber,
      studentClass: incoming.studentClass,
    });

  const normName = normalizeIdentityPart(incoming.studentName);
  const normNumber = normalizeIdentityPart(incoming.candidateNumber);

  return cohort.find((existing) => {
    if (normalizeEmergencyQuizCode(existing.quizCode) !== incomingCode) return false;
    if (existing.id === incoming.id) return true;

    const existingCanonicalId =
      existing.forensics?.proctorStudentId ||
      getCanonicalProctorStudentId({
        quizCode: existing.quizCode,
        studentName: existing.studentName,
        candidateNumber: existing.candidateNumber,
        studentClass: existing.studentClass,
      });

    if (existingCanonicalId === incomingCanonicalId) return true;

    // Fallback identity match when candidate number + name match
    const exName = normalizeIdentityPart(existing.studentName);
    const exNum = normalizeIdentityPart(existing.candidateNumber);
    if (normName && exName === normName) {
      if (normNumber && exNum) return normNumber === exNum;
      if (!normNumber && !exNum) return true;
    }
    return false;
  });
}

/**
 * Decodes, decrypts, verifies, and ingests a single emergency `.exam` file or token string,
 * applying the "Newest Timestamp Wins + Audit Flag" conflict resolution policy.
 */
export async function ingestEmergencySubmissionContent(
  rawContent: string,
  options: {
    fileName?: string;
    expectedQuizCode?: string;
    allowedQuizCodes?: string[];
    existingSubmissions?: StudentSubmission[];
    skipCloudSync?: boolean;
  } = {}
): Promise<EmergencyFileIngestionItemResult> {
  const fileName = options.fileName || 'emergency_submission.exam';
  try {
    const raw = (rawContent || '').trim();
    if (!raw) {
      return { fileName, status: 'failed', error: 'Empty file or token input.' };
    }

    const allowedSet =
      options.allowedQuizCodes && options.allowedQuizCodes.length > 0
        ? new Set(options.allowedQuizCodes.map((c) => normalizeEmergencyQuizCode(c)))
        : null;
    const expectedCode = options.expectedQuizCode
      ? normalizeEmergencyQuizCode(options.expectedQuizCode)
      : undefined;

    let parsedSub: StudentSubmission | null = null;

    if (raw.startsWith('EXAM_TOKEN:')) {
      const b64 = raw.substring('EXAM_TOKEN:'.length).trim();
      const decoded = decodeURIComponent(
        Array.prototype.map
          .call(atob(b64), (c: string) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      const parsed = JSON.parse(decoded);
      parsedSub = parsed.s || parsed;
    } else if (raw.startsWith('{')) {
      let jsonObj: any;
      try {
        jsonObj = JSON.parse(raw);
      } catch {
        return { fileName, status: 'failed', error: 'Malformed JSON file.' };
      }

      if (jsonObj && jsonObj._format === 'testmaker_emergency_v2') {
        if (!validateEmergencyEnvelope(jsonObj)) {
          return {
            fileName,
            status: 'failed',
            studentName: jsonObj.studentName,
            quizCode: jsonObj.quizCode,
            error: 'Tamper detected: invalid emergency v2 envelope structure or checksum format.',
          };
        }

        const envCode = normalizeEmergencyQuizCode(jsonObj.quizCode);
        if (expectedCode && envCode !== expectedCode) {
          return {
            fileName,
            status: 'failed',
            studentName: jsonObj.studentName,
            candidateNumber: jsonObj.candidateNumber,
            quizCode: envCode,
            error: `Wrong exam code: file belongs to "${envCode}", expected "${expectedCode}".`,
          };
        }
        if (allowedSet && !allowedSet.has(envCode)) {
          return {
            fileName,
            status: 'failed',
            studentName: jsonObj.studentName,
            candidateNumber: jsonObj.candidateNumber,
            quizCode: envCode,
            error: `Exam code "${envCode}" is not in the currently monitored exam scope.`,
          };
        }

        parsedSub = await decryptEmergencyPackage(expectedCode || envCode, jsonObj);
      } else {
        // Legacy fluffykitten_exam_v1 or raw submission JSON
        parsedSub = jsonObj.submission || jsonObj;
      }
    } else {
      return { fileName, status: 'failed', error: 'Unrecognized file format.' };
    }

    if (!parsedSub || !parsedSub.id || !parsedSub.studentName || !parsedSub.quizCode) {
      return {
        fileName,
        status: 'failed',
        error: 'Invalid exam submission payload: missing candidate or quiz identifiers.',
      };
    }

    const subQuizCode = normalizeEmergencyQuizCode(parsedSub.quizCode);
    if (expectedCode && subQuizCode !== expectedCode) {
      return {
        fileName,
        status: 'failed',
        studentName: parsedSub.studentName,
        candidateNumber: parsedSub.candidateNumber,
        quizCode: subQuizCode,
        error: `Wrong exam code: file belongs to "${subQuizCode}", expected "${expectedCode}".`,
      };
    }
    if (allowedSet && !allowedSet.has(subQuizCode)) {
      return {
        fileName,
        status: 'failed',
        studentName: parsedSub.studentName,
        candidateNumber: parsedSub.candidateNumber,
        quizCode: subQuizCode,
        error: `Exam code "${subQuizCode}" is not in the currently monitored exam scope.`,
      };
    }

    const canonicalId =
      parsedSub.forensics?.proctorStudentId ||
      getCanonicalProctorStudentId({
        quizCode: subQuizCode,
        studentName: parsedSub.studentName,
        candidateNumber: parsedSub.candidateNumber,
        studentClass: parsedSub.studentClass,
      });

    const normalizedIncoming: StudentSubmission = {
      ...parsedSub,
      quizCode: subQuizCode,
      forensics: {
        ...(parsedSub.forensics || {}),
        proctorStudentId: canonicalId,
      },
    };

    const currentPool = options.existingSubmissions ?? getAllSubmissions();
    const existingMatch = findMatchingCandidateSubmission(currentPool, normalizedIncoming);
    const decision = resolveEmergencySubmissionConflict(existingMatch, normalizedIncoming);

    if (decision.action === 'skip_older') {
      return {
        fileName,
        status: 'skipped_older',
        studentName: normalizedIncoming.studentName,
        candidateNumber: normalizedIncoming.candidateNumber,
        candidateClass: normalizedIncoming.studentClass,
        quizCode: subQuizCode,
        submittedAt: normalizedIncoming.submittedAt,
        score: decision.winner.score,
        totalMarks: decision.winner.totalMarks,
        submission: decision.winner,
        reason: decision.reason,
      };
    }

    const finalSub = decision.winner;

    if (!options.skipCloudSync) {
      saveQuizSubmission(finalSub);
      markOutboxSynced(finalSub.id);
      await saveQuizSubmissionCloud(finalSub);

      recordProctorAuditEvent({
        id: `audit-emerg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        quizCode: subQuizCode,
        studentId: canonicalId,
        studentName: finalSub.studentName,
        candidateNumber: finalSub.candidateNumber,
        candidateClass: finalSub.studentClass,
        eventType: 'emergency_offline_imported',
        severity: 'info',
        detail:
          decision.action === 'update'
            ? `Updated candidate paper from encrypted emergency file (${fileName})`
            : `Ingested new candidate paper from encrypted emergency file (${fileName})`,
        actor: 'invigilator',
        createdAt: new Date().toISOString(),
      });

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('submissions_updated'));
      }
    }

    return {
      fileName,
      status: decision.action === 'update' ? 'updated' : 'inserted',
      studentName: finalSub.studentName,
      candidateNumber: finalSub.candidateNumber,
      candidateClass: finalSub.studentClass,
      quizCode: subQuizCode,
      submittedAt: finalSub.submittedAt,
      score: finalSub.score,
      totalMarks: finalSub.totalMarks,
      submission: finalSub,
      reason: decision.reason,
    };
  } catch (err: any) {
    return {
      fileName,
      status: 'failed',
      error: err?.message || 'Failed to decrypt or validate emergency submission file.',
    };
  }
}

/**
 * Processes a batch of emergency `.exam` files sequentially, maintaining an updated cohort view
 * so even multiple files for the same candidate in the same batch resolve deterministically
 * ("Newest Timestamp Wins").
 */
export async function ingestEmergencySubmissionBatch(
  files: Array<{ fileName: string; content: string }>,
  options: {
    expectedQuizCode?: string;
    allowedQuizCodes?: string[];
    existingSubmissions?: StudentSubmission[];
    skipCloudSync?: boolean;
  } = {}
): Promise<BatchEmergencyIngestionSummary> {
  const workingPool: StudentSubmission[] = [
    ...(options.existingSubmissions ?? getAllSubmissions()),
  ];

  const results: EmergencyFileIngestionItemResult[] = [];
  let insertedCount = 0;
  let updatedCount = 0;
  let skippedOlderCount = 0;
  let failedCount = 0;

  for (const file of files) {
    const res = await ingestEmergencySubmissionContent(file.content, {
      fileName: file.fileName,
      expectedQuizCode: options.expectedQuizCode,
      allowedQuizCodes: options.allowedQuizCodes,
      existingSubmissions: workingPool,
      skipCloudSync: options.skipCloudSync,
    });

    results.push(res);

    if (res.status === 'inserted' && res.submission) {
      insertedCount++;
      workingPool.push(res.submission);
    } else if (res.status === 'updated' && res.submission) {
      updatedCount++;
      const idx = workingPool.findIndex((s) => s.id === res.submission!.id);
      if (idx >= 0) {
        workingPool[idx] = res.submission;
      } else {
        workingPool.push(res.submission);
      }
    } else if (res.status === 'skipped_older') {
      skippedOlderCount++;
    } else {
      failedCount++;
    }
  }

  return {
    totalFiles: files.length,
    insertedCount,
    updatedCount,
    skippedOlderCount,
    failedCount,
    results,
  };
}

/**
 * Decodes, validates, and imports a student submission from a token string or `.exam` JSON string.
 */
export async function importSubmissionToken(
  tokenOrJson: string,
  expectedQuizCode?: string
): Promise<{
  success: boolean;
  submission?: StudentSubmission;
  status?: EmergencyFileIngestionItemResult['status'];
  reason?: string;
  error?: string;
}> {
  const res = await ingestEmergencySubmissionContent(tokenOrJson, {
    fileName: 'pasted_token.exam',
    expectedQuizCode,
  });

  if (res.status === 'failed') {
    return { success: false, status: 'failed', error: res.error };
  }

  return {
    success: true,
    submission: res.submission,
    status: res.status,
    reason: res.reason,
  };
}

/**
 * Flushes all pending outbox submissions to Supabase cloud.
 */
export async function flushSubmissionOutbox(): Promise<{ syncedCount: number; failedCount: number }> {
  const pending = getPendingOutboxSubmissions();
  if (pending.length === 0) return { syncedCount: 0, failedCount: 0 };

  let syncedCount = 0;
  let failedCount = 0;

  for (const item of pending) {
    try {
      const success = await saveQuizSubmissionCloud(item.submission);
      if (success) {
        markOutboxSynced(item.submission.id);
        syncedCount++;
      } else {
        saveToSubmissionOutbox(item.submission, 'failed', 'Cloud endpoint did not confirm receipt');
        failedCount++;
      }
    } catch (err: any) {
      saveToSubmissionOutbox(item.submission, 'failed', err?.message || 'Network error during flush');
      failedCount++;
    }
  }

  return { syncedCount, failedCount };
}

/**
 * Generates a random 3-digit personal PIN (100–999) for secure result retrieval.
 */
export function generateResultPin(): string {
  return String(Math.floor(100 + Math.random() * 900));
}

export interface QuestionSubmissionResult {
  questionId: string;
  questionNumber: number;
  questionText?: string;      // The question prompt/stem
  options?: string[] | null;  // MCQ choice options if available
  topic: string;
  maxMarks: number;
  earnedMarks: number;
  isCorrect: boolean;
  studentAnswer: string | number;
  correctAnswer?: string;
  misconceptions?: string[];
  // Enhanced Structured & AI grading metadata
  aiFeedback?: string;
  missingPoints?: string[];
  criteriaBreakdown?: Array<{ point: string; achieved: boolean; examinerNote?: string }>;
  gradingMethod?: 'mcq' | 'deterministic' | 'ai_gemini' | 'rule_fallback';
  subQuestionResults?: Array<{
    subId: string;
    questionText?: string;
    studentAnswer: string | number;
    earnedMarks: number;
    maxMarks: number;
    isCorrect: boolean;
    feedback?: string;
    criteria?: Array<{ point: string; achieved: boolean }>;
  }>;
}

/**
 * Strips duplicate leading option letters like "A ", "A. ", "A) ", "(A) ", "A: "
 * so that "Option A: " + "A W and X..." becomes "Option A: W and X...".
 */
export function cleanMcqOptionContent(text: string, oIdx?: number): string {
  if (!text) return '';
  let clean = text.trim();
  // Strip duplicate prefix like "Option A: A " -> "Option A: "
  clean = clean.replace(/^Option\s+([A-F]):\s+[A-F][\.\)\s:-]+\s*/i, 'Option $1: ');
  const arLetters = ['أ', 'ب', 'ج', 'د', 'هـ', 'و'];
  if (oIdx !== undefined && oIdx >= 0 && oIdx < 26) {
    const letter = String.fromCharCode(65 + oIdx);
    clean = clean.replace(new RegExp(`^\\s*(\\(${letter}\\)|${letter}[.)\\s:-]+)\\s*`, 'i'), '');
    if (oIdx < arLetters.length) {
      const arL = arLetters[oIdx];
      clean = clean.replace(new RegExp(`^\\s*(\\(${arL}\\)|${arL}[.)\\s:-]+)\\s*`), '');
    }
  } else {
    // Strip standalone leading "A ", "A. ", "A) ", "(A) ", "A: "
    clean = clean.replace(/^[([]?[A-Fa-f][)\]\.:\s-]+\s*/, '');
    clean = clean.replace(/^[([]?[أإآابجددهـ][.)\]:\s-]+\s*/, '');
  }
  return clean.trim();
}

export const cleanOptionText = cleanMcqOptionContent;

/**
 * Formats a student's answer or mark scheme answer into a human-readable string.
 * Translates MCQ option indices (e.g. 0, 1, 2, 3 or "0", "1", "2", "3") into "Option A", "Option B" or "Option A: [Text]".
 * Ensures no duplicate option letters (e.g. "Option A: A ...") occur.
 */
export function formatCandidateAnswer(
  ans: string | number | undefined,
  options?: string[] | null,
  gradingMethod?: string,
  compact: boolean = false
): string {
  if (ans === undefined || ans === null || String(ans).trim() === '') {
    return '(No response)';
  }
  let str = String(ans).trim();

  // If already formatted like "Option A: A ...", clean duplicate option letter
  str = str.replace(/^Option\s+([A-F]):\s+[A-F][\.\)\s:-]+\s*/i, 'Option $1: ');

  // Check if string is already formatted like "Option A" or "Option A: [text]"
  const optMatch = str.match(/^Option\s+([A-Z])(?::\s*(.*))?$/i);
  if (optMatch) {
    const letter = optMatch[1].toUpperCase();
    if (compact) return `Option ${letter}`;
    const content = optMatch[2] ? cleanMcqOptionContent(optMatch[2]) : '';
    return content ? `Option ${letter}: ${content}` : `Option ${letter}`;
  }

  const num = Number(str);
  const isNumericIndex = !isNaN(num) && Number.isInteger(num) && num >= 0 && num <= 25;
  const isMcq = gradingMethod === 'mcq' || (options && options.length > 0) || (isNumericIndex && num <= 5);

  if (isMcq && isNumericIndex) {
    const letter = String.fromCharCode(65 + num);
    if (compact) {
      return `Option ${letter}`;
    }
    if (options && options.length > 0 && num < options.length) {
      const cleanContent = cleanMcqOptionContent(options[num], num);
      return `Option ${letter}: ${cleanContent || options[num]}`;
    }
    return `Option ${letter}`;
  }

  // If ans is a single letter like "A", "B", "C", "D", "E"
  if (str.length === 1 && str.toUpperCase() >= 'A' && str.toUpperCase() <= 'Z' && (isMcq || str.toUpperCase() <= 'F')) {
    const letter = str.toUpperCase();
    if (compact) {
      return `Option ${letter}`;
    }
    const idx = letter.charCodeAt(0) - 65;
    if (options && options[idx]) {
      const cleanContent = cleanMcqOptionContent(options[idx], idx);
      return `Option ${letter}: ${cleanContent || options[idx]}`;
    }
    return `Option ${letter}`;
  }

  if (compact && str.length > 22) {
    return str.substring(0, 20) + '…';
  }

  return str;
}

export interface ProctoringViolationEvent {
  timestamp: string;
  event: string;
  strike: number;
  severity: 'warning' | 'critical';
  type?: 'tab_switch' | 'blur' | 'window_blur' | 'fullscreen_exit' | 'multi_monitor' | 'blocked_shortcut' | 'print_screen' | 'dev_tools' | 'vm_detected';
  detail?: string;
  elapsedExamSeconds?: number;
}

export interface AnswerChangeLogEntry {
  questionIndex: number;
  questionId: string;
  previousAnswer: string | number;
  newAnswer: string | number;
  timestamp: string;          // ISO timestamp
  elapsedExamSeconds: number; // Seconds into the exam
  timeSinceLastActionMs: number; // Rapid-fire detection (< 2000ms)
}

export interface QuestionTimeAnalytics {
  questionIndex: number;
  questionId: string;
  totalDwellSeconds: number;
  visitCount: number;
  firstVisitElapsedSeconds: number;
  lastVisitElapsedSeconds: number;
}

export interface ExamForensics {
  answerChangeLogs?: AnswerChangeLogEntry[];
  questionTimeAnalytics?: QuestionTimeAnalytics[];
  /**
   * Stable answer map keyed by `questionId` / `questionId::subId`. Re-grading
   * prefers this over the positional `rawAnswers` keys.
   */
  answersByQuestionId?: Record<string, string | number>;
  exceededMaxViolations?: boolean;
  /** Canonical candidate id — ties the live proctor row to this submitted record. */
  proctorStudentId?: string;
  /** Every invigilator intervention (unlock, +time, pardon, force submit) in order. */
  invigilatorActions?: Array<{ id: string; type: string; detail: string; timestamp: string }>;
  /** Origin of the submission when recovered via air-gapped emergency file. */
  ingestionSource?: 'online' | 'emergency_offline';
  /** ISO timestamp when the teacher ingested the emergency package. */
  ingestedAt?: string;
  /** Reason recorded when triggered via mid-exam Emergency Save & Exit. */
  emergencyExitReason?: string;
  totalPenaltySeconds?: number;
  finalStrikeCount?: number;
  finalTierReached?: string;
  autoSubmittedBySecurity?: boolean;
  tierHistory?: SecurityTierEvent[];
}

export interface StudentSubmission {
  id: string;
  quizId: string;
  quizCode: string;
  quizTitle: string;
  subject: string;
  studentName: string;
  studentClass?: string;       // e.g. "10-A", "Year 11 Set 2", "IB Chem HL"
  candidateNumber?: string;    // e.g. "0012", "Seat 4"
  submittedAt: string;
  durationSeconds: number;
  score: number;
  totalMarks: number;
  percentage: number;
  violationsCount: number;
  proctoringLogs: ProctoringViolationEvent[];
  questionResults: QuestionSubmissionResult[];
  topicBreakdown: Record<string, { totalMarks: number; earnedMarks: number; percentage: number }>;
  teacherAdjustedMarks?: number; // Optional teacher manual mark override
  teacherNotes?: string;         // Optional teacher annotation / remark notes
  rawAnswers?: Record<string | number, string | number>;
  status?: SubmissionStatus;     // 'submitted' (pending) | 'grading' | 'graded' | 'published' (released)
  resultPin?: string;            // 3-digit personal PIN for secure result retrieval
  updatedAt?: string;            // Timestamp of latest grading or teacher adjustment
  forensics?: ExamForensics;     // Forensic audit telemetry (answer changes, dwell times, violation threshold)
}

const SUBMISSIONS_STORAGE_KEY = 'fluffykitten_quiz_submissions';
const DEVICE_RECEIPTS_KEY = 'fluffykitten_device_exam_receipts';

// In-memory cache for high-frequency operations (e.g. badge counters, dashboard stats)
let submissionsMemoryCache: StudentSubmission[] | null = null;

/**
 * Safely persists submissions to localStorage with multi-stage quota recovery.
 * Prevents browser crashes and unhandled QuotaExceededError when storing hundreds of student attempts.
 */
export function safeSaveSubmissionsToLocalStorage(submissions: StudentSubmission[]): void {
  // Always update in-memory cache first so current app session has immediate, full fidelity
  submissionsMemoryCache = submissions;
  try {
    localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(submissions));
  } catch (err: any) {
    console.warn('LocalStorage quota exceeded while saving submissions, attempting progressive pruning:', err);
    // Stage 1: Sort by most recent submission time first
    const sorted = [...submissions].sort(
      (a, b) => new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime()
    );
    // Try saving recent 100
    try {
      localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(sorted.slice(0, 100)));
      return;
    } catch (e1) {
      // Stage 2: Try saving recent 40 with heavy audit logs stripped for non-recent submissions
      try {
        const compacted = sorted.slice(0, 40).map((s, idx) => {
          if (idx < 10) return s; // Keep first 10 submissions fully detailed
          return {
            ...s,
            proctoringLogs: [],
            questionResults: (s.questionResults || []).map((qr) => ({
              questionId: qr.questionId,
              questionNumber: qr.questionNumber,
              topic: qr.topic,
              maxMarks: qr.maxMarks,
              earnedMarks: qr.earnedMarks,
              isCorrect: qr.isCorrect,
              studentAnswer: qr.studentAnswer,
              correctAnswer: qr.correctAnswer,
            })),
          };
        });
        localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(compacted));
      } catch (e2) {
        console.error('Critical: unable to save even compacted submissions to localStorage quota:', e2);
      }
    }
  }
}

export function getAllSubmissions(): StudentSubmission[] {
  if (submissionsMemoryCache !== null) {
    return submissionsMemoryCache;
  }
  try {
    const raw = localStorage.getItem(SUBMISSIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    submissionsMemoryCache = parsed;
    return parsed;
  } catch (err) {
    console.error('Failed to load submissions from localStorage:', err);
    return [];
  }
}

export function getSubmissionsForQuiz(quizId: string, quizCode?: string, _testId?: string): StudentSubmission[] {
  const all = getAllSubmissions();
  const cleanCode = quizCode ? quizCode.toUpperCase() : undefined;
  const cleanTestId = _testId ? _testId.toUpperCase() : undefined;

  return all.filter((s) => {
    const sQuizId = (s.quizId || '').toUpperCase();
    const sCode = (s.quizCode || '').toUpperCase();

    // 1. Primary strict match on quizId (matches published ID e.g. quiz_174...)
    if (s.quizId && s.quizId === quizId) {
      return true;
    }

    // 2. Underlying Test UUID match (if submitted with testId instead of publishedId)
    if (cleanTestId && (sQuizId === cleanTestId || sCode === cleanTestId)) {
      return true;
    }

    // 3. Quiz Code match (e.g. 6-character token)
    if (cleanCode && sCode === cleanCode) {
      return true;
    }

    return false;
  });
}

export function saveQuizSubmission(submission: StudentSubmission): void {
  try {
    const existing = getAllSubmissions();
    const filtered = existing.filter((s) => s.id !== submission.id);
    const updated = [submission, ...filtered];
    safeSaveSubmissionsToLocalStorage(updated);
  } catch (err) {
    console.error('Failed to save quiz submission:', err);
  }
}

/**
 * Fetches all submissions backed up in app_config key-value store.
 */
export async function fetchSubmissionsFromAppConfig(): Promise<StudentSubmission[]> {
  try {
    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', 'quiz_submissions')
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value) {
      const parsed = JSON.parse(data.value);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('Could not fetch submissions from app_config:', err);
  }
  return [];
}

/**
 * Backs up submissions list to app_config key-value store.
 */
export async function syncSubmissionsToAppConfig(submissions: StudentSubmission[]): Promise<boolean> {
  try {
    // Cap fallback backup to the 200 most recent submissions to prevent unbounded growth and row size limit errors
    const recentSubmissions = [...submissions]
      .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime())
      .slice(0, 200);
      
    const { error } = await (supabase.from('app_config' as any) as any)
      .upsert({
        key: 'quiz_submissions',
        value: JSON.stringify(recentSubmissions),
      });
    if (error) {
      console.warn('app_config submissions sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('app_config sync error:', err);
    return false;
  }
}

/**
 * Saves or updates submission both locally and asynchronously in Supabase cloud (dual-tier table + app_config).
 */
export async function saveQuizSubmissionCloud(submission: StudentSubmission): Promise<boolean> {
  // 1. Always save to local storage immediately
  saveQuizSubmission(submission);
  saveToSubmissionOutbox(submission, 'pending');
  window.dispatchEvent(new Event('submissions_updated'));

  let tableSuccess = false;

  // 2. Upsert to Supabase dedicated table
  try {
    const row = {
      id: submission.id,
      quiz_id: submission.quizId,
      quiz_code: submission.quizCode.toUpperCase(),
      quiz_title: submission.quizTitle,
      subject: submission.subject,
      student_name: submission.studentName,
      student_class: submission.studentClass,
      candidate_number: submission.candidateNumber,
      submitted_at: submission.submittedAt,
      duration_seconds: submission.durationSeconds,
      score: submission.score,
      total_marks: submission.totalMarks,
      percentage: submission.percentage,
      violations_count: submission.violationsCount,
      proctoring_logs: submission.proctoringLogs,
      raw_answers: {
        ...(submission.rawAnswers || {}),
        ...(submission.forensics ? { _forensics: submission.forensics } : {}),
      },
      question_results: submission.questionResults,
      topic_breakdown: submission.topicBreakdown,
      status: submission.status || 'submitted',
      teacher_adjusted_marks: submission.teacherAdjustedMarks || 0,
      teacher_notes: submission.teacherNotes || '',
      result_pin: submission.resultPin || '',
      updated_at: new Date().toISOString(),
    };

    const { error } = await (supabase.from('quiz_submissions' as any) as any).upsert(row);

    if (!error) {
      tableSuccess = true;
      markOutboxSynced(submission.id);
    } else {
      console.warn('Could not sync submission to Supabase table:', error.message);
    }
  } catch (err) {
    console.warn('Error pushing submission to Supabase table:', err);
  }

  // 3. Only use the app_config mirror when the primary table write failed. The
  // mirror is a read-modify-write of one shared JSON blob, so doing it on every
  // successful submit made concurrent end-of-exam papers overwrite each other.
  if (!tableSuccess) {
    try {
      const cloudAppConfigList = await fetchSubmissionsFromAppConfig();
      const mergedMap = new Map<string, StudentSubmission>();
      cloudAppConfigList.forEach((s) => mergedMap.set(s.id, s));
      mergedMap.set(submission.id, submission);
      await syncSubmissionsToAppConfig(Array.from(mergedMap.values()));
    } catch (err) {
      console.warn('Could not mirror submission to app_config:', err);
    }
  }

  return tableSuccess;
}

/**
 * Saves a submission with verified exponential-backoff retries.
 * Returns detailed attempt and success verification information.
 */
export async function saveQuizSubmissionWithVerification(
  submission: StudentSubmission,
  maxRetries: number = 3,
  onAttempt?: (attempt: number, total: number) => void
): Promise<{ success: boolean; attempts: number; error?: string }> {
  // Always save locally immediately
  saveQuizSubmission(submission);
  saveToSubmissionOutbox(submission, 'pending');
  window.dispatchEvent(new Event('submissions_updated'));

  let lastErr = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (onAttempt) onAttempt(attempt, maxRetries);
    try {
      const success = await saveQuizSubmissionCloud(submission);
      if (success) {
        markOutboxSynced(submission.id);
        return { success: true, attempts: attempt };
      }
      lastErr = 'Cloud database returned non-success response';
    } catch (err: any) {
      lastErr = err?.message || 'Network error during cloud save';
    }

    // Wait with exponential backoff (e.g. 500ms, 1200ms, 2000ms)
    if (attempt < maxRetries) {
      await new Promise((res) => setTimeout(res, 400 * Math.pow(1.8, attempt - 1)));
    }
  }

  saveToSubmissionOutbox(submission, 'failed', lastErr);
  return { success: false, attempts: maxRetries, error: lastErr };
}

/**
 * Saves a batch of submissions both locally and asynchronously in Supabase cloud (dual-tier table + app_config).
 */
export async function saveBatchQuizSubmissionsCloud(submissions: StudentSubmission[]): Promise<boolean> {
  if (submissions.length === 0) return true;

  // 1. Save all to local storage immediately
  try {
    const existing = getAllSubmissions();
    const subIds = new Set(submissions.map((s) => s.id));
    const filtered = existing.filter((s) => !subIds.has(s.id));
    const updated = [...submissions, ...filtered];
    safeSaveSubmissionsToLocalStorage(updated);
    window.dispatchEvent(new Event('submissions_updated'));
  } catch (err) {
    console.error('Failed to batch save submissions locally:', err);
  }

  let tableSuccess = false;

  // 2. Batch upsert to Supabase dedicated table
  try {
    const rows = submissions.map((submission) => ({
      id: submission.id,
      quiz_id: submission.quizId,
      quiz_code: submission.quizCode.toUpperCase(),
      quiz_title: submission.quizTitle,
      subject: submission.subject,
      student_name: submission.studentName,
      student_class: submission.studentClass,
      candidate_number: submission.candidateNumber,
      submitted_at: submission.submittedAt,
      duration_seconds: submission.durationSeconds,
      score: submission.score,
      total_marks: submission.totalMarks,
      percentage: submission.percentage,
      violations_count: submission.violationsCount,
      proctoring_logs: submission.proctoringLogs,
      raw_answers: {
        ...(submission.rawAnswers || {}),
        ...(submission.forensics ? { _forensics: submission.forensics } : {}),
      },
      question_results: submission.questionResults,
      topic_breakdown: submission.topicBreakdown,
      status: submission.status || 'submitted',
      teacher_adjusted_marks: submission.teacherAdjustedMarks || 0,
      teacher_notes: submission.teacherNotes || '',
      result_pin: submission.resultPin || '',
      updated_at: new Date().toISOString(),
    }));

    const { error } = await (supabase.from('quiz_submissions' as any) as any).upsert(rows);

    if (!error) {
      tableSuccess = true;
    } else {
      console.warn('Could not batch sync submissions to quiz_submissions table:', error.message);
    }
  } catch (err) {
    console.warn('Error batch pushing submissions to quiz_submissions table:', err);
  }

  // 3. Dual-tier cloud backup: Always sync to app_config to ensure results survive between localhost and Netlify
  try {
    const cloudAppConfigList = await fetchSubmissionsFromAppConfig();
    const mergedMap = new Map<string, StudentSubmission>();
    cloudAppConfigList.forEach((s) => mergedMap.set(s.id, s));
    submissions.forEach((s) => mergedMap.set(s.id, s));
    const mergedList = Array.from(mergedMap.values());
    await syncSubmissionsToAppConfig(mergedList);
  } catch (err) {
    console.warn('Could not backup submissions to app_config:', err);
  }

  return tableSuccess;
}

export async function updateSubmission(submission: StudentSubmission): Promise<boolean> {
  return await saveQuizSubmissionCloud(submission);
}

export async function deleteSubmission(id: string): Promise<void> {
  try {
    const existing = getAllSubmissions();
    const updated = existing.filter((s) => s.id !== id);
    safeSaveSubmissionsToLocalStorage(updated);
  } catch (err) {
    console.error('Failed to delete submission from localStorage:', err);
  }

  try {
    const { error } = await (supabase.from('quiz_submissions' as any) as any)
      .delete()
      .eq('id', id);
    if (error) console.warn('Could not delete from table:', error.message);
  } catch (err) {
    console.warn('Cloud delete error:', err);
  }

  try {
    const appConfigSubs = await fetchSubmissionsFromAppConfig();
    const updatedAppConfig = appConfigSubs.filter((s) => s.id !== id);
    await syncSubmissionsToAppConfig(updatedAppConfig);
  } catch {}

  window.dispatchEvent(new Event('submissions_updated'));
}

export async function clearSubmissionsForQuiz(quizId: string, quizCode?: string): Promise<void> {
  const cleanCode = quizCode ? quizCode.toUpperCase() : undefined;
  try {
    const existing = getAllSubmissions();
    const updated = existing.filter((s) => s.quizId !== quizId && (!cleanCode || s.quizCode.toUpperCase() !== cleanCode));
    safeSaveSubmissionsToLocalStorage(updated);
  } catch (err) {
    console.error('Failed to clear submissions from localStorage:', err);
  }

  try {
    let q = (supabase.from('quiz_submissions' as any) as any).delete();
    if (cleanCode) {
      q = q.or(`quiz_id.eq.${quizId},quiz_code.eq.${cleanCode}`);
    } else {
      q = q.eq('quiz_id', quizId);
    }
    const { error } = await q;
    if (error) console.warn('Could not clear from table:', error.message);
  } catch (err) {
    console.warn('Cloud clear error:', err);
  }

  try {
    const appConfigSubs = await fetchSubmissionsFromAppConfig();
    const updatedAppConfig = appConfigSubs.filter(
      (s) => s.quizId !== quizId && (!cleanCode || s.quizCode.toUpperCase() !== cleanCode)
    );
    await syncSubmissionsToAppConfig(updatedAppConfig);
  } catch {}

  window.dispatchEvent(new Event('submissions_updated'));
}

/**
 * Fetches all student submissions across all quizzes from Supabase cloud (table or app_config).
 */
export async function fetchAllSubmissionsFromSupabase(): Promise<StudentSubmission[]> {
  try {
    // 1. Try dedicated table first
    const { data, error } = await (supabase.from('quiz_submissions' as any) as any)
      .select('*')
      .order('submitted_at', { ascending: false });

    if (!error && Array.isArray(data) && data.length > 0) {
      return data.map((row: any) => {
        const rawAnswers = row.raw_answers ? { ...row.raw_answers } : {};
        const forensics = (row as any).forensics || (rawAnswers as any)._forensics || undefined;
        delete (rawAnswers as any)._forensics;

        return {
          id: row.id,
          quizId: row.quiz_id,
          quizCode: row.quiz_code,
          quizTitle: row.quiz_title,
          subject: row.subject,
          studentName: row.student_name,
          studentClass: row.student_class,
          candidateNumber: row.candidate_number,
          submittedAt: row.submitted_at,
          durationSeconds: row.duration_seconds,
          score: Number(row.score) || 0,
          totalMarks: Number(row.total_marks) || 0,
          percentage: Number(row.percentage) || 0,
          violationsCount: Number(row.violations_count) || 0,
          proctoringLogs: row.proctoring_logs || [],
          rawAnswers,
          questionResults: row.question_results || [],
          topicBreakdown: row.topic_breakdown || {},
          status: (row.status as SubmissionStatus) || 'submitted',
          teacherAdjustedMarks: Number(row.teacher_adjusted_marks) || 0,
          teacherNotes: row.teacher_notes || '',
          resultPin: row.result_pin || '',
          updatedAt: row.updated_at || row.submitted_at,
          forensics,
        };
      });
    }
  } catch (err) {
    console.warn('Could not fetch from quiz_submissions table, trying app_config:', err);
  }

  // 2. Fallback to app_config
  return await fetchSubmissionsFromAppConfig();
}

/**
 * Loads all submissions from local storage, merges with Supabase Cloud,
 * syncs any local-only submissions back to the cloud, and updates localStorage.
 */
export async function loadAndSyncAllSubmissions(): Promise<StudentSubmission[]> {
  const localList = getAllSubmissions();

  try {
    const cloudList = await fetchAllSubmissionsFromSupabase();

    const mergedMap = new Map<string, StudentSubmission>();

    // 1. Cloud submissions
    cloudList.forEach((s) => mergedMap.set(s.id, s));

    // 2. Local submissions - preserve newer/exclusive
    let hasLocalExclusiveOrNewer = false;
    localList.forEach((localS) => {
      const existing = mergedMap.get(localS.id);
      if (!existing) {
        mergedMap.set(localS.id, localS);
        hasLocalExclusiveOrNewer = true;
      } else {
        const localTime = new Date(localS.updatedAt || localS.submittedAt || 0).getTime();
        const cloudTime = new Date(existing.updatedAt || existing.submittedAt || 0).getTime();
        
        // Prioritize graded / published evaluation over provisional un-analyzed 'submitted'
        const isCloudGraded = existing.status === 'graded' || existing.status === 'published';
        const isLocalGraded = localS.status === 'graded' || localS.status === 'published';

        if (isCloudGraded && !isLocalGraded) {
          mergedMap.set(localS.id, existing);
        } else if (isLocalGraded && !isCloudGraded) {
          mergedMap.set(localS.id, localS);
          hasLocalExclusiveOrNewer = true;
        } else if (localTime > cloudTime) {
          mergedMap.set(localS.id, localS);
          hasLocalExclusiveOrNewer = true;
        } else {
          mergedMap.set(localS.id, existing);
        }
      }
    });

    const merged = Array.from(mergedMap.values());

    // 3. Update localStorage safely
    safeSaveSubmissionsToLocalStorage(merged);
    window.dispatchEvent(new Event('submissions_updated'));

    // 4. If local had items not yet in cloud (e.g. graded on localhost), sync to cloud
    if (hasLocalExclusiveOrNewer || cloudList.length < merged.length) {
      await saveBatchQuizSubmissionsCloud(merged);
    }

    return merged;
  } catch (err) {
    console.warn('Could not sync submissions with cloud, using local cache:', err);
    return localList;
  }
}

/**
 * Fetches all student submissions for a specific quiz from Supabase (with table + app_config fallback),
 * merging with local storage. Supports resilient matching across published ID, Quiz Code, and underlying Test UUID.
 */
export async function fetchSubmissionsFromSupabase(
  quizId: string,
  quizCode?: string,
  testId?: string
): Promise<StudentSubmission[]> {
  const cleanCode = quizCode ? quizCode.toUpperCase() : undefined;
  const cleanTestId = testId ? testId.toUpperCase() : undefined;

  try {
    let query = (supabase.from('quiz_submissions' as any) as any)
      .select('*')
      .order('submitted_at', { ascending: false });

    const conditions: string[] = [`quiz_id.eq.${quizId}`];
    if (cleanCode) conditions.push(`quiz_code.eq.${cleanCode}`);
    if (cleanTestId) {
      conditions.push(`quiz_id.eq.${cleanTestId}`);
      conditions.push(`quiz_code.eq.${cleanTestId}`);
    }

    if (conditions.length > 1) {
      query = query.or(conditions.join(','));
    } else {
      query = query.eq('quiz_id', quizId);
    }

    const { data, error } = await query;
    if (!error && Array.isArray(data) && data.length > 0) {
      const cloudSubs: StudentSubmission[] = data.map((row: any) => {
        const rawAnswers = row.raw_answers ? { ...row.raw_answers } : {};
        const forensics = (row as any).forensics || (rawAnswers as any)._forensics || undefined;
        delete (rawAnswers as any)._forensics;

        return {
          id: row.id,
          quizId: row.quiz_id,
          quizCode: row.quiz_code,
          quizTitle: row.quiz_title,
          subject: row.subject,
          studentName: row.student_name,
          studentClass: row.student_class,
          candidateNumber: row.candidate_number,
          submittedAt: row.submitted_at,
          durationSeconds: row.duration_seconds,
          score: Number(row.score) || 0,
          totalMarks: Number(row.total_marks) || 0,
          percentage: Number(row.percentage) || 0,
          violationsCount: Number(row.violations_count) || 0,
          proctoringLogs: row.proctoring_logs || [],
          rawAnswers,
          questionResults: row.question_results || [],
          topicBreakdown: row.topic_breakdown || {},
          status: (row.status as SubmissionStatus) || 'submitted',
          teacherAdjustedMarks: Number(row.teacher_adjusted_marks) || 0,
          teacherNotes: row.teacher_notes || '',
          resultPin: row.result_pin || '',
          updatedAt: row.updated_at || row.submitted_at,
          forensics,
        };
      });

      // Merge with local storage
      const local = getSubmissionsForQuiz(quizId, quizCode, testId);
      const map = new Map<string, StudentSubmission>();
      cloudSubs.forEach((s) => map.set(s.id, s));
      local.forEach((s) => {
        if (!map.has(s.id)) map.set(s.id, s);
      });

      const merged = Array.from(map.values());
      try {
        const allLocal = getAllSubmissions().filter((s) => {
          const sQuizId = (s.quizId || '').toUpperCase();
          const sCode = (s.quizCode || '').toUpperCase();
          const matchPubId = s.quizId === quizId;
          const matchCode = cleanCode && sCode === cleanCode;
          const matchTestId = cleanTestId && (sQuizId === cleanTestId || sCode === cleanTestId);
          return !matchPubId && !matchCode && !matchTestId;
        });
        safeSaveSubmissionsToLocalStorage([...merged, ...allLocal]);
      } catch {}

      return merged;
    }
  } catch (err) {
    console.warn('Could not fetch cloud submissions from table:', err);
  }

  // Fallback to app_config if table returned no results or errored
  try {
    const appConfigSubs = await fetchSubmissionsFromAppConfig();
    const matching = appConfigSubs.filter((s) => {
      const sQuizId = (s.quizId || '').toUpperCase();
      const sCode = (s.quizCode || '').toUpperCase();
      return (
        s.quizId === quizId ||
        (cleanCode && sCode === cleanCode) ||
        (cleanTestId && (sQuizId === cleanTestId || sCode === cleanTestId))
      );
    });

    if (matching.length > 0) {
      const local = getSubmissionsForQuiz(quizId, quizCode, testId);
      const map = new Map<string, StudentSubmission>();
      matching.forEach((s) => map.set(s.id, s));
      local.forEach((s) => {
        if (!map.has(s.id)) map.set(s.id, s);
      });
      const merged = Array.from(map.values());
      try {
        const allLocal = getAllSubmissions().filter((s) => {
          const sQuizId = (s.quizId || '').toUpperCase();
          const sCode = (s.quizCode || '').toUpperCase();
          const matchPubId = s.quizId === quizId;
          const matchCode = cleanCode && sCode === cleanCode;
          const matchTestId = cleanTestId && (sQuizId === cleanTestId || sCode === cleanTestId);
          return !matchPubId && !matchCode && !matchTestId;
        });
        safeSaveSubmissionsToLocalStorage([...merged, ...allLocal]);
      } catch {}
      return merged;
    }
  } catch (err) {
    console.warn('Could not fetch cloud submissions from app_config:', err);
  }

  return getSubmissionsForQuiz(quizId, quizCode, testId);
}

/**
 * Maps a `quiz_submissions` row (client-shaped JSON) to the app's submission type.
 */
function mapRowToSubmission(row: any): StudentSubmission {
  const rawAnswers = row.raw_answers ? { ...row.raw_answers } : {};
  const forensics = (row as any).forensics || rawAnswers._forensics || undefined;
  delete rawAnswers._forensics;

  return {
    id: row.id,
    quizId: row.quiz_id,
    quizCode: row.quiz_code,
    quizTitle: row.quiz_title,
    subject: row.subject,
    studentName: row.student_name,
    studentClass: row.student_class,
    candidateNumber: row.candidate_number,
    submittedAt: row.submitted_at,
    durationSeconds: row.duration_seconds,
    score: Number(row.score) || 0,
    totalMarks: Number(row.total_marks) || 0,
    percentage: Number(row.percentage) || 0,
    violationsCount: Number(row.violations_count) || 0,
    proctoringLogs: row.proctoring_logs || [],
    rawAnswers,
    questionResults: row.question_results || [],
    topicBreakdown: row.topic_breakdown || {},
    status: (row.status as SubmissionStatus) || 'submitted',
    teacherAdjustedMarks: Number(row.teacher_adjusted_marks) || 0,
    teacherNotes: row.teacher_notes || '',
    resultPin: row.result_pin || '',
    updatedAt: row.updated_at || row.submitted_at,
    forensics,
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Searches for a student's submissions across cloud and local storage.
 * Requires Quiz Code + exact Name (or Candidate Number) + 3-digit PIN for privacy.
 *
 * The scoped `lookup_student_exam_result` RPC is authoritative. The legacy
 * fallback queries only this candidate's rows, never the whole cohort, and the
 * last resort is local storage — a student browser must not download the school's
 * submissions just to open a result receipt.
 */
export async function fetchStudentResultsCloud(
  quizCode: string,
  identifier: string,
  pin?: string
): Promise<{ submissions: StudentSubmission[]; hasUnreleased: boolean; pinMismatch?: boolean }> {
  const cleanCode = quizCode.trim().toUpperCase();
  const cleanQuery = identifier.trim();
  const cleanId = normalizeIdentityPart(identifier);
  const cleanPin = (pin || '').trim();

  // 1. Scoped server-side lookup (migration 019). Falls through if not deployed.
  try {
    const { data, error } = await (supabase as any).rpc('lookup_student_exam_result', {
      p_quiz_code: cleanCode,
      p_student_query: cleanQuery,
      p_result_pin: cleanPin,
    });

    if (!error && data && typeof data === 'object') {
      if (data.status === 'pin_mismatch') {
        return { submissions: [], hasUnreleased: false, pinMismatch: true };
      }
      const rows = Array.isArray(data.submissions) ? data.submissions : [];
      return {
        submissions: rows.map(mapRowToSubmission),
        hasUnreleased: data.hasUnreleased === true,
      };
    }
  } catch (err) {
    console.warn('Scoped result RPC unavailable, using scoped table fallback:', err);
  }

  // 2. Legacy fallback: fetch only this candidate's rows (never the cohort).
  try {
    const escaped = escapeLikePattern(cleanQuery);
    const [nameRes, numberRes] = await Promise.all([
      (supabase.from('quiz_submissions' as any) as any)
        .select('*')
        .eq('quiz_code', cleanCode)
        .ilike('student_name', escaped)
        .limit(20),
      (supabase.from('quiz_submissions' as any) as any)
        .select('*')
        .eq('quiz_code', cleanCode)
        .ilike('candidate_number', escaped)
        .limit(20),
    ]);

    const byId = new Map<string, any>();
    for (const res of [nameRes, numberRes]) {
      if (!res?.error && Array.isArray(res.data)) {
        res.data.forEach((row: any) => byId.set(row.id, row));
      }
    }

    if (byId.size > 0) {
      const matchingRows = Array.from(byId.values());
      const storedPin = String(matchingRows[0].result_pin || '').trim();
      if (storedPin && cleanPin !== storedPin) {
        return { submissions: [], hasUnreleased: false, pinMismatch: true };
      }

      const published: StudentSubmission[] = [];
      let hasUnreleased = false;
      matchingRows.forEach((row) => {
        const sub = mapRowToSubmission(row);
        if (sub.status === 'published') published.push(sub);
        else hasUnreleased = true;
      });
      return { submissions: published, hasUnreleased };
    }
  } catch (err) {
    console.warn('Table fetch error for student results:', err);
  }

  // 3. Local-only fallback. No network, no school-wide download.
  try {
    const matching = getAllSubmissions().filter((s) => {
      const codeMatch = s.quizCode.trim().toUpperCase() === cleanCode;
      const sName = normalizeIdentityPart(s.studentName);
      const cNum = normalizeIdentityPart(s.candidateNumber);
      return codeMatch && (sName === cleanId || cNum === cleanId);
    });

    if (matching.length === 0) {
      return { submissions: [], hasUnreleased: false };
    }

    const storedPin = (matching[0].resultPin || '').trim();
    if (storedPin && cleanPin !== storedPin) {
      return { submissions: [], hasUnreleased: false, pinMismatch: true };
    }

    const published = matching.filter((s) => s.status === 'published');
    const hasUnreleased = matching.some((s) => s.status !== 'published');

    return { submissions: published, hasUnreleased };
  } catch (err) {
    console.warn('Fallback error fetching student results:', err);
    return { submissions: [], hasUnreleased: false };
  }
}

/**
 * Updates submission status across all attempts of a quiz (e.g. releasing marks to students)
 */
export async function setQuizSubmissionsStatus(
  quizId: string,
  quizCode: string,
  newStatus: SubmissionStatus
): Promise<boolean> {
  try {
    const { error } = await (supabase.from('quiz_submissions' as any) as any)
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .or(`quiz_id.eq.${quizId},quiz_code.eq.${quizCode.toUpperCase()}`);

    if (error) {
      console.warn('Could not update status in cloud:', error.message);
    }
  } catch (err) {
    console.warn('Error updating status in cloud:', err);
  }

  // Update local storage
  try {
    const all = getAllSubmissions().map((s) => {
      if (s.quizId === quizId || s.quizCode.toUpperCase() === quizCode.toUpperCase()) {
        return { ...s, status: newStatus };
      }
      return s;
    });
    safeSaveSubmissionsToLocalStorage(all);
  } catch {}

  return true;
}

// ─── Local Device Exam Receipts (Zero-Typing Experience) ─────────────────────

export function saveDeviceReceipt(receipt: DeviceExamReceipt): void {
  try {
    const existing = getDeviceReceipts();
    const filtered = existing.filter(
      (r) =>
        !(
          r.quizCode.toUpperCase() === receipt.quizCode.toUpperCase() &&
          r.studentName.toLowerCase() === receipt.studentName.toLowerCase()
        )
    );
    const updated = [receipt, ...filtered].slice(0, 6);
    localStorage.setItem(DEVICE_RECEIPTS_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn('Could not save device exam receipt:', e);
  }
}

export function getDeviceReceipts(): DeviceExamReceipt[] {
  try {
    const raw = localStorage.getItem(DEVICE_RECEIPTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function removeDeviceReceipt(quizCode: string): void {
  try {
    const existing = getDeviceReceipts();
    const filtered = existing.filter((r) => r.quizCode.toUpperCase() !== quizCode.toUpperCase());
    localStorage.setItem(DEVICE_RECEIPTS_KEY, JSON.stringify(filtered));
  } catch {}
}

/**
 * Safely formats any timestamp (ISO string, unix ms, or pre-formatted string) without returning 'Invalid Date'.
 */
export function formatProctorTimestamp(timestamp: string | number | undefined | null): string {
  if (!timestamp) return '-';
  const str = String(timestamp).trim();
  if (!str) return '-';
  
  // If it's already a clean formatted time string (like "16:25:31" or "4:25:31 PM"), return it directly
  if (/^\d{1,2}:\d{2}(:\d{2})?(\s?[APap][Mm])?$/.test(str)) {
    return str;
  }

  const d = new Date(timestamp);
  if (!isNaN(d.getTime())) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  return str;
}

/**
 * Safely formats date & time string without returning 'Invalid Date'.
 */
export function formatSubmissionDateTime(dateVal: string | number | undefined | null): string {
  if (!dateVal) return '-';
  const d = new Date(dateVal);
  if (!isNaN(d.getTime())) {
    return d.toLocaleString();
  }
  return String(dateVal);
}

/**
 * Exports comprehensive class gradebook and item analysis to Excel (.xlsx)
 */
export async function exportAllSubmissionsExcel(
  quizTitle: string,
  quizCode: string,
  totalMarks: number,
  submissions: StudentSubmission[],
  options?: {
    subject?: string;
    targetClass?: string;
    schoolName?: string;
    gradeThresholds?: import('../utils/gradeThresholdUtils').GradeThresholds;
  }
): Promise<void> {
  return exportAllSubmissionsExcelICM(quizTitle, quizCode, totalMarks, submissions, options);
}

/**
 * Exports an individual student's detailed response report to Excel (.xlsx)
 * with official Sekolah Insan Cendekia Madani (ICM) branding, model keys,
 * and psychometric diagnostics.
 */
export async function exportSingleSubmissionExcel(
  submission: StudentSubmission,
  options?: { gradeThresholds?: import('../utils/gradeThresholdUtils').GradeThresholds }
): Promise<void> {
  return exportSingleSubmissionExcelICM(submission, options);
}
