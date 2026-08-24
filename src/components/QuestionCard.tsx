import { useState, useEffect } from 'react';
import type { Question } from '../types/database';
import { isQuestionBookmarked, toggleBookmarkQuestion } from '../services/questionBookmarkService';
import { getQuestionTags, addQuestionTag, removeQuestionTag } from '../services/questionTagService';
import { ExamMathText } from './ExamMathText';
import './QuestionCard.css';

interface QuestionCardProps {
  question: Question;
  isSelected?: boolean;
  onToggleSelect?: (question: Question) => void;
  onViewDetails?: (question: Question) => void;
  onEdit?: (question: Question) => void;
  onDelete?: (question: Question) => void;
  onGenerateVariant?: (question: Question) => void;
  showMarkSchemeDefault?: boolean;
}

export function QuestionCard({
  question,
  isSelected = false,
  onToggleSelect,
  onViewDetails,
  onEdit,
  onDelete,
  onGenerateVariant,
  showMarkSchemeDefault = false,
}: QuestionCardProps) {
  const [showMarkScheme, setShowMarkScheme] = useState(showMarkSchemeDefault);
  const [isBookmarked, setIsBookmarked] = useState(() => isQuestionBookmarked(question.id));
  const [tags, setTags] = useState<string[]>(() => getQuestionTags(question.id));
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    const handleBookmarkUpdate = () => {
      setIsBookmarked(isQuestionBookmarked(question.id));
    };
    const handleTagUpdate = () => {
      setTags(getQuestionTags(question.id));
    };

    window.addEventListener('bookmarks_updated', handleBookmarkUpdate);
    window.addEventListener('tags_updated', handleTagUpdate);
    return () => {
      window.removeEventListener('bookmarks_updated', handleBookmarkUpdate);
      window.removeEventListener('tags_updated', handleTagUpdate);
    };
  }, [question.id]);

  const handleToggleBookmark = (e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = toggleBookmarkQuestion(question.id);
    setIsBookmarked(updated);
  };

  const handleAddTagSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tagInput.trim()) {
      const updated = addQuestionTag(question.id, tagInput.trim());
      setTags(updated);
      setTagInput('');
      setIsAddingTag(false);
    }
  };

  const handleRemoveTag = (e: React.MouseEvent, tag: string) => {
    e.stopPropagation();
    const updated = removeQuestionTag(question.id, tag);
    setTags(updated);
  };

  const cleanOptionText = (text: string, oIdx: number) => {
    if (!text) return '';
    const letter = String.fromCharCode(65 + oIdx);
    return text
      .replace(new RegExp(`^\\s*(\\(${letter}\\)|${letter}[\\.\\)\\:\\s\\-]+)\\s*`, 'i'), '')
      .trim();
  };

  const cleanQuestionStem = (stem: string, options?: string[] | null) => {
    if (!stem || !options || options.length === 0) return stem;
    const lines = stem.split('\n');
    const optStartIdx = lines.findIndex((l) => /^\s*A[.)\s:-]/.test(l));
    if (optStartIdx > 0 && lines.length - optStartIdx <= 6) {
      const remaining = lines.slice(optStartIdx).join('\n');
      if (/\bB[.)\s:-]/.test(remaining) && /\bC[.)\s:-]/.test(remaining)) {
        return lines.slice(0, optStartIdx).join('\n').trim();
      }
    }
    return stem;
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

          <button
            type="button"
            className={`q-bookmark-btn ${isBookmarked ? 'q-bookmark-btn--active' : ''}`}
            onClick={handleToggleBookmark}
            title={isBookmarked ? 'Remove from bookmarked questions' : 'Bookmark this question'}
          >
            {isBookmarked ? '⭐' : '☆'}
          </button>

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
          <ExamMathText content={cleanQuestionStem(question.question_text, question.options)} />
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
                <span className="q-mcq-letter">{String.fromCharCode(65 + oi)}</span>
                <span className="q-mcq-text">
                  <ExamMathText content={cleanOptionText(opt, oi)} />
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Custom Teacher Tags Bar */}
        <div className="q-tags-container">
          <span className="q-tags-label">🏷️</span>
          {tags.map((t) => (
            <span key={t} className="q-tag-chip">
              #{t}
              <button
                type="button"
                className="q-tag-remove-btn"
                onClick={(e) => handleRemoveTag(e, t)}
                title={`Remove #${t}`}
              >
                ✕
              </button>
            </span>
          ))}

          {isAddingTag ? (
            <form onSubmit={handleAddTagSubmit} className="q-tag-input-form" onClick={(e) => e.stopPropagation()}>
              <input
                type="text"
                className="q-tag-input"
                placeholder="tag name..."
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                autoFocus
                onBlur={() => {
                  if (!tagInput.trim()) setIsAddingTag(false);
                }}
              />
              <button type="submit" className="q-tag-submit-btn">✓</button>
              <button type="button" className="q-tag-cancel-btn" onClick={() => setIsAddingTag(false)}>✕</button>
            </form>
          ) : (
            <button
              type="button"
              className="q-tag-add-btn"
              onClick={() => setIsAddingTag(true)}
              title="Add a custom teacher tag (e.g. #homework, #mock2026, #hard)"
            >
              + Tag
            </button>
          )}
        </div>

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

                {/* Sub-question teacher guidance */}
                {sub.guidance && showMarkScheme && (
                  <div className="q-sub-guidance animate-fade-in">
                    <span className="q-guidance-badge">💡 Examiner Tip:</span>
                    <span className="q-guidance-text"><ExamMathText content={sub.guidance} /></span>
                  </div>
                )}

                {/* Sub-question student misconceptions */}
                {sub.common_misconceptions && sub.common_misconceptions.length > 0 && showMarkScheme && (
                  <div className="q-sub-misconception animate-fade-in">
                    <span className="q-misconception-badge">⚠️ Common Trap:</span>
                    <span className="q-guidance-text">
                      <ExamMathText content={sub.common_misconceptions.join('; ')} />
                    </span>
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
              {showMarkScheme ? 'Hide Mark Scheme & Insights' : 'Show Mark Scheme & Insights'}
              {(question.mark_scheme.guidance?.length || question.mark_scheme.common_misconceptions?.length) ? (
                <span className="q-insights-indicator">✨ Insights</span>
              ) : null}
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

                {/* Teacher Guidance Notes */}
                {question.mark_scheme.guidance && question.mark_scheme.guidance.length > 0 && (
                  <div className="q-guidance-container">
                    <div className="q-guidance-title">
                      <span>💡</span> Examiner Marking Notes & Guidance
                    </div>
                    {question.mark_scheme.guidance.map((g, gi) => (
                      <div key={gi} className="q-guidance-item">
                        <span className="q-guidance-bullet">•</span>
                        <ExamMathText content={g} />
                      </div>
                    ))}
                  </div>
                )}

                {/* Common Student Misconceptions */}
                {question.mark_scheme.common_misconceptions && question.mark_scheme.common_misconceptions.length > 0 && (
                  <div className="q-misconceptions-container">
                    <div className="q-misconceptions-title">
                      <span>⚠️</span> Common Student Misconceptions & Traps
                    </div>
                    {question.mark_scheme.common_misconceptions.map((m, mi) => (
                      <div key={mi} className="q-misconception-item">
                        <span className="q-misconception-bullet">•</span>
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

          {onEdit && (
            <button
              type="button"
              className="q-action-btn q-action-btn--edit"
              onClick={() => onEdit(question)}
              title="Edit question text, formulas, sub-questions, and mark scheme"
            >
              ✏️ Edit
            </button>
          )}

          {onGenerateVariant && (
            <button
              type="button"
              className="q-action-btn q-action-btn--variant"
              onClick={() => onGenerateVariant(question)}
              title="Generate AI-powered twin question or scaffolding/extension variant"
            >
              ✨ Similar
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
