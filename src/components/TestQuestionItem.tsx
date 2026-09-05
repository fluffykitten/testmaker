import { useState, memo } from 'react';
import type { Question } from '../types/database';
import { ExamMathText } from './ExamMathText';
import { parseMcqOption } from '../utils/mcqUtils';
import { formatPaperBadge } from '../utils/paperUtils';
import './TestQuestionItem.css';

interface TestQuestionItemProps {
  question: Question;
  index: number;
  totalQuestions: number;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onRemove: (questionId: string) => void;
  onEdit?: (question: Question) => void;
  onGenerateVariant?: (question: Question) => void;
}

function TestQuestionItemComponent({
  question,
  index,
  totalQuestions,
  onMoveUp,
  onMoveDown,
  onRemove,
  onEdit,
  onGenerateVariant,
}: TestQuestionItemProps) {
  const [showMarkScheme, setShowMarkScheme] = useState(false);

  const isFirst = index === 0;
  const isLast = index === totalQuestions - 1;

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
    <div className="test-q-card animate-fade-in">
      {/* ─── Question Header ───────────────────────────────────────────────── */}
      <div className="test-q-header">
        <div className="test-q-header-left">
          <div className="test-q-drag-handle" title="Question position">
            ⠿
          </div>

          <div className="test-q-order-badge">
            Question {index + 1}
          </div>

          <span className="q-badge q-badge--paper">
            From {formatPaperBadge(question.paper_number, question.series, question.year)} • Orig. Q{question.question_number}
          </span>

          {question.difficulty && (
            <span className={`q-badge ${difficultyClass(question.difficulty)}`}>
              {question.difficulty}
            </span>
          )}
        </div>

        <div className="test-q-header-right">
          <span className="test-q-marks-pill">
            [{question.marks} mark{question.marks !== 1 ? 's' : ''}]
          </span>

          {/* Re-order Controls */}
          <div className="test-q-reorder-group">
            <button
              type="button"
              className="test-q-reorder-btn"
              disabled={isFirst}
              onClick={() => onMoveUp(index)}
              title="Move Question Up"
            >
              ▲
            </button>
            <button
              type="button"
              className="test-q-reorder-btn"
              disabled={isLast}
              onClick={() => onMoveDown(index)}
              title="Move Question Down"
            >
              ▼
            </button>
          </div>

          {/* Edit button */}
          {onEdit && (
            <button
              type="button"
              className="test-q-edit-btn"
              onClick={() => onEdit(question)}
              title="Edit this question text, formulas, or mark scheme"
            >
              ✏️
            </button>
          )}

          {/* Generate Variant button */}
          {onGenerateVariant && (
            <button
              type="button"
              className="test-q-variant-btn"
              onClick={() => onGenerateVariant(question)}
              title="Generate AI-powered variant / twin of this question"
            >
              ✨ Variant
            </button>
          )}

          {/* Remove button */}
          <button
            type="button"
            className="test-q-remove-btn"
            onClick={() => onRemove(question.id)}
            title="Remove from custom test"
          >
            ✕
          </button>
        </div>
      </div>

      {/* ─── Question Body ─────────────────────────────────────────────────── */}
      <div className="test-q-body">
        <div className="test-q-stem">
          <ExamMathText content={question.question_text} />
        </div>

        {/* Diagram */}
        {question.diagram_url && (
          <div className="test-q-diagram-container">
            <img
              src={question.diagram_url}
              alt={`Diagram for Question ${index + 1}`}
              className="test-q-diagram-img"
              loading="lazy"
              decoding="async"
            />
          </div>
        )}

        {/* MCQ Choices */}
        {question.options && question.options.length > 0 && (
          <div className="q-mcq-grid">
            {question.options.map((opt, oi) => {
              const { letter, text } = parseMcqOption(opt, oi);
              return (
                <div key={oi} className="q-mcq-choice" style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
                  <span style={{ fontWeight: 'bold', minWidth: '20px', color: '#1e293b' }}>{letter}</span>
                  <div style={{ flex: 1 }}>
                    <ExamMathText content={text} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Sub-Questions */}
        {question.sub_questions && question.sub_questions.length > 0 && (
          <div className="test-q-sub-list">
            {question.sub_questions.map((sub, si) => (
              <div key={si} className="test-q-sub-card">
                <div className="test-q-sub-header">
                  <span className="test-q-sub-id">{sub.sub_id}</span>
                  <div className="test-q-sub-text">
                    <ExamMathText content={sub.question_text} />
                  </div>
                  <span className="test-q-sub-marks">[{sub.marks}]</span>
                </div>

                {/* Sub mark scheme */}
                {sub.mark_scheme && showMarkScheme && (
                  <div className="test-q-sub-ms animate-fade-in">
                    <span className="test-q-ms-label">Mark Scheme:</span>
                    <div className="test-q-ms-content">
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

        {/* Mark scheme toggle */}
        {question.mark_scheme && (
          <div className="test-q-ms-section">
            <button
              type="button"
              className="test-q-ms-toggle"
              onClick={() => setShowMarkScheme(!showMarkScheme)}
            >
              <span className={`q-ms-chevron ${showMarkScheme ? 'q-ms-chevron--open' : ''}`}>›</span>
              {showMarkScheme ? 'Hide Mark Scheme' : 'Preview Mark Scheme'}
            </button>

            {showMarkScheme && (
              <div className="test-q-ms-box animate-fade-in">
                {question.mark_scheme.marking_points?.map((pt, pi) => (
                  <div key={pi} className="test-q-ms-point">
                    <span className="test-q-ms-bullet">•</span>
                    <ExamMathText content={pt} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const TestQuestionItem = memo(TestQuestionItemComponent);
