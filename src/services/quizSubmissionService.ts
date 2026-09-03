// ─── Quiz Submission Service ──────────────────────────────────────────────────
// Stores and tracks student quiz attempts, responses, scores, and proctoring audit logs.
// Supports Excel (.xlsx) exports for individual candidates and class-wide gradebooks.

import * as XLSX from 'xlsx';
import { exportFileUniversal } from './fileExportBridge';
import { supabase } from '../lib/supabase';

export type SubmissionStatus = 'submitted' | 'grading' | 'graded' | 'published';

export interface SubmissionOutboxItem {
  submission: StudentSubmission;
  status: 'pending' | 'synced' | 'failed';
  queuedAt: string;
  retryCount: number;
  lastError?: string;
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
    const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('Failed to load submission outbox:', err);
    return [];
  }
}

/**
 * Retrieves only pending (un-synced) outbox submissions.
 */
export function getPendingOutboxSubmissions(): SubmissionOutboxItem[] {
  return getSubmissionOutbox().filter((item) => item.status === 'pending');
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
    const outbox = getSubmissionOutbox();
    const existingIdx = outbox.findIndex((item) => item.submission.id === submission.id);
    if (existingIdx >= 0) {
      outbox[existingIdx] = {
        submission,
        status,
        queuedAt: outbox[existingIdx].queuedAt || new Date().toISOString(),
        retryCount: (outbox[existingIdx].retryCount || 0) + 1,
        lastError: lastError || outbox[existingIdx].lastError,
      };
    } else {
      outbox.unshift({
        submission,
        status,
        queuedAt: new Date().toISOString(),
        retryCount: 0,
        lastError,
      });
    }
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(outbox));
  } catch (err) {
    console.warn('Could not save to submission outbox:', err);
  }
}

/**
 * Marks a submission as verified synced in the outbox.
 */
export function markOutboxSynced(submissionId: string): void {
  try {
    const outbox = getSubmissionOutbox();
    const updated = outbox.map((item) =>
      item.submission.id === submissionId ? { ...item, status: 'synced' as const, lastError: undefined } : item
    );
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(updated));
  } catch (err) {
    console.warn('Could not mark outbox item synced:', err);
  }
}

/**
 * Exports a student submission to a signed, downloadable .exam JSON file for emergency offline backups.
 */
