import { useState, useEffect } from 'react';
import type { ExtractionResult, ExtractedQuestion } from '../types/database';
import { type DiagramCropItem } from '../lib/diagramCropper';
import { ExamMathText } from './ExamMathText';
import { QuestionEditorModal } from './QuestionEditorModal';
import { DiagramCropModal } from './DiagramCropModal';
import './ExtractionReview.css';

interface ExtractionReviewProps {
  result: ExtractionResult;
  diagramUrls: Map<string, string>;
  pdfFile?: File | null;
  onUpdateDiagram?: (qNum: string, item: DiagramCropItem) => void;
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
  pdfFile,
  onUpdateDiagram,
  onConfirmSave,
  onCancel,
  isSaving,
}: ExtractionReviewProps) {
  const [questions, setQuestions] = useState<ExtractedQuestion[]>(() => result.questions);
  const [expandedMark, setExpandedMark] = useState<Set<number>>(new Set());
  const [showAllMarkSchemes, setShowAllMarkSchemes] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [cropIdx, setCropIdx] = useState<number | null>(null);

  // Sync questions if result changes
  useEffect(() => {
    if (result?.questions) {
      setQuestions(result.questions);
    }
  }, [result]);

  const { paper_metadata } = result;
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
          <MetaBadge label="Subject" value={`${paper_metadata?.subject || 'Exam'} (${paper_metadata?.subject_code || 'General'})`} />
          <MetaBadge label="Session" value={`${paper_metadata?.series || 'Series'} ${paper_metadata?.year || new Date().getFullYear()}`} />
          <MetaBadge label="Paper" value={`${paper_metadata?.paper_number || 1}`} />
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
                <button
                  type="button"
                  className="review-edit-btn"
                  onClick={() => setEditingIdx(idx)}
                  title="Edit question text, formulas, or mark scheme"
                >
                  ✏️ Edit
                </button>
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
                    <div className="review-diagram-wrap">
                      <img
                        src={diagramUrl}
                        alt={`Diagram for Q${q.question_number}`}
                        className="review-diagram-img"
                      />
                      <button
                        type="button"
                        className="review-crop-btn"
                        onClick={() => setCropIdx(idx)}
                        title="Fine-tune diagram crop boundaries with 8-handle visual selector"
                      >
                        ✂️ Adjust Crop
                      </button>
                    </div>
                  </div>
                );
              }

              if (q.has_diagram) {
                return (
                  <div className="review-diagram-placeholder">
                    <span>📊</span>
                    <span>Diagram detected</span>
                    <button
                      type="button"
                      className="review-crop-btn review-crop-btn--inline"
                      onClick={() => setCropIdx(idx)}
                    >
                      ✂️ Crop from PDF
                    </button>
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
                    {sub.guidance && (showAllMarkSchemes || expandedMark.has(idx)) && (
                      <div className="review-sub-guidance animate-fade-in">
                        <span className="review-guidance-badge">💡 Examiner Tip</span>
                        <span className="review-sub-guidance-text"><ExamMathText content={sub.guidance} /></span>
                      </div>
                    )}
                    {sub.common_misconceptions && sub.common_misconceptions.length > 0 && (showAllMarkSchemes || expandedMark.has(idx)) && (
                      <div className="review-sub-misconception animate-fade-in">
                        <span className="review-misconception-badge">⚠️ Common Trap</span>
                        <span className="review-sub-guidance-text">
                          <ExamMathText content={sub.common_misconceptions.join('; ')} />
                        </span>
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
                  {(q.mark_scheme.guidance?.length || q.mark_scheme.common_misconceptions?.length) ? (
                    <span className="review-insights-pill">✨ Insights Available</span>
                  ) : null}
                </button>
                  {(showAllMarkSchemes || expandedMark.has(idx)) && (
                    <div className="review-markscheme-body animate-fade-in">
                      {Array.isArray(q.mark_scheme.marking_points) &&
                        q.mark_scheme.marking_points.map((point, pi) => (
                          <div key={pi} className="review-ms-point">
                            <span className="review-ms-bullet">•</span>
                            <ExamMathText content={point} />
                          </div>
                        ))}
                      {Array.isArray(q.mark_scheme.acceptable_answers) &&
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

                      {/* Teacher Guidance Notes */}
                      {Array.isArray(q.mark_scheme.guidance) && q.mark_scheme.guidance.length > 0 && (
                        <div className="review-guidance-box">
                          <div className="review-guidance-header">
                            <span className="review-guidance-icon">💡</span>
                            <span className="review-guidance-title">Examiner Marking Guidance</span>
                          </div>
                          <div className="review-guidance-list">
                            {q.mark_scheme.guidance.map((g, gi) => (
                              <div key={gi} className="review-guidance-item">
                                <span className="review-guidance-dot">•</span>
                                <ExamMathText content={g} />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Common Student Misconceptions */}
                      {Array.isArray(q.mark_scheme.common_misconceptions) && q.mark_scheme.common_misconceptions.length > 0 && (
                        <div className="review-misconceptions-box">
                          <div className="review-misconceptions-header">
                            <span className="review-misconceptions-icon">⚠️</span>
                            <span className="review-misconceptions-title">Common Student Misconceptions</span>
                          </div>
                          <div className="review-misconceptions-list">
                            {q.mark_scheme.common_misconceptions.map((m, mi) => (
                              <div key={mi} className="review-misconception-item">
                                <span className="review-misconception-dot">•</span>
                                <ExamMathText content={m} />
                              </div>
                            ))}
                          </div>
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

      {/* ─── Question Editor Modal ───────────────────────────────────────── */}
      {editingIdx !== null && questions[editingIdx] && (() => {
        const curQ = questions[editingIdx];
        const diagramUrl =
          diagramUrls.get(curQ.question_number) ||
          (curQ.parent_question_id ? diagramUrls.get(curQ.parent_question_id) : undefined) ||
          diagramUrls.get(`Q${curQ.question_number}`) ||
          diagramUrls.get(curQ.question_number.replace(/^Q/i, '')) ||
          null;

        return (
          <QuestionEditorModal
            isOpen={true}
            question={{
              id: `temp-extracted-${editingIdx}`,
              created_at: new Date().toISOString(),
              syllabus_id: '',
              year: curQ.year || paper_metadata?.year || new Date().getFullYear(),
              series: curQ.series || paper_metadata?.series || 'Exam',
              paper_number: curQ.paper_number || paper_metadata?.paper_number || 1,
              question_number: curQ.question_number || '1',
              parent_question_id: curQ.parent_question_id || null,
              question_text: curQ.question_text || '',
              question_style: curQ.question_style || 'Structured',
              topic: curQ.topic || 'General',
              sub_topic: curQ.sub_topic || null,
              difficulty: curQ.estimated_difficulty || 'Medium',
              marks: Number(curQ.total_marks) || 1,
              diagram_url: diagramUrl,
              options: curQ.options || null,
              sub_questions: curQ.sub_questions || [],
              mark_scheme: curQ.mark_scheme || null,
            }}
            onClose={() => setEditingIdx(null)}
            onSave={(saved) => {
              if (editingIdx !== null && questions[editingIdx]) {
                const updatedList = [...questions];
                updatedList[editingIdx] = {
                  ...updatedList[editingIdx],
                  question_text: saved.question_text,
                  question_number: saved.question_number,
                  topic: saved.topic,
                  sub_topic: saved.sub_topic,
                  estimated_difficulty: saved.difficulty || 'Medium',
                  total_marks: saved.marks,
                  question_style: saved.question_style || 'Structured',
                  options: saved.options || null,
                  sub_questions: saved.sub_questions && saved.sub_questions.length > 0 ? saved.sub_questions : undefined,
                  mark_scheme: saved.mark_scheme as any,
                };
                result.questions = updatedList;
                setQuestions(updatedList);
              }
              setEditingIdx(null);
            }}
          />
        );
      })()}

      {/* ─── Diagram Fine-Tuner Modal ─────────────────────────────────────── */}
      {cropIdx !== null && questions[cropIdx] && (
        <DiagramCropModal
          isOpen={true}
          pdfFile={pdfFile}
          imageSrc={
            diagramUrls.get(questions[cropIdx].question_number) ||
            (questions[cropIdx].parent_question_id ? diagramUrls.get(questions[cropIdx].parent_question_id) : undefined) ||
            diagramUrls.get(`Q${questions[cropIdx].question_number}`) ||
            diagramUrls.get(questions[cropIdx].question_number.replace(/^Q/i, '')) ||
            null
          }
          initialBoundingBox={questions[cropIdx].bounding_box}
          initialPageNumber={questions[cropIdx].page_number || 1}
          questionNumber={questions[cropIdx].question_number}
          onClose={() => setCropIdx(null)}
          onSaveCrop={({ blob, localUrl, boundingBox, pageNumber }) => {
            if (cropIdx !== null && questions[cropIdx]) {
              const qNum = questions[cropIdx].question_number;
              onUpdateDiagram?.(qNum, { blob, localUrl });
              const updatedList = [...questions];
              updatedList[cropIdx] = {
                ...updatedList[cropIdx],
                has_diagram: true,
                bounding_box: boundingBox,
                page_number: pageNumber,
              };
              result.questions = updatedList;
              setQuestions(updatedList);
            }
            setCropIdx(null);
          }}
        />
      )}
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
