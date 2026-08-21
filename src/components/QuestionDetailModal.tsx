import { useState } from 'react';
import type { Question } from '../types/database';
import { ExamMathText } from './ExamMathText';
import './QuestionDetailModal.css';

interface QuestionDetailModalProps {
  question: Question | null;
  onClose: () => void;
  isSelected?: boolean;
  onToggleSelect?: (question: Question) => void;
}

export function QuestionDetailModal({
  question,
  onClose,
  isSelected = false,
  onToggleSelect,
}: QuestionDetailModalProps) {
  const [copied, setCopied] = useState(false);
  const [showMarkScheme, setShowMarkScheme] = useState(true);

  if (!question) return null;

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(question.question_text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const difficultyClass = (diff: string | null) => {
    switch (diff) {
      case 'Easy':
        return 'q-badge--easy';
      case 'Medium':
        return 'q-badge--medium';
      case 'Hard':
        return 'q-badge--hard';
      default:
        return 'q-badge--default';
    }
  };

  return (
    <div className="modal-backdrop animate-fade-in" onClick={onClose}>
      <div
        className="modal-card animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="modal-header">
          <div className="modal-header-left">
            <h2 className="modal-title">Question {question.question_number}</h2>
            <span className="q-badge q-badge--paper">
              📄 Paper {question.paper_number || '1'} ({question.series || 'Exam'} {question.year})
            </span>
            {question.difficulty && (
              <span className={`q-badge ${difficultyClass(question.difficulty)}`}>
                {question.difficulty}
              </span>
            )}
            <span className="q-marks-badge">[{question.marks} marks]</span>
          </div>

          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            title="Close modal"
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div className="modal-body">
          {/* Metadata tags */}
          <div className="modal-meta-row">
            <span className="modal-meta-tag">
              <strong>Topic:</strong> {question.topic}
            </span>
            {question.sub_topic && (
              <span className="modal-meta-tag">
                <strong>Sub-topic:</strong> {question.sub_topic}
              </span>
            )}
            {question.question_style && (
              <span className="modal-meta-tag">
                <strong>Style:</strong> {question.question_style}
              </span>
            )}
          </div>

          {/* Stem Text */}
          <div className="modal-section">
            <h4 className="modal-section-title">Question Stem</h4>
            <div className="modal-stem-text">
              <ExamMathText content={question.question_text} />
            </div>
          </div>

          {/* Diagram Preview */}
          {question.diagram_url && (
            <div className="modal-section">
              <h4 className="modal-section-title">Diagram / Visual Resource</h4>
              <div className="modal-diagram-box">
                <img
                  src={question.diagram_url}
                  alt={`Diagram for Question ${question.question_number}`}
                  className="modal-diagram-img"
                />
              </div>
            </div>
          )}

          {/* MCQ Options (Multiple Choice Questions) */}
          {question.options && question.options.length > 0 && (
            <div className="modal-section">
              <h4 className="modal-section-title">Multiple Choice Options</h4>
              <div className="modal-mcq-grid">
                {question.options.map((opt, oi) => (
                  <div key={oi} className="modal-mcq-choice">
                    <ExamMathText content={opt} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sub-Questions (Paper 4 / Structured) */}
          {question.sub_questions && question.sub_questions.length > 0 && (
            <div className="modal-section">
              <h4 className="modal-section-title">Sub-Questions ({question.sub_questions.length} parts)</h4>
              <div className="modal-sub-list">
                {question.sub_questions.map((sub, si) => (
                  <div key={si} className="modal-sub-card">
                    <div className="modal-sub-header">
                      <span className="modal-sub-id">{sub.sub_id}</span>
                      <div className="modal-sub-text">
                        <ExamMathText content={sub.question_text} />
                      </div>
                      <span className="modal-sub-marks">[{sub.marks} mark{sub.marks !== 1 ? 's' : ''}]</span>
                    </div>

                    {sub.mark_scheme && showMarkScheme && (
                      <div className="modal-sub-ms">
                        <span className="modal-ms-label">Mark Scheme:</span>
                        <div className="modal-ms-content">
                          <ExamMathText
                            content={
                              typeof sub.mark_scheme === 'string'
                                ? sub.mark_scheme
                                : Array.isArray(sub.mark_scheme)
                                  ? (sub.mark_scheme as string[]).join('; ')
                                  : JSON.stringify(sub.mark_scheme)
                            }
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Parent Mark Scheme */}
          {question.mark_scheme && (
            <div className="modal-section">
              <div className="modal-section-header-flex">
                <h4 className="modal-section-title">Mark Scheme & Answers</h4>
                <button
                  type="button"
                  className="modal-toggle-ms-btn"
                  onClick={() => setShowMarkScheme(!showMarkScheme)}
                >
                  {showMarkScheme ? 'Hide' : 'Show'}
                </button>
              </div>

              {showMarkScheme && (
                <div className="modal-ms-box animate-fade-in">
                  {question.mark_scheme.marking_points?.map((pt, pi) => (
                    <div key={pi} className="modal-ms-point">
                      <span className="modal-ms-bullet">•</span>
                      <ExamMathText content={pt} />
                    </div>
                  ))}
                  {question.mark_scheme.acceptable_answers && question.mark_scheme.acceptable_answers.length > 0 && (
                    <div className="modal-ms-answers">
                      <span className="modal-ms-answers-label">Acceptable answers:</span>
                      {question.mark_scheme.acceptable_answers.map((ans, ai) => (
                        <span key={ai} className="q-ms-answer-pill">
                          <ExamMathText content={ans} />
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="modal-footer">
          <button
            type="button"
            className="modal-action-btn modal-action-btn--copy"
            onClick={handleCopyText}
          >
            {copied ? '✓ Copied LaTeX!' : '📋 Copy Question Text'}
          </button>

          <div className="modal-footer-right">
            <button
              type="button"
              className="modal-action-btn modal-action-btn--close"
              onClick={onClose}
            >
              Close
            </button>

            {onToggleSelect && (
              <button
                type="button"
                className={`modal-action-btn ${isSelected ? 'modal-action-btn--remove' : 'modal-action-btn--select'}`}
                onClick={() => onToggleSelect(question)}
              >
                {isSelected ? '✓ In Custom Test (Click to Remove)' : '+ Add to Custom Test'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
