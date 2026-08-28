import { useState, useMemo, useEffect } from 'react';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { PublishedQuiz } from '../services/quizManagerService';
import {
  getSubmissionsForQuiz,
  fetchSubmissionsFromSupabase,
  setQuizSubmissionsStatus,
  deleteSubmission,
  clearSubmissionsForQuiz,
  updateSubmission,
  exportAllSubmissionsExcel,
  exportSingleSubmissionExcel,
  formatProctorTimestamp,
  formatSubmissionDateTime,
  cleanMcqOptionContent,
  type StudentSubmission,
  type QuestionSubmissionResult,
} from '../services/quizSubmissionService';
import { fetchQuestionsByIds } from '../services/quizCodeService';
import { evaluateAnswerWithGemini } from '../services/aiGradingService';
import { gradeDeterministicAnswer, resolveMcqCorrectOptionIndex } from '../services/deterministicGradingService';
import {
  exportClassQuizReportPdf,
  exportIndividualStudentReportPdf,
  exportStudentFeedbackReportPdf,
} from '../services/quizReportPdfService';
import { ExamMathText } from './ExamMathText';
import './QuizResultsModal.css';

interface QuizResultsModalProps {
  quiz: PublishedQuiz;
  onClose: () => void;
}

export function QuizResultsModal({ quiz, onClose }: QuizResultsModalProps) {
  const [submissions, setSubmissions] = useState<StudentSubmission[]>(() =>
    getSubmissionsForQuiz(quiz.id, quiz.quizCode)
  );
  const [selectedSubmission, setSelectedSubmission] = useState<StudentSubmission | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'clean' | 'flagged'>('all');
  const [selectedClass, setSelectedClass] = useState<string>('all');

  // Teacher Mark Override State
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null);
  const [editMarksInput, setEditMarksInput] = useState<number>(0);
  const [editTeacherNote, setEditTeacherNote] = useState<string>('');

  // Batch AI Examiner & Release State
  const [isBatchGrading, setIsBatchGrading] = useState<boolean>(false);
  const [gradingProgress, setGradingProgress] = useState<{ current: number; total: number; text: string }>({
    current: 0,
    total: 0,
    text: '',
  });

  const refreshSubmissions = () => {
    fetchSubmissionsFromSupabase(quiz.id, quiz.quizCode).then((subs) => {
      setSubmissions(subs);
    });
  };

  useEffect(() => {
    refreshSubmissions();
  }, [quiz.id, quiz.quizCode]);

  const unanalyzedCount = useMemo(() => {
    return submissions.filter((s) => s.status === 'submitted' || !s.status).length;
  }, [submissions]);

  const isAllReleased = useMemo(() => {
    return submissions.length > 0 && submissions.every((s) => s.status === 'published');
  }, [submissions]);

  const handleToggleRelease = async () => {
    const nextStatus = isAllReleased ? 'graded' : 'published';
    const confirmed = confirm(
      isAllReleased
        ? 'Hide results from students? Candidates will not be able to view their scores on the portal.'
        : 'Release results to students? Candidates can now enter their quiz code and name on the portal to view their marked paper and download their PDF reports.'
    );
    if (!confirmed) return;

    await setQuizSubmissionsStatus(quiz.id, quiz.quizCode, nextStatus);
    refreshSubmissions();
  };

  const handleRunBatchAI = async () => {
    const targets = submissions.filter((s) => s.status === 'submitted' || !s.status);
    if (targets.length === 0) {
      alert('All student submissions have already been analyzed.');
      return;
    }

    setIsBatchGrading(true);
    setGradingProgress({ current: 0, total: targets.length, text: 'Fetching exam questions...' });

    try {
      const questions = await fetchQuestionsByIds(quiz.questionIds || []);
      if (!questions || questions.length === 0) {
        alert('Could not load questions for this test.');
        setIsBatchGrading(false);
        return;
      }

      for (let sIdx = 0; sIdx < targets.length; sIdx++) {
        const sub = targets[sIdx];
        setGradingProgress({
          current: sIdx + 1,
          total: targets.length,
          text: `Analyzing candidate: ${sub.studentName} (${sIdx + 1} of ${targets.length})...`,
        });

        const rawAnswers = sub.rawAnswers || {};
        let earnedMarks = 0;
        const qResults: QuestionSubmissionResult[] = [];
        const topicBreakdown: Record<string, { totalMarks: number; earnedMarks: number; percentage: number }> = {};

        for (let idx = 0; idx < questions.length; idx++) {
          const q = questions[idx];
          const top = q.topic || 'General';
          if (!topicBreakdown[top]) topicBreakdown[top] = { totalMarks: 0, earnedMarks: 0, percentage: 0 };
          const qMarks = q.marks || 1;
          topicBreakdown[top].totalMarks += qMarks;

          let isCorrect = false;
          let qEarned = 0;
          let aiFeedback: string | undefined;
          let missingPoints: string[] | undefined;
          let criteriaBreakdown: Array<{ point: string; achieved: boolean; examinerNote?: string }> | undefined;
          let gradingMethod: 'mcq' | 'deterministic' | 'ai_gemini' | 'rule_fallback' = 'deterministic';
          const subResults: any[] = [];

          // Case A: MCQ
          if (q.options && q.options.length > 0) {
            gradingMethod = 'mcq';
            const userAns = rawAnswers[idx];
            const correctIdx = resolveMcqCorrectOptionIndex(q);
            const userNum = userAns !== undefined && userAns !== '' ? Number(userAns) : -1;
            const userLetter = typeof userAns === 'string' && userAns.trim().length === 1
              ? userAns.trim().toUpperCase().charCodeAt(0) - 65
              : -1;

            if (userNum === correctIdx || userLetter === correctIdx) {
              isCorrect = true;
              qEarned = qMarks;
            }
          }
          // Case B: Sub-questions
          else if (q.sub_questions && q.sub_questions.length > 0) {
            let totalSubEarned = 0;
            for (let sqIdx = 0; sqIdx < q.sub_questions.length; sqIdx++) {
              const sq = q.sub_questions[sqIdx];
              const subKey = `${idx}_${sqIdx}`;
              const subAns = (rawAnswers[subKey] !== undefined ? rawAnswers[subKey] : (rawAnswers[idx] as any)?.[sqIdx]) ?? '';
              const subMarks = sq.marks || 1;

              const det = gradeDeterministicAnswer(subAns, q, sqIdx);
              if (det.isHandled) {
                totalSubEarned += det.earnedMarks;
                subResults.push({
                  subId: sq.sub_id,
                  questionText: sq.question_text,
                  studentAnswer: subAns,
                  earnedMarks: det.earnedMarks,
                  maxMarks: subMarks,
                  isCorrect: det.isCorrect,
                  feedback: det.feedback,
                });
              } else {
                setGradingProgress({
                  current: sIdx + 1,
                  total: targets.length,
                  text: `Evaluating ${sub.studentName}: Q${idx + 1}(${sq.sub_id})...`,
                });
                const aiRes = await evaluateAnswerWithGemini(q, sqIdx, String(subAns));
                totalSubEarned += aiRes.earnedMarks;
                gradingMethod = aiRes.evaluatedBy === 'gemini' ? 'ai_gemini' : 'rule_fallback';
                subResults.push({
                  subId: sq.sub_id,
                  questionText: sq.question_text,
                  studentAnswer: subAns,
                  earnedMarks: aiRes.earnedMarks,
                  maxMarks: subMarks,
                  isCorrect: aiRes.isCorrect,
                  feedback: aiRes.feedback,
                  criteria: aiRes.criteriaResults,
                });
                // Throttled delay to respect Gemini rate limits
                await new Promise((r) => setTimeout(r, 1200));
              }
            }
            qEarned = Math.min(totalSubEarned, qMarks);
            isCorrect = qEarned === qMarks;
          }
          // Case C: Single structured question
          else {
            const userAns = rawAnswers[idx] ?? '';
            const det = gradeDeterministicAnswer(userAns, q);
            if (det.isHandled) {
              qEarned = det.earnedMarks;
              isCorrect = det.isCorrect;
              aiFeedback = det.feedback;
              gradingMethod = 'deterministic';
            } else {
              setGradingProgress({
                current: sIdx + 1,
                total: targets.length,
                text: `Evaluating ${sub.studentName}: Question ${idx + 1}...`,
              });
              const aiRes = await evaluateAnswerWithGemini(q, undefined, String(userAns));
              qEarned = aiRes.earnedMarks;
              isCorrect = aiRes.isCorrect;
              aiFeedback = aiRes.feedback;
              missingPoints = aiRes.missingKeyPoints;
              criteriaBreakdown = aiRes.criteriaResults;
              gradingMethod = aiRes.evaluatedBy === 'gemini' ? 'ai_gemini' : 'rule_fallback';
              // Throttled delay to respect Gemini rate limits
              await new Promise((r) => setTimeout(r, 1200));
            }
          }

          earnedMarks += qEarned;
          topicBreakdown[top].earnedMarks += qEarned;

          qResults.push({
            questionId: q.id,
            questionNumber: idx + 1,
            questionText: q.question_text,
            options: q.options || undefined,
            topic: top,
            maxMarks: qMarks,
            earnedMarks: qEarned,
            isCorrect,
            studentAnswer: rawAnswers[idx] !== undefined ? rawAnswers[idx] : '',
            correctAnswer: (q.options && q.options.length > 0)
              ? `Option ${String.fromCharCode(65 + resolveMcqCorrectOptionIndex(q))}: ${cleanMcqOptionContent(q.options[resolveMcqCorrectOptionIndex(q)] || '', resolveMcqCorrectOptionIndex(q))}`
              : typeof q.mark_scheme === 'string'
              ? q.mark_scheme
              : Array.isArray(q.mark_scheme?.marking_points)
              ? q.mark_scheme.marking_points.join('; ')
              : undefined,
            misconceptions: (q as any).metadata?.misconceptions || (q as any).misconceptions || [],
            aiFeedback,
            missingPoints,
            criteriaBreakdown,
            gradingMethod,
            subQuestionResults: subResults.length > 0 ? subResults : undefined,
          });
        }

        Object.keys(topicBreakdown).forEach((top) => {
          const item = topicBreakdown[top];
          item.percentage = item.totalMarks > 0 ? (item.earnedMarks / item.totalMarks) * 100 : 0;
        });

        const updatedSub: StudentSubmission = {
          ...sub,
          score: earnedMarks,
          totalMarks: quiz.totalMarks || sub.totalMarks,
          percentage: (quiz.totalMarks || sub.totalMarks) > 0 ? Math.round((earnedMarks / (quiz.totalMarks || sub.totalMarks)) * 100) : 100,
          questionResults: qResults,
          topicBreakdown,
          status: 'graded',
        };

        updateSubmission(updatedSub);
      }

      refreshSubmissions();
    } catch (err) {
      console.error('Batch grading error:', err);
      alert('An error occurred during batch grading. Please check your network and Gemini API key.');
    } finally {
      setIsBatchGrading(false);
    }
  };

  // ─── Unique Classes ─────────────────────────────────────────────────────────
  const availableClasses = useMemo(() => {
    const classes = Array.from(new Set(submissions.map((s) => s.studentClass || 'General')));
    return classes.sort();
  }, [submissions]);

  // ─── Analytics Summary ──────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const activeSubmissions = selectedClass === 'all'
      ? submissions
      : submissions.filter((s) => (s.studentClass || 'General').toLowerCase() === selectedClass.toLowerCase());

    if (activeSubmissions.length === 0) {
      return {
        count: 0,
        avgScore: 0,
        avgPercentage: 0,
        highestScore: 0,
        lowestScore: 0,
        cleanCount: 0,
        flaggedCount: 0,
      };
    }

    const count = activeSubmissions.length;
    const totalScore = activeSubmissions.reduce((s, sub) => s + sub.score, 0);
    const avgScore = totalScore / count;
    const avgPercentage = (avgScore / (quiz.totalMarks || 1)) * 100;
    const highestScore = Math.max(...activeSubmissions.map((s) => s.score));
    const lowestScore = Math.min(...activeSubmissions.map((s) => s.score));
    const cleanCount = activeSubmissions.filter((s) => s.violationsCount === 0).length;
    const flaggedCount = count - cleanCount;

    return {
      count,
      avgScore,
      avgPercentage,
      highestScore,
      lowestScore,
      cleanCount,
      flaggedCount,
    };
  }, [submissions, quiz.totalMarks, selectedClass]);

  // ─── Filtered Submissions ───────────────────────────────────────────────────
  const filteredSubmissions = useMemo(() => {
    return submissions.filter((sub) => {
      const q = searchFilter.toLowerCase().trim();
      const matchesSearch = !q || sub.studentName.toLowerCase().includes(q) || (sub.candidateNumber && sub.candidateNumber.includes(q));
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'clean' && sub.violationsCount === 0) ||
        (statusFilter === 'flagged' && sub.violationsCount > 0);
      const matchesClass =
        selectedClass === 'all' ||
        (sub.studentClass || 'General').toLowerCase() === selectedClass.toLowerCase();

      return matchesSearch && matchesStatus && matchesClass;
    });
  }, [submissions, searchFilter, statusFilter, selectedClass]);

  const handleDelete = (id: string) => {
    if (confirm('Delete this submission record?')) {
      deleteSubmission(id);
      if (selectedSubmission?.id === id) setSelectedSubmission(null);
      refreshSubmissions();
    }
  };

  const handleClearAll = () => {
    if (confirm(`Are you sure you want to delete all ${submissions.length} submission records for this quiz?`)) {
      clearSubmissionsForQuiz(quiz.id);
      setSelectedSubmission(null);
      refreshSubmissions();
    }
  };

  const handleExportAllExcel = () => {
    exportAllSubmissionsExcel(quiz.title, quiz.quizCode, quiz.totalMarks, submissions);
  };

  const handleExportSingleExcel = (sub: StudentSubmission) => {
    exportSingleSubmissionExcel(sub);
  };

  const handleStartEditing = (qr: QuestionSubmissionResult) => {
    setEditingQuestionId(qr.questionId);
    setEditMarksInput(qr.earnedMarks);
    setEditTeacherNote('');
  };

  const handleSaveMarkOverride = (qr: QuestionSubmissionResult) => {
    if (!selectedSubmission) return;

    const diff = editMarksInput - qr.earnedMarks;
    const newScore = Math.max(0, Math.min(selectedSubmission.totalMarks, selectedSubmission.score + diff));
    const newPct = selectedSubmission.totalMarks > 0 ? (newScore / selectedSubmission.totalMarks) * 100 : 0;

    const updatedQuestionResults = selectedSubmission.questionResults.map((q) => {
      if (q.questionId === qr.questionId) {
        return {
          ...q,
          earnedMarks: editMarksInput,
          isCorrect: editMarksInput === q.maxMarks,
          aiFeedback: editTeacherNote ? `${q.aiFeedback ? q.aiFeedback + '\n' : ''}✏️ [Teacher Note]: ${editTeacherNote}` : q.aiFeedback,
        };
      }
      return q;
    });

    const updatedSubmission: StudentSubmission = {
      ...selectedSubmission,
      score: newScore,
      percentage: newPct,
      questionResults: updatedQuestionResults,
      teacherAdjustedMarks: (selectedSubmission.teacherAdjustedMarks || 0) + diff,
    };

    updateSubmission(updatedSubmission);
    setSelectedSubmission(updatedSubmission);
    refreshSubmissions();
    setEditingQuestionId(null);
  };

  const backdropDismiss = useBackdropDismiss(onClose);

  return (
    <div className="qrm-backdrop animate-fade-in" {...backdropDismiss}>
      <div className="qrm-modal animate-scale-up" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="qrm-header">
          <div className="qrm-header-info">
            <div className="qrm-subject-badge">{quiz.subject || 'Chemistry'}</div>
            <h2 className="qrm-title">{quiz.title}</h2>
            <p className="qrm-sub">
              Access Code: <code className="qrm-code">{quiz.quizCode}</code> • {quiz.totalMarks} Total Marks • {submissions.length} Student Submission{submissions.length !== 1 ? 's' : ''}
            </p>
          </div>

          <div className="qrm-header-actions">
            {submissions.length > 0 && (
              <>
                <button
                  type="button"
                  className="qrm-btn"
                  style={{
                    background: '#dc2626',
                    color: '#ffffff',
                    fontWeight: 700,
                    fontSize: '0.8125rem',
                    padding: '8px 14px',
                    borderRadius: '8px',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                  onClick={() => exportClassQuizReportPdf(quiz, submissions, selectedClass)}
                  title="Export complete class diagnostic report as PDF"
                >
                  📄 Export Class Report (PDF)
                </button>
                <button
                  type="button"
                  className="qrm-btn qrm-btn-excel"
                  onClick={handleExportAllExcel}
                  title="Export all results to Excel (.xlsx)"
                >
                  📗 Export All (Excel .xlsx)
                </button>
              </>
            )}
            <button type="button" className="qrm-close-btn" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        {/* Examiner Batch Grading & Results Release Action Bar */}
        <div
          style={{
            background: '#131d31',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            padding: '12px 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            {unanalyzedCount > 0 ? (
              <span
                style={{
                  background: 'rgba(234, 179, 8, 0.15)',
                  color: '#facc15',
                  border: '1px solid rgba(234, 179, 8, 0.3)',
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '0.8125rem',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                ⏳ {unanalyzedCount} Submission{unanalyzedCount !== 1 ? 's' : ''} Awaiting AI Analysis
              </span>
            ) : submissions.length > 0 ? (
              <span
                style={{
                  background: 'rgba(34, 197, 94, 0.15)',
                  color: '#4ade80',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '0.8125rem',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                ✅ All Submissions Graded
              </span>
            ) : null}

            {submissions.length > 0 && (
              <span
                style={{
                  background: isAllReleased ? 'rgba(34, 197, 94, 0.15)' : 'rgba(148, 163, 184, 0.15)',
                  color: isAllReleased ? '#4ade80' : '#cbd5e1',
                  border: `1px solid ${isAllReleased ? 'rgba(34, 197, 94, 0.3)' : 'rgba(148, 163, 184, 0.3)'}`,
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '0.8125rem',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                {isAllReleased ? '📢 Results Released to Students' : '🔒 Results Hidden from Students'}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {unanalyzedCount > 0 && (
              <button
                type="button"
                className="qrm-btn"
                style={{
                  background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
                  color: '#ffffff',
                  fontWeight: 800,
                  fontSize: '0.8125rem',
                  padding: '7px 16px',
                  borderRadius: '8px',
                  border: 'none',
                  cursor: isBatchGrading ? 'not-allowed' : 'pointer',
                  opacity: isBatchGrading ? 0.7 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  boxShadow: '0 4px 12px rgba(139, 92, 246, 0.3)',
                }}
                onClick={handleRunBatchAI}
                disabled={isBatchGrading}
              >
                {isBatchGrading ? '⏳ Evaluating Class...' : '🤖 Run Batch AI Analysis'}
              </button>
            )}

            {submissions.length > 0 && (
              <button
                type="button"
                className="qrm-btn"
                style={{
                  background: isAllReleased ? '#334155' : (unanalyzedCount > 0 && !isAllReleased) ? '#1e293b' : 'linear-gradient(135deg, #16a34a, #15803d)',
                  color: '#ffffff',
                  fontWeight: 700,
                  fontSize: '0.8125rem',
                  padding: '7px 14px',
                  borderRadius: '8px',
                  border: 'none',
                  cursor: (unanalyzedCount > 0 && !isAllReleased) ? 'not-allowed' : 'pointer',
                  opacity: (unanalyzedCount > 0 && !isAllReleased) ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
                onClick={handleToggleRelease}
                disabled={unanalyzedCount > 0 && !isAllReleased}
                title={unanalyzedCount > 0 && !isAllReleased ? 'Run Batch AI Analysis first before releasing results' : undefined}
              >
                {isAllReleased ? '🔒 Hide Marks' : '📢 Release Results to Students'}
              </button>
            )}
          </div>
        </div>

        {/* Live Batch Grading Progress Bar */}
        {isBatchGrading && (
          <div
            style={{
              background: 'linear-gradient(90deg, rgba(139, 92, 246, 0.15), rgba(59, 130, 246, 0.15))',
              borderBottom: '1px solid rgba(139, 92, 246, 0.3)',
              padding: '12px 24px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '6px' }}>
              <span style={{ fontWeight: 700, color: '#c4b5fd' }}>
                🤖 {gradingProgress.text}
              </span>
              <span style={{ fontWeight: 800, color: '#f8fafc' }}>
                {gradingProgress.current} / {gradingProgress.total} Candidates
              </span>
            </div>
            <div style={{ height: '6px', background: 'rgba(0, 0, 0, 0.3)', borderRadius: '3px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${gradingProgress.total > 0 ? (gradingProgress.current / gradingProgress.total) * 100 : 0}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg, #8b5cf6, #3b82f6)',
                  borderRadius: '3px',
                  transition: 'width 0.4s ease',
                }}
              />
            </div>
          </div>
        )}

        {/* Analytics KPI Ribbon */}
        <div className="qrm-kpi-ribbon">
          <div className="qrm-kpi-card">
            <span className="kpi-val">{stats.count}</span>
            <span className="kpi-lbl">Total Students {selectedClass !== 'all' ? `(${selectedClass})` : ''}</span>
          </div>
          <div className="qrm-kpi-card">
            <span className="kpi-val">
              {stats.count > 0 ? `${stats.avgScore.toFixed(1)} / ${quiz.totalMarks}` : '-'}
            </span>
            <span className="kpi-lbl">Average Score ({stats.avgPercentage.toFixed(0)}%)</span>
          </div>
          <div className="qrm-kpi-card">
            <span className="kpi-val">
              {stats.count > 0 ? `${stats.highestScore} / ${quiz.totalMarks}` : '-'}
            </span>
            <span className="kpi-lbl">Highest Score</span>
          </div>
          <div className="qrm-kpi-card">
            <span className="kpi-val kpi-val--integrity">
              {stats.count > 0
                ? `${((stats.cleanCount / stats.count) * 100).toFixed(0)}%`
                : '-'}
            </span>
            <span className="kpi-lbl">Clean Integrity Rate ({stats.cleanCount} clean)</span>
          </div>
        </div>

        {/* Body Split View */}
        <div className="qrm-body-layout">
          {/* Left Panel: Student Roster List */}
          <div className="qrm-roster-panel">
            <div className="qrm-roster-toolbar">
              <input
                type="text"
                className="qrm-roster-search"
                placeholder="Search candidate name or ID..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
              />

              {/* Class Filter Selection */}
              {availableClasses.length > 1 && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', margin: '8px 0' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-text-secondary)' }}>Class:</span>
                  <select
                    className="qrm-class-select"
                    value={selectedClass}
                    onChange={(e) => setSelectedClass(e.target.value)}
                    style={{
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text-primary)',
                      borderRadius: '6px',
                      padding: '4px 8px',
                      fontSize: '0.8125rem',
                      fontWeight: 600,
                      outline: 'none',
                      cursor: 'pointer',
                      flex: 1,
                    }}
                  >
                    <option value="all">All Classes ({submissions.length})</option>
                    {availableClasses.map((cls) => {
                      const clsCount = submissions.filter((s) => (s.studentClass || 'General').toLowerCase() === cls.toLowerCase()).length;
                      return (
                        <option key={cls} value={cls}>
                          {cls} ({clsCount} students)
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}

              <div className="qrm-status-filter-pills">
                <button
                  type="button"
                  className={`qrm-filter-pill ${statusFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('all')}
                >
                  All ({filteredSubmissions.length})
                </button>
                <button
                  type="button"
                  className={`qrm-filter-pill ${statusFilter === 'clean' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('clean')}
                >
                  🟢 Clean ({stats.cleanCount})
                </button>
                <button
                  type="button"
                  className={`qrm-filter-pill ${statusFilter === 'flagged' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('flagged')}
                >
                  ⚠️ Flagged ({stats.flaggedCount})
                </button>
              </div>
            </div>

            {submissions.length === 0 ? (
              <div className="qrm-empty-roster">
                <div className="empty-icon">📝</div>
                <h3>No Submissions Yet</h3>
                <p>
                  When students complete this quiz using code <strong>{quiz.quizCode}</strong>, their answers, scores, and proctoring audit logs will show up here instantly.
                </p>
              </div>
            ) : filteredSubmissions.length === 0 ? (
              <div className="qrm-empty-roster">
                <p>No students matched your search filter.</p>
              </div>
            ) : (
              <div className="qrm-student-list">
                {filteredSubmissions.map((sub) => {
                  const isSelected = selectedSubmission?.id === sub.id;
                  const isClean = sub.violationsCount === 0;
                  const percent = Math.round(sub.percentage);

                  return (
                    <div
                      key={sub.id}
                      className={`qrm-student-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedSubmission(sub)}
                    >
                      <div className="qrm-sc-top">
                        <div className="qrm-sc-name-wrap">
                          <span className="qrm-sc-avatar">👤</span>
                          <div>
                            <strong className="qrm-sc-name">{sub.studentName}</strong>
                            <div style={{ display: 'flex', gap: '6px', marginTop: '2px', fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>
                              <span style={{ background: 'rgba(255, 255, 255, 0.08)', padding: '1px 5px', borderRadius: '4px', fontWeight: 600 }}>
                                {sub.studentClass || 'General'}
                              </span>
                              {sub.candidateNumber && (
                                <span style={{ fontFamily: 'monospace', opacity: 0.8 }}>#{sub.candidateNumber}</span>
                              )}
                              {sub.resultPin && (
                                <span
                                  style={{
                                    fontFamily: 'monospace',
                                    background: 'rgba(234, 179, 8, 0.15)',
                                    color: '#facc15',
                                    padding: '1px 5px',
                                    borderRadius: '4px',
                                    fontWeight: 700,
                                  }}
                                  title="Candidate 3-digit Personal Access PIN"
                                >
                                  PIN: {sub.resultPin}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                          <div className="qrm-sc-score-badge">
                            <span className={`score-tag ${percent >= 70 ? 'high' : percent >= 40 ? 'med' : 'low'}`}>
                              {sub.score} / {sub.totalMarks} ({percent}%)
                            </span>
                          </div>
                          <span
                            style={{
                              fontSize: '0.6875rem',
                              fontWeight: 700,
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background:
                                sub.status === 'published'
                                  ? 'rgba(34, 197, 94, 0.2)'
                                  : sub.status === 'graded'
                                  ? 'rgba(59, 130, 246, 0.2)'
                                  : 'rgba(234, 179, 8, 0.2)',
                              color:
                                sub.status === 'published'
                                  ? '#4ade80'
                                  : sub.status === 'graded'
                                  ? '#60a5fa'
                                  : '#facc15',
                            }}
                          >
                            {sub.status === 'published' ? '📢 Released' : sub.status === 'graded' ? '📝 Graded' : '⏳ Awaiting AI'}
                          </span>
                        </div>
                      </div>

                      <div className="qrm-sc-bottom">
                        <span className="qrm-sc-time">
                          🕒 {Math.floor(sub.durationSeconds / 60)}m {sub.durationSeconds % 60}s • {formatProctorTimestamp(sub.submittedAt)}
                        </span>

                        <span className={`qrm-sc-integrity ${isClean ? 'clean' : 'flagged'}`}>
                          {isClean ? '🟢 0 Strikes' : `⚠️ ${sub.violationsCount} Strike${sub.violationsCount !== 1 ? 's' : ''}`}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {submissions.length > 0 && (
              <div className="qrm-roster-footer">
                <button
                  type="button"
                  className="qrm-btn-danger-link"
                  onClick={handleClearAll}
                >
                  🗑️ Clear All Submissions
                </button>
              </div>
            )}
          </div>

          {/* Right Panel: Detailed Answer & Proctoring Inspector */}
          <div className="qrm-detail-panel">
            {!selectedSubmission ? (
              <div className="qrm-detail-placeholder">
                <div className="placeholder-icon">🔍</div>
                <h3>Select a Candidate</h3>
                <p>Click on any student in the roster to inspect their response breakdown, step-by-step answers, and security audit log.</p>
              </div>
            ) : (
              <div className="qrm-detail-content animate-fade-in">
                {/* Candidate Overview Card */}
                <div className="qrm-candidate-header-card">
                  <div className="cand-info">
                    <h2>{selectedSubmission.studentName}</h2>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', margin: '4px 0 6px' }}>
                      <span style={{ background: 'var(--color-primary-500, #8b5cf6)', color: '#ffffff', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 700 }}>
                        Class: {selectedSubmission.studentClass || 'General'}
                      </span>
                      {selectedSubmission.candidateNumber && (
                        <span style={{ background: 'rgba(255, 255, 255, 0.1)', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem', fontFamily: 'monospace' }}>
                          Cand ID: {selectedSubmission.candidateNumber}
                        </span>
                      )}
                    </div>
                    <p>
                      Submitted on {formatSubmissionDateTime(selectedSubmission.submittedAt)}
                      {selectedSubmission.durationSeconds > 0 ? ` • Duration: ${Math.floor(selectedSubmission.durationSeconds / 60)}m ${selectedSubmission.durationSeconds % 60}s` : ''}
                    </p>
                  </div>

                  <div className="cand-grade">
                    <span className="cand-grade-num">
                      {selectedSubmission.score} / {selectedSubmission.totalMarks}
                    </span>
                    <span className="cand-grade-pct">{selectedSubmission.percentage.toFixed(1)}%</span>
                  </div>

                  <div className="cand-actions">
                    <button
                      type="button"
                      className="qrm-btn"
                      style={{
                        background: '#7c3aed',
                        color: '#ffffff',
                        fontWeight: 700,
                        fontSize: '0.8125rem',
                        padding: '6px 12px',
                        borderRadius: '6px',
                        border: 'none',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                      onClick={() => exportStudentFeedbackReportPdf(selectedSubmission)}
                      title="Print 1-page student feedback & improvement report card"
                    >
                      🎓 1-Page Report
                    </button>

                    <button
                      type="button"
                      className="qrm-btn"
                      style={{
                        background: '#dc2626',
                        color: '#ffffff',
                        fontWeight: 700,
                        fontSize: '0.8125rem',
                        padding: '6px 12px',
                        borderRadius: '6px',
                        border: 'none',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                      onClick={() => exportIndividualStudentReportPdf(selectedSubmission)}
                      title="Export this candidate's full diagnostic script as PDF"
                    >
                      📄 Full Script
                    </button>

                    <button
                      type="button"
                      className="qrm-btn qrm-btn-excel-sm"
                      onClick={() => handleExportSingleExcel(selectedSubmission)}
                      title="Export individual student report to Excel (.xlsx)"
                    >
                      📗 Export Excel (.xlsx)
                    </button>

                    <button
                      type="button"
                      className="cand-delete-btn"
                      onClick={() => handleDelete(selectedSubmission.id)}
                      title="Delete this submission"
                    >
                      🗑️
                    </button>
                  </div>
                </div>

                {/* 🔒 Anti-Cheating & Proctoring Audit Box (Only for Online exams) */}
                {selectedSubmission.durationSeconds > 0 && !selectedSubmission.quizCode?.startsWith('OFFLINE') && (
                <div className={`qrm-proctor-card ${selectedSubmission.violationsCount > 0 ? 'alert' : 'clean'}`}>
                  <div className="proctor-header">
                    <span className="proctor-icon">
                      {selectedSubmission.violationsCount === 0 ? '🛡️' : '🚨'}
                    </span>
                    <div>
                      <strong>Exam Browser & Proctoring Audit Trail</strong>
                      <p>
                        {selectedSubmission.violationsCount === 0
                          ? 'Zero suspicious events detected. Candidate remained in fullscreen and stayed focused.'
                          : `${selectedSubmission.violationsCount} security violation strike(s) recorded during the session.`}
                      </p>
                    </div>
                  </div>

                  {selectedSubmission.proctoringLogs && selectedSubmission.proctoringLogs.length > 0 && (
                    <div className="proctor-timeline">
                      {selectedSubmission.proctoringLogs.map((log, idx) => (
                        <div key={idx} className="proctor-log-item">
                          <span className="log-strike-tag">Strike {log.strike}</span>
                          <span className="log-time">
                            {formatProctorTimestamp(log.timestamp)}
                          </span>
                          <span className="log-event">{log.event}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                )}

                {/* Topic Breakdown Progress */}
                {selectedSubmission.topicBreakdown && Object.keys(selectedSubmission.topicBreakdown).length > 0 && (
                  <div className="qrm-topics-card">
                    <h4>Topic Mastery Breakdown</h4>
                    <div className="topic-bars">
                      {Object.entries(selectedSubmission.topicBreakdown).map(([top, data]) => (
                        <div key={top} className="topic-bar-row">
                          <div className="topic-bar-labels">
                            <span>{top}</span>
                            <span>{data.earnedMarks} / {data.totalMarks} ({Math.round(data.percentage)}%)</span>
                          </div>
                          <div className="topic-progress-bg">
                            <div
                              className="topic-progress-fill"
                              style={{ width: `${Math.min(100, Math.max(0, data.percentage))}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Detailed Questions & Answers List */}
                <div className="qrm-questions-breakdown">
                  <h4>Question Responses ({selectedSubmission.questionResults?.length || 0})</h4>

                  <div className="qrm-questions-list">
                    {selectedSubmission.questionResults?.map((qr) => (
                      <div
                        key={qr.questionId}
                        className={`qrm-q-item ${qr.isCorrect ? 'correct' : 'incorrect'}`}
                      >
                        <div className="q-item-header">
                          <div className="q-num-topic">
                            <span className="q-badge">Q{qr.questionNumber}</span>
                            <span className="q-topic">{qr.topic}</span>
                          </div>

                          <div className="q-marks-tag" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {editingQuestionId === qr.questionId ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="number"
                                  min={0}
                                  max={qr.maxMarks}
                                  value={editMarksInput}
                                  onChange={(e) => setEditMarksInput(Math.max(0, Math.min(qr.maxMarks, Number(e.target.value))))}
                                  style={{
                                    width: '48px',
                                    padding: '2px 4px',
                                    borderRadius: '4px',
                                    border: '1px solid var(--color-border)',
                                    background: 'var(--color-surface)',
                                    color: 'var(--color-text-primary)',
                                    fontWeight: 700,
                                    textAlign: 'center',
                                    fontSize: '0.8125rem',
                                  }}
                                />
                                <span>/ {qr.maxMarks}</span>
                                <button
                                  type="button"
                                  className="sq-btn sq-btn-primary"
                                  style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                                  onClick={() => handleSaveMarkOverride(qr)}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  className="sq-btn sq-btn-secondary"
                                  style={{ padding: '2px 6px', fontSize: '0.75rem' }}
                                  onClick={() => setEditingQuestionId(null)}
                                >
                                  ✕
                                </button>
                              </div>
                            ) : (
                              <>
                                <span>
                                  {qr.isCorrect ? '✓ ' : '✗ '}
                                  {qr.earnedMarks} / {qr.maxMarks} Mark{qr.maxMarks !== 1 ? 's' : ''}
                                </span>
                                <button
                                  type="button"
                                  style={{
                                    background: 'rgba(255, 255, 255, 0.08)',
                                    border: '1px solid var(--color-border)',
                                    color: 'var(--color-text-secondary)',
                                    borderRadius: '4px',
                                    padding: '2px 6px',
                                    fontSize: '0.7rem',
                                    cursor: 'pointer',
                                  }}
                                  onClick={() => handleStartEditing(qr)}
                                  title="Adjust mark or add teacher remark"
                                >
                                  ✏️ Remark
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Teacher Remark Input Form if editing */}
                        {editingQuestionId === qr.questionId && (
                          <div style={{ padding: '8px 12px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '6px', margin: '6px 0' }}>
                            <label style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>
                              Teacher Remark / Feedback Annotation:
                            </label>
                            <input
                              type="text"
                              placeholder="e.g. Awarded +1 for valid alternative derivation of molar volume"
                              value={editTeacherNote}
                              onChange={(e) => setEditTeacherNote(e.target.value)}
                              style={{
                                width: '100%',
                                padding: '6px 10px',
                                borderRadius: '6px',
                                border: '1px solid var(--color-border)',
                                background: 'var(--color-surface)',
                                color: 'var(--color-text-primary)',
                                fontSize: '0.8125rem',
                                boxSizing: 'border-box',
                              }}
                            />
                          </div>
                        )}

                        <div className="q-answer-details">
                          {/* Sub-Questions Results if present */}
                          {qr.subQuestionResults && qr.subQuestionResults.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
                              {qr.subQuestionResults.map((sub, sIdx) => (
                                <div
                                  key={sIdx}
                                  style={{
                                    background: 'var(--color-surface-sunken)',
                                    padding: '8px 12px',
                                    borderRadius: 'var(--radius-md)',
                                    border: '1px solid var(--color-border)',
                                    fontSize: '0.8125rem',
                                  }}
                                >
                                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                    <strong>Part ({sub.subId})</strong>
                                    <span style={{ color: sub.isCorrect ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                                      {sub.earnedMarks} / {sub.maxMarks} mark{sub.maxMarks !== 1 ? 's' : ''}
                                    </span>
                                  </div>
                                  <div style={{ color: 'var(--color-text-secondary)' }}>
                                    Candidate Answer:{' '}
                                    <strong style={{ color: 'var(--color-text-primary)' }}>
                                      <ExamMathText content={String(sub.studentAnswer || '(blank)')} />
                                    </strong>
                                  </div>
                                  {sub.feedback && (
                                    <div style={{ fontSize: '0.75rem', color: sub.isCorrect ? '#22c55e' : 'var(--color-text-secondary)', marginTop: 2 }}>
                                      <ExamMathText content={sub.feedback} />
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="ans-block">
                              <span className="ans-lbl">Student Answer:</span>
                              <span className={`ans-val ${qr.isCorrect ? 'correct-text' : 'wrong-text'}`}>
                                {typeof qr.studentAnswer === 'number'
                                  ? `Option ${String.fromCharCode(65 + qr.studentAnswer)}`
                                  : <ExamMathText content={String(qr.studentAnswer || '(No answer provided)')} />}
                              </span>
                            </div>
                          )}

                          {qr.aiFeedback && (
                            <div style={{ background: 'rgba(139, 92, 246, 0.1)', border: '1px solid rgba(139, 92, 246, 0.3)', borderRadius: '6px', padding: '6px 10px', margin: '6px 0', fontSize: '0.8125rem' }}>
                              <strong style={{ color: '#a78bfa', display: 'block', marginBottom: 2 }}>💡 Examiner Feedback:</strong>
                              <ExamMathText content={qr.aiFeedback} />
                            </div>
                          )}

                          {qr.correctAnswer && (
                            <div className="ans-block">
                              <span className="ans-lbl">Model Solution / Correct Answer:</span>
                              <div className="ans-val model-text">
                                <ExamMathText content={qr.correctAnswer} />
                              </div>
                            </div>
                          )}

                          {qr.misconceptions && qr.misconceptions.length > 0 && (
                            <div className="ans-misconceptions">
                              <span className="misc-lbl">⚠️ Common Misconception:</span>
                              <ul>
                                {qr.misconceptions.map((m, mIdx) => (
                                  <li key={mIdx}>{m}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
