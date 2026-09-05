import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { ExtractionResult, ExtractedQuestion, SubQuestion, PaperMetadata } from '../types/database';
import { type DiagramCropItem } from '../lib/diagramCropper';
import { ExamMathText } from './ExamMathText';
import { QuestionEditorModal } from './QuestionEditorModal';
import { DiagramCropModal } from './DiagramCropModal';
import { ResourceBookletDrawer } from './ResourceBookletDrawer';
import { supabase } from '../lib/supabase';
import { stripDuplicateOptionsFromStem } from '../lib/gemini';
import './ExtractionReview.css';

interface ExtractionReviewProps {
  result: ExtractionResult;
  diagramUrls: Map<string, string>;
  pdfFile?: File | null;
  insertFile?: File | null;
  onUpdateDiagram?: (qNum: string, item: DiagramCropItem) => void;
  onConfirmSave: (customResult?: ExtractionResult) => void;
  onCancel: () => void;
  isSaving: boolean;
}

interface CropTarget {
  qIdx: number;
  subIdx?: number;
  key: string;
  questionNumber: string;
  initialBox?: [number, number, number, number] | null;
  initialPage?: number;
  initialQpPage?: number;
  initialInsertPage?: number;
  initialSrc?: string | null;
  initialSourceType?: 'qp' | 'insert';
}

/**
 * Enhanced Extraction Review Screen for Teachers:
 * 1. Sub-question diagram cropping & interactive PDF snip tool
 * 2. Fast-Edit Teacher Workspace (inline quick-edit, 1-click split/merge, selective save)
 * 3. Quality Assurance (duplicate detection banner, editable paper details & dynamic mark tally verification)
 */
function cleanExtractedQuestions(qs: ExtractedQuestion[]): ExtractedQuestion[] {
  return (qs || []).map((q) => ({
    ...q,
    question_text: stripDuplicateOptionsFromStem(q.question_text, q.options),
    sub_questions: (q.sub_questions || []).map((sq) => ({
      ...sq,
      question_text: stripDuplicateOptionsFromStem(sq.question_text, sq.options || q.options),
    })),
  }));
}

