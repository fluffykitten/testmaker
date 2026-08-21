import { useState } from 'react';
import type { ExtractionResult, ExtractedQuestion } from '../types/database';
import { ExamMathText } from './ExamMathText';
import './ExtractionReview.css';

interface ExtractionReviewProps {
  result: ExtractionResult;
  diagramUrls: Map<string, string>;
  onConfirmSave: () => void;
  onCancel: () => void;
  isSaving: boolean;
}

/**
 * Displays extracted questions for user review before saving to the database.
 * Shows paper metadata, question cards with LaTeX rendering, and save/cancel actions.
 */
export function ExtractionReview({
  result,
  diagramUrls,
  onConfirmSave,
  onCancel,
  isSaving,
}: ExtractionReviewProps) {
  const [expandedMark, setExpandedMark] = useState<Set<number>>(new Set());
  const [showAllMarkSchemes, setShowAllMarkSchemes] = useState(false);

  const { paper_metadata, questions } = result;
  const totalMarks = questions.reduce((sum, q) => sum + q.total_marks, 0);

  const toggleMarkScheme = (idx: number) => {
    setExpandedMark((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const difficultyColor = (d: string) => {
    switch (d) {
      case 'Easy':
        return 'badge--easy';
      case 'Medium':
        return 'badge--medium';
      case 'Hard':
        return 'badge--hard';
      default:
        return '';
    }
  };

  return (
    <div className="review-container animate-fade-in">
      {/* ─── Paper Metadata Header ───────────────────────────────────────── */}
      <div className="review-header">
        <div className="review-header-top">
          <div className="review-header-left">
            <h2 className="review-title">Extraction Complete</h2>
            <p className="review-subtitle">
              Review the extracted questions below before saving to the database.
            </p>
          </div>
          <button
            type="button"
            className={`review-toggle-ms-btn ${showAllMarkSchemes ? 'review-toggle-ms-btn--active' : ''}`}
            onClick={() => setShowAllMarkSchemes(!showAllMarkSchemes)}
            id="toggle-all-ms-btn"
          >
            <span>{showAllMarkSchemes ? '👁️ Mark Schemes: Visible' : '🙈 Mark Schemes: Hidden'}</span>
          </button>
        </div>
        <div className="review-meta-grid">
          <MetaBadge label="Subject" value={`${paper_metadata.subject} (${paper_metadata.subject_code})`} />
          <MetaBadge label="Session" value={`${paper_metadata.series} ${paper_metadata.year}`} />
          <MetaBadge label="Paper" value={`${paper_metadata.paper_number}`} />
          <MetaBadge label="Questions" value={`${questions.length}`} />
          <MetaBadge label="Total Marks" value={`${totalMarks}`} />
        </div>
      </div>

      {/* ─── Question Cards ──────────────────────────────────────────────── */}
      <div className="review-questions">
        {questions.map((q: ExtractedQuestion, idx: number) => (
          <div
            key={idx}
            className="review-card animate-fade-in"
            style={{ animationDelay: `${Math.min(idx * 40, 300)}ms` }}
          >
            {/* Card Header */}
            <div className="review-card-header">
              <div className="review-card-left">
                <span className="review-q-number">Q{q.question_number}</span>
                <span className="review-badge badge--paper">
                  📄 Paper {q.paper_number || paper_metadata.paper_number} ({q.series || paper_metadata.series} {q.year || paper_metadata.year})
                </span>
                <span className={`review-badge ${difficultyColor(q.estimated_difficulty)}`}>
                  {q.estimated_difficulty}
                </span>
                <span className="review-badge badge--style">{q.question_style}</span>
              </div>
              <div className="review-card-right">
                <span className="review-topic">{q.topic}</span>
                <span className="review-marks">[{q.total_marks} mark{q.total_marks !== 1 ? 's' : ''}]</span>
              </div>
            </div>

            {/* Question Text */}
            <div className="review-card-body">
              <ExamMathText content={q.question_text} />
            </div>

            {/* Diagram */}
            {(() => {
              const diagramUrl =
                diagramUrls.get(q.question_number) ||
                (q.parent_question_id ? diagramUrls.get(q.parent_question_id) : undefined) ||
                diagramUrls.get(`Q${q.question_number}`) ||
                diagramUrls.get(q.question_number.replace(/^Q/i, ''));

              if (diagramUrl) {
                return (
                  <div className="review-diagram">
                    <img
                      src={diagramUrl}
                      alt={`Diagram for Q${q.question_number}`}
                      className="review-diagram-img"
                    />
                  </div>
                );
              }

              if (q.has_diagram) {
                return (
                  <div className="review-diagram-placeholder">
                    <span>📊</span> Diagram detected (cropping from PDF)
                  </div>
                );
              }

              return null;
            })()}

            {/* Sub-Questions (Structured / Paper 4 multi-part questions) */}
            {q.sub_questions && q.sub_questions.length > 0 && (
              <div className="review-sub-questions">
                {q.sub_questions.map((sub, si) => (
                  <div key={si} className="review-sub-question">
                    <div className="review-sub-header">
                      <span className="review-sub-id">{sub.sub_id}</span>
                      <div className="review-sub-text">
                        <ExamMathText content={sub.question_text} />
                      </div>
                      <span className="review-sub-marks">[{sub.marks}]</span>
                    </div>
                    {sub.mark_scheme && (showAllMarkSchemes || expandedMark.has(idx)) && (
                      <div className="review-sub-markscheme animate-fade-in">
                        <span className="review-sub-ms-label">Mark Scheme:</span>
                        <div className="review-sub-ms-content">
                          <ExamMathText content={typeof sub.mark_scheme === 'string' ? sub.mark_scheme : JSON.stringify(sub.mark_scheme)} />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* MCQ Options */}
            {q.options && q.options.length > 0 && (
              <div className="review-options">
                {q.options.map((opt, oi) => (
                  <div key={oi} className="review-option">
                    <ExamMathText content={opt} />
                  </div>
                ))}
              </div>
            )}

            {/* Mark Scheme (collapsible) */}
            {q.mark_scheme && (
              <div className="review-markscheme">
                <button
                  className="review-markscheme-toggle"
                  onClick={() => toggleMarkScheme(idx)}
                  id={`toggle-ms-${idx}`}
                >
                  <span className={`review-chevron ${(showAllMarkSchemes || expandedMark.has(idx)) ? 'review-chevron--open' : ''}`}>
                    ›
                  </span>
                  Mark Scheme {(showAllMarkSchemes || expandedMark.has(idx)) ? '(Expanded)' : ''}
                </button>
                {(showAllMarkSchemes || expandedMark.has(idx)) && (
                  <div className="review-markscheme-body animate-fade-in">
                    {q.mark_scheme.marking_points.map((point, pi) => (
                      <div key={pi} className="review-ms-point">
                        <span className="review-ms-bullet">•</span>
                        <ExamMathText content={point} />
                      </div>
                    ))}
                    {q.mark_scheme.acceptable_answers &&
                      q.mark_scheme.acceptable_answers.length > 0 && (
                        <div className="review-ms-section">
                          <span className="review-ms-label">Acceptable answers:</span>
                          {q.mark_scheme.acceptable_answers.map((ans, ai) => (
                            <span key={ai} className="review-ms-answer">
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
        ))}
      </div>

      {/* ─── Action Bar ──────────────────────────────────────────────────── */}
      <div className="review-actions">
        <button
          className="review-btn review-btn--cancel"
          onClick={onCancel}
          disabled={isSaving}
          id="cancel-extraction-btn"
        >
          Discard
        </button>
        <button
          className="review-btn review-btn--save"
          onClick={onConfirmSave}
          disabled={isSaving}
          id="save-questions-btn"
        >
          {isSaving ? (
            <>
              <span className="extract-btn-spinner" />
              Saving…
            </>
          ) : (
            <>Save {questions.length} Questions to Database</>
          )}
        </button>
      </div>
    </div>
  );
}

// ─── Helper: Metadata Badge ────────────────────────────────────────────────────

function MetaBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="meta-badge">
      <span className="meta-badge-label">{label}</span>
      <span className="meta-badge-value">{value}</span>
    </div>
  );
}
