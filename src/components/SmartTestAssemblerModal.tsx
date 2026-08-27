import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { Question, Syllabus } from '../types/database';
import { ExamMathText } from './ExamMathText';
import {
  assembleTestFromCriteria,
  DIFFICULTY_PRESETS,
  type TestAssemblyCriteria,
  type AssemblyResult,
  type DifficultyBalance,
  type QuestionStyleFilter,
  type DiagramPreference,
  type AssemblySortOrder,
} from '../services/autoAssemblerService';
import {
  fetchUploadedSubjectTopics,
  type SubjectTopicSummary,
} from '../services/questionBankService';
import './SmartTestAssemblerModal.css';

interface SmartTestAssemblerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoadIntoBuilder: (assembledQuestions: Question[]) => void;
  syllabuses?: Syllabus[];
  topics?: { topic: string; subTopics: string[] }[];
  customPool?: Question[];
}

const MARK_PRESETS = [20, 40, 60, 80, 100];

export const SmartTestAssemblerModal: React.FC<SmartTestAssemblerModalProps> = ({
  isOpen,
  onClose,
  onLoadIntoBuilder,
  customPool,
}) => {
  const [step, setStep] = useState<'configure' | 'preview'>('configure');
  const [isAssembling, setIsAssembling] = useState(false);
  const [assemblyResult, setAssemblyResult] = useState<AssemblyResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Uploaded Subject & Topic summaries from DB
  const [subjectSummaries, setSubjectSummaries] = useState<SubjectTopicSummary[]>([]);
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);

  // Selected Subject Index ('all' or index in subjectSummaries)
  const [selectedSubjectIdx, setSelectedSubjectIdx] = useState<string>('all');

  // User-added custom topics for the current session
  const [customAddedTopics, setCustomAddedTopics] = useState<string[]>([]);
  const [newTopicInput, setNewTopicInput] = useState<string>('');

  // Criteria State
  const [targetMarks, setTargetMarks] = useState<number>(40);
  const [customMarksInput, setCustomMarksInput] = useState<string>('');
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  
  // Topic Proportion Mode: 'equal' (automatic equal split) | 'custom' (user custom percentage sliders)
  const [topicProportionMode, setTopicProportionMode] = useState<'equal' | 'custom'>('equal');
  const [topicWeights, setTopicWeights] = useState<Record<string, number>>({});

  const [activeDifficultyPresetId, setActiveDifficultyPresetId] = useState<string>('cambridge_standard');
  const [questionStyle, setQuestionStyle] = useState<QuestionStyleFilter>('all');
  const [diagramPreference, setDiagramPreference] = useState<DiagramPreference>('any');
  const [sortOrder, setSortOrder] = useState<AssemblySortOrder>('progressive');

  // Load uploaded metadata from database on modal open
  useEffect(() => {
    if (!isOpen) return;

    setStep('configure');
    setErrorMessage(null);
    setCustomAddedTopics([]);
    setNewTopicInput('');
    setTopicWeights({});
    setTopicProportionMode('equal');

    async function loadData() {
      setIsLoadingMetadata(true);
      try {
        const summaries = await fetchUploadedSubjectTopics();
        setSubjectSummaries(summaries);
        if (summaries.length > 0) {
          setSelectedSubjectIdx('0'); // default to first uploaded subject
        } else {
          setSelectedSubjectIdx('all');
        }
      } catch (err) {
        console.error('Failed to load subject metadata:', err);
      } finally {
        setIsLoadingMetadata(false);
      }
    }

    loadData();
  }, [isOpen]);

  // Determine active topics list based on selected subject
  const currentTopicItems = useMemo(() => {
    const topicCountMap = new Map<string, { count: number; marks: number }>();

    if (selectedSubjectIdx === 'all') {
      // Aggregate across all subjects
      subjectSummaries.forEach((s) => {
        s.topics.forEach((t) => {
          const prev = topicCountMap.get(t.name) || { count: 0, marks: 0 };
          topicCountMap.set(t.name, {
            count: prev.count + t.questionCount,
            marks: prev.marks + t.totalMarks,
          });
        });
      });
    } else {
      const idx = parseInt(selectedSubjectIdx, 10);
      if (!isNaN(idx) && subjectSummaries[idx]) {
        subjectSummaries[idx].topics.forEach((t) => {
          topicCountMap.set(t.name, {
            count: t.questionCount,
            marks: t.totalMarks,
          });
        });
      }
    }

    // Include custom added topics
    customAddedTopics.forEach((tName) => {
      if (!topicCountMap.has(tName)) {
        topicCountMap.set(tName, { count: 0, marks: 0 });
      }
    });

    return Array.from(topicCountMap.entries()).map(([name, stats]) => ({
      name,
      questionCount: stats.count,
      totalMarks: stats.marks,
    }));
  }, [selectedSubjectIdx, subjectSummaries, customAddedTopics]);

  // Effective marks target
  const effectiveMarks = customMarksInput
    ? Math.max(5, parseInt(customMarksInput, 10) || targetMarks)
    : targetMarks;

  // Initialize or rebalance weights equally across selected topics
  const distributeWeightsEvenly = (topicsList: string[]) => {
    if (topicsList.length === 0) {
      setTopicWeights({});
      return;
    }
    const perTopic = Math.floor(100 / topicsList.length);
    const remainder = 100 - perTopic * topicsList.length;
    const newWeights: Record<string, number> = {};
    topicsList.forEach((t, i) => {
      newWeights[t] = perTopic + (i === 0 ? remainder : 0);
    });
    setTopicWeights(newWeights);
  };

  // Current active difficulty balance
  const currentDifficultyBalance: DifficultyBalance = useMemo(() => {
    const preset = DIFFICULTY_PRESETS.find((p) => p.id === activeDifficultyPresetId);
    return preset ? preset.balance : { easy: 30, medium: 50, hard: 20 };
  }, [activeDifficultyPresetId]);

  // Topic selection helpers
  const handleToggleTopic = (topicName: string) => {
    setSelectedTopics((prev) => {
      const updated = prev.includes(topicName)
        ? prev.filter((t) => t !== topicName)
        : [...prev, topicName];

      if (topicProportionMode === 'custom') {
        distributeWeightsEvenly(updated);
      }
      return updated;
    });
  };

  const handleSelectAllTopics = () => {
    const allNames = currentTopicItems.map((t) => t.name);
    setSelectedTopics(allNames);
    if (topicProportionMode === 'custom') {
      distributeWeightsEvenly(allNames);
    }
  };

  const handleClearTopics = () => {
    setSelectedTopics([]);
    setTopicWeights({});
  };

  // Add custom topic tag
  const handleAddCustomTopic = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = newTopicInput.trim();
    if (!trimmed) return;

    if (!customAddedTopics.includes(trimmed)) {
      setCustomAddedTopics((prev) => [...prev, trimmed]);
    }
    if (!selectedTopics.includes(trimmed)) {
      const updated = [...selectedTopics, trimmed];
      setSelectedTopics(updated);
      if (topicProportionMode === 'custom') {
        distributeWeightsEvenly(updated);
      }
    }
    setNewTopicInput('');
  };

  // Switch proportion mode
  const handleToggleProportionMode = (mode: 'equal' | 'custom') => {
    setTopicProportionMode(mode);
    if (mode === 'custom' && selectedTopics.length > 0) {
      distributeWeightsEvenly(selectedTopics);
    }
  };

  // Update specific topic weight
  const handleUpdateTopicWeight = (topicName: string, value: number) => {
    setTopicWeights((prev) => ({
      ...prev,
      [topicName]: Math.max(0, Math.min(100, value)),
    }));
  };

  // Auto-normalize topic weights to exactly 100%
  const handleNormalizeWeights = () => {
    if (selectedTopics.length === 0) return;
    const currentSum = selectedTopics.reduce((sum, t) => sum + (topicWeights[t] || 0), 0);
    if (currentSum === 0) {
      distributeWeightsEvenly(selectedTopics);
      return;
    }
    const newWeights: Record<string, number> = {};
    let accumulated = 0;
    selectedTopics.forEach((t, i) => {
      if (i === selectedTopics.length - 1) {
        newWeights[t] = Math.max(0, 100 - accumulated);
      } else {
        const val = Math.round(((topicWeights[t] || 0) / currentSum) * 100);
        newWeights[t] = val;
        accumulated += val;
      }
    });
    setTopicWeights(newWeights);
  };

  // Total calculated weight percentage in custom mode
  const totalCustomWeight = useMemo(() => {
    return selectedTopics.reduce((sum, t) => sum + (topicWeights[t] || 0), 0);
  }, [selectedTopics, topicWeights]);

  // Run Assembly Algorithm
  const handleAssemble = async () => {
    setIsAssembling(true);
    setErrorMessage(null);

    // Get syllabusId for selected subject
    let syllabusId: string | null = null;
    if (selectedSubjectIdx !== 'all') {
      const idx = parseInt(selectedSubjectIdx, 10);
      if (!isNaN(idx) && subjectSummaries[idx]?.syllabusId) {
        syllabusId = subjectSummaries[idx].syllabusId;
      }
    }

    const criteria: TestAssemblyCriteria = {
      targetMarks: effectiveMarks,
      syllabusId,
      selectedTopics,
      topicProportions: topicProportionMode === 'custom' ? topicWeights : undefined,
      difficultyBalance: currentDifficultyBalance,
      questionStyle,
      diagramPreference,
      sortOrder,
    };

    try {
      const result = await assembleTestFromCriteria(criteria, customPool);
      if (result.questions.length === 0) {
        setErrorMessage(
          'No matching questions found in Question Bank for these criteria. Try selecting more topics or adjusting difficulty/marks.'
        );
      } else {
        setAssemblyResult(result);
        setStep('preview');
      }
    } catch (err: any) {
      console.error('Failed to assemble test:', err);
      setErrorMessage(err?.message || 'Failed to auto-assemble exam paper.');
    } finally {
      setIsAssembling(false);
    }
  };

  const handleApplyToBuilder = () => {
    if (!assemblyResult || assemblyResult.questions.length === 0) return;
    onLoadIntoBuilder(assemblyResult.questions);
    onClose();
  };

  const backdropDismiss = useBackdropDismiss(onClose);

  if (!isOpen) return null;

  return createPortal(
    <div className="assembler-backdrop animate-fade-in" {...backdropDismiss}>
      <div
        className="assembler-modal animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ─── Header ──────────────────────────────────────────────────────── */}
        <div className="assembler-header">
          <div className="assembler-header-left">
            <div className="assembler-header-icon">⚡</div>
            <div>
              <h2 className="assembler-title">Smart Test Auto-Assembler</h2>
              <p className="assembler-subtitle">
                {step === 'configure'
                  ? 'Assemble a balanced exam from your uploaded past papers with custom topic weights & difficulty presets.'
                  : 'Review assembled exam paper balance, topic coverage, and question layout.'}
              </p>
            </div>
          </div>

          <button
            type="button"
            className="assembler-close-btn"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {/* ─── Body ────────────────────────────────────────────────────────── */}
        <div className="assembler-body">
          {errorMessage && (
            <div className="assembler-alert assembler-alert--error animate-fade-in">
              <span>⚠️</span> {errorMessage}
            </div>
          )}

          {step === 'configure' ? (
            /* ──────────────── STEP 1: CONFIGURE CRITERIA ──────────────── */
            <div className="assembler-config-grid">
              {/* Left Column: Marks, Difficulty & Format */}
              <div className="assembler-config-col">
                {/* Target Marks */}
                <div className="assembler-section">
                  <label className="assembler-label">
                    <span>🎯</span> Target Total Marks:
                  </label>
                  <div className="assembler-marks-row">
                    {MARK_PRESETS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`assembler-pill-btn ${targetMarks === m && !customMarksInput ? 'assembler-pill-btn--active' : ''}`}
                        onClick={() => {
                          setTargetMarks(m);
                          setCustomMarksInput('');
                        }}
                      >
                        {m} marks
                      </button>
                    ))}
                    <div className="assembler-custom-marks-wrap">
                      <input
                        type="number"
                        min="5"
                        max="200"
                        placeholder="Custom"
                        className={`assembler-custom-marks-input ${customMarksInput ? 'assembler-custom-marks-input--active' : ''}`}
                        value={customMarksInput}
                        onChange={(e) => {
                          setCustomMarksInput(e.target.value);
                        }}
                      />
                    </div>
                  </div>
                  <span className="assembler-help-text">
                    Estimated Duration: ~{Math.round(effectiveMarks * 1.25)} minutes
                  </span>
                </div>

                {/* Difficulty Balance Presets */}
                <div className="assembler-section">
                  <label className="assembler-label">
                    <span>⚖️</span> Difficulty Balance:
                  </label>
                  <div className="assembler-diff-presets">
                    {DIFFICULTY_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className={`assembler-diff-card ${activeDifficultyPresetId === preset.id ? 'assembler-diff-card--active' : ''}`}
                        onClick={() => setActiveDifficultyPresetId(preset.id)}
                      >
                        <div className="assembler-diff-card-title">{preset.name}</div>
                        <div className="assembler-diff-card-desc">{preset.desc}</div>
                        <div className="assembler-diff-bars">
                          <span className="diff-bar diff-bar--easy" style={{ width: `${preset.balance.easy}%` }} title={`Easy: ${preset.balance.easy}%`} />
                          <span className="diff-bar diff-bar--med" style={{ width: `${preset.balance.medium}%` }} title={`Medium: ${preset.balance.medium}%`} />
                          <span className="diff-bar diff-bar--hard" style={{ width: `${preset.balance.hard}%` }} title={`Hard: ${preset.balance.hard}%`} />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Format & Style Filter */}
                <div className="assembler-section">
                  <label className="assembler-label">
                    <span>📝</span> Question Format & Style:
                  </label>
                  <div className="assembler-format-row">
                    <button
                      type="button"
                      className={`assembler-pill-btn ${questionStyle === 'all' ? 'assembler-pill-btn--active' : ''}`}
                      onClick={() => setQuestionStyle('all')}
                    >
                      Balanced Mixed
                    </button>
                    <button
                      type="button"
                      className={`assembler-pill-btn ${questionStyle === 'structured' ? 'assembler-pill-btn--active' : ''}`}
                      onClick={() => setQuestionStyle('structured')}
                    >
                      Theory & Structured
                    </button>
                    <button
                      type="button"
                      className={`assembler-pill-btn ${questionStyle === 'mcq' ? 'assembler-pill-btn--active' : ''}`}
                      onClick={() => setQuestionStyle('mcq')}
                    >
                      Pure MCQ (Paper 1/2)
                    </button>
                  </div>
                </div>

                {/* Diagram Preference & Sort Order */}
                <div className="assembler-section assembler-section--split">
                  <div>
                    <label className="assembler-label">
                      <span>🖼️</span> Diagrams:
                    </label>
                    <select
                      className="assembler-select"
                      value={diagramPreference}
                      onChange={(e) => setDiagramPreference(e.target.value as DiagramPreference)}
                    >
                      <option value="any">Any (Mix diagrams & text)</option>
                      <option value="require_diagram">Only Diagram Questions</option>
                      <option value="no_diagram">No Diagrams (Text only)</option>
                    </select>
                  </div>

                  <div>
                    <label className="assembler-label">
                      <span>🗂️</span> Question Ordering:
                    </label>
                    <select
                      className="assembler-select"
                      value={sortOrder}
                      onChange={(e) => setSortOrder(e.target.value as AssemblySortOrder)}
                    >
                      <option value="progressive">Progressive (Easy → Hard)</option>
                      <option value="topic">Grouped by Syllabus Topic</option>
                      <option value="natural">Exam Order (MCQ First)</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Right Column: Uploaded Subject -> Uploaded Topics + Proportions Slider */}
              <div className="assembler-config-col">
                <div className="assembler-section assembler-section--full-height">
                  {/* Stage 1: Uploaded Subject Selector */}
                  <div className="assembler-subject-picker">
                    <label className="assembler-label">
                      <span>📂</span> 1. Select Subject / Past Paper Pool:
                    </label>

                    {isLoadingMetadata ? (
                      <div className="assembler-loading-meta">
                        <span className="assembler-topics-spinner" /> Loading subjects from question bank…
                      </div>
                    ) : (
                      <div className="assembler-subject-chips">
                        {subjectSummaries.map((s, idx) => (
                          <button
                            key={idx}
                            type="button"
                            className={`assembler-subject-chip ${selectedSubjectIdx === String(idx) ? 'assembler-subject-chip--active' : ''}`}
                            onClick={() => {
                              setSelectedSubjectIdx(String(idx));
                              setSelectedTopics([]);
                              setTopicWeights({});
                            }}
                          >
                            <span>📚</span>
                            <span>
                              {s.subjectName}
                              {s.subjectCode ? ` (${s.subjectCode})` : ''}
                            </span>
                            <span className="assembler-subject-badge">
                              {s.topics.reduce((sum, t) => sum + t.questionCount, 0)}Q
                            </span>
                          </button>
                        ))}

                        <button
                          type="button"
                          className={`assembler-subject-chip ${selectedSubjectIdx === 'all' ? 'assembler-subject-chip--active' : ''}`}
                          onClick={() => {
                            setSelectedSubjectIdx('all');
                            setSelectedTopics([]);
                            setTopicWeights({});
                          }}
                        >
                          <span>🌐</span>
                          <span>All Uploaded Papers</span>
                        </button>
                      </div>
                    )}
                  </div>

                  <hr className="assembler-divider" />

                  {/* Stage 2: Uploaded Topics List + Proportions Toggle */}
                  <div className="assembler-topics-header">
                    <label className="assembler-label">
                      <span>🏷️</span> 2. Syllabus Topics ({currentTopicItems.length}):
                    </label>
                    <div className="assembler-topics-actions">
                      <button
                        type="button"
                        className="assembler-text-btn"
                        onClick={handleSelectAllTopics}
                      >
                        Select All
                      </button>
                      <span>•</span>
                      <button
                        type="button"
                        className="assembler-text-btn"
                        onClick={handleClearTopics}
                      >
                        Clear
                      </button>
                    </div>
                  </div>

                  {/* Add New Custom Topic Input */}
                  <form className="assembler-add-topic-form" onSubmit={handleAddCustomTopic}>
                    <input
                      type="text"
                      className="assembler-add-topic-input"
                      placeholder="+ Add custom topic (e.g. Social Stratification, Coastal Processes)..."
                      value={newTopicInput}
                      onChange={(e) => setNewTopicInput(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="assembler-add-topic-btn"
                      disabled={!newTopicInput.trim()}
                    >
                      + Add
                    </button>
                  </form>

                  {/* Topic Proportion Mode Switcher */}
                  {selectedTopics.length > 0 && (
                    <div className="assembler-proportion-toolbar">
                      <div className="assembler-proportion-toggle">
                        <button
                          type="button"
                          className={`assembler-prop-mode-btn ${topicProportionMode === 'equal' ? 'assembler-prop-mode-btn--active' : ''}`}
                          onClick={() => handleToggleProportionMode('equal')}
                        >
                          ⚖️ Equal Split
                        </button>
                        <button
                          type="button"
                          className={`assembler-prop-mode-btn ${topicProportionMode === 'custom' ? 'assembler-prop-mode-btn--active' : ''}`}
                          onClick={() => handleToggleProportionMode('custom')}
                        >
                          📊 Custom Proportions (%)
                        </button>
                      </div>

                      {topicProportionMode === 'custom' && (
                        <div className="assembler-prop-status-row">
                          <span
                            className={`assembler-prop-total-badge ${
                              totalCustomWeight === 100
                                ? 'assembler-prop-total-badge--ok'
                                : 'assembler-prop-total-badge--warn'
                            }`}
                          >
                            Total: {totalCustomWeight}% {totalCustomWeight === 100 ? '✓' : `(${100 - totalCustomWeight > 0 ? `-${100 - totalCustomWeight}%` : `+${totalCustomWeight - 100}%`})`}
                          </span>

                          {totalCustomWeight !== 100 && (
                            <button
                              type="button"
                              className="assembler-normalize-btn"
                              onClick={handleNormalizeWeights}
                              title="Auto-balance proportions to exactly 100%"
                            >
                              ⚡ Auto-Balance to 100%
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  <p className="assembler-help-text" style={{ marginBottom: '8px' }}>
                    {selectedTopics.length === 0
                      ? 'All available topics in this subject pool will be evenly distributed.'
                      : topicProportionMode === 'custom'
                      ? 'Adjust the percentage sliders below to allocate custom mark weightings to each topic.'
                      : `${selectedTopics.length} of ${currentTopicItems.length} topics selected with equal weighting.`}
                  </p>

                  <div className="assembler-topics-list">
                    {currentTopicItems.length === 0 ? (
                      <div className="assembler-topics-empty">
                        <span>💡</span> No uploaded topics found for this subject yet. Type above to add custom topics!
                      </div>
                    ) : (
                      currentTopicItems.map((topicItem) => {
                        const isSelected = selectedTopics.includes(topicItem.name);
                        const weight = topicWeights[topicItem.name] ?? Math.round(100 / (selectedTopics.length || 1));
                        const approxMarks = Math.round((effectiveMarks * weight) / 100);

                        return (
                          <div
                            key={topicItem.name}
                            className={`assembler-topic-card ${isSelected ? 'assembler-topic-card--selected' : ''}`}
                          >
                            <div
                              className="assembler-topic-card-header"
                              onClick={() => handleToggleTopic(topicItem.name)}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {}} // handled by parent onClick
                                className="assembler-topic-checkbox"
                              />
                              <span className="assembler-topic-name">{topicItem.name}</span>
                              {topicItem.questionCount > 0 && (
                                <span className="assembler-topic-count-pill">
                                  {topicItem.questionCount} {topicItem.questionCount === 1 ? 'Q' : 'Qs'}
                                </span>
                              )}
                            </div>

                            {/* Custom Weight Slider */}
                            {isSelected && topicProportionMode === 'custom' && (
                              <div className="assembler-topic-slider-row animate-fade-in">
                                <input
                                  type="range"
                                  min="0"
                                  max="100"
                                  step="5"
                                  value={weight}
                                  onChange={(e) =>
                                    handleUpdateTopicWeight(topicItem.name, parseInt(e.target.value, 10))
                                  }
                                  className="assembler-topic-range"
                                />
                                <div className="assembler-topic-slider-meta">
                                  <span className="assembler-topic-weight-value">
                                    {weight}%
                                  </span>
                                  <span className="assembler-topic-approx-marks">
                                    (~{approxMarks} marks)
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* ──────────────── STEP 2: PREVIEW & ANALYTICS ──────────────── */
            assemblyResult && (
              <div className="assembler-preview-container animate-fade-in">
                {/* Metrics Summary Strip */}
                <div className="assembler-metrics-strip">
                  <div className="assembler-metric-box">
                    <span className="assembler-metric-label">Total Marks</span>
                    <span className="assembler-metric-value">
                      {assemblyResult.totalMarks} / {assemblyResult.targetMarks}
                      {assemblyResult.isExactMatch ? (
                        <span className="assembler-match-tag">✓ Exact</span>
                      ) : (
                        <span className="assembler-diff-tag">
                          {assemblyResult.markDifference > 0 ? `+${assemblyResult.markDifference}` : `${assemblyResult.markDifference}`}
                        </span>
                      )}
                    </span>
                  </div>

                  <div className="assembler-metric-box">
                    <span className="assembler-metric-label">Questions</span>
                    <span className="assembler-metric-value">
                      {assemblyResult.questions.length} questions
                    </span>
                  </div>

                  <div className="assembler-metric-box">
                    <span className="assembler-metric-label">Est. Duration</span>
                    <span className="assembler-metric-value">
                      ~{assemblyResult.estimatedDuration} mins
                    </span>
                  </div>

                  <div className="assembler-metric-box assembler-metric-box--wide">
                    <span className="assembler-metric-label">Difficulty Distribution</span>
                    <div className="assembler-live-diff-bar">
                      <div
                        className="live-diff-fill live-diff-fill--easy"
                        style={{ width: `${assemblyResult.difficultyStats.easyPercent}%` }}
                        title={`Easy: ${assemblyResult.difficultyStats.easyMarks} marks (${assemblyResult.difficultyStats.easyPercent}%)`}
                      >
                        {assemblyResult.difficultyStats.easyPercent > 12 && `${assemblyResult.difficultyStats.easyPercent}%`}
                      </div>
                      <div
                        className="live-diff-fill live-diff-fill--med"
                        style={{ width: `${assemblyResult.difficultyStats.mediumPercent}%` }}
                        title={`Medium: ${assemblyResult.difficultyStats.mediumMarks} marks (${assemblyResult.difficultyStats.mediumPercent}%)`}
                      >
                        {assemblyResult.difficultyStats.mediumPercent > 12 && `${assemblyResult.difficultyStats.mediumPercent}%`}
                      </div>
                      <div
                        className="live-diff-fill live-diff-fill--hard"
                        style={{ width: `${assemblyResult.difficultyStats.hardPercent}%` }}
                        title={`Hard: ${assemblyResult.difficultyStats.hardMarks} marks (${assemblyResult.difficultyStats.hardPercent}%)`}
                      >
                        {assemblyResult.difficultyStats.hardPercent > 12 && `${assemblyResult.difficultyStats.hardPercent}%`}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Topic Distribution Tags */}
                <div className="assembler-topic-tags-strip">
                  <span className="assembler-topic-strip-title">Topic Coverage:</span>
                  <div className="assembler-topic-tags">
                    {assemblyResult.topicStats.map((t) => (
                      <span key={t.topic} className="assembler-topic-stat-tag">
                        <strong>{t.topic}</strong> ({t.marks}m • {t.percent}%)
                      </span>
                    ))}
                  </div>
                </div>

                {/* Assembled Questions List Preview */}
                <div className="assembler-preview-list">
                  {assemblyResult.questions.map((q, idx) => (
                    <div key={q.id || idx} className="assembler-preview-item">
                      <div className="assembler-preview-item-header">
                        <span className="assembler-q-num">Q{idx + 1}</span>
                        <span className="assembler-q-topic">{q.topic}</span>
                        <span
                          className={`assembler-q-diff ${
                            q.difficulty === 'Easy'
                              ? 'diff-easy'
                              : q.difficulty === 'Hard'
                              ? 'diff-hard'
                              : 'diff-med'
                          }`}
                        >
                          {q.difficulty || 'Medium'}
                        </span>
                        <span className="assembler-q-marks">[{q.marks} mark{q.marks !== 1 ? 's' : ''}]</span>
                      </div>
                      <div className="assembler-preview-item-body">
                        <ExamMathText
                          content={
                            q.question_text.length > 220
                              ? `${q.question_text.slice(0, 220)}…`
                              : q.question_text
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          )}
        </div>

        {/* ─── Footer ──────────────────────────────────────────────────────── */}
        <div className="assembler-footer">
          <div className="assembler-footer-left">
            {step === 'preview' && (
              <button
                type="button"
                className="assembler-btn-secondary"
                onClick={() => setStep('configure')}
              >
                ← Back to Criteria
              </button>
            )}
          </div>

          <div className="assembler-footer-right">
            <button
              type="button"
              className="assembler-btn-secondary"
              onClick={onClose}
            >
              Cancel
            </button>

            {step === 'configure' ? (
              <button
                type="button"
                className="assembler-btn-primary"
                onClick={handleAssemble}
                disabled={isAssembling}
              >
                {isAssembling ? 'Assembling Paper…' : '⚡ Assemble Exam Paper'}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="assembler-btn-tool"
                  onClick={handleAssemble}
                  title="Generate alternative valid permutation"
                >
                  🎲 Re-shuffle / Re-roll
                </button>

                <button
                  type="button"
                  className="assembler-btn-primary"
                  onClick={handleApplyToBuilder}
                >
                  🚀 Load into Test Builder ({assemblyResult?.totalMarks} marks) →
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
