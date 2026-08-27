// ─── Quiz Submission Service ──────────────────────────────────────────────────
// Stores and tracks student quiz attempts, responses, scores, and proctoring audit logs.
// Supports Excel (.xlsx) exports for individual candidates and class-wide gradebooks.

import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { supabase } from '../lib/supabase';

export type SubmissionStatus = 'submitted' | 'grading' | 'graded' | 'published';

export interface DeviceExamReceipt {
  quizCode: string;
  quizTitle: string;
  studentName: string;
  candidateNumber?: string;
  submittedAt: string;
  resultPin?: string;
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
 * Formats a student's answer into a human-readable string.
 * Translates MCQ option indices (e.g. 0, 1, 2, 3 or "2") into "Option C: [Text]" or "Option C".
 * Ensures no duplicate option letters (e.g. "Option A: A ...") occur.
 */
export function formatCandidateAnswer(
  ans: string | number | undefined,
  options?: string[] | null,
  gradingMethod?: string
): string {
  if (ans === undefined || ans === null || String(ans).trim() === '') {
    return '(No response)';
  }
  let str = String(ans).trim();

  // If already formatted like "Option A: A ...", clean duplicate option letter
  str = str.replace(/^Option\s+([A-D]):\s+[A-D][\.\)\s:-]+\s*/i, 'Option $1: ');

  const num = Number(str);
  const isNumericIndex = !isNaN(num) && Number.isInteger(num) && num >= 0 && num <= 25;
  const isMcq = gradingMethod === 'mcq' || (options && options.length > 0) || (isNumericIndex && str.length <= 2);

  if (isMcq && isNumericIndex) {
    const letter = String.fromCharCode(65 + num);
    if (options && options[num]) {
      const cleanContent = cleanMcqOptionContent(options[num], num);
      return `Option ${letter}: ${cleanContent || options[num]}`;
    }
    return `Option ${letter}`;
  }

  // If ans is just a single letter like "A", "B", "C", "D"
  if (isMcq && str.length === 1 && str >= 'A' && str <= 'Z') {
    const idx = str.charCodeAt(0) - 65;
    if (options && options[idx]) {
      const cleanContent = cleanMcqOptionContent(options[idx], idx);
      return `Option ${str}: ${cleanContent || options[idx]}`;
    }
    return `Option ${str}`;
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

export function getSubmissionsForQuiz(quizId: string, quizCode?: string): StudentSubmission[] {
  const all = getAllSubmissions();
  return all.filter((s) => s.quizId === quizId || (quizCode && s.quizCode.toUpperCase() === quizCode.toUpperCase()));
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
 * Saves or updates submission both locally and asynchronously in Supabase cloud.
 */
export async function saveQuizSubmissionCloud(submission: StudentSubmission): Promise<boolean> {
  // 1. Always save to local storage immediately
  saveQuizSubmission(submission);

  // 2. Upsert to Supabase
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

    if (error) {
      console.warn('Could not sync submission to Supabase cloud:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Error pushing submission to Supabase:', err);
    return false;
  }
}

export function updateSubmission(submission: StudentSubmission): void {
  saveQuizSubmissionCloud(submission);
}

export function deleteSubmission(id: string): void {
  try {
    const existing = getAllSubmissions();
    const updated = existing.filter((s) => s.id !== id);
    localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(updated));
  } catch (err) {
    console.error('Failed to delete submission from localStorage:', err);
  }

  try {
    (supabase.from('quiz_submissions' as any) as any)
      .delete()
      .eq('id', id)
      .then(({ error }: any) => {
        if (error) console.warn('Could not delete from cloud:', error.message);
      });
  } catch {}
}

export function clearSubmissionsForQuiz(quizId: string, quizCode?: string): void {
  try {
    const existing = getAllSubmissions();
    const updated = existing.filter((s) => s.quizId !== quizId && (!quizCode || s.quizCode.toUpperCase() !== quizCode.toUpperCase()));
    localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(updated));
  } catch (err) {
    console.error('Failed to clear submissions from localStorage:', err);
  }

  try {
    let q = (supabase.from('quiz_submissions' as any) as any).delete();
    if (quizCode) {
      q = q.or(`quiz_id.eq.${quizId},quiz_code.eq.${quizCode.toUpperCase()}`);
    } else {
      q = q.eq('quiz_id', quizId);
    }
    q.then(({ error }: any) => {
      if (error) console.warn('Could not clear from cloud:', error.message);
    });
  } catch {}
}

/**
 * Fetches all student submissions for a quiz from Supabase, merging with local storage.
 */
export async function fetchSubmissionsFromSupabase(quizId: string, quizCode?: string): Promise<StudentSubmission[]> {
  try {
    let query = (supabase.from('quiz_submissions' as any) as any)
      .select('*')
      .order('submitted_at', { ascending: false });

    if (quizCode) {
      query = query.or(`quiz_id.eq.${quizId},quiz_code.eq.${quizCode.toUpperCase()}`);
    } else {
      query = query.eq('quiz_id', quizId);
    }

    const { data, error } = await query;
    if (!error && Array.isArray(data)) {
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
      }));

