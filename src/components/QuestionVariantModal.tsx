import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { Question } from '../types/database';
import { ExamMathText } from './ExamMathText';
import { generateQuestionVariant, type VariantMode } from '../lib/gemini';
import { createQuestion } from '../services/questionBankService';
import './QuestionVariantModal.css';

interface QuestionVariantModalProps {
  isOpen: boolean;
  question: Question | null;
  onClose: () => void;
  onSaveToBank?: (created: Question) => void;
  onAddToTest?: (question: Question) => void;
  onOpenInEditor?: (variant: Question) => void;
}

const VARIANT_MODES: { id: VariantMode; label: string; icon: string; desc: string }[] = [
  {
    id: 'parallel',
    label: 'Parallel Twin',
    icon: '👯',
    desc: 'Identical syllabus standard & marks with altered values or chemical compounds',
  },
  {
    id: 'scaffold',
    label: 'Foundation / Scaffolding',
    icon: '🪜',
    desc: 'Step-by-step guided prompts for differentiated support',
  },
  {
    id: 'extension',
    label: 'Challenging Extension',
    icon: '🚀',
    desc: 'Higher-order thinking, evaluation, or inverted algebraic calculation',
  },
  {
    id: 'mcq',
    label: 'Convert to MCQ',
    icon: '🔀',
    desc: 'Format shift to 4-option multiple choice with plausible distractors',
  },
  {
    id: 'structured',
    label: 'Convert to Structured',
    icon: '📝',
    desc: 'Format shift to multi-part structured question with sub-parts',
  },
];

const PROMPT_SUGGESTIONS = [
  'Change numerical values & concentrations',
  'Use a different chemical compound or element',
  'Invert problem (solve for initial mass/velocity)',
  'Add practical laboratory context',
  'Simplify terminology for EAL students',
];