export function exportSubmissionToFile(submission: StudentSubmission): void {
  try {
    const payload = {
      _format: 'fluffykitten_exam_v1',
      exportedAt: new Date().toISOString(),
      submission,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const cleanStudent = (submission.studentName || 'candidate').replace(/[^a-zA-Z0-9_-]/g, '_');
    const cleanCode = (submission.quizCode || 'EXAM').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${cleanCode}_${cleanStudent}_exam_backup.exam`;

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Failed to export submission file:', err);
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

/**
 * Decodes, validates, and imports a student submission from a token string or JSON string.
 */
export async function importSubmissionToken(
  tokenOrJson: string
): Promise<{ success: boolean; submission?: StudentSubmission; error?: string }> {
  try {
    const raw = tokenOrJson.trim();
    if (!raw) return { success: false, error: 'Empty token input' };

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
      const parsed = JSON.parse(raw);
      parsedSub = parsed.submission || parsed;
    }

    if (!parsedSub || !parsedSub.id || !parsedSub.studentName || !parsedSub.quizCode) {
      return { success: false, error: 'Invalid exam token structure. Missing required student identifiers.' };
    }

    // Save locally and push to cloud
    saveQuizSubmission(parsedSub);
    markOutboxSynced(parsedSub.id);
    await saveQuizSubmissionCloud(parsedSub);
    window.dispatchEvent(new Event('submissions_updated'));

    return { success: true, submission: parsedSub };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to decode exam token' };
  }
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
  clean = clean.replace(/^Option\s+([A-D]):\s+[A-D][\.\)\s:-]+\s*/i, 'Option $1: ');
  if (oIdx !== undefined && oIdx >= 0 && oIdx < 26) {
    const letter = String.fromCharCode(65 + oIdx);
    clean = clean.replace(new RegExp(`^\\s*(\\(${letter}\\)|${letter}[\\.\\)\\:\\s\\-]+)\\s*`, 'i'), '');
  } else {
    // Strip standalone leading "A ", "A. ", "A) ", "(A) ", "A: "
    clean = clean.replace(/^[([]?[A-Da-d][)\]\.:\s-]+\s*/, '');
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
  str = str.replace(/^Option\s+([A-D]):\s+[A-D][\.\)\s:-]+\s*/i, 'Option $1: ');

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
  const isMcq = gradingMethod === 'mcq' || (options && options.length > 0) || (isNumericIndex && num <= 3);

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

  // If ans is a single letter like "A", "B", "C", "D"
  if (str.length === 1 && str.toUpperCase() >= 'A' && str.toUpperCase() <= 'Z' && (isMcq || str.toUpperCase() <= 'D')) {
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
}

const SUBMISSIONS_STORAGE_KEY = 'fluffykitten_quiz_submissions';
const DEVICE_RECEIPTS_KEY = 'fluffykitten_device_exam_receipts';

export function getAllSubmissions(): StudentSubmission[] {
  try {
    const raw = localStorage.getItem(SUBMISSIONS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('Failed to load submissions from localStorage:', err);
    return [];
  }
}

export function getSubmissionsForQuiz(quizId: string, quizCode?: string, testId?: string): StudentSubmission[] {
  const all = getAllSubmissions();
  const cleanCode = quizCode ? quizCode.toUpperCase() : undefined;
  const cleanTestId = testId ? testId.toUpperCase() : undefined;

  return all.filter((s) => {
    const sQuizId = (s.quizId || '').toUpperCase();
    const sCode = (s.quizCode || '').toUpperCase();
    return (
      s.quizId === quizId ||
      (cleanCode && sCode === cleanCode) ||
      (cleanTestId && (sQuizId === cleanTestId || sCode === cleanTestId))
    );
  });
}

export function saveQuizSubmission(submission: StudentSubmission): void {
  try {
    const existing = getAllSubmissions();
    const filtered = existing.filter((s) => s.id !== submission.id);
    const updated = [submission, ...filtered];
    localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(updated));
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
    const { error } = await (supabase.from('app_config' as any) as any)
      .upsert({
        key: 'quiz_submissions',
        value: JSON.stringify(submissions),
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
      raw_answers: submission.rawAnswers || {},
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

  // 3. Always mirror to app_config key-value store for resilience
  try {
    const cloudAppConfigList = await fetchSubmissionsFromAppConfig();
    const mergedMap = new Map<string, StudentSubmission>();
    cloudAppConfigList.forEach((s) => mergedMap.set(s.id, s));
    mergedMap.set(submission.id, submission);
    const appConfigSuccess = await syncSubmissionsToAppConfig(Array.from(mergedMap.values()));
    if (appConfigSuccess && !tableSuccess) {
      markOutboxSynced(submission.id);
    }
  } catch (err) {
    console.warn('Could not mirror submission to app_config:', err);
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
    localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(updated));
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
      raw_answers: submission.rawAnswers || {},
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
    localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(updated));
    window.dispatchEvent(new Event('submissions_updated'));
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
}

export async function clearSubmissionsForQuiz(quizId: string, quizCode?: string): Promise<void> {
  const cleanCode = quizCode ? quizCode.toUpperCase() : undefined;
  try {
    const existing = getAllSubmissions();
    const updated = existing.filter((s) => s.quizId !== quizId && (!cleanCode || s.quizCode.toUpperCase() !== cleanCode));
    localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(updated));
    window.dispatchEvent(new Event('submissions_updated'));
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
      return data.map((row: any) => ({
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
        rawAnswers: row.raw_answers || {},
        questionResults: row.question_results || [],
        topicBreakdown: row.topic_breakdown || {},
        status: (row.status as SubmissionStatus) || 'submitted',
        teacherAdjustedMarks: Number(row.teacher_adjusted_marks) || 0,
        teacherNotes: row.teacher_notes || '',
        resultPin: row.result_pin || '',
        updatedAt: row.updated_at || row.submitted_at,
      }));
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

    // 3. Update localStorage
    localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(merged));
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
      const cloudSubs: StudentSubmission[] = data.map((row: any) => ({
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
        rawAnswers: row.raw_answers || {},
        questionResults: row.question_results || [],
        topicBreakdown: row.topic_breakdown || {},
        status: (row.status as SubmissionStatus) || 'submitted',
        teacherAdjustedMarks: Number(row.teacher_adjusted_marks) || 0,
        teacherNotes: row.teacher_notes || '',
        resultPin: row.result_pin || '',
        updatedAt: row.updated_at || row.submitted_at,
      }));

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
        localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify([...merged, ...allLocal]));
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
        localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify([...merged, ...allLocal]));
      } catch {}
      return merged;
    }
  } catch (err) {
    console.warn('Could not fetch cloud submissions from app_config:', err);
  }

  return getSubmissionsForQuiz(quizId, quizCode, testId);
}

/**
 * Searches for a student's submissions across cloud and local storage.
 * Requires Quiz Code + exact Name (or Candidate Number) + 3-digit PIN for privacy.
 */
export async function fetchStudentResultsCloud(
  quizCode: string,
  identifier: string,
  pin?: string
): Promise<{ submissions: StudentSubmission[]; hasUnreleased: boolean; pinMismatch?: boolean }> {
  const cleanCode = quizCode.trim().toUpperCase();
  const cleanId = identifier.trim().toLowerCase();
  const cleanPin = (pin || '').trim();

  // 1. Try quiz_submissions table
  try {
    const { data, error } = await (supabase.from('quiz_submissions' as any) as any)
      .select('*')
      .eq('quiz_code', cleanCode)
      .order('submitted_at', { ascending: false });

    if (!error && Array.isArray(data) && data.length > 0) {
      const matchingRows = data.filter((row: any) => {
        const sName = (row.student_name || '').toLowerCase().trim();
        const cNum = (row.candidate_number || '').toLowerCase().trim();
        return sName === cleanId || cNum === cleanId;
      });

      if (matchingRows.length > 0) {
        const storedPin = (matchingRows[0].result_pin || '').trim();
        if (storedPin && cleanPin !== storedPin) {
          return { submissions: [], hasUnreleased: false, pinMismatch: true };
        }

        const published: StudentSubmission[] = [];
        let hasUnreleased = false;

        matchingRows.forEach((row: any) => {
          const sub: StudentSubmission = {
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
            rawAnswers: row.raw_answers || {},
            questionResults: row.question_results || [],
            topicBreakdown: row.topic_breakdown || {},
            status: (row.status as SubmissionStatus) || 'submitted',
            teacherAdjustedMarks: Number(row.teacher_adjusted_marks) || 0,
            teacherNotes: row.teacher_notes || '',
            resultPin: row.result_pin || '',
          };

          if (sub.status === 'published') {
            published.push(sub);
          } else {
            hasUnreleased = true;
          }
        });

        return { submissions: published, hasUnreleased };
      }
    }
  } catch (err) {
    console.warn('Table fetch error for student results:', err);
  }

  // 2. Fallback to app_config / local
  try {
    const allSubs = await loadAndSyncAllSubmissions();
    const matching = allSubs.filter((s) => {
      const codeMatch = s.quizCode.trim().toUpperCase() === cleanCode;
      const sName = (s.studentName || '').toLowerCase().trim();
      const cNum = (s.candidateNumber || '').toLowerCase().trim();
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
    localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(all));
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
export function exportAllSubmissionsExcel(
  quizTitle: string,
  quizCode: string,
  totalMarks: number,
  submissions: StudentSubmission[]
): void {
  if (!submissions || submissions.length === 0) {
    alert('No submissions available to export.');
    return;
  }

  const wb = XLSX.utils.book_new();

  const isOffline =
    !quizCode ||
    quizCode.toUpperCase().startsWith('OFFLINE') ||
    submissions.every((s) => s.durationSeconds === 0) ||
    submissions[0]?.teacherNotes?.toLowerCase().includes('offline');

  // ── Sheet 1: Gradebook Summary ──────────────────────────────────────────────
  const summaryRows = submissions.map((s, idx) => {
    const base: Record<string, any> = {
      'Rank': idx + 1,
      'Candidate Name': s.studentName,
      'Class / Section': s.studentClass || 'General',
      'Candidate #': s.candidateNumber || '-',
      'Score Earned': s.score,
      'Total Marks': s.totalMarks || totalMarks,
      'Percentage': `${Math.round(s.percentage)}%`,
      'Grade':
        s.percentage >= 90
          ? 'A*'
          : s.percentage >= 80
          ? 'A'
          : s.percentage >= 70
          ? 'B'
          : s.percentage >= 60
          ? 'C'
          : s.percentage >= 50
          ? 'D'
          : s.percentage >= 40
          ? 'E'
          : 'U',
    };

    if (!isOffline) {
      base['Time Taken'] = `${Math.floor(s.durationSeconds / 60)}m ${s.durationSeconds % 60}s`;
      base['Strikes'] = s.violationsCount;
      base['Integrity Status'] =
        s.violationsCount === 0
          ? 'Clean (0 Strikes)'
          : s.violationsCount >= 3
          ? 'Flagged / Disqualified'
          : `Suspicious (${s.violationsCount} strikes)`;
    }

    base['Date Submitted'] = formatSubmissionDateTime(s.submittedAt);
    return base;
  });

  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = isOffline
    ? [
        { wch: 6 },
        { wch: 25 },
        { wch: 16 },
        { wch: 14 },
        { wch: 12 },
        { wch: 12 },
        { wch: 12 },
        { wch: 8 },
        { wch: 22 },
      ]
    : [
        { wch: 6 },
        { wch: 25 },
        { wch: 16 },
        { wch: 14 },
        { wch: 12 },
        { wch: 12 },
        { wch: 12 },
        { wch: 8 },
        { wch: 14 },
        { wch: 10 },
        { wch: 24 },
        { wch: 22 },
      ];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Gradebook Summary');

  // ── Sheet 2: Question Item Analysis ────────────────────────────────────────
  if (submissions[0]?.questionResults) {
    const qCount = submissions[0].questionResults.length;
    const itemAnalysis = [];

    for (let i = 0; i < qCount; i++) {
      const qNum = i + 1;
      const topic = submissions[0].questionResults[i]?.topic || 'General';
      const maxMarks = submissions[0].questionResults[i]?.maxMarks || 1;
      
      let correctCount = 0;
      let totalEarned = 0;

      submissions.forEach((sub) => {
        const qr = sub.questionResults[i];
        if (qr) {
          if (qr.isCorrect) correctCount++;
          totalEarned += qr.earnedMarks;
        }
      });

      const accuracy = ((correctCount / submissions.length) * 100).toFixed(1);
      const avgEarned = (totalEarned / submissions.length).toFixed(2);

      itemAnalysis.push({
        'Question #': `Q${qNum}`,
        'Topic': topic,
        'Max Marks': maxMarks,
        'Class Accuracy (%)': `${accuracy}%`,
        'Correct Submissions': correctCount,
        'Incorrect Submissions': submissions.length - correctCount,
        'Avg Earned Marks': avgEarned,
      });
    }

    const wsItem = XLSX.utils.json_to_sheet(itemAnalysis);
    wsItem['!cols'] = [
      { wch: 12 },
      { wch: 28 },
      { wch: 12 },
      { wch: 20 },
      { wch: 20 },
      { wch: 22 },
      { wch: 18 },
    ];
    XLSX.utils.book_append_sheet(wb, wsItem, 'Item Analysis');
  }

  // ── Sheet 3: Security & Proctoring Audit Trail ─────────────────────────────
  if (!isOffline) {
    const proctorLogs: any[] = [];
    submissions.forEach((sub) => {
      if (sub.proctoringLogs && sub.proctoringLogs.length > 0) {
        sub.proctoringLogs.forEach((log) => {
          proctorLogs.push({
            'Candidate Name': sub.studentName,
            'Strike': `Strike ${log.strike}`,
            'Timestamp': formatProctorTimestamp(log.timestamp),
            'Security Event': log.event,
            'Severity': log.severity.toUpperCase(),
          });
        });
      }
    });

    if (proctorLogs.length > 0) {
      const wsProctor = XLSX.utils.json_to_sheet(proctorLogs);
      wsProctor['!cols'] = [
        { wch: 24 },
        { wch: 12 },
        { wch: 16 },
        { wch: 45 },
        { wch: 12 },
      ];
      XLSX.utils.book_append_sheet(wb, wsProctor, 'Proctoring Audit Log');
    }
  }

  const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const filename = `${quizTitle.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}_${quizCode}_results.xlsx`;
  exportFileUniversal(blob, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/**
 * Exports an individual student's detailed response report to Excel (.xlsx)
 */
export function exportSingleSubmissionExcel(submission: StudentSubmission): void {
  const wb = XLSX.utils.book_new();

  const isOffline =
    !submission.quizCode ||
    submission.quizCode.toUpperCase().startsWith('OFFLINE') ||
    submission.durationSeconds === 0 ||
    submission.teacherNotes?.toLowerCase().includes('offline');

  // ── Sheet 1: Candidate Overview ────────────────────────────────────────────
  const overviewRows: Array<{ Property: string; Value: any }> = [
    { Property: 'Candidate Name', Value: submission.studentName },
    { Property: 'Quiz Title', Value: submission.quizTitle },
    { Property: 'Subject', Value: submission.subject || 'General' },
    { Property: 'Assessment Mode', Value: isOffline ? 'Offline Paper Exam' : submission.quizCode },
    { Property: 'Score Earned', Value: `${submission.score} / ${submission.totalMarks}` },
    { Property: 'Percentage', Value: `${submission.percentage.toFixed(1)}%` },
  ];

  if (!isOffline) {
    overviewRows.push(
      { Property: 'Time Taken', Value: `${Math.floor(submission.durationSeconds / 60)}m ${submission.durationSeconds % 60}s` },
      { Property: 'Violation Strikes', Value: submission.violationsCount },
      { Property: 'Integrity Status', Value: submission.violationsCount === 0 ? 'Clean (0 Strikes)' : 'Flagged' }
    );
  }

  overviewRows.push({ Property: 'Submission Date', Value: formatSubmissionDateTime(submission.submittedAt) });

  const wsOverview = XLSX.utils.json_to_sheet(overviewRows);
  wsOverview['!cols'] = [{ wch: 20 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, wsOverview, 'Candidate Overview');

  // ── Sheet 2: Question Responses & Model Solutions ──────────────────────────
  if (submission.questionResults && submission.questionResults.length > 0) {
    const qRows = submission.questionResults.map((qr) => ({
      'Question #': `Q${qr.questionNumber}`,
      'Topic': qr.topic,
      'Marks': `${qr.earnedMarks} / ${qr.maxMarks}`,
      'Result': qr.isCorrect ? 'Correct ✓' : 'Incorrect ✗',
      'Student Answer': typeof qr.studentAnswer === 'number'
        ? `Option ${String.fromCharCode(65 + qr.studentAnswer)}`
        : String(qr.studentAnswer || '(No answer)'),
      'Model Solution / Correct Answer': qr.correctAnswer || '',
      'Misconception Alerts': qr.misconceptions?.join('; ') || '',
    }));

    const wsQuestions = XLSX.utils.json_to_sheet(qRows);
    wsQuestions['!cols'] = [
      { wch: 12 },
      { wch: 25 },
      { wch: 12 },
      { wch: 14 },
      { wch: 30 },
      { wch: 40 },
      { wch: 35 },
    ];
    XLSX.utils.book_append_sheet(wb, wsQuestions, 'Responses & Solutions');
  }

  // ── Sheet 3: Proctoring Audit Log ──────────────────────────────────────────
  if (submission.proctoringLogs && submission.proctoringLogs.length > 0) {
    const proctorRows = submission.proctoringLogs.map((log) => ({
      'Strike': `Strike ${log.strike}`,
      'Time': formatProctorTimestamp(log.timestamp),
      'Event Description': log.event,
      'Severity': log.severity.toUpperCase(),
    }));

    const wsProctor = XLSX.utils.json_to_sheet(proctorRows);
    wsProctor['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 45 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsProctor, 'Proctoring Log');
  }

  const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const safeName = submission.studentName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const filename = `${safeName}_${submission.quizCode}_report.xlsx`;
  exportFileUniversal(blob, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
