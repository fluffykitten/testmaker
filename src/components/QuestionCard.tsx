import { useState } from 'react';
import type { Question } from '../types/database';
import { ExamMathText } from './ExamMathText';
import './QuestionCard.css';

interface QuestionCardProps {
  question: Question;
  isSelected?: boolean;
  onToggleSelect?: (question: Question) => void;
  onViewDetails?: (question: Question) => void;
  onDelete?: (question: Question) => void;
  showMarkSchemeDefault?: boolean;
}

export function QuestionCard({
  question,
  isSelected = false,
  onToggleSelect,
  onViewDetails,
  onDelete,
  showMarkSchemeDefault = false,
}: QuestionCardProps) {
  const [showMarkScheme, setShowMarkScheme] = useState(showMarkSchemeDefault);

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

  const hasSubQuestions = question.sub_questions && question.sub_questions.length > 0;

  return (
    <div className={`q-card animate-fade-in ${isSelected ? 'q-card--selected' : ''}`}>
      {/* ─── Card Header ───────────────────────────────────────────────────── */}
      <div className="q-card-header">
        <div className="q-card-header-left">
          {onToggleSelect && (
            <label className="q-select-label" title="Select for Custom Test">
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggleSelect(question)}
                className="q-checkbox"
              />
              <span className="q-checkbox-custom" />
            </label>
          )}

          <span className="q-number">Q{question.question_number}</span>

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
        </div>

        <div className="q-card-header-right">
          <span className="q-topic-tag" title={question.sub_topic ? `${question.topic} → ${question.sub_topic}` : question.topic}>
            {question.topic}
            {question.sub_topic && <span className="q-subtopic-tag"> • {question.sub_topic}</span>}
          </span>
          <span className="q-marks-badge">[{question.marks} mark{question.marks !== 1 ? 's' : ''}]</span>
        </div>
      </div>

      {/* ─── Question Stem & Content ───────────────────────────────────────── */}
      <div className="q-card-body">
        <div className="q-stem-text">
          <ExamMathText content={question.question_text} />
        </div>

        {/* Diagram Preview */}
        {question.diagram_url && (
          <div className="q-diagram-container">
            <img
              src={question.diagram_url}
              alt={`Diagram for Question ${question.question_number}`}
              className="q-diagram-img"
              onClick={() => onViewDetails?.(question)}
              title="Click to view high resolution diagram"
            />
          </div>
        )}

        {/* MCQ Options (Paper 1 / Paper 2) */}
        {question.options && question.options.length > 0 && (
          <div className="q-mcq-grid">
            {question.options.map((opt, oi) => (
              <div key={oi} className="q-mcq-choice">
                <ExamMathText content={opt} />
              </div>
            ))}
          </div>
        )}

        {/* Sub-Questions (Structured Questions) */}
        {hasSubQuestions && (
          <div className="q-sub-list">
            {question.sub_questions.map((sub, si) => (
              <div key={si} className="q-sub-item">
                <div className="q-sub-item-header">
                  <span className="q-sub-id">{sub.sub_id}</span>
                  <div className="q-sub-text">
                    <ExamMathText content={sub.question_text} />
                  </div>
                  <span className="q-sub-marks">[{sub.marks}]</span>
                </div>

                {/* Sub-question mark scheme */}
                {sub.mark_scheme && showMarkScheme && (
                  <div className="q-sub-ms animate-fade-in">
                    <span className="q-ms-label">Answer:</span>
                    <div className="q-ms-content">
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
        )}

        {/* Mark Scheme (Parent level) */}
        {question.mark_scheme && (
          <div className="q-markscheme-section">
            <button
              type="button"
              className="q-ms-toggle-btn"
              onClick={() => setShowMarkScheme(!showMarkScheme)}
            >
              <span className={`q-ms-chevron ${showMarkScheme ? 'q-ms-chevron--open' : ''}`}>›</span>
              {showMarkScheme ? 'Hide Mark Scheme' : 'Show Mark Scheme'}
            </button>

            {showMarkScheme && (
              <div className="q-ms-body animate-fade-in">
                {question.mark_scheme.marking_points?.map((pt, pi) => (
                  <div key={pi} className="q-ms-point">
                    <span className="q-ms-bullet">•</span>
                    <ExamMathText content={pt} />
                  </div>
                ))}
                {question.mark_scheme.acceptable_answers && question.mark_scheme.acceptable_answers.length > 0 && (
                  <div className="q-ms-answers">
                    <span className="q-ms-answers-label">Acceptable answers:</span>
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

      {/* ─── Card Actions Footer ───────────────────────────────────────────── */}
      <div className="q-card-footer">
        <div className="q-card-footer-left">
          {onViewDetails && (
            <button
              type="button"
              className="q-action-btn q-action-btn--preview"
              onClick={() => onViewDetails(question)}
            >
              🔍 View Details
            </button>
          )}

          {onDelete && (
            <button
              type="button"
              className="q-action-btn q-action-btn--delete"
              onClick={() => onDelete(question)}
              title="Delete this question from question bank"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
              Delete
            </button>
          )}
        </div>

        {onToggleSelect && (
          <button
            type="button"
            className={`q-action-btn ${isSelected ? 'q-action-btn--remove' : 'q-action-btn--add'}`}
            onClick={() => onToggleSelect(question)}
          >
            {isSelected ? '✓ Added to Custom Test' : '+ Add to Test'}
          </button>
        )}
      </div>
    </div>
  );
}
