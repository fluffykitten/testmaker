import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from '../services/testBuilderService';
import { ExamMathText } from './ExamMathText';
import { ExamVisualRender } from './ExamVisualRender';
import {
  classifyQuestion,
  cleanQuestionNumber,
  generateExamVariantBatch,
  regenerateSingleVariant,
  persistVariantExam,
  type VariantGenerationItem,
} from '../services/examVariantService';
import { getSavedSettings } from '../lib/settings';
import './ExamVariantModal.css';

interface ExamVariantModalProps {
  isOpen: boolean;
  onClose: () => void;
  originalQuestions: Question[];
  originalHeaderConfig: ExamHeaderConfig;
  onSaveComplete: () => void;
  onOpenInBuilder?: (questions: Question[], headerConfig: ExamHeaderConfig) => void;
}

type ModalStep = 'config' | 'generating' | 'review';

export const ExamVariantModal: React.FC<ExamVariantModalProps> = ({
  isOpen,
  onClose,
  originalQuestions,
  originalHeaderConfig,
  onSaveComplete,
  onOpenInBuilder,
}) => {
  const [step, setStep] = useState<ModalStep>('config');
  const [examTitle, setExamTitle] = useState('');
  const [globalDirective, setGlobalDirective] = useState('');
  const [generateAiDiagrams, setGenerateAiDiagrams] = useState(() => Boolean(getSavedSettings().enableVariantImageGeneration));
  const [items, setItems] = useState<VariantGenerationItem[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Review step states
  const [activeTweakIdx, setActiveTweakIdx] = useState<number | null>(null);
  const [tweakTextMap, setTweakTextMap] = useState<Record<number, string>>({});
  const [regeneratingIdx, setRegeneratingIdx] = useState<number | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  // Dismiss backdrop
  const backdropDismissProps = useBackdropDismiss(onClose);

  // Initialize title and items on open
  useEffect(() => {
    if (!isOpen) return;

    const baseTitle = originalHeaderConfig.title || 'Exam Assessment';
    setExamTitle(`${baseTitle} - Set B`);
    setGlobalDirective('');
    setGenerateAiDiagrams(true);
    setStep('config');
    setSaveError(null);
    setActiveTweakIdx(null);
    setTweakTextMap({});
    setRegeneratingIdx(null);

    // Initial pre-classification of questions
    const initialItems: VariantGenerationItem[] = originalQuestions.map((q, idx) => {
      const classification = classifyQuestion(q);
      const cleanNum = cleanQuestionNumber(q.question_number, idx);

      if (classification.action === 'skip') {
        return {
          originalQuestion: q,
          index: idx,
          status: 'skipped',
          variantQuestion: { ...q, question_number: cleanNum },
          skipReason: classification.reason,
        };
      }

      return {
        originalQuestion: q,
        index: idx,
        status: 'pending',
        variantQuestion: null,
        isPhotoReused: classification.isPhotoReused,
      };
    });

    setItems(initialItems);
  }, [isOpen, originalQuestions, originalHeaderConfig]);

  // Clean up abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Compute counts
  const generatableCount = useMemo(() => {
    return items.filter((it) => it.status !== 'skipped' || !it.skipReason).length;
  }, [items]);

  const skippedCount = useMemo(() => {
    return items.filter((it) => it.status === 'skipped' && it.skipReason).length;
  }, [items]);

  const completedCount = useMemo(() => {
    return items.filter((it) => it.status === 'done').length;
  }, [items]);

  const progressPercent = useMemo(() => {
    if (generatableCount === 0) return 100;
    return Math.round((completedCount / generatableCount) * 100);
  }, [completedCount, generatableCount]);

  // Handler: Start Batch Generation
  const handleStartGeneration = async () => {
    setStep('generating');
    abortControllerRef.current = new AbortController();

    try {
      const result = await generateExamVariantBatch(originalQuestions, {
        title: examTitle,
        globalDirective: globalDirective.trim() || undefined,
        generateAiDiagrams,
        concurrency: 2,
        signal: abortControllerRef.current.signal,
        onProgress: (updatedItems) => {
          setItems(updatedItems);
        },
      });

      setItems(result.items);
      setStep('review');
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setStep('review');
      } else {
        console.error('[ExamVariantModal] Batch generation failed:', err);
        setStep('review');
      }
    }
  };

  // Handler: Cancel generation mid-flight
  const handleCancelGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setStep('review');
  };

  // Handler: Regenerate single variant in review
  const handleRegenerateSingle = async (index: number) => {
    const item = items[index];
    if (!item) return;

    setRegeneratingIdx(index);
    const tweakText = tweakTextMap[index] || '';

    try {
      const updated = await regenerateSingleVariant(item, {
        globalDirective: globalDirective.trim() || undefined,
        tweakDirective: tweakText.trim() || undefined,
        generateAiDiagrams,
      });

      setItems((prev) => {
        const next = [...prev];
        next[index] = updated;
        return next;
      });

      setActiveTweakIdx(null);
      setTweakTextMap((prev) => ({ ...prev, [index]: '' }));
    } catch (err: any) {
      console.error(`[ExamVariantModal] Failed to regenerate Q${index + 1}:`, err);
      alert(`Failed to regenerate variant for question ${index + 1}: ${err?.message || 'Unknown error'}`);
    } finally {
      setRegeneratingIdx(null);
    }
  };

  // Handler: Toggle use original question
  const handleToggleUseOriginal = (index: number) => {
    setItems((prev) => {
      const next = [...prev];
      const current = next[index];
      if (current) {
        next[index] = {
          ...current,
          useOriginal: !current.useOriginal,
        };
      }
      return next;
    });
  };

  // Handler: Persist and Save as New Exam
  const handleSaveExam = async (openInBuilder = false) => {
    setIsSaving(true);
    setSaveError(null);

    try {
      await persistVariantExam(
        items,
        originalHeaderConfig,
        examTitle.trim() || `${originalHeaderConfig.title || 'Exam'} - Set B`
      );

      onSaveComplete();

      if (openInBuilder && onOpenInBuilder) {
        // Collect resolved questions for builder
        const resolvedQs = items.map((it) => {
          if (it.useOriginal || !it.variantQuestion) {
            return it.originalQuestion;
          }
          return it.variantQuestion;
        });
        onOpenInBuilder(resolvedQs, {
          ...originalHeaderConfig,
          title: examTitle.trim() || `${originalHeaderConfig.title || 'Exam'} - Set B`,
        });
      }

      onClose();
    } catch (err: any) {
      console.error('[ExamVariantModal] Save failed:', err);
      setSaveError(`Failed to save variant exam: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      className="exam-variant-backdrop"
      {...backdropDismissProps}
      role="dialog"
      aria-modal="true"
      aria-labelledby="exam-variant-modal-title"
    >
      <div className="exam-variant-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="exam-variant-header">
          <div className="exam-variant-header-left">
            <div className="exam-variant-header-icon" aria-hidden="true">
              🔀
            </div>
            <div>
              <h2 id="exam-variant-modal-title" className="exam-variant-title">
                AI Parallel Twin Exam Generator (Set B)
              </h2>
              <p className="exam-variant-subtitle">
                Generate an equivalent parallel exam paper with identical marks, topics, and question formats.
              </p>
            </div>

            {/* Step Indicators */}
            <div className="exam-variant-steps-indicator" aria-label="Wizard Steps">
              <span className={`exam-variant-step-pill ${step === 'config' ? 'active' : 'completed'}`}>
                {step !== 'config' ? '✓' : '1'} Configure
              </span>
              <span style={{ color: 'var(--color-text-tertiary, #94a3b8)' }}>→</span>
              <span className={`exam-variant-step-pill ${step === 'generating' ? 'active' : step === 'review' ? 'completed' : ''}`}>
                {step === 'review' ? '✓' : '2'} Generate
              </span>
              <span style={{ color: 'var(--color-text-tertiary, #94a3b8)' }}>→</span>
              <span className={`exam-variant-step-pill ${step === 'review' ? 'active' : ''}`}>
                3 Review & Compare
              </span>
            </div>
          </div>

          <button
            type="button"
            className="exam-variant-close-btn"
            onClick={onClose}
            title="Close modal"
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="exam-variant-body">
          {/* ─── STEP 1: CONFIGURE ────────────────────────────────────────── */}
          {step === 'config' && (
            <>
              <div className="exam-variant-field">
                <label htmlFor="variant-exam-title" className="exam-variant-label">
                  Exam Title (Set B)
                </label>
                <input
                  id="variant-exam-title"
                  type="text"
                  className="exam-variant-input"
                  value={examTitle}
                  onChange={(e) => setExamTitle(e.target.value)}
                  placeholder="e.g. Biology Midterm Assessment - Set B"
                />
              </div>

              <div className="exam-variant-field">
                <label htmlFor="variant-global-directive" className="exam-variant-label">
                  Teacher Global Directive <span className="exam-variant-hint">(Optional)</span>
                </label>
                <textarea
                  id="variant-global-directive"
                  className="exam-variant-input exam-variant-textarea"
                  value={globalDirective}
                  onChange={(e) => setGlobalDirective(e.target.value)}
                  placeholder="e.g. 'Use realistic laboratory contexts', 'Focus on industrial chemical processes', 'Change all masses to kg'..."
                />
              </div>

              <div className="exam-variant-field" style={{ marginTop: '4px', marginBottom: '16px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  <input
                    type="checkbox"
                    checked={generateAiDiagrams}
                    onChange={(e) => setGenerateAiDiagrams(e.target.checked)}
                    style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: '#6366f1' }}
                  />
                  <span>✨ Generate fresh technical diagrams for altered apparatus (Workers AI / Parametric SVG)</span>
                </label>
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary, #64748b)', marginLeft: '24px', marginTop: '2px' }}>
                  {generateAiDiagrams
                    ? 'Synthesizes new figures. (Can also be managed in Advanced Settings)'
                    : 'Disabled (recommended). Original Set A diagrams will be retained unchanged, focusing variants on question text & calculations.'}
                </div>
              </div>

              {/* Question Inventory */}
              <div className="exam-variant-inventory">
                <div className="exam-variant-inventory-header">
                  <span>EXAM QUESTION INVENTORY ({items.length} QUESTIONS)</span>
                  <span>
                    {generatableCount} to regenerate • {skippedCount} copied unchanged
                  </span>
                </div>

                <table className="exam-variant-inventory-table">
                  <thead>
                    <tr>
                      <th style={{ width: '60px' }}>Q#</th>
                      <th>Topic & Sub-Topic</th>
                      <th style={{ width: '110px' }}>Style</th>
                      <th style={{ width: '80px' }}>Marks</th>
                      <th style={{ width: '220px' }}>Generation Plan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, idx) => {
                      const q = item.originalQuestion;
                      return (
                        <tr key={q.id || idx}>
                          <td style={{ fontWeight: 700 }}>{cleanQuestionNumber(q.question_number, idx)}</td>
                          <td>
                            <div style={{ fontWeight: 600 }}>{q.topic || 'General'}</div>
                            {q.sub_topic && (
                              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary, #64748b)' }}>
                                {q.sub_topic}
                              </div>
                            )}
                          </td>
                          <td>{q.question_style || 'Structured'}</td>
                          <td style={{ fontWeight: 700 }}>{q.marks || 1} m</td>
                          <td>
                            {item.isPhotoReused ? (
                              <span className="status-badge status-badge--photo" title="Reuses existing photo asset with a newly generated question & mark scheme">
                                📷 Photo Reused • New Question
                              </span>
                            ) : item.status === 'skipped' ? (
                              <span className="status-badge status-badge--skip" title={item.skipReason}>
                                ⏭️ Copied Unchanged ({item.skipReason?.split(' ')[0]})
                              </span>
                            ) : (
                              <span className="status-badge status-badge--ready">
                                ✨ Parallel AI Twin
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* ─── STEP 2: GENERATING PROGRESS ─────────────────────────────── */}
          {step === 'generating' && (
            <div className="exam-variant-progress-container">
              <div className="exam-variant-progress-header">
                <span>
                  Generating Set B Questions ({completedCount} of {generatableCount} completed)
                </span>
                <span>{progressPercent}%</span>
              </div>

              <div className="exam-variant-progress-track">
                <div
                  className="exam-variant-progress-bar"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>

              <div className="exam-variant-live-items-list">
                {items.map((item, idx) => {
                  const q = item.originalQuestion;
                  const isCurrent = item.status === 'generating';
                  return (
                    <div
                      key={q.id || idx}
                      className={`exam-variant-live-row ${isCurrent ? 'generating' : ''}`}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontWeight: 700, width: '32px' }}>
                          Q{cleanQuestionNumber(q.question_number, idx)}
                        </span>
                        <span>{q.topic || 'Question'}</span>
                        {item.isPhotoReused && (
                          <span style={{ fontSize: '0.75rem', color: '#0284c7' }}>
                            (📷 Visual Asset)
                          </span>
                        )}
                      </div>

                      <div>
                        {item.status === 'pending' && (
                          <span className="status-badge" style={{ background: '#f1f5f9', color: '#64748b' }}>
                            ⏳ Queued
                          </span>
                        )}
                        {item.status === 'generating' && (
                          <span className="status-badge status-badge--generating">
                            🔄 Generating AI Twin...
                          </span>
                        )}
                        {item.status === 'done' && (
                          <span className="status-badge status-badge--ready">
                            ✅ Ready
                          </span>
                        )}
                        {item.status === 'skipped' && (
                          <span className="status-badge status-badge--skip">
                            ⏭️ Copied Unchanged
                          </span>
                        )}
                        {item.status === 'failed' && (
                          <span className="status-badge status-badge--failed" title={item.errorMessage}>
                            ❌ Failed
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ─── STEP 3: REVIEW & COMPARE ─────────────────────────────────── */}
          {step === 'review' && (
            <div className="exam-variant-comparison-list">
              {items.map((item, idx) => {
                const orig = item.originalQuestion;
                const variant = item.variantQuestion;
                const isRegenerating = regeneratingIdx === idx;
                const isShowingTweak = activeTweakIdx === idx;
                const isUsingOriginal = item.useOriginal || item.status === 'skipped' || !variant;

                return (
                  <div key={orig.id || idx} className="exam-variant-comparison-card">
                    {/* Header */}
                    <div className="exam-variant-comparison-header">
                      <div className="exam-variant-card-title-row">
                        <span>Question {cleanQuestionNumber(orig.question_number, idx)}</span>
                        <span style={{ color: 'var(--color-text-secondary, #64748b)', fontWeight: 500 }}>
                          • {orig.topic} ({orig.marks} marks)
                        </span>

                        {item.isPhotoReused && (
                          <span className="status-badge status-badge--photo">
                            📷 Photo Reused
                          </span>
                        )}
                        {item.isAiDiagramGenerated && (
                          <span className="status-badge" style={{ background: '#ede9fe', color: '#6366f1', border: '1px solid #c7d2fe' }}>
                            🎨 AI Diagram Generated
                          </span>
                        )}
                        {!item.isAiDiagramGenerated && item.variantQuestion?.svg_content && (
                          <span className="status-badge" style={{ background: '#e0f2fe', color: '#0369a1', border: '1px solid #bae6fd' }}>
                            📐 Parametric SVG
                          </span>
                        )}
                        {item.status === 'skipped' && (
                          <span className="status-badge status-badge--skip">
                            ⏭️ Copied Unchanged
                          </span>
                        )}
                        {item.useOriginal && (
                          <span className="status-badge" style={{ background: '#f1f5f9', color: '#475569' }}>
                            ↩️ Using Set A Original
                          </span>
                        )}
                      </div>

                      <div className="exam-variant-card-actions">
                        {item.status !== 'skipped' && (
                          <>
                            <button
                              type="button"
                              className="exam-variant-btn exam-variant-btn--secondary"
                              onClick={() => setActiveTweakIdx(isShowingTweak ? null : idx)}
                              disabled={isRegenerating}
                              style={{ fontSize: '0.75rem', padding: '5px 10px' }}
                            >
                              {isShowingTweak ? 'Cancel Tweak' : '✍️ Tweak'}
                            </button>

                            <button
                              type="button"
                              className="exam-variant-btn exam-variant-btn--secondary"
                              onClick={() => handleRegenerateSingle(idx)}
                              disabled={isRegenerating}
                              style={{ fontSize: '0.75rem', padding: '5px 10px' }}
                            >
                              {isRegenerating ? '🔄 Regenerating...' : '🔄 Regenerate'}
                            </button>

                            <button
                              type="button"
                              className="exam-variant-btn exam-variant-btn--secondary"
                              onClick={() => handleToggleUseOriginal(idx)}
                              style={{ fontSize: '0.75rem', padding: '5px 10px' }}
                            >
                              {isUsingOriginal ? '🔀 Use Set B Twin' : '↩️ Use Set A Original'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Inline Tweak Box */}
                    {isShowingTweak && (
                      <div className="exam-variant-tweak-box">
                        <input
                          type="text"
                          className="exam-variant-input"
                          style={{ flex: 1 }}
                          value={tweakTextMap[idx] || ''}
                          onChange={(e) =>
                            setTweakTextMap((prev) => ({ ...prev, [idx]: e.target.value }))
                          }
                          placeholder="e.g. 'Make the calculation numbers easier', 'Ask about cell wall instead'..."
                        />
                        <button
                          type="button"
                          className="exam-variant-btn exam-variant-btn--primary"
                          onClick={() => handleRegenerateSingle(idx)}
                          disabled={isRegenerating}
                          style={{ fontSize: '0.75rem', padding: '8px 14px' }}
                        >
                          Apply & Regenerate
                        </button>
                      </div>
                    )}

                    {/* Side-by-Side Comparison Grid */}
                    <div className="exam-variant-comparison-grid">
                      {/* Left: Original Set A */}
                      <div className="exam-variant-pane exam-variant-pane--original">
                        <div className="exam-variant-pane-badge">Original (Set A)</div>
                        <div className="exam-variant-stem-text">
                          <ExamMathText content={orig.question_text || ''} />
                        </div>

                        {/* Visual / Diagram */}
                        {(orig.diagram_url || orig.svg_content) && (
                          <div className="exam-variant-visual-box">
                            <ExamVisualRender
                              diagramUrl={orig.diagram_url}
                              svgContent={orig.svg_content}
                              diagramType={orig.diagram_type}
                              resourceRef={orig.resource_ref}
                              alt={`Original Figure ${cleanQuestionNumber(orig.question_number, idx)}`}
                            />
                          </div>
                        )}

                        {/* Sub-questions breakdown */}
                        {orig.sub_questions && orig.sub_questions.length > 0 && (
                          <div className="exam-variant-subs-list">
                            {orig.sub_questions.map((sub, sIdx) => (
                              <div key={sIdx} className="exam-variant-sub-item">
                                <div className="exam-variant-sub-meta">
                                  <span>{sub.sub_id}</span>
                                  <span>[{sub.marks} m]</span>
                                </div>
                                <ExamMathText content={sub.question_text} />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Right: Variant Set B */}
                      <div className="exam-variant-pane exam-variant-pane--variant">
                        <div className="exam-variant-pane-badge set-b">
                          {isUsingOriginal ? 'Copied Original (Set B)' : 'Parallel Twin (Set B)'}
                        </div>

                        {variant ? (
                          <>
                            <div className="exam-variant-stem-text">
                              <ExamMathText content={isUsingOriginal ? (orig.question_text || '') : (variant.question_text || '')} />
                            </div>

                            {/* Visual / Diagram */}
                            {((isUsingOriginal ? orig.diagram_url : variant.diagram_url) ||
                              (isUsingOriginal ? orig.svg_content : variant.svg_content)) && (
                              <div className="exam-variant-visual-box">
                                <ExamVisualRender
                                  diagramUrl={isUsingOriginal ? orig.diagram_url : variant.diagram_url}
                                  svgContent={isUsingOriginal ? orig.svg_content : variant.svg_content}
                                  diagramType={isUsingOriginal ? orig.diagram_type : variant.diagram_type}
                                  resourceRef={isUsingOriginal ? orig.resource_ref : variant.resource_ref}
                                  alt={`Variant Figure ${cleanQuestionNumber(orig.question_number, idx)}`}
                                />
                              </div>
                            )}

                            {/* Sub-questions breakdown */}
                            {(isUsingOriginal ? orig.sub_questions : variant.sub_questions) &&
                              (isUsingOriginal ? orig.sub_questions : variant.sub_questions).length > 0 && (
                                <div className="exam-variant-subs-list">
                                  {(isUsingOriginal ? orig.sub_questions : variant.sub_questions).map((sub, sIdx) => (
                                    <div key={sIdx} className="exam-variant-sub-item">
                                      <div className="exam-variant-sub-meta">
                                        <span>{sub.sub_id}</span>
                                        <span>[{sub.marks} m]</span>
                                      </div>
                                      <ExamMathText content={sub.question_text} />
                                    </div>
                                  ))}
                                </div>
                              )}
                          </>
                        ) : (
                          <div style={{ padding: '20px', textAlign: 'center', color: '#dc2626' }}>
                            Generation failed for this question. Original Set A question will be retained.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {saveError && (
            <div style={{ padding: '10px 14px', background: '#fee2e2', color: '#dc2626', borderRadius: '8px' }}>
              {saveError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="exam-variant-footer">
          <div className="exam-variant-footer-summary">
            {step === 'config' && (
              <span>
                {originalQuestions.length} questions ready to generate
              </span>
            )}
            {step === 'generating' && (
              <span>
                Generating parallel exam... Please keep this window open.
              </span>
            )}
            {step === 'review' && (
              <span>
                {items.length} questions •{' '}
                {items.filter((it) => it.status === 'done' && !it.useOriginal).length} twin variants •{' '}
                {items.filter((it) => it.useOriginal || it.status === 'skipped').length} copied from Set A
              </span>
            )}
          </div>

          <div className="exam-variant-footer-actions">
            {step === 'config' && (
              <>
                <button
                  type="button"
                  className="exam-variant-btn exam-variant-btn--secondary"
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="exam-variant-btn exam-variant-btn--primary"
                  onClick={handleStartGeneration}
                  disabled={!examTitle.trim()}
                >
                  ✨ Start Generation
                </button>
              </>
            )}

            {step === 'generating' && (
              <button
                type="button"
                className="exam-variant-btn exam-variant-btn--secondary"
                onClick={handleCancelGeneration}
              >
                ⏹️ Stop & Review Partial Results
              </button>
            )}

            {step === 'review' && (
              <>
                <button
                  type="button"
                  className="exam-variant-btn exam-variant-btn--secondary"
                  onClick={onClose}
                  disabled={isSaving}
                >
                  Close
                </button>

                {onOpenInBuilder && (
                  <button
                    type="button"
                    className="exam-variant-btn exam-variant-btn--secondary"
                    onClick={() => handleSaveExam(true)}
                    disabled={isSaving}
                    title="Save variant exam and load directly into Test Builder"
                  >
                    {isSaving ? 'Saving...' : '✏️ Save & Open in Builder'}
                  </button>
                )}

                <button
                  type="button"
                  className="exam-variant-btn exam-variant-btn--success"
                  onClick={() => handleSaveExam(false)}
                  disabled={isSaving}
                >
                  {isSaving ? '💾 Saving Exam...' : '💾 Save as New Exam'}
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
