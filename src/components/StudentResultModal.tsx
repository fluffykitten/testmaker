import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import {
  fetchStudentResultsCloud,
  formatSubmissionDateTime,
  formatCandidateAnswer,
  type StudentSubmission,
} from '../services/quizSubmissionService';
import {
  exportIndividualStudentReportPdf,
  exportStudentFeedbackReportPdf,
} from '../services/quizReportPdfService';
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
    if (percentage >= 90) return { label: 'A*', className: 'srm-grade-pill--a', stroke: '#10b981' };
    if (percentage >= 80) return { label: 'A', className: 'srm-grade-pill--a', stroke: '#10b981' };
    if (percentage >= 70) return { label: 'B', className: 'srm-grade-pill--b', stroke: '#2563eb' };
    if (percentage >= 60) return { label: 'C', className: 'srm-grade-pill--b', stroke: '#4f46e5' };
    if (percentage >= 50) return { label: 'D', className: 'srm-grade-pill--c', stroke: '#ca8a04' };
    if (percentage >= 40) return { label: 'E', className: 'srm-grade-pill--u', stroke: '#e11d48' };
    return { label: 'U', className: 'srm-grade-pill--u', stroke: '#e11d48' };
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="srm-backdrop animate-fade-in" {...backdropDismiss}>
      <div className="srm-modal animate-scale-up" onClick={(e) => e.stopPropagation()}>
        {/* Header Section (Direction 2: Executive Light Academic Dashboard) */}
        <div className="srm-header">
          <div className="srm-header-info">
            <div className="srm-badge-group">
              <span className="srm-badge-pill">Diagnostic Review</span>
              <span className="srm-badge-code">Assessment ID: {quizCode.toUpperCase()}</span>
            </div>
            <h2 className="srm-title">
              {selectedSubmission ? selectedSubmission.quizTitle : `Exam Results: ${quizCode.toUpperCase()}`}
            </h2>
            <p className="srm-subtitle">
              Candidate: <strong>{candidateIdentifier}</strong>
              {selectedSubmission && (
                <>
                  <span className="srm-subtitle-sep">|</span>
                  <span>📅 Submitted {formatSubmissionDateTime(selectedSubmission.submittedAt)}</span>
                </>
              )}
            </p>
          </div>
          <button type="button" className="srm-close-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {/* Scrollable Modal Body */}
        <div className="srm-body">
          {loading ? (
            <div className="srm-loading-state">
              <div className="srm-spinner" />
              <h3 style={{ fontSize: '1.15rem', fontWeight: 800, margin: '0 0 6px', color: '#0f172a' }}>
                Connecting to Examiner Cloud...
              </h3>
              <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0 }}>
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
                  ? "The 3-digit PIN entered does not match this candidate's examination receipt. Please verify the 3-digit PIN displayed on your exam confirmation screen and try again."
                  : hasUnreleased
                    ? 'Your examination responses have been safely received! The examiner is currently reviewing and grading the class. Please check back soon once results are officially released.'
                    : `We could not find any published exam attempts for "${candidateIdentifier}" under code "${quizCode}". Please double check your Quiz Code or Candidate Name / Number.`}
              </p>
            </div>
          ) : selectedSubmission ? (
            /* Detailed Result View for Selected Attempt */
            <div className="srm-detail-view animate-fade-in">
              {/* Back Bar (if multiple attempts) or Timestamp Pill */}
              <div className="srm-detail-back-bar">
                {submissions.length > 1 ? (
                  <button
                    type="button"
                    className="srm-back-btn"
                    onClick={() => setSelectedSubmission(null)}
                  >
                    <span>←</span> Back to All Attempts ({submissions.length})
                  </button>
                ) : (
                  <span className="srm-submitted-pill">
                    <span>📅</span> Official Marked Script Receipt
                  </span>
                )}
              </div>

              {/* Executive Scorecard Dashboard (Direction 2) */}
              <div className="srm-scorecard-grid">
                {/* Score & Integrity Ribbon */}
                <div className="srm-scorecard-card">
                  {/* Circular Radial Score Meter */}
                  <div className="srm-scorecard-ring-wrapper">
                    {(() => {
                      const roundedPct = Math.round(selectedSubmission.percentage);
                      const clampedPct = Math.max(0, Math.min(100, roundedPct));
                      const circumference = 251.32; // 2 * PI * 40
                      const strokeDashoffset = circumference - (circumference * clampedPct) / 100;
                      const grade = getGradeInfo(roundedPct);

                      return (
                        <>
                          <svg className="srm-scorecard-ring-svg" viewBox="0 0 100 100">
                            <circle
                              cx="50"
                              cy="50"
                              r="40"
                              stroke="#e2e8f0"
                              strokeWidth="7"
                              fill="transparent"
                            />
                            <circle
                              cx="50"
                              cy="50"
                              r="40"
                              stroke={grade.stroke}
                              strokeWidth="7"
                              fill="transparent"
                              strokeDasharray={circumference}
                              strokeDashoffset={strokeDashoffset}
                              strokeLinecap="round"
                              style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.16, 1, 0.3, 1)' }}
                            />
                          </svg>
                          <div className="srm-scorecard-ring-center">
                            <span className="srm-scorecard-ring-pct">{roundedPct}%</span>
                            <span className="srm-scorecard-ring-label">Score</span>
                          </div>
                        </>
                      );
                    })()}
                  </div>

                  {/* Badges & Metrics Breakdown */}
                  <div className="srm-scorecard-details">
                    <div className="srm-scorecard-badges">
                      <span className={`srm-grade-pill ${getGradeInfo(selectedSubmission.percentage).className}`}>
                        Grade {getGradeInfo(selectedSubmission.percentage).label}
                      </span>
                      <span className="srm-marks-badge">
                        {selectedSubmission.score} / {selectedSubmission.totalMarks} Total Marks
                      </span>
                    </div>

                    <div className="srm-scorecard-metrics">
                      <div className="srm-metric-box">
                        <div className="srm-metric-icon srm-metric-icon--duration">
                          ⏱️
                        </div>
                        <div>
                          <p className="srm-metric-label">Duration</p>
                          <p className="srm-metric-val">
                            {Math.floor(selectedSubmission.durationSeconds / 60)}m {selectedSubmission.durationSeconds % 60}s
                          </p>
                        </div>
                      </div>

                      <div className="srm-metric-box">
                        <div
                          className={`srm-metric-icon ${
                            selectedSubmission.violationsCount === 0
                              ? 'srm-metric-icon--clean'
                              : 'srm-metric-icon--warning'
                          }`}
                        >
                          🛡️
                        </div>
                        <div>
                          <p className="srm-metric-label">Integrity</p>
                          <p
                            className={`srm-metric-val ${
                              selectedSubmission.violationsCount === 0
                                ? 'srm-metric-val--clean'
                                : 'srm-metric-val--warning'
                            }`}
                          >
                            {selectedSubmission.violationsCount === 0
                              ? 'Clean (0 Strikes)'
                              : `${selectedSubmission.violationsCount} Warnings`}
                          </p>
                        </div>
                      </div>
                    </div>

                    {selectedSubmission.teacherNotes && (
                      <div className="srm-teacher-note-card">
                        <span>💬</span>
                        <div>
                          <strong>Teacher Note:</strong> {selectedSubmission.teacherNotes}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* PDF Action Dock */}
                <div className="srm-action-dock">
                  <button
                    type="button"
                    className="srm-btn-report-card"
                    onClick={() => exportStudentFeedbackReportPdf(selectedSubmission)}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                      <span>🎓</span> 1-Page Report Card
                    </span>
                    <span style={{ opacity: 0.7 }}>⬇</span>
                  </button>

                  <button
                    type="button"
                    className="srm-btn-full-script"
                    onClick={() => exportIndividualStudentReportPdf(selectedSubmission)}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                      <span>📄</span> Full Script PDF
                    </span>
                    <span style={{ color: '#94a3b8' }}>↗</span>
                  </button>
                </div>
              </div>

              {/* Competency Framework (Topic Mastery) */}
              {selectedSubmission.topicBreakdown && Object.keys(selectedSubmission.topicBreakdown).length > 0 && (
                <div style={{ marginBottom: '26px' }}>
                  <h3 className="srm-section-title">
                    <span>📊</span> Competency Framework
                  </h3>
                  <div className="srm-competency-grid">
                    {Object.entries(selectedSubmission.topicBreakdown).map(([top, stat]) => {
                      const pct = Math.round(stat.percentage);
                      const tier = pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low';
                      return (
                        <div key={top} className="srm-competency-card">
                          <div className="srm-competency-header">
                            <span className="srm-competency-name">{top}</span>
                            <span className={`srm-competency-pct srm-competency-pct--${tier}`}>
                              {pct}% Score
                            </span>
                          </div>
                          <div className="srm-competency-track">
                            <div
                              className={`srm-competency-fill srm-competency-fill--${tier}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <p className="srm-competency-sub">
                            {stat.earnedMarks} of {stat.totalMarks} Marks
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Detailed Response Analysis (Question-by-Question Script & Feedback) */}
              <div>
                <h3 className="srm-section-title">
                  <span>📝</span> Detailed Response Analysis
                </h3>
                <div className="srm-questions-list">
                  {selectedSubmission.questionResults.map((q, idx) => {
                    const isFull = q.earnedMarks === q.maxMarks;
                    const isZero = q.earnedMarks === 0;
                    const marksModifier = isFull ? 'full' : isZero ? 'zero' : 'partial';

                    const rawStudentAns = formatCandidateAnswer(q.studentAnswer, q.options, q.gradingMethod);
                    const isAnsEmpty = !rawStudentAns || rawStudentAns.trim() === '' || rawStudentAns === '[]';

                    return (
                      <div key={idx} className="srm-q-card">
                        {/* Question Header Strip */}
                        <div className="srm-q-header">
                          <div className="srm-q-header-left">
                            <span className="srm-q-badge-num">{q.questionNumber}</span>
                            <span className="srm-q-topic-title">{q.topic || `Question ${q.questionNumber}`}</span>
                            {q.gradingMethod && (
                              <>
                                <span className="srm-q-topic-sep">•</span>
                                <span className="srm-q-style-badge">
                                  {q.gradingMethod === 'mcq'
                                    ? 'Multiple Choice'
                                    : q.gradingMethod === 'deterministic'
                                      ? 'Objective Key'
                                      : q.gradingMethod === 'ai_gemini'
                                        ? 'Examiner AI Evaluated'
                                        : 'Structured Response'}
                                </span>
                              </>
                            )}
                          </div>
                          <span className={`srm-q-marks-pill srm-q-marks-pill--${marksModifier}`}>
                            {q.earnedMarks} / {q.maxMarks} {q.maxMarks === 1 ? 'Mark' : 'Marks'}
                          </span>
                        </div>

                        {/* Question Stem Prompt if available */}
                        {q.questionText && (
                          <div className="srm-q-stem">
                            <ExamMathText content={q.questionText} />
                          </div>
                        )}

                        {/* Candidate vs Marking Reference Grid */}
                        <div className="srm-q-comparison-grid">
                          {/* Student Response */}
                          <div className="srm-q-pane srm-q-pane--student">
                            <span className="srm-q-pane-label srm-q-pane-label--student">
                              <span>👤</span> Candidate Response
                            </span>
                            <div className="srm-q-pane-content">
                              {isAnsEmpty ? (
                                <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>
                                  [ No Response Recorded ]
                                </span>
                              ) : (
                                <ExamMathText content={rawStudentAns} />
                              )}
                            </div>
                          </div>

                          {/* Official Scheme / Model Answer */}
                          {q.correctAnswer && (
                            <div className="srm-q-pane srm-q-pane--scheme">
                              <span className="srm-q-pane-label srm-q-pane-label--scheme">
                                <span>✓</span> Marking Reference
                              </span>
                              <div className="srm-q-pane-content">
                                <ExamMathText
                                  content={formatCandidateAnswer(q.correctAnswer, q.options, q.gradingMethod)}
                                />
                              </div>
                            </div>
                          )}
                        </div>

                        {/* AI Examiner Guidance */}
                        {q.aiFeedback && (
                          <div className="srm-q-guidance-card">
                            <div className="srm-q-guidance-icon">💡</div>
                            <div className="srm-q-guidance-content">
                              <div className="srm-q-guidance-label">Examiner Guidance</div>
                              <p className="srm-q-guidance-text">{q.aiFeedback}</p>
                            </div>
                          </div>
                        )}

                        {/* Criteria Breakdown */}
                        {q.criteriaBreakdown && q.criteriaBreakdown.length > 0 && (
                          <div className="srm-criteria-list">
                            {q.criteriaBreakdown.map((crit, cIdx) => (
                              <div
                                key={cIdx}
                                className={`srm-criteria-item ${
                                  crit.achieved ? 'srm-criteria-item--achieved' : 'srm-criteria-item--missed'
                                }`}
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

              {/* Institutional Footer Branding */}
              <footer className="srm-footer-branding">
                <div className="srm-footer-logos">
                  <img
                    src="/logos/icm_school_logo.png"
                    alt="ICM Logo"
                    className="srm-footer-logo-img"
                  />
                  <div className="srm-footer-divider" />
                  <img
                    src="/logos/cambridge_assessment_logo.png"
                    alt="Cambridge Assessment"
                    className="srm-footer-logo-img"
                  />
                </div>
                <div className="srm-footer-text">
                  <p className="srm-footer-primary">Insan Cendekia Madani • ID395</p>
                  <p className="srm-footer-secondary">
                    Academic Integrity System • Cambridge International School
                  </p>
                </div>
              </footer>
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
                            <span
                              style={{
                                color: sub.violationsCount === 0 ? '#059669' : '#e11d48',
                                fontWeight: 700,
                              }}
                            >
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

              {/* Institutional Footer Branding */}
              <footer className="srm-footer-branding" style={{ marginTop: '32px' }}>
                <div className="srm-footer-logos">
                  <img
                    src="/logos/icm_school_logo.png"
                    alt="ICM Logo"
                    className="srm-footer-logo-img"
                  />
                  <div className="srm-footer-divider" />
                  <img
                    src="/logos/cambridge_assessment_logo.png"
                    alt="Cambridge Assessment"
                    className="srm-footer-logo-img"
                  />
                </div>
                <div className="srm-footer-text">
                  <p className="srm-footer-primary">Insan Cendekia Madani • ID395</p>
                  <p className="srm-footer-secondary">
                    Academic Integrity System • Cambridge International School
                  </p>
                </div>
              </footer>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
