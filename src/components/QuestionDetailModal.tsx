import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Question } from '../types/database';
import { ExamMathText } from './ExamMathText';
import { enrichQuestionWithGuidance } from '../lib/gemini';
import { updateQuestionMarkScheme } from '../services/questionBankService';
import './QuestionDetailModal.css';

interface QuestionDetailModalProps {
  question: Question | null;
  onClose: () => void;
  isSelected?: boolean;
  onToggleSelect?: (question: Question) => void;
  onQuestionUpdated?: (updated: Question) => void;
  onEdit?: (question: Question) => void;
  onGenerateVariant?: (question: Question) => void;
}

export function QuestionDetailModal({
  question: initialQuestion,
  onClose,
  isSelected = false,
  onToggleSelect,
  onQuestionUpdated,
  onEdit,
  onGenerateVariant,
}: QuestionDetailModalProps) {
  const [copied, setCopied] = useState(false);
  const [showMarkScheme, setShowMarkScheme] = useState(true);
  const [activeQuestion, setActiveQuestion] = useState<Question | null>(initialQuestion);
  const [isEnriching, setIsEnriching] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);

  useEffect(() => {
    setActiveQuestion(initialQuestion);
    setEnrichError(null);
  }, [initialQuestion]);

  if (!activeQuestion) return null;
  const question = activeQuestion;

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(question.question_text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleGenerateGuidance = async () => {
    setIsEnriching(true);
    setEnrichError(null);
    try {
      const enrichment = await enrichQuestionWithGuidance(question);
      const updatedMarkScheme = {
        ...(question.mark_scheme || { marking_points: [] }),
        guidance: enrichment.guidance,
        common_misconceptions: enrichment.common_misconceptions,
      };
      const updatedSubQuestions = enrichment.sub_questions || question.sub_questions;

      const updatedQuestion: Question = {
        ...question,
        mark_scheme: updatedMarkScheme,
        sub_questions: updatedSubQuestions,
      };

      if (question.id) {
        await updateQuestionMarkScheme(question.id, updatedMarkScheme, updatedSubQuestions);
      }

      setActiveQuestion(updatedQuestion);
      onQuestionUpdated?.(updatedQuestion);
    } catch (err: any) {
      setEnrichError(err?.message || 'Failed to generate AI guidance');
    } finally {
      setIsEnriching(false);
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

  const hasInsights = Boolean(
    question.mark_scheme?.guidance?.length ||
    question.mark_scheme?.common_misconceptions?.length ||
    question.sub_questions?.some((sq: any) => sq.guidance || sq.common_misconceptions?.length)
  );

  return createPortal(
    <div className="modal-backdrop animate-fade-in" onClick={onClose}>
      <div
        className="modal-card animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
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
            {question.question_style && (
              <span className="q-badge q-badge--style">
                {question.question_style}
              </span>
            )}
            {hasInsights && (
              <span className="modal-insights-badge">
                ✨ AI Insights
              </span>
            )}
          </div>

          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
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

          <div className="modal-section">
            <h4 className="modal-section-title">Question Stem</h4>
            <div className="modal-stem-text">
              <ExamMathText content={question.question_text} />
            </div>
          </div>

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

          {question.sub_questions && question.sub_questions.length > 0 && (
            <div className="modal-section">
              <h4 className="modal-section-title">Sub-Questions ({question.sub_questions.length} parts)</h4>
              <div className="modal-sub-list">
                {question.sub_questions.map((sub: any, si) => (
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
                    {sub.guidance && showMarkScheme && (
                      <div className="modal-sub-guidance animate-fade-in">
                        <span className="modal-guidance-badge">💡 Examiner Tip:</span>
                        <span className="modal-guidance-text"><ExamMathText content={sub.guidance} /></span>
                      </div>
                    )}

                    {sub.common_misconceptions && sub.common_misconceptions.length > 0 && showMarkScheme && (
                      <div className="modal-sub-misconception animate-fade-in">
                        <span className="modal-misconception-badge">⚠️ Common Trap:</span>
                        <span className="modal-guidance-text">
                          <ExamMathText content={sub.common_misconceptions.join('; ')} />
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {question.mark_scheme && (
            <div className="modal-section">
              <div className="modal-section-header-flex">
                <h4 className="modal-section-title">Mark Scheme & Criteria</h4>
                <div className="modal-header-actions-row">
                  {!hasInsights && (
                    <button
                      type="button"
                      className="modal-enrich-btn"
                      onClick={handleGenerateGuidance}
                      disabled={isEnriching}
                      title="Generate examiner guidance and misconceptions with Gemini AI"
                    >
                      {isEnriching ? (
                        <>
                          <span className="modal-enrich-spinner" />
                          Generating Insights…
                        </>
                      ) : (
                        <>✨ Generate AI Guidance</>
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className="modal-toggle-ms-btn"
                    onClick={() => setShowMarkScheme(!showMarkScheme)}
                  >
                    {showMarkScheme ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              {enrichError && (
                <div className="modal-enrich-error animate-fade-in">
                  <span>⚠</span> {enrichError}
                </div>
              )}

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

                  {question.mark_scheme.guidance && question.mark_scheme.guidance.length > 0 && (
                    <div className="modal-guidance-container animate-fade-in">
                      <div className="modal-guidance-title">
                        <span>💡</span> Examiner Marking Guidance & Tips
                      </div>
                      {question.mark_scheme.guidance.map((g, gi) => (
                        <div key={gi} className="modal-guidance-item">
                          <span className="modal-guidance-bullet">•</span>
                          <ExamMathText content={g} />
                        </div>
                      ))}
                    </div>
                  )}

                  {question.mark_scheme.common_misconceptions && question.mark_scheme.common_misconceptions.length > 0 && (
                    <div className="modal-misconceptions-container animate-fade-in">
                      <div className="modal-misconceptions-title">
                        <span>⚠️</span> Common Student Misconceptions & Pitfalls
                      </div>
                      {question.mark_scheme.common_misconceptions.map((m, mi) => (
                        <div key={mi} className="modal-misconception-item">
                          <span className="modal-misconception-bullet">•</span>
                          <ExamMathText content={m} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <div className="modal-footer-left">
            <button
              type="button"
              className="modal-action-btn modal-action-btn--copy"
              onClick={handleCopyText}
            >
              {copied ? '✓ Copied LaTeX!' : '📋 Copy Question Text'}
            </button>

            {onEdit && (
              <button
                type="button"
                className="modal-action-btn modal-action-btn--edit"
                onClick={() => {
                  onClose();
                  onEdit(question);
                }}
              >
                ✏️ Edit Question
              </button>
            )}

            {onGenerateVariant && (
              <button
                type="button"
                className="modal-action-btn modal-action-btn--variant"
                onClick={() => {
                  onClose();
                  onGenerateVariant(question);
                }}
              >
                ✨ Generate Variant
              </button>
            )}
          </div>

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
    </div>,
    document.body
  );
}
