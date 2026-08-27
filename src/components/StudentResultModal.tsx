import { useState, useEffect } from 'react';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import {
  fetchStudentResultsCloud,
  formatSubmissionDateTime,
  formatCandidateAnswer,
  type StudentSubmission,
} from '../services/quizSubmissionService';
import { exportIndividualStudentReportPdf } from '../services/quizReportPdfService';
import { ExamMathText } from './ExamMathText';
import './StudentResultModal.css';

interface StudentResultModalProps {
  isOpen: boolean;
  quizCode: string;
  candidateIdentifier: string;
  pin?: string;
  onClose: () => void;
}

export function StudentResultModal({
  isOpen,
  quizCode,
  candidateIdentifier,
  pin,
  onClose,
}: StudentResultModalProps) {
  const [loading, setLoading] = useState<boolean>(true);
  const [submissions, setSubmissions] = useState<StudentSubmission[]>([]);
  const [hasUnreleased, setHasUnreleased] = useState<boolean>(false);
  const [pinMismatch, setPinMismatch] = useState<boolean>(false);
  const [selectedSubmission, setSelectedSubmission] = useState<StudentSubmission | null>(null);

  useEffect(() => {
    if (!isOpen || !quizCode || !candidateIdentifier) {
      setSubmissions([]);
      setSelectedSubmission(null);
      setPinMismatch(false);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setPinMismatch(false);

    fetchStudentResultsCloud(quizCode, candidateIdentifier, pin)
      .then((res) => {
        if (!isMounted) return;
        setSubmissions(res.submissions);
        setHasUnreleased(res.hasUnreleased);
        setPinMismatch(!!res.pinMismatch);
        // If there is exactly one published submission, auto-select it directly
        if (res.submissions.length === 1) {
          setSelectedSubmission(res.submissions[0]);
        } else {
          setSelectedSubmission(null);
        }
      })
      .catch((err) => {
        console.error('Failed to load student results:', err);
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, quizCode, candidateIdentifier, pin]);

  const backdropDismiss = useBackdropDismiss(onClose);

  const getGradeInfo = (percentage: number) => {
    if (percentage >= 90) return { label: 'A*', className: 'srm-grade-pill--a' };
    if (percentage >= 80) return { label: 'A', className: 'srm-grade-pill--a' };
    if (percentage >= 70) return { label: 'B', className: 'srm-grade-pill--b' };
    if (percentage >= 60) return { label: 'C', className: 'srm-grade-pill--c' };
    if (percentage >= 50) return { label: 'D', className: 'srm-grade-pill--c' };
    if (percentage >= 40) return { label: 'E', className: 'srm-grade-pill--u' };
    return { label: 'U', className: 'srm-grade-pill--u' };
  };

  if (!isOpen) return null;

  return (
    <div className="srm-backdrop animate-fade-in" {...backdropDismiss}>
      <div className="srm-modal animate-scale-up" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="srm-header">
          <div className="srm-header-info">
            <span className="srm-badge">CANDIDATE RESULTS PORTAL</span>
            <h2 className="srm-title">
              {selectedSubmission ? selectedSubmission.quizTitle : `Exam Results: ${quizCode.toUpperCase()}`}
            </h2>
            <p className="srm-subtitle">
              Candidate: <strong>{candidateIdentifier}</strong> • Assessment Code: <strong>{quizCode.toUpperCase()}</strong>
            </p>
          </div>
          <button type="button" className="srm-close-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {/* Body Content */}
        <div className="srm-body">
          {loading ? (
            <div className="srm-loading-state">
              <div className="srm-spinner" />
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 6px' }}>
                Connecting to Examiner Cloud...
              </h3>
              <p style={{ color: '#94a3b8', fontSize: '0.875rem', margin: 0 }}>
                Retrieving your marked assessment scripts and examiner feedback.
              </p>
            </div>
          ) : submissions.length === 0 ? (
            <div className="srm-empty-state">
              <div className="srm-empty-icon">{pinMismatch ? '🔐' : hasUnreleased ? '⏳' : '🔍'}</div>
              <h3 className="srm-empty-title">
                {pinMismatch
                  ? 'Incorrect Personal Access PIN'
                  : hasUnreleased
                  ? 'Evaluation In Progress'
                  : 'No Published Submissions Found'}
              </h3>
              <p className="srm-empty-desc">
                {pinMismatch
                  ? 'The 3-digit PIN entered does not match this candidate\'s examination receipt. Please verify the 3-digit PIN displayed on your exam confirmation screen and try again.'
                  : hasUnreleased
                  ? 'Your examination responses have been safely received! The examiner is currently reviewing and grading the class. Please check back soon once results are officially released.'
                  : `We could not find any published exam attempts for "${candidateIdentifier}" under code "${quizCode}". Please double check your Quiz Code or Candidate Name / Number.`}
              </p>
            </div>
          ) : selectedSubmission ? (
            /* Detailed Result View for Selected Attempt */
            <div className="srm-detail-view animate-fade-in">
              {/* Back Bar & Actions */}
              <div className="srm-detail-back-bar">
                {submissions.length > 1 ? (
                  <button
                    type="button"
                    className="srm-back-btn"
                    onClick={() => setSelectedSubmission(null)}
                  >
                    ← Back to All Attempts ({submissions.length})
                  </button>
                ) : (
                  <span style={{ fontSize: '0.875rem', color: '#94a3b8' }}>
                    📅 Submitted {formatSubmissionDateTime(selectedSubmission.submittedAt)}
                  </span>
                )}

                <button
                  type="button"
                  className="srm-download-pdf-btn"
                  onClick={() => exportIndividualStudentReportPdf(selectedSubmission)}
                >
                  📄 Download Examiner PDF Report
                </button>
              </div>

              {/* Score Summary Card */}
              <div
                style={{
                  background: '#1e293b',
                  borderRadius: '12px',
                  padding: '20px 24px',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '24px',
                  flexWrap: 'wrap',
                }}
              >
                <div className="srm-detail-score-circle">
                  <span className="srm-detail-score-num">{Math.round(selectedSubmission.percentage)}%</span>
                  <span className="srm-detail-score-sub">
                    {selectedSubmission.score} / {selectedSubmission.totalMarks} Marks
                  </span>
                </div>

                <div style={{ flex: 1, minWidth: '220px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ color: '#94a3b8', fontSize: '0.875rem' }}>Official Grade:</span>
                    <span
                      className={`srm-grade-pill ${getGradeInfo(selectedSubmission.percentage).className}`}
                      style={{ fontSize: '0.9rem', padding: '3px 12px' }}
                    >
                      Grade {getGradeInfo(selectedSubmission.percentage).label}
                    </span>
                  </div>

                  <div style={{ fontSize: '0.875rem', color: '#cbd5e1' }}>
                    ⏱️ Time Taken: <strong>{Math.floor(selectedSubmission.durationSeconds / 60)}m {selectedSubmission.durationSeconds % 60}s</strong>
                  </div>

                  <div style={{ fontSize: '0.875rem', color: '#cbd5e1' }}>
                    🛡️ Proctor Status:{' '}
                    <strong style={{ color: selectedSubmission.violationsCount === 0 ? '#4ade80' : '#f87171' }}>
                      {selectedSubmission.violationsCount === 0 ? 'Clean (0 Strikes) ✅' : `${selectedSubmission.violationsCount} Warning Strikes ⚠️`}
                    </strong>
                  </div>

                  {selectedSubmission.teacherNotes && (
                    <div
                      style={{
                        background: 'rgba(234, 179, 8, 0.1)',
                        border: '1px solid rgba(234, 179, 8, 0.3)',
                        borderRadius: '6px',
                        padding: '6px 10px',
                        fontSize: '0.8rem',
                        color: '#fef08a',
                        marginTop: '4px',
                      }}
                    >
                      💬 <strong>Teacher Note:</strong> {selectedSubmission.teacherNotes}
                    </div>
                  )}
                </div>
              </div>

              {/* Topic Mastery Breakdown */}
              {selectedSubmission.topicBreakdown && Object.keys(selectedSubmission.topicBreakdown).length > 0 && (
                <div style={{ marginTop: '20px' }}>
                  <h4 style={{ fontSize: '0.9375rem', fontWeight: 800, margin: '0 0 10px', color: '#e2e8f0' }}>
                    📊 Topic Mastery Breakdown
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {Object.entries(selectedSubmission.topicBreakdown).map(([top, stat]) => {
                      const pct = Math.round(stat.percentage);
                      return (
                        <div
                          key={top}
                          style={{
                            background: '#1e293b',
                            borderRadius: '8px',
                            padding: '10px 14px',
                            border: '1px solid rgba(255, 255, 255, 0.06)',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '6px' }}>
                            <span style={{ fontWeight: 700, color: '#f1f5f9' }}>{top}</span>
                            <span style={{ color: '#94a3b8' }}>
                              {stat.earnedMarks} / {stat.totalMarks} marks ({pct}%)
                            </span>
                          </div>
                          <div style={{ height: '6px', background: '#0f172a', borderRadius: '3px', overflow: 'hidden' }}>
                            <div
                              style={{
                                width: `${pct}%`,
                                height: '100%',
                                background: pct >= 80 ? '#22c55e' : pct >= 50 ? '#3b82f6' : '#ef4444',
                                borderRadius: '3px',
                                transition: 'width 0.5s ease',
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Question-by-Question Marking & Feedback */}
              <div style={{ marginTop: '24px' }}>
                <h4 style={{ fontSize: '0.9375rem', fontWeight: 800, margin: '0 0 12px', color: '#e2e8f0' }}>
                  📝 Question-by-Question Script & Feedback
                </h4>
                <div className="srm-questions-list">
                  {selectedSubmission.questionResults.map((q, idx) => {
                    const isFull = q.earnedMarks === q.maxMarks;
                    return (
                      <div key={idx} className="srm-q-card">
                        <div className="srm-q-header">
                          <span className="srm-q-num">Question {q.questionNumber} ({q.topic})</span>
                          <span
                            className="srm-q-marks-pill"
                            style={{
                              background: isFull ? 'rgba(34, 197, 94, 0.2)' : q.earnedMarks > 0 ? 'rgba(234, 179, 8, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                              color: isFull ? '#4ade80' : q.earnedMarks > 0 ? '#facc15' : '#f87171',
                            }}
                          >
                            {q.earnedMarks} / {q.maxMarks} Marks
                          </span>
                        </div>

                        {/* Question Stem Prompt if available */}
                        {q.questionText && (
                          <div style={{ margin: '8px 0 10px', color: '#e2e8f0', fontSize: '0.875rem', lineHeight: '1.5', background: 'rgba(255, 255, 255, 0.04)', borderLeft: '3px solid #6366f1', padding: '8px 12px', borderRadius: '0 8px 8px 0' }}>
                            <ExamMathText content={q.questionText} />
                          </div>
                        )}

                        {/* Student Response */}
                        <div className="srm-q-ans-box">
                          <span style={{ color: '#94a3b8', fontSize: '0.75rem', display: 'block', marginBottom: '4px', textTransform: 'uppercase', fontWeight: 700 }}>
                            Your Submitted Response:
                          </span>
                          <div style={{ color: '#f8fafc' }}>
                            <ExamMathText
                              content={formatCandidateAnswer(q.studentAnswer, q.options, q.gradingMethod)}
                            />
                          </div>
                        </div>

                        {/* Model Answer / Correct Solution */}
                        {q.correctAnswer && (
                          <div
                            style={{
                              background: 'rgba(34, 197, 94, 0.06)',
                              border: '1px solid rgba(34, 197, 94, 0.2)',
                              borderRadius: '8px',
                              padding: '10px 14px',
                              marginTop: '6px',
                              fontSize: '0.875rem',
                            }}
                          >
                            <span style={{ color: '#86efac', fontSize: '0.75rem', display: 'block', marginBottom: '4px', textTransform: 'uppercase', fontWeight: 700 }}>
                              Official Mark Scheme Reference:
                            </span>
                            <div style={{ color: '#f0fdf4' }}>
                              <ExamMathText content={formatCandidateAnswer(q.correctAnswer, q.options, q.gradingMethod)} />
                            </div>
                          </div>
                        )}

                        {/* AI Examiner Advice */}
                        {q.aiFeedback && (
                          <div className="srm-feedback-box">
                            <strong>💡 Examiner Note:</strong> {q.aiFeedback}
                          </div>
                        )}

                        {/* Criteria Breakdown */}
                        {q.criteriaBreakdown && q.criteriaBreakdown.length > 0 && (
                          <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {q.criteriaBreakdown.map((crit, cIdx) => (
                              <div
                                key={cIdx}
                                style={{
                                  fontSize: '0.8rem',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '6px',
                                  color: crit.achieved ? '#86efac' : '#fca5a5',
                                }}
                              >
                                <span>{crit.achieved ? '✓' : '✗'}</span>
                                <span>{crit.point}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            /* Attempt History Cards View (Multiple Attempts Found) */
            <div className="srm-attempts-list-view animate-fade-in">
              <div className="srm-history-header">
                <span className="srm-history-title">
                  Attempt History for <strong>{candidateIdentifier}</strong>
                </span>
                <span className="srm-attempt-count-pill">{submissions.length} Attempts Found</span>
              </div>

              <div className="srm-cards-list">
                {submissions.map((sub, index) => {
                  const attemptNumber = submissions.length - index;
                  const isLatest = index === 0;
                  const grade = getGradeInfo(sub.percentage);

                  return (
                    <div
                      key={sub.id}
                      className={`srm-attempt-card ${isLatest ? 'srm-attempt-card--latest' : ''}`}
                    >
                      <div className="srm-card-main">
                        <div className="srm-attempt-tags">
                          <span className="srm-attempt-number-badge">Attempt {attemptNumber}</span>
                          {isLatest && <span className="srm-latest-badge">LATEST</span>}
                          <span className={`srm-grade-pill ${grade.className}`}>Grade {grade.label}</span>
                        </div>

                        <div className="srm-attempt-datetime">
                          <span>📅</span>
                          <span>{formatSubmissionDateTime(sub.submittedAt)}</span>
                        </div>

                        <div className="srm-attempt-metrics">
                          <div className="srm-metric-item">
                            <span>🎯</span>
                            <strong>
                              {sub.score} / {sub.totalMarks} Marks ({Math.round(sub.percentage)}%)
                            </strong>
                          </div>

                          <div className="srm-metric-item">
                            <span>⏱️</span>
                            <span>
                              {Math.floor(sub.durationSeconds / 60)}m {sub.durationSeconds % 60}s
                            </span>
                          </div>

                          <div className="srm-metric-item">
                            <span>🛡️</span>
                            <span style={{ color: sub.violationsCount === 0 ? '#4ade80' : '#f87171' }}>
                              {sub.violationsCount === 0 ? 'Clean (0 Strikes)' : `${sub.violationsCount} Strikes`}
                            </span>
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        className="srm-view-btn"
                        onClick={() => setSelectedSubmission(sub)}
                      >
                        View Marked Paper →
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