export function ExtractionReview({
  result,
  diagramUrls,
  pdfFile,
  insertFile,
  onUpdateDiagram,
  onConfirmSave,
  onCancel,
  isSaving,
}: ExtractionReviewProps) {
  const [questions, setQuestions] = useState<ExtractedQuestion[]>(() => cleanExtractedQuestions(result.questions));
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(
    () => new Set(result.questions.map((_, i) => i))
  );
  const [expandedMark, setExpandedMark] = useState<Set<number>>(new Set());
  const [showAllMarkSchemes, setShowAllMarkSchemes] = useState(false);
  const [showAllGuidance, setShowAllGuidance] = useState(true);
  const [isFastEditMode, setIsFastEditMode] = useState(false);

  // Editable Paper Metadata & Custom Target Marks
  const [paperMetadata, setPaperMetadata] = useState<PaperMetadata>(() => ({
    ...result.paper_metadata,
  }));
  const [isEditingMetadata, setIsEditingMetadata] = useState(false);
  const [customTargetMarks, setCustomTargetMarks] = useState<number | null>(null);
  const [metadataDraft, setMetadataDraft] = useState<PaperMetadata>(() => ({
    ...result.paper_metadata,
  }));
  const [targetMarksDraft, setTargetMarksDraft] = useState<string>('');

  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [cropTarget, setCropTarget] = useState<CropTarget | null>(null);
  const [showBookletDrawer, setShowBookletDrawer] = useState<boolean>(false);
  const [removedDiagramKeys, setRemovedDiagramKeys] = useState<Set<string>>(new Set());

  const getDiagramUrl = useCallback(
    (key: string, fallback?: string | null) => {
      if (removedDiagramKeys.has(key)) return null;
      return diagramUrls.get(key) || fallback || null;
    },
    [diagramUrls, removedDiagramKeys]
  );

  // Duplicate paper check states
  const [existingDuplicates, setExistingDuplicates] = useState<Set<string>>(new Set());

  // Sync questions & metadata if external result changes
  useEffect(() => {
    if (result?.questions) {
      setQuestions(cleanExtractedQuestions(result.questions));
      setSelectedIndices(new Set(result.questions.map((_, i) => i)));
    }
    if (result?.paper_metadata) {
      setPaperMetadata(result.paper_metadata);
      setMetadataDraft(result.paper_metadata);
    }
  }, [result]);

  const handleOpenMetadataModal = () => {
    setMetadataDraft({ ...paperMetadata });
    setTargetMarksDraft(customTargetMarks ? String(customTargetMarks) : (expectedMarks ? String(expectedMarks) : ''));
    setIsEditingMetadata(true);
  };

  const handleSaveMetadata = () => {
    setPaperMetadata({ ...metadataDraft });
    const parsedTarget = targetMarksDraft.trim() ? parseInt(targetMarksDraft.trim(), 10) : null;
    setCustomTargetMarks(!isNaN(Number(parsedTarget)) && (parsedTarget || 0) > 0 ? parsedTarget : null);
    setIsEditingMetadata(false);
  };

  // ─── Duplicate Paper & Question Check ──────────────────────────────────────
  useEffect(() => {
    if (!paperMetadata) return;
    const { year, series, paper_number, subject_code, subject } = paperMetadata;

    async function checkDuplicates() {
      try {
        // 1. Resolve matching syllabus for this subject first
        let targetSyllabusId: string | null = null;
        if (subject_code) {
          const { data: syl } = (await supabase
            .from('syllabuses')
            .select('id')
            .eq('subject_code', subject_code)
            .limit(1)
            .maybeSingle()) as { data: { id: string } | null };
          if (syl?.id) targetSyllabusId = syl.id;
        } else if (subject) {
          const { data: syl } = (await supabase
            .from('syllabuses')
            .select('id')
            .ilike('subject_name', `%${subject}%`)
            .limit(1)
            .maybeSingle()) as { data: { id: string } | null };
          if (syl?.id) targetSyllabusId = syl.id;
        }

        // If no syllabus exists yet for this subject in the database, there are NO duplicate questions
        if (!targetSyllabusId && (subject_code || subject)) {
          setExistingDuplicates(new Set());
          return;
        }

        // 2. Query questions matching year, series, paper_number AND syllabus
        let query = supabase
          .from('questions')
          .select('id, question_number, year, series, paper_number, syllabus_id');

        if (targetSyllabusId) query = query.eq('syllabus_id', targetSyllabusId);
        if (year) query = query.eq('year', year);
        if (series) query = query.eq('series', series);
        if (paper_number) query = query.eq('paper_number', paper_number);

        const { data, error } = await query;
        if (!error && data && data.length > 0) {
          const dupSet = new Set<string>();
          data.forEach((row: any) => {
            dupSet.add(String(row.question_number).trim().toLowerCase());
          });
          setExistingDuplicates(dupSet);
        } else {
          setExistingDuplicates(new Set());
        }
      } catch (err) {
        console.warn('Duplicate check failed:', err);
        setExistingDuplicates(new Set());
      }
    }

    checkDuplicates();
  }, [paperMetadata]);

  // ─── Mark Tally Calculations ───────────────────────────────────────────────
  const selectedQuestions = questions.filter((_, i) => selectedIndices.has(i));
  const totalSelectedMarks = selectedQuestions.reduce((sum, q) => sum + (Number(q.total_marks) || 0), 0);
  const totalAllMarks = questions.reduce((sum, q) => sum + (Number(q.total_marks) || 0), 0);

  // Standard Cambridge Paper Total Marks Benchmark
  const standardPaperMarks: Record<number, number> = {
    1: 40, 11: 40, 12: 40, 13: 40,
    2: 40, 21: 40, 22: 40, 23: 40,
    3: 80, 31: 80, 32: 80, 33: 80,
    4: 80, 41: 80, 42: 80, 43: 80,
    5: 40, 51: 40, 52: 40, 53: 40,
    6: 40, 61: 40, 62: 40, 63: 40,
  };

  const paperNum = Number(paperMetadata?.paper_number) || 1;
  const isCambridgeCode = /^\d{4}$/.test((paperMetadata?.subject_code || '').trim());
  const expectedMarks = customTargetMarks ?? (isCambridgeCode ? standardPaperMarks[paperNum] || null : null);
  const isMarkTallyExact = expectedMarks ? totalAllMarks === expectedMarks : true;

  // ─── Keyboard Shortcut (Press 'M' to toggle mark schemes) ──────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        editingIdx !== null ||
        cropTarget !== null
      ) {
        return;
      }
      if (e.key === 'm' || e.key === 'M') {
        setShowAllMarkSchemes((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editingIdx, cropTarget]);

  // ─── Selection Handlers ───────────────────────────────────────────────────
  const toggleSelectQuestion = (idx: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIndices.size === questions.length) {
      setSelectedIndices(new Set());
    } else {
      setSelectedIndices(new Set(questions.map((_, i) => i)));
    }
  };

  const handleDeselectDuplicates = () => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      questions.forEach((q, idx) => {
        const isDup = existingDuplicates.has(String(q.question_number).trim().toLowerCase());
        if (isDup) next.delete(idx);
      });
      return next;
    });
  };

  const toggleMarkScheme = (idx: number) => {
    setExpandedMark((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  // ─── 1-Click Split: Promote Sub-Question to Separate Top-Level Question ─────
  const handleSplitSubQuestion = useCallback((qIdx: number, subIdx: number) => {
    const parentQ = questions[qIdx];
    if (!parentQ || !parentQ.sub_questions || !parentQ.sub_questions[subIdx]) return;

    const sub = parentQ.sub_questions[subIdx];
    const remainingSubs = parentQ.sub_questions.filter((_, i) => i !== subIdx);
    const subMarks = Number(sub.marks) || 1;

    const updatedParent: ExtractedQuestion = {
      ...parentQ,
      sub_questions: remainingSubs,
      total_marks: Math.max(1, (Number(parentQ.total_marks) || subMarks) - subMarks),
    };

    const newQuestion: ExtractedQuestion = {
      question_number: `${parentQ.question_number}${sub.sub_id.replace(/[()]/g, '')}`,
      parent_question_id: `Q${parentQ.question_number}`,
      year: parentQ.year || paperMetadata?.year,
      series: parentQ.series || paperMetadata?.series,
      paper_number: parentQ.paper_number || paperMetadata?.paper_number,
      question_text: sub.question_text,
      question_style: parentQ.question_style,
      total_marks: subMarks,
      estimated_difficulty: parentQ.estimated_difficulty,
      topic: parentQ.topic,
      sub_topic: parentQ.sub_topic,
      has_diagram: !!sub.diagram_url,
      bounding_box: null,
      options: sub.options || null,
      sub_questions: [],
      mark_scheme: sub.mark_scheme
        ? {
            marking_points: [sub.mark_scheme],
            acceptable_answers: [],
            guidance: sub.guidance ? [sub.guidance] : undefined,
            common_misconceptions: sub.common_misconceptions,
          }
        : null,
    };

    const updatedList = [...questions];
    updatedList.splice(qIdx, 1, updatedParent, newQuestion);
    result.questions = updatedList;
    setQuestions(updatedList);
    setSelectedIndices(new Set(updatedList.map((_, i) => i)));
  }, [questions, paperMetadata, result]);

  // ─── 1-Click Merge: Merge Question into Preceding Question ─────────────────
  const handleMergeWithPrevious = useCallback((qIdx: number) => {
    if (qIdx <= 0 || !questions[qIdx] || !questions[qIdx - 1]) return;

    const currentQ = questions[qIdx];
    const prevQ = questions[qIdx - 1];

    const currentSubs: SubQuestion[] =
      currentQ.sub_questions && currentQ.sub_questions.length > 0
        ? currentQ.sub_questions
        : [
            {
              sub_id: `(${String.fromCharCode(97 + (prevQ.sub_questions?.length || 0))})`,
              question_text: currentQ.question_text,
              marks: Number(currentQ.total_marks) || 1,
              diagram_url:
                diagramUrls.get(currentQ.question_number) ||
                diagramUrls.get(`Q${currentQ.question_number}`) ||
                null,
              options: currentQ.options || null,
              mark_scheme: currentQ.mark_scheme?.marking_points?.join('; ') || '',
            },
          ];

    const updatedPrev: ExtractedQuestion = {
      ...prevQ,
      total_marks: (Number(prevQ.total_marks) || 0) + (Number(currentQ.total_marks) || 0),
      sub_questions: [...(prevQ.sub_questions || []), ...currentSubs],
    };

    const updatedList = questions.filter((_, i) => i !== qIdx);
    updatedList[qIdx - 1] = updatedPrev;
    result.questions = updatedList;
    setQuestions(updatedList);
    setSelectedIndices(new Set(updatedList.map((_, i) => i)));
  }, [questions, diagramUrls, result]);

  // ─── Fast-Edit Inline Updates ───────────────────────────────────────────────
  const handleUpdateQuestionField = (qIdx: number, field: keyof ExtractedQuestion, val: any) => {
    setQuestions((prev) => {
      const next = [...prev];
      next[qIdx] = { ...next[qIdx], [field]: val };
      result.questions = next;
      return next;
    });
  };

  const handleUpdateSubQuestion = (qIdx: number, subIdx: number, field: keyof SubQuestion, val: any) => {
    setQuestions((prev) => {
      const next = [...prev];
      const subs = [...(next[qIdx].sub_questions || [])];
      subs[subIdx] = { ...subs[subIdx], [field]: val };
      
      // Auto-recalculate parent total marks if sub marks changed
      if (field === 'marks') {
        const sumMarks = subs.reduce((acc, s) => acc + (Number(s.marks) || 0), 0);
        next[qIdx] = { ...next[qIdx], sub_questions: subs, total_marks: sumMarks };
      } else {
        next[qIdx] = { ...next[qIdx], sub_questions: subs };
      }
      result.questions = next;
      return next;
    });
  };

  const handleAddSubQuestion = (qIdx: number) => {
    setQuestions((prev) => {
      const next = [...prev];
      const existingSubs = next[qIdx].sub_questions || [];
      const nextLetter = String.fromCharCode(97 + existingSubs.length);
      const newSub: SubQuestion = {
        sub_id: `(${nextLetter})`,
        question_text: 'New sub-question text...',
        marks: 1,
        mark_scheme: '',
      };
      const updatedSubs = [...existingSubs, newSub];
      const sumMarks = updatedSubs.reduce((acc, s) => acc + (Number(s.marks) || 0), 0);
      next[qIdx] = { ...next[qIdx], sub_questions: updatedSubs, total_marks: sumMarks };
      result.questions = next;
      return next;
    });
  };

  const handleDeleteSubQuestion = (qIdx: number, subIdx: number) => {
    setQuestions((prev) => {
      const next = [...prev];
      const subs = (next[qIdx].sub_questions || []).filter((_, i) => i !== subIdx);
      const sumMarks = subs.reduce((acc, s) => acc + (Number(s.marks) || 0), 0);
      next[qIdx] = { ...next[qIdx], sub_questions: subs, total_marks: Math.max(1, sumMarks) };
      result.questions = next;
      return next;
    });
  };

  const handleDeleteQuestion = (qIdx: number) => {
    setQuestions((prev) => {
      const next = prev.filter((_, i) => i !== qIdx);
      result.questions = next;
      setSelectedIndices(new Set(next.map((_, i) => i)));
      return next;
    });
  };

  // ─── Save Confirmation (Filters Selected Questions) ────────────────────────
  const handleSaveClick = () => {
    const questionsToSave = cleanExtractedQuestions(questions.filter((_, i) => selectedIndices.has(i)));
    onConfirmSave({
      ...result,
      paper_metadata: paperMetadata,
      questions: questionsToSave.map((q) => ({
        ...q,
        year: paperMetadata.year,
        series: paperMetadata.series,
        paper_number: paperMetadata.paper_number,
      })),
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
      {/* ─── Duplicate Paper Warning Banner ───────────────────────────────── */}
      {existingDuplicates.size > 0 && (
        <div className="review-duplicate-banner animate-fade-in">
          <div className="review-dup-icon">⚠️</div>
          <div className="review-dup-content">
            <strong className="review-dup-title">Existing Paper Questions Detected</strong>
            <p className="review-dup-desc">
              Found {existingDuplicates.size} question{existingDuplicates.size !== 1 ? 's' : ''} in Question Bank already saved for{' '}
              <strong>{paperMetadata?.subject} {paperMetadata?.series} {paperMetadata?.year} Paper {paperMetadata?.paper_number}</strong>.
            </p>
          </div>
          <div className="review-dup-actions">
            <button
              type="button"
              className="review-dup-btn"
              onClick={handleDeselectDuplicates}
              title="Uncheck existing questions so they won't be re-saved as duplicates"
            >
              Deselect Existing ({existingDuplicates.size})
            </button>
          </div>
        </div>
      )}

      {/* ─── Paper Metadata Header ───────────────────────────────────────── */}
      <div className="review-header">
        <div className="review-header-top">
          <div className="review-header-left">
            <h2 className="review-title">Extraction Complete</h2>
            <p className="review-subtitle">
              Review and fast-edit questions before saving to your Question Bank.
            </p>
          </div>

          <div className="review-header-controls">
            {/* Edit Paper Details Button */}
            <button
              type="button"
              className="review-toggle-btn"
              style={{
                background: 'rgba(99, 102, 241, 0.12)',
                color: '#4f46e5',
                borderColor: 'rgba(99, 102, 241, 0.3)',
                fontWeight: 600,
              }}
              onClick={handleOpenMetadataModal}
              id="edit-paper-info-btn"
              title="Customize subject name, course code, year, session, or mark target"
            >
              <span>✏️ Edit Paper Info</span>
            </button>

            {/* Fast Edit Mode Toggle */}
            <button
              type="button"
              className={`review-toggle-btn ${isFastEditMode ? 'review-toggle-btn--active' : ''}`}
              onClick={() => setIsFastEditMode(!isFastEditMode)}
              id="toggle-fast-edit-btn"
              title="Toggle inline fast editing on question cards"
            >
              <span>{isFastEditMode ? '✏️ Fast Edit: ON' : '✏️ Fast Edit: OFF'}</span>
            </button>

            {/* Mark Scheme Global Toggle */}
            <button
              type="button"
              className={`review-toggle-btn ${showAllMarkSchemes ? 'review-toggle-btn--active' : ''}`}
              onClick={() => setShowAllMarkSchemes(!showAllMarkSchemes)}
              id="toggle-all-ms-btn"
              title="Press [M] to toggle mark schemes"
            >
              <span>{showAllMarkSchemes ? '👁️ Mark Schemes: Visible' : '🙈 Mark Schemes: Hidden'}</span>
            </button>

            {/* Guidance Global Toggle */}
            <button
              type="button"
              className={`review-toggle-btn ${showAllGuidance ? 'review-toggle-btn--active' : ''}`}
              onClick={() => setShowAllGuidance(!showAllGuidance)}
              id="toggle-all-guidance-btn"
              title="Toggle examiner tips and common traps"
            >
              <span>{showAllGuidance ? '💡 Tips: Visible' : '💡 Tips: Hidden'}</span>
            </button>

            {/* Insert Booklet Preview Button */}
            {(insertFile || (result.insert_resources && result.insert_resources.length > 0) || questions.some(q => q.diagram_source === 'insert' || q.resource_ref)) && (
              <button
                type="button"
                className="review-toggle-btn"
                style={{
                  background: 'rgba(14, 165, 233, 0.15)',
                  color: '#0284c7',
                  border: '1px solid rgba(14, 165, 233, 0.4)',
                  fontWeight: 700,
                }}
                onClick={() => setShowBookletDrawer(true)}
                title="Preview Cambridge Insert / Resource Booklet"
              >
                <span>📖 Insert Booklet ({result.insert_resources?.length || 'Attached'})</span>
              </button>
            )}
          </div>
        </div>

        {/* Metadata & Quality Assurance Badges */}
        <div className="review-meta-grid">
          <MetaBadge
            label="Subject"
            value={`${paperMetadata?.subject || 'Exam'} (${paperMetadata?.subject_code || 'General'})`}
            onClick={handleOpenMetadataModal}
            isClickable
          />
          <MetaBadge
            label="Session"
            value={`${paperMetadata?.series || 'Series'} ${paperMetadata?.year || new Date().getFullYear()}`}
            onClick={handleOpenMetadataModal}
            isClickable
          />
          <MetaBadge
            label="Paper"
            value={`Paper ${paperMetadata?.paper_number || 1}`}
            onClick={handleOpenMetadataModal}
            isClickable
          />
          <MetaBadge label="Extracted" value={`${questions.length} Questions`} />
          
          {/* Dynamic Mark Tally Validator Badge */}
          <div
            className={`meta-badge ${expectedMarks ? (isMarkTallyExact ? 'meta-badge--success' : 'meta-badge--warning') : 'meta-badge--neutral'} meta-badge--clickable`}
            onClick={handleOpenMetadataModal}
            title={expectedMarks ? 'Click to adjust target marks benchmark' : 'Click to set target marks benchmark'}
          >
            <span className="meta-badge-label">Mark Tally {expectedMarks ? '' : '(Custom)'}</span>
            <span className="meta-badge-value">
              {totalAllMarks} {expectedMarks ? `/ ${expectedMarks}` : 'marks'}
              {expectedMarks && (
                <span className="meta-badge-sub">
                  {isMarkTallyExact ? ' ✓ Exact' : ` (${totalAllMarks > expectedMarks ? `+${totalAllMarks - expectedMarks}` : totalAllMarks - expectedMarks})`}
                </span>
              )}
              {!expectedMarks && (
                <span className="meta-badge-sub"> ({questions.length} Qs)</span>
              )}
            </span>
          </div>

          <div className="meta-badge meta-badge--selected">
            <span className="meta-badge-label">Selected to Save</span>
            <span className="meta-badge-value">{selectedIndices.size} of {questions.length} ({totalSelectedMarks} marks)</span>
          </div>
        </div>

        {/* Selection Master Bar */}
        <div className="review-selection-bar">
          <label className="review-select-all-label">
            <input
              type="checkbox"
              checked={selectedIndices.size === questions.length && questions.length > 0}
              onChange={toggleSelectAll}
              className="review-checkbox"
            />
            <span>Select All Questions ({questions.length})</span>
          </label>
          {selectedIndices.size < questions.length && (
            <span className="review-selection-hint">
              ({questions.length - selectedIndices.size} question{questions.length - selectedIndices.size !== 1 ? 's' : ''} will be discarded)
            </span>
          )}
        </div>
      </div>

      {/* ─── Question Cards ──────────────────────────────────────────────── */}
      <div className="review-questions">
        {questions.map((q: ExtractedQuestion, idx: number) => {
          const isSelected = selectedIndices.has(idx);
          const isExistingDup = existingDuplicates.has(String(q.question_number).trim().toLowerCase());

          return (
            <div
              key={idx}
              className={`review-card animate-fade-in ${!isSelected ? 'review-card--unselected' : ''} ${isExistingDup ? 'review-card--duplicate' : ''}`}
              style={{ animationDelay: `${Math.min(idx * 30, 300)}ms` }}
            >
              {/* Card Header */}
              <div className="review-card-header">
                <div className="review-card-left">
                  {/* Selection Checkbox */}
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelectQuestion(idx)}
                    className="review-checkbox"
                    title={isSelected ? 'Deselect question' : 'Select question to save'}
                  />

                  {isFastEditMode ? (
                    <div className="review-inline-qnum-wrap">
                      <span className="review-inline-label">Q#</span>
                      <input
                        type="text"
                        className="review-inline-qnum-input"
                        value={q.question_number}
                        onChange={(e) => handleUpdateQuestionField(idx, 'question_number', e.target.value)}
                      />
                    </div>
                  ) : (
                    <span className="review-q-number">Q{q.question_number}</span>
                  )}

                  {isExistingDup && (
                    <span className="review-badge badge--duplicate" title="Already in Question Bank">
                      ⚠️ Existing in Bank
                    </span>
                  )}

                  <span className="review-badge badge--paper">
                    📄 Paper {q.paper_number || paperMetadata?.paper_number || 1}
                  </span>

                  {/* Insert Resource Badge */}
                  {(q.resource_ref || q.diagram_source === 'insert') && (
                    <button
                      type="button"
                      className="review-badge"
                      style={{
                        background: 'rgba(14, 165, 233, 0.15)',
                        color: '#0284c7',
                        border: '1px solid rgba(14, 165, 233, 0.35)',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        fontWeight: 700,
                      }}
                      onClick={() => setShowBookletDrawer(true)}
                      title="Click to view this figure in the Resource Booklet"
                    >
                      📖 {q.resource_ref || 'Insert Resource'}
                    </button>
                  )}

                  {isFastEditMode ? (
                    <select
                      className="review-inline-select"
                      value={q.estimated_difficulty}
                      onChange={(e) => handleUpdateQuestionField(idx, 'estimated_difficulty', e.target.value)}
                    >
                      <option value="Easy">Easy</option>
                      <option value="Medium">Medium</option>
                      <option value="Hard">Hard</option>
                    </select>
                  ) : (
                    <span className={`review-badge ${difficultyColor(q.estimated_difficulty)}`}>
                      {q.estimated_difficulty}
                    </span>
                  )}

                  {isFastEditMode ? (
                    <select
                      className="review-inline-select"
                      value={q.question_style || 'Structured'}
                      onChange={(e) => handleUpdateQuestionField(idx, 'question_style', e.target.value)}
                    >
                      <option value="Structured">Structured</option>
                      <option value="Multiple Choice">Multiple Choice</option>
                      <option value="Calculation">Calculation</option>
                      <option value="Short Answer">Short Answer</option>
                    </select>
                  ) : (
                    <span className="review-badge badge--style">{q.question_style}</span>
                  )}
                </div>

                <div className="review-card-right">
                  {isFastEditMode ? (
                    <div className="review-inline-topic-wrap">
                      <input
                        type="text"
                        className="review-inline-topic-input"
                        placeholder="Topic..."
                        value={q.topic || ''}
                        onChange={(e) => handleUpdateQuestionField(idx, 'topic', e.target.value)}
                      />
                      <input
                        type="text"
                        className="review-inline-subtopic-input"
                        placeholder="Subtopic..."
                        value={q.sub_topic || ''}
                        onChange={(e) => handleUpdateQuestionField(idx, 'sub_topic', e.target.value)}
                      />
                    </div>
                  ) : (
                    <span className="review-topic" title={q.sub_topic ? `${q.topic} → ${q.sub_topic}` : q.topic}>
                      {q.topic}
                      {q.sub_topic && <span className="review-subtopic"> • {q.sub_topic}</span>}
                    </span>
                  )}

                  <span className="review-marks">[{q.total_marks} mark{q.total_marks !== 1 ? 's' : ''}]</span>

                  {/* 1-Click Merge (available from Q2 onwards) */}
                  {idx > 0 && (
                    <button
                      type="button"
                      className="review-tool-btn review-merge-btn"
                      onClick={() => handleMergeWithPrevious(idx)}
                      title={`Merge Q${q.question_number} into preceding Q${questions[idx - 1]?.question_number}`}
                    >
                      🔗 Merge
                    </button>
                  )}

                  {/* Full Modal Editor */}
                  <button
                    type="button"
                    className="review-edit-btn"
                    onClick={() => setEditingIdx(idx)}
                    title="Open full question editor modal"
                  >
                    ✏️ Edit
                  </button>

                  {/* Delete Question */}
                  {isFastEditMode && (
                    <button
                      type="button"
                      className="review-tool-btn review-delete-btn"
                      onClick={() => handleDeleteQuestion(idx)}
                      title="Delete question from review list"
                    >
                      🗑️
                    </button>
                  )}
                </div>
              </div>

              {/* ─── Question Stem Body ───────────────────────────────────── */}
              <div className="review-card-body">
                {isFastEditMode ? (
                  <div className="review-inline-stem-editor">
                    <textarea
                      className="review-inline-textarea"
                      value={q.question_text || ''}
                      onChange={(e) => handleUpdateQuestionField(idx, 'question_text', e.target.value)}
                      rows={3}
                      placeholder="Enter main question context or setup..."
                    />
                    <div className="review-inline-preview">
                      <span className="review-preview-label">Live Math Preview:</span>
                      <ExamMathText content={q.question_text || ''} />
                    </div>
                  </div>
                ) : (
                  <ExamMathText content={q.question_text} />
                )}
              </div>

              {/* ─── Parent Question Diagram ──────────────────────────────── */}
              {(() => {
                const parentDiagramUrl = getDiagramUrl(q.question_number, (q as any).diagram_url);
                if (!parentDiagramUrl) {
                  return (
                    <div className="review-diagram-bar">
                      <button
                        type="button"
                        className="review-add-diagram-btn"
                        onClick={() => {
                          const isInsert = q.diagram_source === 'insert';
                          const targetPage = isInsert
                            ? (q.insert_page_number && q.insert_page_number > 0 ? q.insert_page_number : 1)
                            : (q.page_number && q.page_number > 0 ? q.page_number : 1);

                          setCropTarget({
                            qIdx: idx,
                            key: q.question_number,
                            questionNumber: `Question ${q.question_number}`,
                            initialBox: q.bounding_box,
                            initialPage: targetPage,
                            initialQpPage: q.page_number || 1,
                            initialInsertPage: q.insert_page_number || 1,
                            initialSourceType: isInsert ? 'insert' : 'qp',
                          });
                        }}
                      >
                        + 📸 Add/Crop Main Diagram
                      </button>
                    </div>
                  );
                }

                return (
                  <div className="review-diagram">
                    <div className="review-diagram-wrap">
                      <img
                        src={parentDiagramUrl}
                        alt={`Diagram for Q${q.question_number}`}
                        className="review-diagram-img"
                      />
                      <div className="review-diagram-overlay-actions">
                        <button
                          type="button"
                          className="review-crop-btn"
                          onClick={() => {
                            const isInsert = q.diagram_source === 'insert';
                            const targetPage = isInsert
                              ? (q.insert_page_number && q.insert_page_number > 0 ? q.insert_page_number : 1)
                              : (q.page_number && q.page_number > 0 ? q.page_number : 1);

                            setCropTarget({
                              qIdx: idx,
                              key: q.question_number,
                              questionNumber: `Question ${q.question_number}`,
                              initialBox: q.bounding_box,
                              initialPage: targetPage,
                              initialQpPage: q.page_number || 1,
                              initialInsertPage: q.insert_page_number || 1,
                              initialSrc: parentDiagramUrl,
                              initialSourceType: isInsert ? 'insert' : 'qp',
                            });
                          }}
                          title="Fine-tune diagram boundaries"
                        >
                          ✂️ Adjust Crop
                        </button>
                        <button
                          type="button"
                          className="review-crop-btn review-crop-btn--remove"
                          onClick={() => {
                            setRemovedDiagramKeys((prev) => new Set(prev).add(q.question_number));
                            handleUpdateQuestionField(idx, 'has_diagram', false);
                            handleUpdateQuestionField(idx, 'diagram_source', null);
                            handleUpdateQuestionField(idx, 'resource_ref', null);
                            handleUpdateQuestionField(idx, 'bounding_box', null);
                          }}
                          title="Remove diagram"
                        >
                          🗑️ Remove
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* ─── Sub-Questions (Structured Multi-Part Questions) ───────── */}
              {q.sub_questions && q.sub_questions.length > 0 && (
                <div className="review-sub-questions">
                  {q.sub_questions.map((sub, si) => {
                    const subDiagramKey = `${q.question_number}_sub_${si}`;
                    const subDiagramUrl = getDiagramUrl(subDiagramKey, sub.diagram_url);

                    return (
                      <div key={si} className="review-sub-question">
                        <div className="review-sub-header">
                          {isFastEditMode ? (
                            <input
                              type="text"
                              className="review-inline-subid-input"
                              value={sub.sub_id}
                              onChange={(e) => handleUpdateSubQuestion(idx, si, 'sub_id', e.target.value)}
                            />
                          ) : (
                            <span className="review-sub-id">{sub.sub_id}</span>
                          )}

                          <div className="review-sub-text">
                            {isFastEditMode ? (
                              <div className="review-inline-subtext-wrap">
                                <textarea
                                  className="review-inline-textarea review-inline-textarea--sub"
                                  value={sub.question_text || ''}
                                  onChange={(e) => handleUpdateSubQuestion(idx, si, 'question_text', e.target.value)}
                                  rows={2}
                                  placeholder="Sub-question text or Markdown table..."
                                />
                                <div className="review-inline-preview">
                                  <ExamMathText content={sub.question_text || ''} />
                                </div>
                              </div>
                            ) : (
                              <ExamMathText content={sub.question_text} />
                            )}
                          </div>

                          {isFastEditMode ? (
                            <div className="review-inline-marks-wrap">
                              <span className="review-inline-label">Marks</span>
                              <input
                                type="number"
                                min={0}
                                max={20}
                                className="review-inline-marks-input"
                                value={sub.marks}
                                onChange={(e) => handleUpdateSubQuestion(idx, si, 'marks', Number(e.target.value) || 0)}
                              />
                            </div>
                          ) : (
                            <span className="review-sub-marks">[{sub.marks}]</span>
                          )}

                          {/* 1-Click Split Sub-Question */}
                          <button
                            type="button"
                            className="review-tool-btn review-split-btn"
                            onClick={() => handleSplitSubQuestion(idx, si)}
                            title={`Split ${sub.sub_id} into an independent top-level question`}
                          >
                            ⚡ Split
                          </button>

                          {/* Delete Sub-Question (in Fast Edit Mode) */}
                          {isFastEditMode && (
                            <button
                              type="button"
                              className="review-tool-btn review-delete-btn"
                              onClick={() => handleDeleteSubQuestion(idx, si)}
                              title={`Delete sub-question ${sub.sub_id}`}
                            >
                              ✕
                            </button>
                          )}
                        </div>

                        {/* Sub-Question Diagram Preview & Snip Controls */}
                        {subDiagramUrl ? (
                          <div className="review-sub-diagram-container">
                            <img
                              src={subDiagramUrl}
                              alt={`Diagram for ${sub.sub_id}`}
                              className="review-sub-diagram-img"
                            />
                            <div className="review-sub-diagram-actions">
                              <button
                                type="button"
                                className="review-sub-crop-btn"
                                onClick={() => {
                                  const isSubInsert = sub.diagram_source === 'insert' || (!sub.diagram_source && q.diagram_source === 'insert' && !sub.page_number);
                                  const subTargetPage = isSubInsert
                                    ? (sub.insert_page_number && sub.insert_page_number > 0 ? sub.insert_page_number : (q.insert_page_number || 1))
                                    : (sub.page_number && sub.page_number > 0 ? sub.page_number : (q.page_number || 1));

                                  setCropTarget({
                                    qIdx: idx,
                                    subIdx: si,
                                    key: subDiagramKey,
                                    questionNumber: `Question ${q.question_number} ${sub.sub_id}`,
                                    initialBox: sub.bounding_box || q.bounding_box,
                                    initialPage: subTargetPage,
                                    initialQpPage: sub.page_number || q.page_number || 1,
                                    initialInsertPage: sub.insert_page_number || q.insert_page_number || 1,
                                    initialSrc: subDiagramUrl,
                                    initialSourceType: isSubInsert ? 'insert' : 'qp',
                                  });
                                }}
                              >
                                ✂️ Re-crop
                              </button>
                              <button
                                type="button"
                                className="review-sub-crop-btn review-sub-crop-btn--remove"
                                onClick={() => {
                                  setRemovedDiagramKeys((prev) => new Set(prev).add(subDiagramKey));
                                  handleUpdateSubQuestion(idx, si, 'diagram_url', null);
                                  handleUpdateSubQuestion(idx, si, 'has_diagram', false);
                                  handleUpdateSubQuestion(idx, si, 'diagram_source', null);
                                  handleUpdateSubQuestion(idx, si, 'resource_ref', null);
                                  handleUpdateSubQuestion(idx, si, 'bounding_box', null);
                                }}
                              >
                                🗑️ Remove
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="review-sub-diagram-trigger-bar">
                            <button
                              type="button"
                              className="review-sub-add-diagram-btn"
                              onClick={() => {
                                const isSubInsert = sub.diagram_source === 'insert' || (!sub.diagram_source && q.diagram_source === 'insert' && !sub.page_number);
                                const subTargetPage = isSubInsert
                                  ? (sub.insert_page_number && sub.insert_page_number > 0 ? sub.insert_page_number : (q.insert_page_number || 1))
                                  : (sub.page_number && sub.page_number > 0 ? sub.page_number : (q.page_number || 1));

                                setCropTarget({
                                  qIdx: idx,
                                  subIdx: si,
                                  key: subDiagramKey,
                                  questionNumber: `Question ${q.question_number} ${sub.sub_id}`,
                                  initialBox: sub.bounding_box || q.bounding_box,
                                  initialPage: subTargetPage,
                                  initialQpPage: sub.page_number || q.page_number || 1,
                                  initialInsertPage: sub.insert_page_number || q.insert_page_number || 1,
                                  initialSourceType: isSubInsert ? 'insert' : 'qp',
                                });
                              }}
                            >
                              + 📸 Add Diagram to {sub.sub_id}
                            </button>
                          </div>
                        )}

                        {/* Sub-Question Mark Scheme */}
                        {sub.mark_scheme && (showAllMarkSchemes || expandedMark.has(idx)) && (
                          <div className="review-sub-markscheme animate-fade-in">
                            <span className="review-sub-ms-label">Mark Scheme:</span>
                            <div className="review-sub-ms-content">
                              {isFastEditMode ? (
                                <textarea
                                  className="review-inline-textarea review-inline-textarea--ms"
                                  value={typeof sub.mark_scheme === 'string' ? sub.mark_scheme : JSON.stringify(sub.mark_scheme)}
                                  onChange={(e) => handleUpdateSubQuestion(idx, si, 'mark_scheme', e.target.value)}
                                  rows={1}
                                />
                              ) : (
                                <ExamMathText content={typeof sub.mark_scheme === 'string' ? sub.mark_scheme : JSON.stringify(sub.mark_scheme)} />
                              )}
                            </div>
                          </div>
                        )}

                        {/* Sub-Question Teacher Guidance */}
                        {sub.guidance && showAllGuidance && (showAllMarkSchemes || expandedMark.has(idx)) && (
                          <div className="review-sub-guidance animate-fade-in">
                            <span className="review-guidance-badge">💡 Examiner Tip</span>
                            <span className="review-sub-guidance-text"><ExamMathText content={sub.guidance} /></span>
                          </div>
                        )}

                        {/* Sub-Question Student Misconceptions */}
                        {sub.common_misconceptions && sub.common_misconceptions.length > 0 && showAllGuidance && (showAllMarkSchemes || expandedMark.has(idx)) && (
                          <div className="review-sub-misconception animate-fade-in">
                            <span className="review-misconception-badge">⚠️ Common Trap</span>
                            <span className="review-sub-guidance-text">
                              <ExamMathText content={sub.common_misconceptions.join('; ')} />
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Add Sub-Question Button (in Fast Edit Mode) */}
                  {isFastEditMode && (
                    <button
                      type="button"
                      className="review-add-subq-btn"
                      onClick={() => handleAddSubQuestion(idx)}
                    >
                      + Add Sub-Question Part
                    </button>
                  )}
                </div>
              )}

              {/* ─── MCQ Options ──────────────────────────────────────────── */}
              {q.options && q.options.length > 0 && (
                <div className="review-options">
                  {q.options.map((opt, oi) => (
                    <div key={oi} className="review-option">
                      <ExamMathText content={opt} />
                    </div>
                  ))}
                </div>
              )}

              {/* ─── Mark Scheme (Collapsible) ────────────────────────────── */}
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
                      {showAllGuidance && Array.isArray(q.mark_scheme.guidance) && q.mark_scheme.guidance.length > 0 && (
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
                      {showAllGuidance && Array.isArray(q.mark_scheme.common_misconceptions) && q.mark_scheme.common_misconceptions.length > 0 && (
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
          );
        })}
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
          onClick={handleSaveClick}
          disabled={isSaving || selectedIndices.size === 0}
          id="save-questions-btn"
        >
          {isSaving ? (
            <>
              <span className="extract-btn-spinner" />
              Saving…
            </>
          ) : (
            <>Save {selectedIndices.size} of {questions.length} Selected Questions to Database</>
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
              year: curQ.year || paperMetadata?.year || new Date().getFullYear(),
              series: curQ.series || paperMetadata?.series || 'Exam',
              paper_number: curQ.paper_number || paperMetadata?.paper_number || 1,
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

      {/* ─── Diagram Fine-Tuner & Sub-Question Snip Modal ──────────────────── */}
      {cropTarget !== null && (
        <DiagramCropModal
          isOpen={true}
          pdfFile={pdfFile}
          insertFile={insertFile}
          initialSourceType={cropTarget.initialSourceType || 'qp'}
          imageSrc={cropTarget.initialSrc || null}
          initialBoundingBox={cropTarget.initialBox}
          initialPageNumber={cropTarget.initialPage || 1}
          initialQpPageNumber={cropTarget.initialQpPage || 1}
          initialInsertPageNumber={cropTarget.initialInsertPage || 1}
          questionNumber={cropTarget.questionNumber}
          onClose={() => setCropTarget(null)}
          onSaveCrop={({ blob, localUrl, boundingBox, pageNumber, sourceDoc }) => {
            const { qIdx, subIdx, key } = cropTarget;
            const chosenDoc = sourceDoc || cropTarget.initialSourceType || 'qp';
            setRemovedDiagramKeys((prev) => {
              const next = new Set(prev);
              next.delete(key);
              return next;
            });
            onUpdateDiagram?.(key, { blob, localUrl, sourceDoc: chosenDoc, pageNumber });

            const updatedList = [...questions];
            if (subIdx !== undefined && updatedList[qIdx]?.sub_questions?.[subIdx]) {
              // Sub-question crop
              const subs = [...(updatedList[qIdx].sub_questions || [])];
              const isInsert = chosenDoc === 'insert';
              subs[subIdx] = {
                ...subs[subIdx],
                has_diagram: true,
                diagram_url: localUrl,
                diagram_source: chosenDoc,
                bounding_box: boundingBox,
                page_number: isInsert ? (subs[subIdx].page_number || updatedList[qIdx].page_number || 1) : pageNumber,
                insert_page_number: isInsert ? pageNumber : null,
              };
              updatedList[qIdx] = {
                ...updatedList[qIdx],
                sub_questions: subs,
              };
            } else if (updatedList[qIdx]) {
              // Parent question crop
              const isInsert = chosenDoc === 'insert';
              updatedList[qIdx] = {
                ...updatedList[qIdx],
                has_diagram: true,
                diagram_source: chosenDoc,
                bounding_box: boundingBox,
                page_number: isInsert ? (updatedList[qIdx].page_number || 1) : pageNumber,
                insert_page_number: isInsert ? pageNumber : null,
              };
            }

            result.questions = updatedList;
            setQuestions(updatedList);
            setCropTarget(null);
          }}
        />
      )}

      {/* ─── Cambridge Insert / Resource Booklet Drawer Modal ──────────────── */}
      <ResourceBookletDrawer
        isOpen={showBookletDrawer}
        onClose={() => setShowBookletDrawer(false)}
        questions={questions as any}
        resources={result.insert_resources}
        title={`${paperMetadata?.subject || 'Assessment'} — Insert / Resource Booklet`}
        subject={paperMetadata?.subject || 'Humanities'}
      />

      {/* ─── Edit Paper Metadata Modal ────────────────────────────────────── */}
      {isEditingMetadata &&
        createPortal(
          <div className="review-metadata-modal-overlay animate-fade-in" onClick={() => setIsEditingMetadata(false)}>
            <div className="review-metadata-modal" onClick={(e) => e.stopPropagation()}>
              <div className="review-metadata-modal-header">
                <div className="review-metadata-modal-title-group">
                  <span className="review-metadata-modal-icon">✏️</span>
                  <div>
                    <h3 className="review-metadata-modal-title">Edit Paper Details</h3>
                    <p className="review-metadata-modal-desc">
                      Customize subject, course code, and exam term before saving to Question Bank.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="review-metadata-modal-close"
                  onClick={() => setIsEditingMetadata(false)}
                >
                  ✕
                </button>
              </div>

              <div className="review-metadata-modal-body">
                <div className="review-metadata-grid">
                  <div className="review-meta-field">
                    <label>Subject Name</label>
                    <input
                      type="text"
                      value={metadataDraft.subject}
                      onChange={(e) => setMetadataDraft({ ...metadataDraft, subject: e.target.value })}
                      placeholder="e.g. English Literature, Chemistry, History"
                    />
                  </div>

                  <div className="review-meta-field">
                    <label>Subject / Exam Code</label>
                    <input
                      type="text"
                      value={metadataDraft.subject_code}
                      onChange={(e) => setMetadataDraft({ ...metadataDraft, subject_code: e.target.value })}
                      placeholder="e.g. 0500, ENG-10, AP-CHEM, General"
                    />
                  </div>

                  <div className="review-meta-field">
                    <label>Session / Term</label>
                    <input
                      type="text"
                      value={metadataDraft.series}
                      onChange={(e) => setMetadataDraft({ ...metadataDraft, series: e.target.value })}
                      placeholder="e.g. Midterm, Semester 1, May/June, Final"
                    />
                  </div>

                  <div className="review-meta-field">
                    <label>Year</label>
                    <input
                      type="number"
                      value={metadataDraft.year}
                      onChange={(e) => setMetadataDraft({ ...metadataDraft, year: parseInt(e.target.value) || ('' as any) })}
                    />
                  </div>

                  <div className="review-meta-field">
                    <label>Paper / Section Number</label>
                    <input
                      type="number"
                      value={metadataDraft.paper_number}
                      onChange={(e) => setMetadataDraft({ ...metadataDraft, paper_number: parseInt(e.target.value) || ('' as any) })}
                    />
                  </div>

                  <div className="review-meta-field">
                    <label>Target Total Marks (Optional)</label>
                    <input
                      type="number"
                      value={targetMarksDraft}
                      onChange={(e) => setTargetMarksDraft(e.target.value)}
                      placeholder="e.g. 25, 50, 100 (auto if empty)"
                    />
                  </div>
                </div>
              </div>

              <div className="review-metadata-modal-footer">
                <button
                  type="button"
                  className="review-meta-cancel-btn"
                  onClick={() => setIsEditingMetadata(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="review-meta-save-btn"
                  onClick={handleSaveMetadata}
                >
                  Apply Changes
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

// ─── Helper: Metadata Badge ────────────────────────────────────────────────────

function MetaBadge({
  label,
  value,
  onClick,
  isClickable,
}: {
  label: string;
  value: string;
  onClick?: () => void;
  isClickable?: boolean;
}) {
  return (
    <div
      className={`meta-badge ${isClickable ? 'meta-badge--clickable' : ''}`}
      onClick={onClick}
      title={isClickable ? 'Click to edit' : undefined}
    >
      <span className="meta-badge-label">{label}</span>
      <span className="meta-badge-value">{value}</span>
    </div>
  );
}
