import { useState, useMemo } from 'react';
import type { PublishedQuiz } from '../services/quizManagerService';
import {
  getSubmissionsForQuiz,
  deleteSubmission,
  clearSubmissionsForQuiz,
  updateSubmission,
  exportAllSubmissionsExcel,
  exportSingleSubmissionExcel,
  type StudentSubmission,
  type QuestionSubmissionResult,
} from '../services/quizSubmissionService';
import {
  exportClassQuizReportPdf,
  exportIndividualStudentReportPdf,
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

  const refreshSubmissions = () => {
    setSubmissions(getSubmissionsForQuiz(quiz.id, quiz.quizCode));
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

  return (
    <div className="qrm-backdrop animate-fade-in" onClick={onClose}>
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
                            </div>
                          </div>
                        </div>

                        <div className="qrm-sc-score-badge">
                          <span className={`score-tag ${percent >= 70 ? 'high' : percent >= 40 ? 'med' : 'low'}`}>
                            {sub.score} / {sub.totalMarks} ({percent}%)
                          </span>
                        </div>
                      </div>

                      <div className="qrm-sc-bottom">
                        <span className="qrm-sc-time">
                          🕒 {Math.floor(sub.durationSeconds / 60)}m {sub.durationSeconds % 60}s • {new Date(sub.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
                      Submitted on {new Date(selectedSubmission.submittedAt).toLocaleString()} • Duration: {Math.floor(selectedSubmission.durationSeconds / 60)}m {selectedSubmission.durationSeconds % 60}s
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
                      title="Export this candidate's diagnostic report as PDF"
                    >
                      📄 Export PDF Report
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

                {/* 🔒 Anti-Cheating & Proctoring Audit Box */}
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
                            {new Date(log.timestamp).toLocaleTimeString()}
                          </span>
                          <span className="log-event">{log.event}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

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
