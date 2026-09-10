import { useState, memo } from 'react';
import type { Question } from '../types/database';
import { ExamMathText } from './ExamMathText';
import { ExamVisualRender } from './ExamVisualRender';
import { ExamDataTable } from './ExamDataTable';
import { parseMcqOption } from '../utils/mcqUtils';
import { formatPaperBadge } from '../utils/paperUtils';
import { stripDuplicateOptionsFromStem, stripDuplicateSubQuestionsFromStem } from '../lib/gemini';
import {
  generateExamDiagram,
  suggestDiagramPrompt,
  resolveStylePreset,
  type StylePreset,
} from '../services/imageGenerationService';
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
  onUpdateQuestion?: (updated: Question) => void;
  isCustomized?: boolean;
  onRevert?: (questionId: string) => void;
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
  onUpdateQuestion,
  isCustomized,
  onRevert,
}: TestQuestionItemProps) {
  const [showMarkScheme, setShowMarkScheme] = useState(false);
  const [isAiStudioOpen, setIsAiStudioOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState(question.ai_diagram_prompt || '');
  const [aiStyle, setAiStyle] = useState<StylePreset>(resolveStylePreset(question.topic));
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [isSuggestingPrompt, setIsSuggestingPrompt] = useState(false);
  const [aiSuccessMsg, setAiSuccessMsg] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const handleGenerateDiagram = async () => {
    if (!aiPrompt.trim()) return;
    setIsGeneratingAi(true);
    setAiError(null);
    setAiSuccessMsg(null);

    try {
      const res = await generateExamDiagram(aiPrompt, {
        stylePreset: aiStyle,
        topic: question.topic,
      });

      if (res.success && res.url) {
        onUpdateQuestion?.({
          ...question,
          diagram_url: res.url,
          svg_content: null,
          diagram_type: 'apparatus',
          ai_diagram_prompt: aiPrompt,
        });
        setAiSuccessMsg('✓ Diagram updated with Workers AI');
        setTimeout(() => setAiSuccessMsg(null), 3000);
      } else {
        throw new Error(res.error || 'Diagram generation failed');
      }
    } catch (err: any) {
      setAiError(err?.message || 'Workers AI error');
    } finally {
      setIsGeneratingAi(false);
    }
  };

  const handleSuggestPrompt = async () => {
    setIsSuggestingPrompt(true);
    try {
      const suggestion = await suggestDiagramPrompt(question);
      setAiPrompt(suggestion);
    } catch (err: any) {
      console.warn('Failed to suggest prompt:', err);
    } finally {
      setIsSuggestingPrompt(false);
    }
  };

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

          {isCustomized && (
            <span className="q-badge" style={{ backgroundColor: '#fef3c7', color: '#b45309', border: '1px solid #fcd34d' }}>
              ✏️ Customised for this test
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

          {/* Revert button */}
          {isCustomized && onRevert && (
            <button
              type="button"
              className="test-q-revert-btn"
              onClick={() => onRevert(question.id)}
              title="Revert to original Question Bank version"
              style={{ padding: '4px 8px', fontSize: '12px', background: '#fef3c7', color: '#b45309', border: '1px solid #fcd34d', borderRadius: '4px', cursor: 'pointer' }}
            >
              ↺ Revert
            </button>
          )}

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

          {/* AI Diagram button */}
          {onUpdateQuestion && (
            <button
              type="button"
              className={`test-q-ai-btn ${isAiStudioOpen ? 'active' : ''}`}
              onClick={() => {
                setIsAiStudioOpen(!isAiStudioOpen);
                if (!aiPrompt) {
                  setAiPrompt(question.ai_diagram_prompt || '');
                }
              }}
              title="Regenerate or attach fresh AI line-art diagram"
            >
              🎨 AI Diagram
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
          <ExamMathText content={stripDuplicateSubQuestionsFromStem(stripDuplicateOptionsFromStem(question.question_text, question.options), question.sub_questions)} />
        </div>

        {/* Diagram / SVG Visual */}
        <ExamVisualRender
          svgContent={question.svg_content}
          diagramUrl={question.diagram_url}
          resourceRef={question.resource_ref}
          alt={`Diagram for Question ${index + 1}`}
          diagramType={question.diagram_type}
          hasEmbeddedValues={question.has_embedded_values}
        />

        {/* Inline AI Diagram Studio */}
        {isAiStudioOpen && onUpdateQuestion && (
          <div className="test-q-ai-studio animate-fade-in">
            <div className="test-q-ai-header">
              <span className="test-q-ai-title">✨ Cloudflare Workers AI Diagram Studio</span>
              <button
                type="button"
                className="test-q-ai-close"
                onClick={() => setIsAiStudioOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="test-q-ai-controls">
              <div className="test-q-ai-input-wrap">
                <input
                  type="text"
                  className="test-q-ai-input"
                  placeholder="Describe apparatus, landform, or cartoon..."
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  disabled={isGeneratingAi}
                />
                <button
                  type="button"
                  className="test-q-ai-suggest-btn"
                  onClick={handleSuggestPrompt}
                  disabled={isSuggestingPrompt || isGeneratingAi}
                  title="Auto-formulate prompt from question stem"
                >
                  {isSuggestingPrompt ? '⏳' : '💡 Auto-Prompt'}
                </button>
              </div>

              <select
                className="test-q-ai-select"
                value={aiStyle}
                onChange={(e) => setAiStyle(e.target.value as StylePreset)}
                disabled={isGeneratingAi}
              >
                <option value="stem">🔬 STEM (Line Art)</option>
                <option value="geography">🌍 Geography (Map/Topography)</option>
                <option value="history">📜 History (Cross-Hatch)</option>
              </select>

              <button
                type="button"
                className="test-q-ai-gen-btn"
                onClick={handleGenerateDiagram}
                disabled={isGeneratingAi || !aiPrompt.trim()}
              >
                {isGeneratingAi ? '⏳ Generating...' : '🎨 Generate'}
              </button>
            </div>

            {aiError && <div className="test-q-ai-error">{aiError}</div>}
            {aiSuccessMsg && <div className="test-q-ai-success">{aiSuccessMsg}</div>}
          </div>
        )}

        {/* Structured Data Tables if present */}
        {question.data_tables && question.data_tables.length > 0 && (
          <ExamDataTable tables={question.data_tables} />
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

                {/* Sub-question diagram / SVG */}
                <ExamVisualRender
                  svgContent={sub.svg_content}
                  diagramUrl={sub.diagram_url}
                  resourceRef={sub.resource_ref}
                  alt={`Diagram for ${sub.sub_id}`}
                  diagramType={sub.diagram_type}
                  hasEmbeddedValues={sub.has_embedded_values}
                />

                {/* Sub-question data tables if present */}
                {sub.data_tables && sub.data_tables.length > 0 && (
                  <ExamDataTable tables={sub.data_tables} />
                )}

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