      // Merge with local storage
      const local = getSubmissionsForQuiz(quizId, quizCode);
      const map = new Map<string, StudentSubmission>();
      cloudSubs.forEach((s) => map.set(s.id, s));
      local.forEach((s) => {
        if (!map.has(s.id)) map.set(s.id, s);
      });

      const merged = Array.from(map.values());
      try {
        const allLocal = getAllSubmissions().filter(
          (s) => s.quizId !== quizId && (!quizCode || s.quizCode.toUpperCase() !== quizCode.toUpperCase())
        );
        localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify([...merged, ...allLocal]));
      } catch {}

      return merged;
    }
  } catch (err) {
    console.warn('Could not fetch cloud submissions:', err);
  }

  return getSubmissionsForQuiz(quizId, quizCode);
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

  try {
    const { data, error } = await (supabase.from('quiz_submissions' as any) as any)
      .select('*')
      .eq('quiz_code', cleanCode)
      .order('submitted_at', { ascending: false });

    if (!error && Array.isArray(data)) {
      // Exact name or candidate number match (no partial matching)
      const matchingRows = data.filter((row: any) => {
        const sName = (row.student_name || '').toLowerCase().trim();
        const cNum = (row.candidate_number || '').toLowerCase().trim();
        return sName === cleanId || cNum === cleanId;
      });

      if (matchingRows.length === 0) {
        return { submissions: [], hasUnreleased: false };
      }

      // Verify PIN against the first matching row's stored PIN
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

        if (row.status === 'published') {
          published.push(sub);
        } else {
          hasUnreleased = true;
        }
      });

      return { submissions: published, hasUnreleased };
    }
  } catch (err) {
    console.warn('Cloud fetch student results error:', err);
  }

  // Fallback to local storage (exact match + PIN)
  const local = getAllSubmissions().filter((s) => {
    const codeMatch = s.quizCode.toUpperCase() === cleanCode;
    const nameMatch =
      s.studentName.toLowerCase().trim() === cleanId ||
      (s.candidateNumber && s.candidateNumber.toLowerCase().trim() === cleanId);
    return codeMatch && nameMatch;
  });

  if (local.length > 0 && local[0].resultPin && cleanPin !== local[0].resultPin) {
    return { submissions: [], hasUnreleased: false, pinMismatch: true };
  }

  const published = local.filter((s) => s.status === 'published' || !s.status);
  const hasUnreleased = local.some((s) => s.status === 'submitted' || s.status === 'grading');
  return { submissions: published, hasUnreleased };
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

  // ── Sheet 1: Gradebook Summary ──────────────────────────────────────────────
  const summaryRows = submissions.map((s, idx) => ({
    'Rank': idx + 1,
    'Candidate Name': s.studentName,
    'Class / Section': s.studentClass || 'General',
    'Candidate #': s.candidateNumber || '-',
    'Score Earned': s.score,
    'Total Marks': s.totalMarks || totalMarks,
    'Percentage': `${Math.round(s.percentage)}%`,
    'Grade': s.percentage >= 90 ? 'A*' : s.percentage >= 80 ? 'A' : s.percentage >= 70 ? 'B' : s.percentage >= 60 ? 'C' : s.percentage >= 50 ? 'D' : s.percentage >= 40 ? 'E' : 'U',
    'Time Taken': `${Math.floor(s.durationSeconds / 60)}m ${s.durationSeconds % 60}s`,
    'Strikes': s.violationsCount,
    'Integrity Status': s.violationsCount === 0 ? 'Clean (0 Strikes)' : s.violationsCount >= 3 ? 'Flagged / Disqualified' : `Suspicious (${s.violationsCount} strikes)`,
    'Date Submitted': formatSubmissionDateTime(s.submittedAt),
  }));

  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = [
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

  const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const filename = `${quizTitle.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}_${quizCode}_results.xlsx`;
  saveAs(blob, filename);
}

/**
 * Exports an individual student's detailed response report to Excel (.xlsx)
 */
export function exportSingleSubmissionExcel(submission: StudentSubmission): void {
  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Candidate Overview ────────────────────────────────────────────
  const overviewRows = [
    { Property: 'Candidate Name', Value: submission.studentName },
    { Property: 'Quiz Title', Value: submission.quizTitle },
    { Property: 'Subject', Value: submission.subject || 'Chemistry' },
    { Property: 'Access Code', Value: submission.quizCode },
    { Property: 'Score Earned', Value: `${submission.score} / ${submission.totalMarks}` },
    { Property: 'Percentage', Value: `${submission.percentage.toFixed(1)}%` },
    { Property: 'Time Taken', Value: `${Math.floor(submission.durationSeconds / 60)}m ${submission.durationSeconds % 60}s` },
    { Property: 'Violation Strikes', Value: submission.violationsCount },
    { Property: 'Integrity Status', Value: submission.violationsCount === 0 ? 'Clean (0 Strikes)' : 'Flagged' },
    { Property: 'Submission Date', Value: formatSubmissionDateTime(submission.submittedAt) },
  ];

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
  saveAs(blob, filename);
}
