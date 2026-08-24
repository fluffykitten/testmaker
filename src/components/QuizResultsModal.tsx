import { useState, useMemo } from 'react';
import type { PublishedQuiz } from '../services/quizManagerService';
import {
  getSubmissionsForQuiz,
  deleteSubmission,
  clearSubmissionsForQuiz,
  exportAllSubmissionsExcel,
  exportSingleSubmissionExcel,
  type StudentSubmission,
} from '../services/quizSubmissionService';
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

  const refreshSubmissions = () => {
    setSubmissions(getSubmissionsForQuiz(quiz.id, quiz.quizCode));
  };

  // ─── Analytics Summary ──────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (submissions.length === 0) {
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

    const count = submissions.length;
    const totalScore = submissions.reduce((s, sub) => s + sub.score, 0);
    const avgScore = totalScore / count;
    const avgPercentage = (avgScore / (quiz.totalMarks || 1)) * 100;
    const highestScore = Math.max(...submissions.map((s) => s.score));
    const lowestScore = Math.min(...submissions.map((s) => s.score));
    const cleanCount = submissions.filter((s) => s.violationsCount === 0).length;
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
  }, [submissions, quiz.totalMarks]);

  // ─── Filtered Submissions ───────────────────────────────────────────────────
  const filteredSubmissions = useMemo(() => {
    return submissions.filter((sub) => {
      const q = searchFilter.toLowerCase().trim();
      const matchesSearch = !q || sub.studentName.toLowerCase().includes(q);
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'clean' && sub.violationsCount === 0) ||
        (statusFilter === 'flagged' && sub.violationsCount > 0);

      return matchesSearch && matchesStatus;
    });
  }, [submissions, searchFilter, statusFilter]);

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
              <button
                type="button"
                className="qrm-btn qrm-btn-excel"
                onClick={handleExportAllExcel}
                title="Export all results to Excel (.xlsx)"
              >
                📗 Export All (Excel .xlsx)
              </button>
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
            <span className="kpi-lbl">Total Students</span>
          </div>
          <div className="qrm-kpi-card">
            <span className="kpi-val">
              {stats.count > 0 ? `${stats.avgScore.toFixed(1)} / ${quiz.totalMarks}` : '-'}
            </span>
            <span className="kpi-lbl">Class Average ({stats.avgPercentage.toFixed(0)}%)</span>
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
                placeholder="Search candidate name..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
              />

              <div className="qrm-status-filter-pills">
                <button
                  type="button"
                  className={`qrm-filter-pill ${statusFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('all')}
                >
                  All ({submissions.length})
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
                          <strong className="qrm-sc-name">{sub.studentName}</strong>
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
                      className="qrm-btn qrm-btn-excel-sm"
                      onClick={() => handleExportSingleExcel(selectedSubmission)}
                      title="Export individual student report to Excel (.xlsx)"
                    >
                      📗 Export Student Report (.xlsx)
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

                          <div className="q-marks-tag">
                            {qr.isCorrect ? '✓ ' : '✗ '}
                            {qr.earnedMarks} / {qr.maxMarks} Mark{qr.maxMarks !== 1 ? 's' : ''}
                          </div>
                        </div>

                        <div className="q-answer-details">
                          <div className="ans-block">
                            <span className="ans-lbl">Student Answer:</span>
                            <span className={`ans-val ${qr.isCorrect ? 'correct-text' : 'wrong-text'}`}>
                              {typeof qr.studentAnswer === 'number'
                                ? `Option ${String.fromCharCode(65 + qr.studentAnswer)}`
                                : String(qr.studentAnswer || '(No answer provided)')}
                            </span>
                          </div>

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