export const QuestionVariantModal: React.FC<QuestionVariantModalProps> = ({
  isOpen,
  question,
  onClose,
  onSaveToBank,
  onAddToTest,
  onOpenInEditor,
}) => {
  const [selectedMode, setSelectedMode] = useState<VariantMode | null>(null);
  const [customInstruction, setCustomInstruction] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [variant, setVariant] = useState<Question | null>(null);
  const [showMarkScheme, setShowMarkScheme] = useState(true);
  const [isSavedToBank, setIsSavedToBank] = useState(false);
  const [isAddedToTest, setIsAddedToTest] = useState(false);
  const [actionSuccessMsg, setActionSuccessMsg] = useState<string | null>(null);

  const handleGenerate = useCallback(
    async (mode?: VariantMode, overrideInstruction?: string) => {
      if (!question) return;
      const targetMode: VariantMode = mode || selectedMode || 'parallel';
      setSelectedMode(targetMode);
      setIsGenerating(true);
      setErrorMessage(null);

      const instruction = overrideInstruction !== undefined ? overrideInstruction : customInstruction;

      try {
        const generated = await generateQuestionVariant(question, {
          mode: targetMode,
          customInstruction: instruction.trim() || undefined,
        });

        const fullVariant: Question = {
          id: `variant-temp-${Date.now()}`,
          created_at: new Date().toISOString(),
          syllabus_id: question.syllabus_id,
          year: question.year || new Date().getFullYear(),
          series: question.series || 'Variant',
          paper_number: question.paper_number || 1,
          question_number: `${question.question_number}V`,
          parent_question_id: null,
          question_text: generated.question_text || '',
          question_style: targetMode === 'structured' ? 'Structured' : targetMode === 'mcq' ? 'Multiple Choice' : (generated.question_style || question.question_style),
          topic: generated.topic || question.topic,
          sub_topic: generated.sub_topic || question.sub_topic,
          difficulty: generated.difficulty || question.difficulty,
          marks: generated.marks || (targetMode === 'mcq' ? 1 : question.marks),
          diagram_url: generated.diagram_url !== undefined ? generated.diagram_url : (question.diagram_url || null),
          diagram_source: generated.diagram_source !== undefined ? generated.diagram_source : (question.diagram_source || null),
          resource_ref: generated.resource_ref !== undefined ? generated.resource_ref : (question.resource_ref || null),
          insert_page_number: generated.insert_page_number !== undefined ? generated.insert_page_number : (question.insert_page_number || null),
          audio_url: generated.audio_url !== undefined ? generated.audio_url : (question.audio_url || null),
          audio_metadata: generated.audio_metadata !== undefined ? generated.audio_metadata : (question.audio_metadata || null),
          options: targetMode === 'structured' ? null : (generated.options || null),
          sub_questions: targetMode === 'mcq' ? [] : (generated.sub_questions || []),
          mark_scheme: generated.mark_scheme || null,
        };

        setVariant(fullVariant);
        setIsSavedToBank(false);
        setIsAddedToTest(false);
        setActionSuccessMsg(null);
      } catch (err: any) {
        console.error('Failed to generate variant:', err);
        setErrorMessage(err?.message || 'Failed to generate question variant. Please try again.');
      } finally {
        setIsGenerating(false);
      }
    },
    [question, selectedMode, customInstruction]
  );

  // Reset state on open or question change
  useEffect(() => {
    setVariant(null);
    setSelectedMode(null);
    setCustomInstruction('');
    setErrorMessage(null);
    setIsGenerating(false);
    setIsSavedToBank(false);
    setIsAddedToTest(false);
    setActionSuccessMsg(null);
  }, [isOpen, question]);

  const handleSaveToQuestionBank = async () => {
    if (!variant) return;
    setIsSaving(true);
    setErrorMessage(null);

    try {
      if (isSavedToBank) {
        setActionSuccessMsg('Already saved to Question Bank!');
        setTimeout(() => setActionSuccessMsg(null), 3000);
        return;
      }

      const { id, created_at, ...cleanVariant } = variant;
      const saved = await createQuestion(cleanVariant);
      if (saved) {
        setVariant(saved);
        setIsSavedToBank(true);
        onSaveToBank?.(saved);
        setActionSuccessMsg('✓ Saved to Question Bank!');
        setTimeout(() => setActionSuccessMsg(null), 4000);
      } else {
        throw new Error('Failed to create question record.');
      }
    } catch (err: any) {
      console.error('Failed to save variant to bank:', err);
      setErrorMessage(err?.message || 'Failed to save question to bank.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddToTest = async () => {
    if (!variant) return;
    setIsSaving(true);
    setErrorMessage(null);

    try {
      let questionToAdd = variant;
      // Auto-save to ensure permanent record with valid UUID for custom tests if not already saved
      if (!isSavedToBank && (!variant.id || variant.id.startsWith('variant-temp-'))) {
        const { id, created_at, ...cleanVariant } = variant;
        const saved = await createQuestion(cleanVariant);
        if (saved) {
          questionToAdd = saved;
          setVariant(saved);
          setIsSavedToBank(true);
          onSaveToBank?.(saved);
        }
      }
      onAddToTest?.(questionToAdd);
      setIsAddedToTest(true);
      setActionSuccessMsg('✓ Added to Custom Test!');
      setTimeout(() => setActionSuccessMsg(null), 4000);
    } catch (err: any) {
      console.warn('Could not persist variant to DB, adding locally:', err);
      onAddToTest?.(variant);
      setIsAddedToTest(true);
      setActionSuccessMsg('✓ Added to Custom Test!');
      setTimeout(() => setActionSuccessMsg(null), 4000);
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenEditor = () => {
    if (!variant) return;
    onOpenInEditor?.(variant);
    onClose();
  };

  const backdropDismiss = useBackdropDismiss(onClose);

  if (!isOpen || !question) return null;

  return createPortal(
    <div className="variant-modal-backdrop animate-fade-in" {...backdropDismiss}>
      <div
        className="variant-modal-card animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ─── Header ──────────────────────────────────────────────────────── */}
        <div className="variant-modal-header">
          <div className="variant-header-left">
            <div className="variant-header-icon">✨</div>
            <div>
              <h2 className="variant-modal-title">
                Generate Question Variant
              </h2>
              <p className="variant-modal-subtitle">
                Create syllabus-aligned twin questions, scaffolding tasks, or challenging extensions.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="variant-close-btn"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {/* ─── Mode & Custom Instruction Toolbar ────────────────────────────── */}
        <div className="variant-config-section">
          <div className="variant-modes-row">
            <span className="variant-label">Generation Mode:</span>
            <div className="variant-mode-chips">
              {VARIANT_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={`variant-mode-chip ${selectedMode === mode.id ? 'variant-mode-chip--active' : ''}`}
                  onClick={() => {
                    setSelectedMode(mode.id);
                    handleGenerate(mode.id);
                  }}
                  title={mode.desc}
                  disabled={isGenerating}
                >
                  <span>{mode.icon}</span>
                  <span>{mode.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Teacher custom prompt input */}
          <div className="variant-instruction-row">
            <input
              type="text"
              className="variant-instruction-input"
              placeholder="Optional custom instruction (e.g. 'Use 0.25 mol/dm³ HCl', 'Context: car braking on wet road')"
              value={customInstruction}
              onChange={(e) => setCustomInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleGenerate();
              }}
              disabled={isGenerating}
            />
            <button
              type="button"
              className="variant-generate-btn"
              onClick={() => handleGenerate()}
              disabled={isGenerating}
            >
              {isGenerating ? (
                <>
                  <span className="variant-spinner" />
                  Generating…
                </>
              ) : (
                <>✨ Generate</>
              )}
            </button>
          </div>

          {/* Quick Prompt Suggestions */}
          <div className="variant-suggestions-row">
            <span className="variant-sublabel">Ideas:</span>
            {PROMPT_SUGGESTIONS.map((text, idx) => (
              <button
                key={idx}
                type="button"
                className="variant-suggestion-chip"
                onClick={() => {
                  setCustomInstruction(text);
                }}
                disabled={isGenerating}
              >
                + {text}
              </button>
            ))}
          </div>
        </div>

        {/* Error Alert */}
        {errorMessage && (
          <div className="variant-error-alert animate-fade-in">
            <span>⚠️</span> {errorMessage}
          </div>
        )}

        {/* ─── Side-by-Side Comparison Workspace ────────────────────────────── */}
        <div className="variant-workspace">
          {/* LEFT: Original Question */}
          <div className="variant-column variant-column--original">
            <div className="variant-column-header">
              <div className="variant-col-badge variant-col-badge--original">
                Original Question ({question.question_number})
              </div>
              <span className="variant-meta-info">
                {question.topic} • [{question.marks} mark{question.marks !== 1 ? 's' : ''}]
              </span>
            </div>

            <div className="variant-column-scroll">
              <div className="variant-stem-box">
                <ExamMathText content={question.question_text} />
              </div>

              {/* Original Diagram Preview */}
              {question.diagram_url && (
                <div className="variant-diagram-box">
                  <span className="variant-diagram-badge">🖼️ Original Diagram</span>
                  <img
                    src={question.diagram_url}
                    alt="Original question diagram"
                    className="variant-diagram-img"
                  />
                </div>
              )}

              {/* Original Sub-questions */}
              {question.sub_questions && question.sub_questions.length > 0 && (
                <div className="variant-sub-list">
                  {question.sub_questions.map((sub, idx) => (
                    <div key={idx} className="variant-sub-item">
                      <div className="variant-sub-header">
                        <span className="variant-sub-id">{sub.sub_id}</span>
                        <div className="variant-sub-text">
                          <ExamMathText content={sub.question_text} />
                        </div>
                        <span className="variant-sub-marks">[{sub.marks}]</span>
                      </div>
                      {sub.diagram_url && (
                        <div className="variant-diagram-box" style={{ marginTop: '6px' }}>
                          <span className="variant-diagram-badge">🖼️ Diagram for {sub.sub_id}</span>
                          <img
                            src={sub.diagram_url}
                            alt={`Diagram for ${sub.sub_id}`}
                            className="variant-diagram-img"
                          />
                        </div>
                      )}
                      {sub.mark_scheme && showMarkScheme && (
                        <div className="variant-sub-ms">
                          <span className="variant-ms-tag">MS:</span>
                          <ExamMathText content={sub.mark_scheme} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Original MCQ Options */}
              {question.options && question.options.length > 0 && (
                <div className="variant-options-list">
                  {question.options.map((opt, idx) => (
                    <div key={idx} className="variant-option-item">
                      <ExamMathText content={opt} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT: Generated AI Variant */}
          <div className="variant-column variant-column--generated">
            <div className="variant-column-header">
              <div className="variant-col-badge variant-col-badge--generated">
                ✨ AI Generated Variant
              </div>
              {variant && (
                <span className="variant-meta-info">
                  {variant.difficulty} • [{variant.marks} mark{variant.marks !== 1 ? 's' : ''}]
                </span>
              )}
            </div>

            <div className="variant-column-scroll">
              {isGenerating ? (
                <div className="variant-loading-state">
                  <div className="variant-shimmer-box" />
                  <div className="variant-shimmer-line" />
                  <div className="variant-shimmer-line" style={{ width: '80%' }} />
                  <div className="variant-shimmer-line" style={{ width: '60%' }} />
                  <p className="variant-loading-text">
                    Authoring Cambridge-standard variant with formulas & rubrics…
                  </p>
                </div>
              ) : variant ? (
                <>
                  <div className="variant-stem-box variant-stem-box--highlight">
                    <ExamMathText content={variant.question_text} />
                  </div>

                  {/* Transferred Diagram Preview */}
                  {variant.diagram_url && (
                    <div className="variant-diagram-box variant-diagram-box--transferred">
                      <span className="variant-diagram-badge variant-diagram-badge--transferred">
                        ✨ Transferred Diagram
                      </span>
                      <img
                        src={variant.diagram_url}
                        alt="Transferred diagram for variant question"
                        className="variant-diagram-img"
                      />
                    </div>
                  )}

                  {/* Variant Sub-questions */}
                  {variant.sub_questions && variant.sub_questions.length > 0 && (
                    <div className="variant-sub-list">
                      {variant.sub_questions.map((sub, idx) => (
                        <div key={idx} className="variant-sub-item">
                          <div className="variant-sub-header">
                            <span className="variant-sub-id">{sub.sub_id}</span>
                            <div className="variant-sub-text">
                              <ExamMathText content={sub.question_text} />
                            </div>
                            <span className="variant-sub-marks">[{sub.marks}]</span>
                          </div>
                          {sub.diagram_url && (
                            <div className="variant-diagram-box variant-diagram-box--transferred" style={{ marginTop: '6px' }}>
                              <span className="variant-diagram-badge variant-diagram-badge--transferred">
                                ✨ Transferred Diagram for {sub.sub_id}
                              </span>
                              <img
                                src={sub.diagram_url}
                                alt={`Diagram for ${sub.sub_id}`}
                                className="variant-diagram-img"
                              />
                            </div>
                          )}
                          {sub.mark_scheme && showMarkScheme && (
                            <div className="variant-sub-ms">
                              <span className="variant-ms-tag">MS:</span>
                              <ExamMathText content={sub.mark_scheme} />
                            </div>
                          )}
                          {sub.guidance && showMarkScheme && (
                            <div className="variant-sub-guidance">
                              <span>💡 Tip:</span>
                              <ExamMathText content={sub.guidance} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Variant MCQ Options */}
                  {variant.options && variant.options.length > 0 && (
                    <div className="variant-options-list">
                      {variant.options.map((opt, idx) => (
                        <div key={idx} className="variant-option-item variant-option-item--mcq">
                          <ExamMathText content={opt} />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Mark Scheme & Insights */}
                  {variant.mark_scheme && showMarkScheme && (
                    <div className="variant-ms-card">
                      <div className="variant-ms-header">
                        <span>✨ Complete Marking Scheme & Guidance</span>
                      </div>
                      <div className="variant-ms-points">
                        {variant.mark_scheme.marking_points?.map((pt, idx) => (
                          <div key={idx} className="variant-ms-point">
                            <span className="variant-ms-dot">•</span>
                            <ExamMathText content={pt} />
                          </div>
                        ))}
                      </div>

                      {variant.mark_scheme.guidance && variant.mark_scheme.guidance.length > 0 && (
                        <div className="variant-insight-box variant-insight-box--guidance">
                          <strong>💡 Examiner Guidance:</strong>
                          {variant.mark_scheme.guidance.map((g, i) => (
                            <div key={i}><ExamMathText content={g} /></div>
                          ))}
                        </div>
                      )}

                      {variant.mark_scheme.common_misconceptions && variant.mark_scheme.common_misconceptions.length > 0 && (
                        <div className="variant-insight-box variant-insight-box--trap">
                          <strong>⚠️ Common Student Traps:</strong>
                          {variant.mark_scheme.common_misconceptions.map((m, i) => (
                            <div key={i}><ExamMathText content={m} /></div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="variant-empty-state">
                  <span style={{ fontSize: '2.5rem', marginBottom: '8px' }}>✨</span>
                  <h4 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 6px', color: 'var(--color-text-primary)' }}>
                    Select a Variant Mode Above
                  </h4>
                  <p style={{ margin: 0, maxWidth: '380px', lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
                    Choose <strong>Parallel Twin</strong>, <strong>Foundation</strong>, <strong>Extension</strong>, <strong>Convert to MCQ</strong>, or <strong>Convert to Structured</strong> to generate an AI question variant.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ─── Modal Footer Actions ─────────────────────────────────────────── */}
        <div className="variant-modal-footer">
          <div className="variant-footer-left">
            <button
              type="button"
              className="variant-toggle-ms-btn"
              onClick={() => setShowMarkScheme(!showMarkScheme)}
            >
              {showMarkScheme ? '👁️ Mark Schemes: Shown' : '🙈 Mark Schemes: Hidden'}
            </button>
          </div>

          <div className="variant-footer-right">
            {actionSuccessMsg && (
              <span className="variant-success-pill animate-fade-in">
                {actionSuccessMsg}
              </span>
            )}

            <button
              type="button"
              className="variant-btn-secondary"
              onClick={onClose}
            >
              {isAddedToTest || isSavedToBank ? 'Done' : 'Cancel'}
            </button>

            {variant && (
              <>
                <button
                  type="button"
                  className="variant-btn-tool"
                  onClick={handleOpenEditor}
                  title="Fine-tune formulas or text in full editor"
                >
                  ✏️ Edit in Live Editor
                </button>

                {onAddToTest && (
                  <button
                    type="button"
                    className={`variant-btn-accent ${isAddedToTest ? 'variant-btn--completed' : ''}`}
                    onClick={handleAddToTest}
                    disabled={isSaving}
                  >
                    {isAddedToTest ? '✓ Added to Test' : '+ Add to Custom Test'}
                  </button>
                )}

                <button
                  type="button"
                  className={`variant-btn-primary ${isSavedToBank ? 'variant-btn--completed' : ''}`}
                  onClick={handleSaveToQuestionBank}
                  disabled={isSaving || isSavedToBank}
                >
                  {isSavedToBank
                    ? '✓ Saved to Question Bank'
                    : isSaving
                    ? 'Saving…'
                    : '💾 Save to Question Bank'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
