import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { Question } from '../types/database';
import { ExamMathText } from './ExamMathText';
import { ExamVisualRender } from './ExamVisualRender';
import { ExamDataTable } from './ExamDataTable';
import {
  generateQuestionVariant,
  stripDuplicateSubQuestionsFromStem,
  stripDuplicateOptionsFromStem,
  extractSvgFromDiagramUrl,
  generateParametricSvg,
  type VariantMode,
} from '../lib/gemini';
import {
  generateExamDiagram,
  suggestDiagramPrompt,
  resolveStylePreset,
  getDailyNeuronUsage,
  type StylePreset,
} from '../services/imageGenerationService';
import { createQuestion } from '../services/questionBankService';
import { getSavedSettings } from '../lib/settings';
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
  const [appliedInstruction, setAppliedInstruction] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [variant, setVariant] = useState<Question | null>(null);
  const [showMarkScheme, setShowMarkScheme] = useState(true);
  const [isSavedToBank, setIsSavedToBank] = useState(false);
  const [isAddedToTest, setIsAddedToTest] = useState(false);
  const [actionSuccessMsg, setActionSuccessMsg] = useState<string | null>(null);

  // Cloudflare Workers AI Diagram States
  const [visualMode, setVisualMode] = useState<'original' | 'svg' | 'ai'>('original');
  const [aiDiagramPrompt, setAiDiagramPrompt] = useState<string>('');
  const [aiStylePreset, setAiStylePreset] = useState<StylePreset>('stem');
  const [isGeneratingDiagram, setIsGeneratingDiagram] = useState(false);
  const [isSuggestingPrompt, setIsSuggestingPrompt] = useState(false);
  const [diagramSuccessMsg, setDiagramSuccessMsg] = useState<string | null>(null);
  const [cachedOriginalDiagram, setCachedOriginalDiagram] = useState<{ url: string | null; svg: string | null }>({ url: null, svg: null });

  // Parametric SVG Studio States
  const [svgCustomPrompt, setSvgCustomPrompt] = useState<string>('');
  const [isGeneratingSvg, setIsGeneratingSvg] = useState<boolean>(false);
  const [isEditingSvgCode, setIsEditingSvgCode] = useState<boolean>(false);
  const [svgSuccessMsg, setSvgSuccessMsg] = useState<string | null>(null);
  const [cachedSvgContent, setCachedSvgContent] = useState<string | null>(null);
  const [cachedAiDiagramUrl, setCachedAiDiagramUrl] = useState<string | null>(null);

  const handleGenerate = useCallback(
    async (mode?: VariantMode, overrideInstruction?: string) => {
      if (!question) return;
      const targetMode: VariantMode = mode || selectedMode || 'parallel';
      setSelectedMode(targetMode);
      setIsGenerating(true);
      setErrorMessage(null);

      const instruction = overrideInstruction !== undefined ? overrideInstruction : customInstruction;
      const trimmedInstruction = instruction.trim();

      try {
        const isImageGenEnabled = Boolean(getSavedSettings().enableVariantImageGeneration);

        const generated = await generateQuestionVariant(question, {
          mode: targetMode,
          customInstruction: trimmedInstruction || undefined,
          enableImageGeneration: isImageGenEnabled,
        });

        const finalSubs = targetMode === 'mcq' ? [] : (generated.sub_questions || []);
        const cleanStem = stripDuplicateSubQuestionsFromStem(
          stripDuplicateOptionsFromStem(generated.question_text || '', generated.options),
          finalSubs
        );

        const resolvedSvg = isImageGenEnabled
          ? (generated.svg_content ||
             extractSvgFromDiagramUrl(generated.diagram_url) ||
             extractSvgFromDiagramUrl(question.diagram_url) ||
             null)
          : (question.svg_content || extractSvgFromDiagramUrl(question.diagram_url) || null);

        const resolvedDiagramUrl = isImageGenEnabled
          ? (generated.diagram_url ||
             (resolvedSvg ? `data:image/svg+xml;utf8,${encodeURIComponent(resolvedSvg)}` : (question.diagram_url || null)))
          : (question.diagram_url || (resolvedSvg ? `data:image/svg+xml;utf8,${encodeURIComponent(resolvedSvg)}` : null));

        const fullVariant: Question = {
          id: `variant-temp-${Date.now()}`,
          created_at: new Date().toISOString(),
          syllabus_id: question.syllabus_id,
          year: question.year || new Date().getFullYear(),
          series: question.series || 'Variant',
          paper_number: question.paper_number || 1,
          question_number: `${question.question_number}V`,
          parent_question_id: null,
          question_text: cleanStem,
          question_style: targetMode === 'structured' ? 'Structured' : targetMode === 'mcq' ? 'Multiple Choice' : (generated.question_style || question.question_style),
          topic: generated.topic || question.topic,
          sub_topic: generated.sub_topic || question.sub_topic,
          difficulty: generated.difficulty || question.difficulty,
          marks: generated.marks || (targetMode === 'mcq' ? 1 : question.marks),
          svg_content: resolvedSvg,
          diagram_url: resolvedDiagramUrl,
          ai_diagram_prompt: isImageGenEnabled ? (generated.ai_diagram_prompt || question.ai_diagram_prompt || null) : null,
          diagram_type: isImageGenEnabled ? (generated.diagram_type !== undefined ? generated.diagram_type : (question.diagram_type || null)) : (question.diagram_type || null),
          has_embedded_values: generated.has_embedded_values !== undefined ? generated.has_embedded_values : (question.has_embedded_values || false),
          diagram_source: question.diagram_source || null,
          resource_ref: generated.resource_ref !== undefined ? generated.resource_ref : (question.resource_ref || null),
          insert_page_number: generated.insert_page_number !== undefined ? generated.insert_page_number : (question.insert_page_number || null),
          audio_url: generated.audio_url !== undefined ? generated.audio_url : (question.audio_url || null),
          audio_metadata: generated.audio_metadata !== undefined ? generated.audio_metadata : (question.audio_metadata || null),
          options: targetMode === 'structured' ? null : (generated.options || null),
          sub_questions: finalSubs,
          mark_scheme: generated.mark_scheme || null,
        };

        setVariant(fullVariant);
        setAppliedInstruction(trimmedInstruction || null);
        setIsSavedToBank(false);
        setIsAddedToTest(false);
        setActionSuccessMsg(null);

        // Visual strategy configuration - prioritize Workers AI for apparatus/illustrations
        const origSvg = extractSvgFromDiagramUrl(question.diagram_url) || question.svg_content || null;
        setCachedOriginalDiagram({
          url: question.diagram_url || null,
          svg: origSvg,
        });

        if (generated.ai_diagram_prompt) {
          setAiDiagramPrompt(generated.ai_diagram_prompt);
          setSvgCustomPrompt(generated.ai_diagram_prompt);
          setVisualMode('ai');
        } else if (question.diagram_url && !resolvedSvg) {
          setVisualMode('original');
        } else if (resolvedSvg) {
          setCachedSvgContent(resolvedSvg);
          setVisualMode('svg');
        } else if (question.diagram_url) {
          setVisualMode('original');
        } else {
          setVisualMode('ai');
        }

        setAiStylePreset(resolveStylePreset(generated.topic || question.topic));
      } catch (err: any) {
        console.error('Failed to generate variant:', err);
        setErrorMessage(err?.message || 'Failed to generate question variant. Please try again.');
      } finally {
        setIsGenerating(false);
      }
    },
    [question, selectedMode, customInstruction]
  );

  const handleGenerateAiDiagram = async () => {
    if (!variant || !aiDiagramPrompt.trim()) return;
    setIsGeneratingDiagram(true);
    setErrorMessage(null);
    setDiagramSuccessMsg(null);

    try {
      const res = await generateExamDiagram(aiDiagramPrompt, {
        stylePreset: aiStylePreset,
        topic: variant.topic,
      });

      if (res.success && res.url) {
        setCachedAiDiagramUrl(res.url);
        setVariant((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            diagram_url: res.url!,
            svg_content: null,
            diagram_type: 'apparatus',
            ai_diagram_prompt: aiDiagramPrompt,
          };
        });
        setVisualMode('ai');
        setDiagramSuccessMsg('✓ Technical diagram generated & saved to Cloudflare R2!');
        setTimeout(() => setDiagramSuccessMsg(null), 4000);
      } else {
        throw new Error(res.error || 'Failed to generate diagram with Workers AI');
      }
    } catch (err: any) {
      console.error('[QuestionVariantModal] Diagram generation failed:', err);
      setErrorMessage(err?.message || 'Workers AI generation failed');
    } finally {
      setIsGeneratingDiagram(false);
    }
  };

  const handleGenerateSvg = async () => {
    if (!variant) return;
    setIsGeneratingSvg(true);
    setErrorMessage(null);
    setSvgSuccessMsg(null);

    try {
      const refUrl = cachedOriginalDiagram.url || question?.diagram_url || undefined;
      const generatedSvg = await generateParametricSvg(variant, svgCustomPrompt.trim() || undefined, refUrl);
      setCachedSvgContent(generatedSvg);
      setVariant((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          svg_content: generatedSvg,
          diagram_url: `data:image/svg+xml;utf8,${encodeURIComponent(generatedSvg)}`,
          diagram_type: 'apparatus',
        };
      });
      setVisualMode('svg');
      setSvgSuccessMsg(refUrl ? '✓ Clean parametric vector SVG reconstructed from original diagram with exact Cambridge typography!' : '✓ Clean parametric vector SVG generated with exact Cambridge-style typography!');
      setTimeout(() => setSvgSuccessMsg(null), 4000);
    } catch (err: any) {
      console.error('[QuestionVariantModal] SVG generation failed:', err);
      setErrorMessage(err?.message || 'Parametric SVG generation failed');
    } finally {
      setIsGeneratingSvg(false);
    }
  };

  const handleSuggestPrompt = async () => {
    if (!variant) return;
    setIsSuggestingPrompt(true);
    try {
      const suggested = await suggestDiagramPrompt(variant);
      setAiDiagramPrompt(suggested);
    } catch (err) {
      console.warn('Failed to suggest prompt:', err);
    } finally {
      setIsSuggestingPrompt(false);
    }
  };

  // Reset state on open or question change
  useEffect(() => {
    setVariant(null);
    setSelectedMode(null);
    setCustomInstruction('');
    setAppliedInstruction(null);
    setErrorMessage(null);
    setIsGenerating(false);
    setIsSavedToBank(false);
    setIsAddedToTest(false);
    setActionSuccessMsg(null);
    setVisualMode('original');
    setAiDiagramPrompt('');
    setDiagramSuccessMsg(null);
    setIsGeneratingDiagram(false);
    setIsSuggestingPrompt(false);
    setSvgCustomPrompt('');
    setIsGeneratingSvg(false);
    setIsEditingSvgCode(false);
    setSvgSuccessMsg(null);
    setCachedSvgContent(null);
    setCachedAiDiagramUrl(null);
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
            <div className="variant-instruction-input-wrap">
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
              {customInstruction && !isGenerating && (
                <button
                  type="button"
                  className="variant-instruction-clear-btn"
                  onClick={() => setCustomInstruction('')}
                  title="Clear custom instruction"
                  aria-label="Clear custom instruction"
                >
                  ✕
                </button>
              )}
            </div>
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
            {PROMPT_SUGGESTIONS.map((text, idx) => {
              const isIncluded = customInstruction.toLowerCase().includes(text.toLowerCase());
              return (
                <button
                  key={idx}
                  type="button"
                  className={`variant-suggestion-chip ${isIncluded ? 'variant-suggestion-chip--active' : ''}`}
                  onClick={() => {
                    setCustomInstruction((prev) => {
                      const trimmed = prev.trim();
                      if (!trimmed) return text;
                      if (trimmed.toLowerCase().includes(text.toLowerCase())) return trimmed;
                      return `${trimmed}; ${text}`;
                    });
                  }}
                  disabled={isGenerating}
                  title={`Add "${text}" to custom instruction`}
                >
                  {isIncluded ? '✓ ' : '+ '} {text}
                </button>
              );
            })}
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

              {/* Original Structured Data Tables if present */}
              {question.data_tables && question.data_tables.length > 0 && (
                <ExamDataTable tables={question.data_tables} />
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
                      {sub.data_tables && sub.data_tables.length > 0 && (
                        <ExamDataTable tables={sub.data_tables} />
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
                    {customInstruction.trim() ? (
                      <>
                        Authoring variant with custom instruction:
                        <span className="variant-loading-instruction">"{customInstruction.trim()}"</span>
                      </>
                    ) : (
                      'Authoring Cambridge-standard variant with formulas & rubrics…'
                    )}
                  </p>
                </div>
              ) : variant ? (
                <>
                  {appliedInstruction && (
                    <div className="variant-applied-badge animate-fade-in">
                      <span className="variant-applied-icon">🎯</span>
                      <div className="variant-applied-content">
                        <span className="variant-applied-label">Custom Instruction Applied</span>
                        <span className="variant-applied-val">"{appliedInstruction}"</span>
                      </div>
                    </div>
                  )}

                  <div className="variant-stem-box variant-stem-box--highlight">
                    <ExamMathText content={variant.question_text} />
                  </div>

                  {/* Transferred Diagram / Generated SVG Preview */}
                  <ExamVisualRender
                    svgContent={variant.svg_content}
                    diagramUrl={variant.diagram_url}
                    resourceRef={variant.resource_ref}
                    alt="Visual diagram for variant question"
                    diagramType={variant.diagram_type}
                    hasEmbeddedValues={variant.has_embedded_values}
                  />

                  {/* Visual Strategy & Diagram Studio */}
                  {!getSavedSettings().enableVariantImageGeneration ? (
                    <div className="variant-original-diagram-banner">
                      <span className="variant-original-diagram-badge">🖼️ Set A Visual Retained</span>
                      <span className="variant-original-diagram-sub">
                        Diagram image generation is disabled in settings. Variant questions and calculations are formulated around this authentic original figure.
                      </span>
                    </div>
                  ) : (
                    <div className="variant-visual-studio">
                    <div className="variant-visual-toolbar">
                      <div className="variant-visual-modes">
                        {Boolean(cachedOriginalDiagram.url || question.diagram_url) && (
                          <button
                            type="button"
                            className={`variant-visual-mode-btn ${visualMode === 'original' ? 'active' : ''}`}
                            onClick={() => {
                              setVisualMode('original');
                              setVariant(prev => prev ? ({
                                ...prev,
                                diagram_url: cachedOriginalDiagram.url || question.diagram_url,
                                svg_content: null,
                              }) : prev);
                            }}
                          >
                            🖼️ Retain Original
                          </button>
                        )}
                        <button
                          type="button"
                          className={`variant-visual-mode-btn ${visualMode === 'ai' ? 'active' : ''}`}
                          onClick={() => {
                            setVisualMode('ai');
                            if (cachedAiDiagramUrl) {
                              setVariant(prev => prev ? ({
                                ...prev,
                                diagram_url: cachedAiDiagramUrl,
                                svg_content: null,
                              }) : prev);
                            }
                          }}
                        >
                          ✨ Workers AI Diagram
                        </button>
                        <button
                          type="button"
                          className={`variant-visual-mode-btn ${visualMode === 'svg' ? 'active' : ''}`}
                          onClick={() => {
                            setVisualMode('svg');
                            const svgToRestore = variant.svg_content || cachedSvgContent || cachedOriginalDiagram.svg;
                            if (svgToRestore) {
                              setVariant(prev => prev ? ({
                                ...prev,
                                svg_content: svgToRestore,
                                diagram_url: `data:image/svg+xml;utf8,${encodeURIComponent(svgToRestore)}`,
                              }) : prev);
                            }
                          }}
                        >
                          📐 Parametric SVG
                        </button>
                      </div>

                      <div className="variant-visual-quota-badge">
                        {visualMode === 'svg' ? (
                          <span>⚡ 100% Vector CAD Typography</span>
                        ) : (
                          <span>⚡ Free Edge AI: {getDailyNeuronUsage().used} / {getDailyNeuronUsage().maxDaily} today</span>
                        )}
                      </div>
                    </div>

                    {/* Parametric SVG Studio Panel */}
                    {visualMode === 'svg' && (
                      <div className="variant-svg-panel animate-fade-in">
                        <div className="variant-svg-header">
                          <div className="variant-svg-info">
                            <span className="variant-svg-badge">
                              {variant.svg_content ? '✓ Vector CAD SVG Active' : '📐 Parametric Vector SVG Studio'}
                            </span>
                            <span className="variant-svg-desc">
                              Zero-hallucination vector line art with true font rendering (<code className="variant-svg-code-inline">&lt;text&gt;</code>) and CAD dimension arrows (<code className="variant-svg-code-inline">&lt;marker&gt;</code>). Ideal for heights, distances, mechanics, and circuits.
                            </span>
                            {Boolean(cachedOriginalDiagram.url || question?.diagram_url) && (
                              <div style={{ marginTop: '6px' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '0.725rem', color: '#0369a1', background: '#e0f2fe', border: '1px solid #bae6fd', padding: '2px 8px', borderRadius: '6px', fontWeight: 600 }}>
                                  👁️ Gemini Vision: Inspects Set A diagram layout to replicate apparatus with new values
                                </span>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="variant-svg-row">
                          <div className="variant-svg-prompt-wrap">
                            <input
                              type="text"
                              className="variant-svg-prompt-input"
                              placeholder="e.g. Student dropping steel sphere from 1.4 m with vertical dimension arrow..."
                              value={svgCustomPrompt}
                              onChange={(e) => setSvgCustomPrompt(e.target.value)}
                              disabled={isGeneratingSvg}
                            />
                            <button
                              type="button"
                              className="variant-svg-suggest-btn"
                              onClick={() => {
                                if (variant.ai_diagram_prompt) {
                                  setSvgCustomPrompt(variant.ai_diagram_prompt);
                                } else {
                                  setSvgCustomPrompt(`Technical line diagram for ${variant.topic || 'physics'}: ${variant.question_text.slice(0, 100).replace(/["\n]/g, ' ')}`);
                                }
                              }}
                              title="Auto-fill prompt from question stem or AI prompt"
                            >
                              💡 Auto-Fill
                            </button>
                          </div>

                          <button
                            type="button"
                            className="variant-svg-generate-btn"
                            onClick={handleGenerateSvg}
                            disabled={isGeneratingSvg}
                          >
                            {isGeneratingSvg ? (
                              <>
                                <span className="variant-spinner-sm"></span> Drawing Vector SVG...
                              </>
                            ) : variant.svg_content ? (
                              '🔄 Regenerate SVG'
                            ) : (
                              '⚡ Generate Parametric SVG'
                            )}
                          </button>

                          {variant.svg_content && (
                            <button
                              type="button"
                              className={`variant-svg-code-toggle-btn ${isEditingSvgCode ? 'active' : ''}`}
                              onClick={() => setIsEditingSvgCode(!isEditingSvgCode)}
                              title="Inspect or tweak raw SVG XML code"
                            >
                              {isEditingSvgCode ? '👁️ Preview' : '📝 Edit SVG XML'}
                            </button>
                          )}
                        </div>

                        {isEditingSvgCode && variant.svg_content && (
                          <div className="variant-svg-code-container animate-fade-in">
                            <div className="variant-svg-code-header">
                              <span>Direct SVG Source (Live Preview Updates Instantly)</span>
                            </div>
                            <textarea
                              className="variant-svg-textarea"
                              value={variant.svg_content}
                              onChange={(e) => {
                                const newSvg = e.target.value;
                                setCachedSvgContent(newSvg);
                                setVariant(prev => prev ? ({
                                  ...prev,
                                  svg_content: newSvg,
                                  diagram_url: `data:image/svg+xml;utf8,${encodeURIComponent(newSvg)}`,
                                }) : prev);
                              }}
                              rows={7}
                              spellCheck={false}
                            />
                          </div>
                        )}

                        {svgSuccessMsg && (
                          <div className="variant-diagram-success-msg">
                            {svgSuccessMsg}
                          </div>
                        )}
                      </div>
                    )}

                    {/* AI Diagram Input & Prompt Controls */}
                    {visualMode === 'ai' && (
                      <div className="variant-ai-panel animate-fade-in">
                        <div className="variant-ai-row">
                          <div className="variant-ai-prompt-wrap">
                            <input
                              type="text"
                              className="variant-ai-prompt-input"
                              placeholder="Describe diagram apparatus, landform, or cartoon..."
                              value={aiDiagramPrompt}
                              onChange={(e) => setAiDiagramPrompt(e.target.value)}
                              disabled={isGeneratingDiagram}
                            />
                            <button
                              type="button"
                              className="variant-ai-suggest-btn"
                              onClick={handleSuggestPrompt}
                              disabled={isSuggestingPrompt || isGeneratingDiagram}
                              title="Auto-formulate prompt from question stem"
                            >
                              {isSuggestingPrompt ? '⏳' : '💡 Auto-Prompt'}
                            </button>
                          </div>

                          <select
                            className="variant-ai-style-select"
                            value={aiStylePreset}
                            onChange={(e) => setAiStylePreset(e.target.value as StylePreset)}
                            disabled={isGeneratingDiagram}
                          >
                            <option value="stem">🔬 STEM (Technical Line Art)</option>
                            <option value="geography">🌍 Geography (Topography / Map)</option>
                            <option value="history">📜 History (Cross-Hatch Cartoon)</option>
                          </select>

                          <button
                            type="button"
                            className="variant-ai-generate-btn"
                            onClick={handleGenerateAiDiagram}
                            disabled={isGeneratingDiagram || !aiDiagramPrompt.trim()}
                          >
                            {isGeneratingDiagram ? (
                              <>
                                <span className="variant-spinner-sm"></span> Generating...
                              </>
                            ) : (
                              '🎨 Generate Diagram'
                            )}
                          </button>
                        </div>

                        {diagramSuccessMsg && (
                          <div className="variant-diagram-success-msg">
                            {diagramSuccessMsg}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  )}

                  {/* Variant Structured Data Tables if present */}
                  {variant.data_tables && variant.data_tables.length > 0 && (
                    <ExamDataTable tables={variant.data_tables} />
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
                          {/* Sub-question Visual / SVG Preview */}
                          <ExamVisualRender
                            svgContent={sub.svg_content}
                            diagramUrl={sub.diagram_url}
                            resourceRef={sub.resource_ref}
                            alt={`Diagram for ${sub.sub_id}`}
                            diagramType={sub.diagram_type}
                            hasEmbeddedValues={sub.has_embedded_values}
                          />
                          {sub.data_tables && sub.data_tables.length > 0 && (
                            <ExamDataTable tables={sub.data_tables} />
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

                      {/* AI Scientific Scratchpad Verification Badge */}
                      {variant.scratchpad && (
                        <div
                          className="variant-scratchpad-box animate-fade-in"
                          style={{
                            marginTop: '12px',
                            padding: '10px 12px',
                            background: '#f8fafc',
                            border: '1px solid #cbd5e1',
                            borderRadius: '6px',
                            fontSize: '0.82rem',
                          }}
                        >
                          <div style={{ fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
                            🧪 Scientific Derivation Verification:
                          </div>
                          {variant.scratchpad.bounds_and_constraints && (
                            <div style={{ marginBottom: '4px' }}>
                              <strong style={{ color: '#475569' }}>Domain Bounds:</strong>{' '}
                              <span>{variant.scratchpad.bounds_and_constraints}</span>
                            </div>
                          )}
                          {variant.scratchpad.independent_variables && (
                            <div style={{ marginBottom: '4px' }}>
                              <strong style={{ color: '#475569' }}>Variables:</strong>{' '}
                              <span>{typeof variant.scratchpad.independent_variables === 'object' ? JSON.stringify(variant.scratchpad.independent_variables) : variant.scratchpad.independent_variables}</span>
                            </div>
                          )}
                          {variant.scratchpad.derivations_and_laws && (
                            <div style={{ marginBottom: '4px' }}>
                              <strong style={{ color: '#475569' }}>Derivations:</strong>{' '}
                              <span>{typeof variant.scratchpad.derivations_and_laws === 'object' ? JSON.stringify(variant.scratchpad.derivations_and_laws) : variant.scratchpad.derivations_and_laws}</span>
                            </div>
                          )}
                          {variant.scratchpad.synchronization_checklist && (
                            <div>
                              <strong style={{ color: '#475569' }}>Checklist:</strong>{' '}
                              <span style={{ color: '#059669' }}>{variant.scratchpad.synchronization_checklist}</span>
                            </div>
                          )}
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
