// ─── Quiz Submission Service ──────────────────────────────────────────────────
// Stores and tracks student quiz attempts, responses, scores, and proctoring audit logs.
// Supports Excel (.xlsx) exports for individual candidates and class-wide gradebooks.

import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';

export interface QuestionSubmissionResult {
  questionId: string;
  questionNumber: number;
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
    studentAnswer: string | number;
    earnedMarks: number;
    maxMarks: number;
    isCorrect: boolean;
    feedback?: string;
    criteria?: Array<{ point: string; achieved: boolean }>;
  }>;
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
}

const SUBMISSIONS_STORAGE_KEY = 'fluffykitten_quiz_submissions';

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

export function updateSubmission(submission: StudentSubmission): void {
  saveQuizSubmission(submission);
}

export function deleteSubmission(id: string): void {
  try {
    const existing = getAllSubmissions();
    const updated = existing.filter((s) => s.id !== id);
    localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(updated));
  } catch (err) {
    console.error('Failed to delete submission:', err);
  }
}

export function clearSubmissionsForQuiz(quizId: string): void {
  try {
    const existing = getAllSubmissions();
    const updated = existing.filter((s) => s.quizId !== quizId);
    localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(updated));
  } catch (err) {
    console.error('Failed to clear submissions for quiz:', err);
  }
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
    'Date Submitted': new Date(s.submittedAt).toLocaleString(),
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
          'Timestamp': new Date(log.timestamp).toLocaleTimeString(),
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
    { Property: 'Submission Date', Value: new Date(submission.submittedAt).toLocaleString() },
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
      'Time': new Date(log.timestamp).toLocaleTimeString(),
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
