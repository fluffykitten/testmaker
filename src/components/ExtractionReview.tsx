import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { normalizeQuestionStyle, type ExtractionResult, type ExtractedQuestion, type SubQuestion, type PaperMetadata, type ExtractedPassage } from '../types/database';
import { type DiagramCropItem } from '../lib/diagramCropper';
import { ExamMathText } from './ExamMathText';
import { QuestionEditorModal } from './QuestionEditorModal';
import { DiagramCropModal } from './DiagramCropModal';
import { ResourceBookletDrawer } from './ResourceBookletDrawer';
import { supabase } from '../lib/supabase';
import {
  generateQuestionMarkScheme,
  stripDuplicateOptionsFromStem,
  stripDuplicateSubIdPrefix,
} from '../lib/gemini';
import { auditExtractionMarkSchemes } from '../lib/markSchemeAudit';
import { propagateReadingPassages, stitchPassagesToQuestions } from '../lib/pdfProcessor';
import {
  NO_PASSAGE_TAG,
  hasExplicitPassageMarkers,
  hasNoPassageDirective,
} from '../lib/readingPassageUtils';
import { formatPaperLabel } from '../utils/paperUtils';
import { validateCambridgeHubUrl } from '../services/questionBankService';
import {
  normalizeDiagramUrlList,
  normalizeOptionDiagramList,
  resolveOptionDiagramUrls,
  resolveQuestionImageUrlsExcludingStandaloneSvg,
} from '../utils/questionDiagramUtils';
import './ExtractionReview.css';

interface ExtractionReviewProps {
  result: ExtractionResult;
  diagramUrls: Map<string, string>;
  pdfFile?: File | null;
  insertFile?: File | null;
  markSchemeBase64?: string | null;
  hasOfficialMarkScheme?: boolean;
  onUpdateDiagram?: (qNum: string, item: DiagramCropItem) => void;
  onRemoveDiagram?: (key: string) => void;
  onRenameDiagramKey?: (oldKey: string, newKey: string) => void;
  onUpdateQuestions?: (questions: ExtractedQuestion[]) => void;
  onConfirmSave: (customResult?: ExtractionResult, tags?: string) => void;
  onCancel: () => void;
  isSaving: boolean;
  initialTags?: string;
  onUpdateTags?: (tags: string) => void;
  onUpdateMetadata?: (metadata: PaperMetadata) => void;
}

interface CropTarget {
  qIdx: number;
  subIdx?: number;
  imageIndex?: number;
  optionIndex?: number;
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
function cleanExtractedQuestions(qs: ExtractedQuestion[], passages?: ExtractedPassage[]): ExtractedQuestion[] {
  const stitched = stitchPassagesToQuestions(qs || [], passages);
  const propagated = propagateReadingPassages(stitched);
  return propagated.map((q) => {
    const normStyle = normalizeQuestionStyle(q.question_style, q.options);
    return {
      ...q,
      question_style: normStyle,
      question_text: stripDuplicateOptionsFromStem(q.question_text, q.options),
      sub_questions: (q.sub_questions || []).map((sq) => ({
        ...sq,
        question_text: stripDuplicateSubIdPrefix(
          sq.sub_id,
          stripDuplicateOptionsFromStem(sq.question_text, sq.options || q.options)
        ),
      })),
    };
  });
}

export function ExtractionReview({
  result,
  diagramUrls,
  pdfFile,
  insertFile,
  markSchemeBase64 = null,
  hasOfficialMarkScheme = false,
  onUpdateDiagram,
  onRemoveDiagram,
  onRenameDiagramKey,
  onUpdateQuestions,
  onConfirmSave,
  onCancel,
  isSaving,
  initialTags = '',
  onUpdateTags,
  onUpdateMetadata,
}: ExtractionReviewProps) {
  const [questions, setQuestions] = useState<ExtractedQuestion[]>(() => cleanExtractedQuestions(result.questions, result.passages));
  const [tags, setTags] = useState<string>(initialTags);
  const [tagsDraft, setTagsDraft] = useState<string>(initialTags);
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
  const [msActionLoadingIdx, setMsActionLoadingIdx] = useState<number | null>(null);
  const [msActionError, setMsActionError] = useState<{ idx: number; message: string } | null>(null);

  const hasAttachedOfficialMs = Boolean(hasOfficialMarkScheme || markSchemeBase64);
  const msAudit = useMemo(
    () =>
      auditExtractionMarkSchemes(questions, {
        hasOfficialMarkScheme: hasAttachedOfficialMs,
      }),
    [questions, hasAttachedOfficialMs]
  );

  const getDiagramUrl = useCallback(
    (key: string, fallback?: string | null) => {
      if (removedDiagramKeys.has(key)) return null;
      return diagramUrls.get(key) || fallback || null;
    },
    [diagramUrls, removedDiagramKeys]
  );

  const getStemDiagramEntries = useCallback(
    (q: ExtractedQuestion): Array<{ key: string; url: string; index: number }> => {
      const seenUrls = new Set<string>();
      const entries: Array<{ key: string; url: string; index: number }> = [];

      const primaryUrl = getDiagramUrl(q.question_number, (q as any).diagram_url);
      if (primaryUrl && !seenUrls.has(primaryUrl)) {
        seenUrls.add(primaryUrl);
        entries.push({ key: q.question_number, url: primaryUrl, index: 0 });
      }

      const extraUrls = Array.isArray(q.diagram_urls) ? q.diagram_urls : [];
      extraUrls.forEach((rawUrl, i) => {
        const key = i === 0 ? q.question_number : `${q.question_number}__img_${i}`;
        const url = getDiagramUrl(key, rawUrl);
        if (url && !seenUrls.has(url)) {
          seenUrls.add(url);
          entries.push({ key, url, index: i });
        }
      });

      // Also include any diagramUrls map entries keyed as `${q.question_number}__img_*`
      for (const [k, url] of diagramUrls.entries()) {
        if (k.startsWith(`${q.question_number}__img_`) && !removedDiagramKeys.has(k) && !seenUrls.has(url)) {
          const suffixIdx = Number(k.slice(`${q.question_number}__img_`.length));
          seenUrls.add(url);
          entries.push({ key: k, url, index: isNaN(suffixIdx) ? entries.length : suffixIdx });
        }
      }

      return entries;
    },
    [diagramUrls, removedDiagramKeys, getDiagramUrl]
  );

  const getSubDiagramEntries = useCallback(
    (q: ExtractedQuestion, sub: SubQuestion, si: number): Array<{ key: string; url: string; index: number }> => {
      const subBaseKey = `${q.question_number}_sub_${si}`;
      const seenUrls = new Set<string>();
      const entries: Array<{ key: string; url: string; index: number }> = [];

      const primaryUrl = getDiagramUrl(subBaseKey, sub.diagram_url);
      if (primaryUrl && !seenUrls.has(primaryUrl)) {
        seenUrls.add(primaryUrl);
        entries.push({ key: subBaseKey, url: primaryUrl, index: 0 });
      }

      const extraUrls = Array.isArray(sub.diagram_urls) ? sub.diagram_urls : [];
      extraUrls.forEach((rawUrl, i) => {
        const key = i === 0 ? subBaseKey : `${subBaseKey}__img_${i}`;
        const url = getDiagramUrl(key, rawUrl);
        if (url && !seenUrls.has(url)) {
          seenUrls.add(url);
          entries.push({ key, url, index: i });
        }
      });

      for (const [k, url] of diagramUrls.entries()) {
        if (k.startsWith(`${subBaseKey}__img_`) && !removedDiagramKeys.has(k) && !seenUrls.has(url)) {
          const suffixIdx = Number(k.slice(`${subBaseKey}__img_`.length));
          seenUrls.add(url);
          entries.push({ key: k, url, index: isNaN(suffixIdx) ? entries.length : suffixIdx });
        }
      }

      return entries;
    },
    [diagramUrls, removedDiagramKeys, getDiagramUrl]
  );

  const handleRebuildMarkScheme = useCallback(
    async (idx: number, mode: 'realign' | 'generate') => {
      const targetQ = questions[idx];
      if (!targetQ) return;

      setMsActionLoadingIdx(idx);
      setMsActionError(null);
      try {
        const parentUrl = getDiagramUrl(targetQ.question_number, (targetQ as any).diagram_url);
        const subDiagramUrls: Record<string, string | null> = {};
        (targetQ.sub_questions || []).forEach((sq, si) => {
          const subKey = `${targetQ.question_number}_sub_${si}`;
          subDiagramUrls[sq.sub_id] = getDiagramUrl(subKey, sq.diagram_url);
        });

        const res = await generateQuestionMarkScheme(targetQ as any, {
          markSchemePdfBase64: mode === 'realign' ? markSchemeBase64 : null,
          includeGuidance: true,
          diagramUrlOverride: parentUrl,
          subDiagramUrls,
        });

        setQuestions((prev) => {
          const next = [...prev];
          if (!next[idx]) return prev;
          next[idx] = {
            ...next[idx],
            mark_scheme: res.mark_scheme,
            sub_questions: res.sub_questions || next[idx].sub_questions,
          };
          result.questions = next;
          return next;
        });
        setExpandedMark((prev) => {
          const next = new Set(prev);
          next.add(idx);
          return next;
        });
      } catch (err: any) {
        setMsActionError({
          idx,
          message: err?.message || 'Failed to update mark scheme',
        });
      } finally {
        setMsActionLoadingIdx(null);
      }
    },
    [questions, getDiagramUrl, markSchemeBase64, result]
  );

  // Duplicate paper check states
  const [existingDuplicates, setExistingDuplicates] = useState<Set<string>>(new Set());

  // Real-time Cambridge Support Hub URL validations
  const qpValidation = paperMetadata.cambridge_hub_url
    ? validateCambridgeHubUrl(paperMetadata.cambridge_hub_url)
    : null;
  const msValidation = paperMetadata.cambridge_ms_hub_url
    ? validateCambridgeHubUrl(paperMetadata.cambridge_ms_hub_url)
    : null;

  const onUpdateQuestionsRef = useRef(onUpdateQuestions);
  onUpdateQuestionsRef.current = onUpdateQuestions;
  const resultRef = useRef(result);
  resultRef.current = result;
  const isEditingMetadataRef = useRef(isEditingMetadata);
  isEditingMetadataRef.current = isEditingMetadata;

  const lastEmittedQuestionsRef = useRef<ExtractedQuestion[] | null>(null);
  const lastSyncedInputQuestionsRef = useRef<ExtractedQuestion[] | null>(result?.questions ?? null);
  const syncedInitialQuestionsRef = useRef<ExtractedQuestion[]>(questions);
  const lastEmittedMetadataRef = useRef<PaperMetadata | null>(null);
  const lastSyncedMetadataRef = useRef<PaperMetadata | null>(result?.paper_metadata ?? null);
  const initialPassageQNumsRef = useRef<Set<string>>(
    new Set(
      questions
        .filter((q) => Boolean(q.passage_ref) || hasExplicitPassageMarkers(q.question_text))
        .map((q) => String(q.question_number).trim().toLowerCase())
    )
  );

  // Persist every local question/mark-scheme/diagram edit back to UploadPage & IndexedDB draft recovery.
  // Depend strictly on `questions` (never on callback identity or `result`) so parent state updates
  // cannot trigger an infinite re-render loop or reset paper metadata edits.
  useEffect(() => {
    if (questions === syncedInitialQuestionsRef.current) return;
    if (questions === lastEmittedQuestionsRef.current) return;
    lastEmittedQuestionsRef.current = questions;
    if (resultRef.current) {
      resultRef.current.questions = questions;
    }
    onUpdateQuestionsRef.current?.(questions);
  }, [questions]);

  // Sync questions & metadata ONLY when a genuinely new external result/draft arrives
  useEffect(() => {
    if (
      result?.questions &&
      result.questions !== lastSyncedInputQuestionsRef.current &&
      result.questions !== lastEmittedQuestionsRef.current
    ) {
      const cleaned = cleanExtractedQuestions(result.questions, result.passages);
      lastSyncedInputQuestionsRef.current = result.questions;
      syncedInitialQuestionsRef.current = cleaned;
      initialPassageQNumsRef.current = new Set(
        cleaned
          .filter((q) => Boolean(q.passage_ref) || hasExplicitPassageMarkers(q.question_text))
          .map((q) => String(q.question_number).trim().toLowerCase())
      );
      setQuestions(cleaned);
      setSelectedIndices(new Set(cleaned.map((_, i) => i)));
    }
    if (
      result?.paper_metadata &&
      result.paper_metadata !== lastSyncedMetadataRef.current &&
      result.paper_metadata !== lastEmittedMetadataRef.current
    ) {
      lastSyncedMetadataRef.current = result.paper_metadata;
      setPaperMetadata(result.paper_metadata);
      if (!isEditingMetadataRef.current) {
        setMetadataDraft(result.paper_metadata);
      }
    }
  }, [result]);

  const handleOpenMetadataModal = () => {
    setMetadataDraft({ ...paperMetadata });
    setTargetMarksDraft(customTargetMarks ? String(customTargetMarks) : (expectedMarks ? String(expectedMarks) : ''));
    setTagsDraft(tags);
    setIsEditingMetadata(true);
  };

  const handleSaveMetadata = () => {
    const nextMeta: PaperMetadata = {
      ...metadataDraft,
      year: Number(metadataDraft.year) || paperMetadata.year || new Date().getFullYear(),
      paper_number:
        metadataDraft.paper_number !== '' && metadataDraft.paper_number !== undefined && metadataDraft.paper_number !== null
          ? metadataDraft.paper_number
          : paperMetadata.paper_number || 1,
    };
    lastEmittedMetadataRef.current = nextMeta;
    setPaperMetadata(nextMeta);
    const parsedTarget = targetMarksDraft.trim() ? parseInt(targetMarksDraft.trim(), 10) : null;
    setCustomTargetMarks(!isNaN(Number(parsedTarget)) && (parsedTarget || 0) > 0 ? parsedTarget : null);
    setTags(tagsDraft);
    onUpdateTags?.(tagsDraft);
    onUpdateMetadata?.(nextMeta);
    setIsEditingMetadata(false);
  };

  const handleUpdateCambridgeLink = (target: 'qp' | 'ms', value: string) => {
    const trimmed = value.trim();
    const updatedMeta: PaperMetadata = {
      ...paperMetadata,
      [target === 'qp' ? 'cambridge_hub_url' : 'cambridge_ms_hub_url']: trimmed ? trimmed : null,
    };
    lastEmittedMetadataRef.current = updatedMeta;
    setPaperMetadata(updatedMeta);
    setMetadataDraft((prev) => ({
      ...prev,
      [target === 'qp' ? 'cambridge_hub_url' : 'cambridge_ms_hub_url']: trimmed ? trimmed : null,
    }));
    onUpdateMetadata?.(updatedMeta);
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

    const parentStem = parentQ.question_text?.trim() || '';
    const isContextAlreadyPresent = parentStem && sub.question_text.includes(parentStem.slice(0, 30));
    const selfContainedText = !isContextAlreadyPresent && parentStem
      ? `[Scenario Context: ${parentStem}]\n\n${sub.question_text}`
      : sub.question_text;

    const subHasSvg = Boolean(sub.svg_content);
    const subHasDiagram = Boolean(sub.diagram_url);
    const inheritedSvg = subHasSvg ? sub.svg_content : (!subHasDiagram ? parentQ.svg_content : null);
    const inheritedDiagramUrl = subHasDiagram ? sub.diagram_url : (!subHasSvg ? (parentQ.diagram_url || null) : null);

    const newQuestion: ExtractedQuestion = {
      question_number: `${parentQ.question_number}${sub.sub_id.replace(/[()]/g, '')}`,
      parent_question_id: `Q${parentQ.question_number}`,
      year: parentQ.year || paperMetadata?.year,
      series: parentQ.series || paperMetadata?.series,
      paper_number: parentQ.paper_number || paperMetadata?.paper_number,
      question_text: selfContainedText,
      question_style: normalizeQuestionStyle(parentQ.question_style, sub.options),
      total_marks: subMarks,
      estimated_difficulty: parentQ.estimated_difficulty,
      cognitive_level: sub.cognitive_level || parentQ.cognitive_level || null,
      topic: parentQ.topic,
      sub_topic: parentQ.sub_topic,
      has_diagram: Boolean(inheritedSvg || inheritedDiagramUrl),
      svg_content: inheritedSvg || null,
      diagram_url: inheritedDiagramUrl || null,
      diagram_type: sub.diagram_type || parentQ.diagram_type || null,
      has_embedded_values: sub.has_embedded_values !== undefined ? sub.has_embedded_values : parentQ.has_embedded_values,
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

    const oldSubCount = parentQ.sub_questions.length;
    const oldSubDiagramKey = `${parentQ.question_number}_sub_${subIdx}`;
    const targetNewQNum = newQuestion.question_number;
    if (diagramUrls.has(oldSubDiagramKey)) {
      onRenameDiagramKey?.(oldSubDiagramKey, targetNewQNum);
    }
    for (let k = subIdx + 1; k < oldSubCount; k++) {
      const prevKey = `${parentQ.question_number}_sub_${k}`;
      const shiftedKey = `${parentQ.question_number}_sub_${k - 1}`;
      if (diagramUrls.has(prevKey)) {
        onRenameDiagramKey?.(prevKey, shiftedKey);
      }
    }

    const updatedList = [...questions];
    updatedList.splice(qIdx, 1, updatedParent, newQuestion);
    result.questions = updatedList;
    setQuestions(updatedList);
    setSelectedIndices(new Set(updatedList.map((_, i) => i)));
  }, [questions, paperMetadata, result, diagramUrls, onRenameDiagramKey]);

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
    const selectedRaw = questions.filter((_, i) => selectedIndices.has(i));
    const preparedSelected = selectedRaw.map((q) => {
      const key = String(q.question_number).trim().toLowerCase();
      const hadInitialPassage = initialPassageQNumsRef.current.has(key);
      if (
        hadInitialPassage &&
        !hasExplicitPassageMarkers(q.question_text) &&
        !hasNoPassageDirective(q.question_text)
      ) {
        return {
          ...q,
          passage_ref: null,
          question_text: `${NO_PASSAGE_TAG}\n${q.question_text || ''}`,
        };
      }
      return q;
    });
    const questionsToSave = cleanExtractedQuestions(preparedSelected);
    onConfirmSave(
      {
        ...result,
        paper_metadata: paperMetadata,
        questions: questionsToSave.map((q) => ({
          ...q,
          year: paperMetadata.year,
          series: paperMetadata.series,
          paper_number: paperMetadata.paper_number,
          cambridge_hub_url: q.cambridge_hub_url || paperMetadata.cambridge_hub_url || null,
          cambridge_ms_hub_url: q.cambridge_ms_hub_url || paperMetadata.cambridge_ms_hub_url || null,
        })),
      },
      tags
    );
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
            label="Paper Type"
            value={`${paperMetadata?.series || 'Series'} ${paperMetadata?.year || new Date().getFullYear()}`}
            onClick={handleOpenMetadataModal}
            isClickable
          />
          <MetaBadge
            label="Paper / Section"
            value={formatPaperLabel(paperMetadata?.paper_number || '1')}
            onClick={handleOpenMetadataModal}
            isClickable
          />
          <MetaBadge
            label="Question Tags"
            value={tags && tags.trim() ? tags.split(/[\s,]+/).filter(Boolean).map(t => '#' + t.replace(/^#/, '')).join(' ') : '+ Add #Tags'}
            onClick={handleOpenMetadataModal}
            isClickable
          />
          <MetaBadge
            label="Cambridge QP Link"
            value={paperMetadata.cambridge_hub_url ? '✓ Linked' : '+ Add QP Link'}
            onClick={handleOpenMetadataModal}
            isClickable
          />
          <MetaBadge
            label="Cambridge MS Link"
            value={paperMetadata.cambridge_ms_hub_url ? '✓ Linked' : '+ Add MS Link'}
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

          <div
            className={`meta-badge ${
              msAudit.errorCount > 0 || msAudit.warningCount > 0
                ? 'meta-badge--warning meta-badge--clickable'
                : 'meta-badge--success'
            }`}
            onClick={() => {
              if (msAudit.flaggedIndices.length > 0) {
                setExpandedMark((prev) => new Set([...prev, ...msAudit.flaggedIndices]));
                const firstCard = document.getElementById(`review-card-${msAudit.flaggedIndices[0]}`);
                firstCard?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }}
            title={
              msAudit.flaggedIndices.length > 0
                ? 'Click to expand and jump to the first question with a Mark Scheme QA flag'
                : 'All extracted mark schemes passed structural & mark-sum checks'
            }
          >
            <span className="meta-badge-label">
              Mark Scheme QA {hasAttachedOfficialMs ? '(Official MS)' : '(AI)'}
            </span>
            <span className="meta-badge-value">
              {msAudit.errorCount + msAudit.warningCount === 0
                ? '✓ Verified'
                : `⚠️ ${msAudit.errorCount + msAudit.warningCount} Flagged`}
            </span>
          </div>
        </div>

        {/* ─── Cambridge Support Hub Links Card (for ToS Citations) ─────────────── */}
        <div className="review-cambridge-links-card">
          <div className="review-cambridge-links-header">
            <div className="review-cambridge-links-title-wrap">
              <span className="review-cambridge-links-icon">🔗</span>
              <div>
                <strong className="review-cambridge-links-title">
                  Official Cambridge School Support Hub Links
                </strong>
                <span className="review-cambridge-links-badge">Table of Specifications (ToS) Citations</span>
                <p className="review-cambridge-links-desc">
                  Attach Cambridge Hub links to power official hyperlinks in exported assessment specifications. Links will be applied to all {questions.length} questions when saved.
                </p>
              </div>
            </div>
          </div>

          <div className="review-cambridge-links-grid">
            {/* Question Paper Hub Link */}
            <div className="review-cambridge-input-block">
              <div className="review-cambridge-label-row">
                <label htmlFor="review-qp-hub-url">
                  📄 Cambridge Question Paper (QP) Link
                </label>
                {qpValidation && (
                  <span
                    className={`review-cambridge-status-pill ${
                      qpValidation.isCambridgeHubDomain
                        ? 'review-cambridge-status--valid'
                        : qpValidation.isValid
                        ? 'review-cambridge-status--warning'
                        : 'review-cambridge-status--error'
                    }`}
                  >
                    {qpValidation.isCambridgeHubDomain
                      ? '✓ Cambridge Hub'
                      : qpValidation.isValid
                      ? 'ℹ️ Custom Link'
                      : '⚠️ Invalid URL'}
                  </span>
                )}
              </div>
              <div className="review-cambridge-input-wrapper">
                <input
                  id="review-qp-hub-url"
                  type="url"
                  className="review-cambridge-url-input"
                  placeholder="https://schoolsupporthub.cambridge.org/item/..."
                  value={paperMetadata.cambridge_hub_url || ''}
                  onChange={(e) => handleUpdateCambridgeLink('qp', e.target.value)}
                />
                {paperMetadata.cambridge_hub_url && (
                  <button
                    type="button"
                    className="review-cambridge-clear-btn"
                    onClick={() => handleUpdateCambridgeLink('qp', '')}
                    title="Clear Question Paper Hub Link"
                    aria-label="Clear Question Paper Hub Link"
                  >
                    ✕
                  </button>
                )}
              </div>
              {qpValidation?.warning && (
                <span className="review-cambridge-hint-text review-cambridge-hint--warning">
                  {qpValidation.warning}
                </span>
              )}
            </div>

            {/* Mark Scheme Hub Link */}
            <div className="review-cambridge-input-block">
              <div className="review-cambridge-label-row">
                <label htmlFor="review-ms-hub-url">
                  📝 Cambridge Mark Scheme (MS) Link
                </label>
                {msValidation && (
                  <span
                    className={`review-cambridge-status-pill ${
                      msValidation.isCambridgeHubDomain
                        ? 'review-cambridge-status--valid'
                        : msValidation.isValid
                        ? 'review-cambridge-status--warning'
                        : 'review-cambridge-status--error'
                    }`}
                  >
                    {msValidation.isCambridgeHubDomain
                      ? '✓ Cambridge Hub'
                      : msValidation.isValid
                      ? 'ℹ️ Custom Link'
                      : '⚠️ Invalid URL'}
                  </span>
                )}
              </div>
              <div className="review-cambridge-input-wrapper">
                <input
                  id="review-ms-hub-url"
                  type="url"
                  className="review-cambridge-url-input"
                  placeholder="https://schoolsupporthub.cambridge.org/item/..."
                  value={paperMetadata.cambridge_ms_hub_url || ''}
                  onChange={(e) => handleUpdateCambridgeLink('ms', e.target.value)}
                />
                {paperMetadata.cambridge_ms_hub_url && (
                  <button
                    type="button"
                    className="review-cambridge-clear-btn"
                    onClick={() => handleUpdateCambridgeLink('ms', '')}
                    title="Clear Mark Scheme Hub Link"
                    aria-label="Clear Mark Scheme Hub Link"
                  >
                    ✕
                  </button>
                )}
              </div>
              {msValidation?.warning && (
                <span className="review-cambridge-hint-text review-cambridge-hint--warning">
                  {msValidation.warning}
                </span>
              )}
            </div>
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
          const qMsAudit = msAudit.byIndex[idx] || { status: 'ok', issues: [] };
          const isMsExpanded = showAllMarkSchemes || expandedMark.has(idx);
          const isRebuildingThis = msActionLoadingIdx === idx;

          return (
            <div
              key={idx}
              id={`review-card-${idx}`}
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

                  {qMsAudit.status !== 'ok' && (
                    <span
                      className={`review-badge ${
                        qMsAudit.status === 'error' ? 'badge--ms-error' : 'badge--ms-warning'
                      }`}
                      title={qMsAudit.issues.map((i) => i.message).join('\n')}
                    >
                      {qMsAudit.status === 'error'
                        ? `⚠️ MS Issue (${qMsAudit.issues.length})`
                        : `⚠️ MS Check (${qMsAudit.issues.length})`}
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

                  <select
                    className={isFastEditMode ? 'review-inline-select' : 'review-badge'}
                    style={
                      isFastEditMode
                        ? undefined
                        : {
                            background: '#eff6ff',
                            color: '#1d4ed8',
                            borderColor: '#bfdbfe',
                            fontWeight: 600,
                            cursor: 'pointer',
                            paddingRight: '6px',
                          }
                    }
                    value={q.cognitive_level || 'C2'}
                    onChange={(e) => handleUpdateQuestionField(idx, 'cognitive_level', e.target.value)}
                    title="Bloom's Taxonomy Cognitive Level (Click to change)"
                  >
                    <option value="C1">{isFastEditMode ? 'C1 (Remembering)' : 'C1'}</option>
                    <option value="C2">{isFastEditMode ? 'C2 (Understanding)' : 'C2'}</option>
                    <option value="C3">{isFastEditMode ? 'C3 (Applying)' : 'C3'}</option>
                    <option value="C4">{isFastEditMode ? 'C4 (Analyzing)' : 'C4'}</option>
                    <option value="C5">{isFastEditMode ? 'C5 (Evaluating)' : 'C5'}</option>
                    <option value="C6">{isFastEditMode ? 'C6 (Creating)' : 'C6'}</option>
                  </select>

                  {isFastEditMode ? (
                    <select
                      className="review-inline-select"
                      value={normalizeQuestionStyle(q.question_style, q.options)}
                      onChange={(e) => handleUpdateQuestionField(idx, 'question_style', e.target.value)}
                    >
                      <option value="Structured">Structured</option>
                      <option value="Multiple Choice">Multiple Choice</option>
                      <option value="Multiple Select">Multiple Select</option>
                      <option value="Table Choice">Table Choice</option>
                      <option value="Calculation">Calculation</option>
                      <option value="Short Answer">Short Answer</option>
                      <option value="Fill in the Blank">Fill in the Blank</option>
                    </select>
                  ) : (
                    <span className="review-badge badge--style">{normalizeQuestionStyle(q.question_style, q.options)}</span>
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

              {/* ─── Parent Question Diagrams (Multi-Image Supported) ──────── */}
              {(() => {
                const stemEntries = getStemDiagramEntries(q);
                const isInsert = q.diagram_source === 'insert';
                const targetPage = isInsert
                  ? (q.insert_page_number && q.insert_page_number > 0 ? q.insert_page_number : 1)
                  : (q.page_number && q.page_number > 0 ? q.page_number : 1);

                const openAddParentCrop = () => {
                  const nextIdx = stemEntries.length;
                  const nextKey = nextIdx === 0 ? q.question_number : `${q.question_number}__img_${nextIdx}`;
                  setCropTarget({
                    qIdx: idx,
                    imageIndex: nextIdx,
                    key: nextKey,
                    questionNumber: nextIdx === 0 ? `Question ${q.question_number}` : `Question ${q.question_number} (Fig. ${nextIdx + 1})`,
                    initialBox: q.bounding_box,
                    initialPage: targetPage,
                    initialQpPage: q.page_number || 1,
                    initialInsertPage: q.insert_page_number || 1,
                    initialSourceType: isInsert ? 'insert' : 'qp',
                  });
                };

                if (stemEntries.length === 0) {
                  return (
                    <div className="review-diagram-bar">
                      <button
                        type="button"
                        className="review-add-diagram-btn"
                        onClick={openAddParentCrop}
                      >
                        + 📸 Add/Crop Main Diagram
                      </button>
                    </div>
                  );
                }

                return (
                  <div className="review-diagrams-gallery">
                    {stemEntries.map((entry, ePos) => (
                      <div key={entry.key} className="review-diagram-card">
                        {stemEntries.length > 1 && (
                          <span className="review-diagram-fig-label">Figure {ePos + 1}</span>
                        )}
                        <img
                          src={entry.url}
                          alt={`Diagram ${ePos + 1} for Q${q.question_number}`}
                          className="review-diagram-img"
                        />
                        <div className="review-diagram-overlay-actions">
                          <button
                            type="button"
                            className="review-crop-btn"
                            onClick={() => {
                              setCropTarget({
                                qIdx: idx,
                                imageIndex: entry.index,
                                key: entry.key,
                                questionNumber: `Question ${q.question_number} (Fig. ${ePos + 1})`,
                                initialBox: q.bounding_box,
                                initialPage: targetPage,
                                initialQpPage: q.page_number || 1,
                                initialInsertPage: q.insert_page_number || 1,
                                initialSrc: entry.url,
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
                              setRemovedDiagramKeys((prev) => new Set(prev).add(entry.key));
                              onRemoveDiagram?.(entry.key);
                              setQuestions((prev) => {
                                const next = [...prev];
                                if (next[idx]) {
                                  const remaining = stemEntries
                                    .filter((other) => other.key !== entry.key)
                                    .map((other) => other.url);
                                  next[idx] = {
                                    ...next[idx],
                                    has_diagram: remaining.length > 0,
                                    diagram_url: remaining[0] || null,
                                    diagram_urls: remaining.length > 0 ? remaining : null,
                                    ...(remaining.length === 0
                                      ? {
                                          svg_content: null,
                                          ai_diagram_prompt: null,
                                          diagram_source: null,
                                          resource_ref: null,
                                          bounding_box: null,
                                        }
                                      : {}),
                                  };
                                }
                                result.questions = next;
                                return next;
                              });
                            }}
                            title="Remove diagram"
                          >
                            🗑️ Remove
                          </button>
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="review-add-diagram-btn"
                      style={{ alignSelf: 'center' }}
                      onClick={openAddParentCrop}
                      title="Crop an additional figure for this question"
                    >
                      + 📸 Add Another Diagram
                    </button>
                  </div>
                );
              })()}

              {/* ─── Sub-Questions (Structured Multi-Part Questions) ───────── */}
              {q.sub_questions && q.sub_questions.length > 0 && (
                <div className="review-sub-questions">
                  {q.sub_questions.map((sub, si) => {
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

                          {sub.cognitive_level && (
                            <span
                              style={{
                                fontSize: '11px',
                                fontWeight: 600,
                                color: '#1d4ed8',
                                background: '#eff6ff',
                                border: '1px solid #bfdbfe',
                                borderRadius: '4px',
                                padding: '1px 6px',
                                alignSelf: 'center',
                              }}
                              title={`Bloom's Taxonomy: ${sub.cognitive_level}`}
                            >
                              {sub.cognitive_level}
                            </span>
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

                        {/* Sub-Question Multi-Image Diagram Preview & Snip Controls */}
                        {(() => {
                          const subEntries = getSubDiagramEntries(q, sub, si);
                          const subBaseKey = `${q.question_number}_sub_${si}`;
                          const isSubInsert = sub.diagram_source === 'insert' || (!sub.diagram_source && q.diagram_source === 'insert' && !sub.page_number);
                          const subTargetPage = isSubInsert
                            ? (sub.insert_page_number && sub.insert_page_number > 0 ? sub.insert_page_number : (q.insert_page_number || 1))
                            : (sub.page_number && sub.page_number > 0 ? sub.page_number : (q.page_number || 1));

                          const openAddSubCrop = () => {
                            const nextIdx = subEntries.length;
                            const nextKey = nextIdx === 0 ? subBaseKey : `${subBaseKey}__img_${nextIdx}`;
                            setCropTarget({
                              qIdx: idx,
                              subIdx: si,
                              imageIndex: nextIdx,
                              key: nextKey,
                              questionNumber: `Question ${q.question_number} ${sub.sub_id}${nextIdx > 0 ? ` (Fig. ${nextIdx + 1})` : ''}`,
                              initialBox: sub.bounding_box || q.bounding_box,
                              initialPage: subTargetPage,
                              initialQpPage: sub.page_number || q.page_number || 1,
                              initialInsertPage: sub.insert_page_number || q.insert_page_number || 1,
                              initialSourceType: isSubInsert ? 'insert' : 'qp',
                            });
                          };

                          if (subEntries.length === 0) {
                            return (
                              <div className="review-sub-diagram-trigger-bar">
                                <button
                                  type="button"
                                  className="review-sub-add-diagram-btn"
                                  onClick={openAddSubCrop}
                                >
                                  + 📸 Add Diagram to {sub.sub_id}
                                </button>
                              </div>
                            );
                          }

                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {subEntries.map((entry, ePos) => (
                                <div key={entry.key} className="review-sub-diagram-container">
                                  {subEntries.length > 1 && (
                                    <span className="review-diagram-fig-label">Figure {ePos + 1}</span>
                                  )}
                                  <img
                                    src={entry.url}
                                    alt={`Diagram ${ePos + 1} for ${sub.sub_id}`}
                                    className="review-sub-diagram-img"
                                  />
                                  <div className="review-sub-diagram-actions">
                                    <button
                                      type="button"
                                      className="review-sub-crop-btn"
                                      onClick={() => {
                                        setCropTarget({
                                          qIdx: idx,
                                          subIdx: si,
                                          imageIndex: entry.index,
                                          key: entry.key,
                                          questionNumber: `Question ${q.question_number} ${sub.sub_id} (Fig. ${ePos + 1})`,
                                          initialBox: sub.bounding_box || q.bounding_box,
                                          initialPage: subTargetPage,
                                          initialQpPage: sub.page_number || q.page_number || 1,
                                          initialInsertPage: sub.insert_page_number || q.insert_page_number || 1,
                                          initialSrc: entry.url,
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
                                        setRemovedDiagramKeys((prev) => new Set(prev).add(entry.key));
                                        onRemoveDiagram?.(entry.key);
                                        setQuestions((prev) => {
                                          const next = [...prev];
                                          const subs = [...(next[idx]?.sub_questions || [])];
                                          if (subs[si]) {
                                            const remaining = subEntries
                                              .filter((other) => other.key !== entry.key)
                                              .map((other) => other.url);
                                            subs[si] = {
                                              ...subs[si],
                                              diagram_url: remaining[0] || null,
                                              diagram_urls: remaining.length > 0 ? remaining : null,
                                              has_diagram: remaining.length > 0,
                                              ...(remaining.length === 0
                                                ? {
                                                    svg_content: null,
                                                    ai_diagram_prompt: null,
                                                    diagram_source: null,
                                                    resource_ref: null,
                                                    bounding_box: null,
                                                  }
                                                : {}),
                                            };
                                            next[idx] = { ...next[idx], sub_questions: subs };
                                          }
                                          result.questions = next;
                                          return next;
                                        });
                                      }}
                                    >
                                      🗑️ Remove
                                    </button>
                                  </div>
                                </div>
                              ))}
                              <div>
                                <button
                                  type="button"
                                  className="review-sub-add-diagram-btn"
                                  onClick={openAddSubCrop}
                                >
                                  + 📸 Add Another Diagram to {sub.sub_id}
                                </button>
                              </div>
                            </div>
                          );
                        })()}

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

              {/* ─── MCQ Options (With Optional Per-Option Diagrams) ──────── */}
              {q.options && q.options.length > 0 && (
                <div className="review-options">
                  {q.options.map((opt, oi) => {
                    const optKey = `${q.question_number}__opt_${oi}`;
                    const optDiagramUrl = getDiagramUrl(optKey, q.option_diagrams?.[oi]);
                    const letter = String.fromCharCode(65 + oi);
                    const openOptionCrop = () => {
                      const isInsert = q.diagram_source === 'insert';
                      const targetPage = isInsert
                        ? (q.insert_page_number && q.insert_page_number > 0 ? q.insert_page_number : 1)
                        : (q.page_number && q.page_number > 0 ? q.page_number : 1);
                      setCropTarget({
                        qIdx: idx,
                        optionIndex: oi,
                        key: optKey,
                        questionNumber: `Question ${q.question_number} Option ${letter}`,
                        initialBox: q.bounding_box,
                        initialPage: targetPage,
                        initialQpPage: q.page_number || 1,
                        initialInsertPage: q.insert_page_number || 1,
                        initialSrc: optDiagramUrl,
                        initialSourceType: isInsert ? 'insert' : 'qp',
                      });
                    };

                    return (
                      <div key={oi} className="review-option">
                        <div className="review-option-main-row">
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {isFastEditMode ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
                                <span style={{ fontWeight: 600, minWidth: '22px', color: 'var(--text-muted)' }}>
                                  {letter}.
                                </span>
                                <input
                                  type="text"
                                  className="review-inline-topic-input"
                                  style={{ flex: 1, padding: '4px 8px', fontSize: '0.88rem' }}
                                  value={opt}
                                  onChange={(e) => {
                                    const newOpts = [...(q.options || [])];
                                    newOpts[oi] = e.target.value;
                                    handleUpdateQuestionField(idx, 'options', newOpts);
                                  }}
                                  placeholder={`Option ${letter} (text optional if image attached)`}
                                />
                              </div>
                            ) : opt && opt.trim() ? (
                              <ExamMathText content={opt} />
                            ) : (
                              <span style={{ color: 'var(--color-text-tertiary)', fontWeight: 600 }}>
                                Option {letter} (Diagram)
                              </span>
                            )}
                          </div>

                          <div style={{ display: 'inline-flex', gap: 6, flexShrink: 0 }}>
                            <button
                              type="button"
                              className="review-sub-add-diagram-btn"
                              onClick={openOptionCrop}
                              title={`Crop diagram from PDF for Option ${letter}`}
                            >
                              {optDiagramUrl ? `✂️ Re-crop ${letter}` : `+ 📸 Crop Option ${letter}`}
                            </button>
                            {optDiagramUrl && (
                              <button
                                type="button"
                                className="review-sub-crop-btn review-sub-crop-btn--remove"
                                onClick={() => {
                                  setRemovedDiagramKeys((prev) => new Set(prev).add(optKey));
                                  onRemoveDiagram?.(optKey);
                                  setQuestions((prev) => {
                                    const next = [...prev];
                                    if (next[idx]) {
                                      const nextOptDiags = normalizeOptionDiagramList(
                                        next[idx].option_diagrams,
                                        next[idx].options?.length || oi + 1
                                      );
                                      nextOptDiags[oi] = null;
                                      next[idx] = {
                                        ...next[idx],
                                        option_diagrams: nextOptDiags.some(Boolean) ? nextOptDiags : null,
                                      };
                                    }
                                    result.questions = next;
                                    return next;
                                  });
                                }}
                                title={`Remove Option ${letter} diagram`}
                              >
                                🗑️
                              </button>
                            )}
                          </div>
                        </div>

                        {optDiagramUrl && (
                          <div className="review-option-thumb-wrap">
                            <img
                              src={optDiagramUrl}
                              alt={`Option ${letter} diagram`}
                              className="review-option-thumb-img"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ─── Mark Scheme (Collapsible) ────────────────────────────── */}
              <div className="review-markscheme">
                <div className="review-markscheme-header-row">
                  <button
                    type="button"
                    className="review-markscheme-toggle"
                    onClick={() => toggleMarkScheme(idx)}
                    id={`toggle-ms-${idx}`}
                  >
                    <span className={`review-chevron ${isMsExpanded ? 'review-chevron--open' : ''}`}>
                      ›
                    </span>
                    Mark Scheme {isMsExpanded ? '(Expanded)' : ''}
                    {!q.mark_scheme && (
                      <span className="review-badge badge--ms-error" style={{ fontSize: '0.68rem' }}>
                        Missing
                      </span>
                    )}
                    {(q.mark_scheme?.guidance?.length || q.mark_scheme?.common_misconceptions?.length) ? (
                      <span className="review-insights-pill">✨ Insights Available</span>
                    ) : null}
                  </button>

                  <div className="review-ms-actions">
                    {markSchemeBase64 && (
                      <button
                        type="button"
                        className="review-ms-action-btn review-ms-action-btn--realign"
                        disabled={isRebuildingThis || msActionLoadingIdx !== null}
                        onClick={() => handleRebuildMarkScheme(idx, 'realign')}
                        title="Re-match and copy official marking criteria strictly from the uploaded Mark Scheme PDF"
                      >
                        {isRebuildingThis ? 'Re-aligning…' : '🔄 Re-align from MS'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="review-ms-action-btn"
                      disabled={isRebuildingThis || msActionLoadingIdx !== null}
                      onClick={() => handleRebuildMarkScheme(idx, 'generate')}
                      title="Generate or regenerate full mark scheme using question stem, tables, and cropped diagrams"
                    >
                      {isRebuildingThis ? 'Generating…' : '✨ Generate MS'}
                    </button>
                  </div>
                </div>

                {msActionError?.idx === idx && (
                  <div className="review-ms-error-msg">⚠ {msActionError.message}</div>
                )}

                {isMsExpanded && (
                  <div className="review-markscheme-body animate-fade-in">
                    {qMsAudit.issues.length > 0 && (
                      <div
                        className={`review-ms-audit-alert ${
                          qMsAudit.status === 'error' ? 'review-ms-audit-alert--error' : ''
                        }`}
                      >
                        {qMsAudit.issues.map((iss, ii) => (
                          <div key={ii}>• {iss.message}</div>
                        ))}
                      </div>
                    )}

                    {Array.isArray(q.mark_scheme?.marking_points) &&
                      q.mark_scheme.marking_points.map((point, pi) => (
                        <div key={pi} className="review-ms-point">
                          <span className="review-ms-bullet">•</span>
                          <ExamMathText content={point} />
                        </div>
                      ))}

                    {Array.isArray(q.mark_scheme?.acceptable_answers) &&
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
                    {showAllGuidance && Array.isArray(q.mark_scheme?.guidance) && q.mark_scheme.guidance.length > 0 && (
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
                    {showAllGuidance && Array.isArray(q.mark_scheme?.common_misconceptions) && q.mark_scheme.common_misconceptions.length > 0 && (
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
        const stemEntries = getStemDiagramEntries(curQ);
        const combinedStemUrls = normalizeDiagramUrlList([
          ...stemEntries.map((e) => e.url),
          ...resolveQuestionImageUrlsExcludingStandaloneSvg(curQ),
          diagramUrls.get(curQ.question_number),
          curQ.parent_question_id ? diagramUrls.get(curQ.parent_question_id) : undefined,
          diagramUrls.get(`Q${curQ.question_number}`),
          diagramUrls.get(curQ.question_number.replace(/^Q/i, '')),
        ]);
        const resolvedCurOptDiagrams = normalizeOptionDiagramList(
          (curQ.options || []).map((_, oi) =>
            getDiagramUrl(`${curQ.question_number}__opt_${oi}`, curQ.option_diagrams?.[oi])
          ),
          curQ.options?.length || 0
        );

        const effectiveInitialStyle = normalizeQuestionStyle(curQ.question_style, curQ.options, resolvedCurOptDiagrams);

        return (
          <QuestionEditorModal
            isOpen={true}
            markSchemePdfBase64={markSchemeBase64}
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
              question_style: effectiveInitialStyle,
              topic: curQ.topic || 'General',
              sub_topic: curQ.sub_topic || null,
              difficulty: curQ.estimated_difficulty || 'Medium',
              cognitive_level: curQ.cognitive_level || 'C2',
              source_pdf_url: curQ.source_pdf_url || null,
              cambridge_hub_url: curQ.cambridge_hub_url || null,
              cambridge_ms_hub_url: curQ.cambridge_ms_hub_url || null,
              page_number: curQ.page_number ?? null,
              marks: Number(curQ.total_marks) || 1,
              diagram_url: combinedStemUrls[0] || curQ.diagram_url || null,
              diagram_urls: combinedStemUrls.length > 0 ? combinedStemUrls : null,
              svg_content: curQ.svg_content || null,
              ai_diagram_prompt: curQ.ai_diagram_prompt || null,
              options: curQ.options && curQ.options.length > 0 ? curQ.options : null,
              option_diagrams: resolvedCurOptDiagrams.some(Boolean) ? resolvedCurOptDiagrams : null,
              sub_questions: curQ.sub_questions || [],
              mark_scheme: curQ.mark_scheme || null,
            }}
            onClose={() => setEditingIdx(null)}
            onSave={(saved) => {
              if (editingIdx !== null && questions[editingIdx]) {
                const updatedList = [...questions];
                const originalQ = updatedList[editingIdx];

                const savedOptDiags = resolveOptionDiagramUrls(saved, saved.options?.length ?? originalQ.options?.length);
                const preservedOptions = (saved.options && saved.options.length > 0)
                  ? saved.options
                  : (savedOptDiags.some(Boolean))
                  ? savedOptDiags.map(() => '')
                  : (originalQ.options && originalQ.options.length > 0 && saved.question_style !== 'Calculation' && saved.question_style !== 'Short Answer')
                  ? originalQ.options
                  : null;

                const resolvedSavedStyle = normalizeQuestionStyle(saved.question_style, preservedOptions, savedOptDiags);

                const originalHadPassage =
                  Boolean(originalQ.passage_ref) || hasExplicitPassageMarkers(originalQ.question_text);
                const editedRemovedPassage =
                  originalHadPassage &&
                  !hasExplicitPassageMarkers(saved.question_text) &&
                  !hasNoPassageDirective(saved.question_text);

                const finalQuestionText = editedRemovedPassage
                  ? `${NO_PASSAGE_TAG}\n${saved.question_text || ''}`
                  : saved.question_text;

                const savedStemUrls = resolveQuestionImageUrlsExcludingStandaloneSvg(saved);
                const hasEditedDiagram = Boolean(savedStemUrls.length > 0 || saved.diagram_url || saved.svg_content);
                if (!hasEditedDiagram && originalQ.has_diagram) {
                  setRemovedDiagramKeys((prev) => new Set(prev).add(originalQ.question_number));
                  onRemoveDiagram?.(originalQ.question_number);
                }

                updatedList[editingIdx] = {
                  ...originalQ,
                  question_text: finalQuestionText,
                  question_number: saved.question_number,
                  passage_ref: editedRemovedPassage ? null : originalQ.passage_ref,
                  topic: saved.topic,
                  sub_topic: saved.sub_topic,
                  estimated_difficulty: saved.difficulty || 'Medium',
                  cognitive_level: saved.cognitive_level !== undefined ? saved.cognitive_level : (originalQ.cognitive_level || null),
                  source_pdf_url: saved.source_pdf_url !== undefined ? saved.source_pdf_url : originalQ.source_pdf_url,
                  cambridge_hub_url: saved.cambridge_hub_url !== undefined ? saved.cambridge_hub_url : originalQ.cambridge_hub_url,
                  cambridge_ms_hub_url: saved.cambridge_ms_hub_url !== undefined ? saved.cambridge_ms_hub_url : originalQ.cambridge_ms_hub_url,
                  page_number: saved.page_number !== undefined ? (saved.page_number ?? undefined) : originalQ.page_number,
                  total_marks: saved.marks,
                  question_style: resolvedSavedStyle,
                  has_diagram: hasEditedDiagram,
                  diagram_url: savedStemUrls[0] ?? saved.diagram_url ?? null,
                  diagram_urls: savedStemUrls.length > 0 ? savedStemUrls : null,
                  svg_content: saved.svg_content ?? null,
                  ai_diagram_prompt: saved.ai_diagram_prompt ?? null,
                  ...(hasEditedDiagram ? {} : { diagram_source: null, resource_ref: null, bounding_box: null }),
                  options: preservedOptions,
                  option_diagrams: savedOptDiags.some(Boolean) ? savedOptDiags : null,
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
            const { qIdx, subIdx, imageIndex, optionIndex, key } = cropTarget;
            const chosenDoc = sourceDoc || cropTarget.initialSourceType || 'qp';
            setRemovedDiagramKeys((prev) => {
              const next = new Set(prev);
              next.delete(key);
              return next;
            });
            onUpdateDiagram?.(key, { blob, localUrl, sourceDoc: chosenDoc, pageNumber });

            const updatedList = [...questions];
            const isInsert = chosenDoc === 'insert';
            if (optionIndex !== undefined && updatedList[qIdx]) {
              // MC option diagram crop on parent question
              const curQ = updatedList[qIdx];
              const nextOptDiags = normalizeOptionDiagramList(
                curQ.option_diagrams,
                Math.max(curQ.options?.length || 0, optionIndex + 1)
              );
              nextOptDiags[optionIndex] = localUrl;
              updatedList[qIdx] = {
                ...curQ,
                option_diagrams: nextOptDiags,
              };
            } else if (subIdx !== undefined && updatedList[qIdx]?.sub_questions?.[subIdx]) {
              // Sub-question crop (single or multi-image)
              const subs = [...(updatedList[qIdx].sub_questions || [])];
              const existingSubUrls = getSubDiagramEntries(updatedList[qIdx], subs[subIdx], subIdx).map((e) => e.url);
              const targetImgIdx = imageIndex ?? 0;
              const nextSubUrls =
                targetImgIdx >= existingSubUrls.length
                  ? normalizeDiagramUrlList([...existingSubUrls, localUrl])
                  : normalizeDiagramUrlList(existingSubUrls.map((u, ui) => (ui === targetImgIdx ? localUrl : u)));
              subs[subIdx] = {
                ...subs[subIdx],
                has_diagram: true,
                diagram_url: nextSubUrls[0] || localUrl,
                diagram_urls: nextSubUrls.length > 0 ? nextSubUrls : [localUrl],
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
              // Parent question crop (single or multi-image)
              const curQ = updatedList[qIdx];
              const existingStemUrls = getStemDiagramEntries(curQ).map((e) => e.url);
              const targetImgIdx = imageIndex ?? 0;
              const nextStemUrls =
                targetImgIdx >= existingStemUrls.length
                  ? normalizeDiagramUrlList([...existingStemUrls, localUrl])
                  : normalizeDiagramUrlList(existingStemUrls.map((u, ui) => (ui === targetImgIdx ? localUrl : u)));
              updatedList[qIdx] = {
                ...curQ,
                has_diagram: true,
                diagram_url: nextStemUrls[0] || localUrl,
                diagram_urls: nextStemUrls.length > 0 ? nextStemUrls : [localUrl],
                diagram_source: chosenDoc,
                bounding_box: boundingBox,
                page_number: isInsert ? (curQ.page_number || 1) : pageNumber,
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
        title={`${paperMetadata?.subject || 'Assessment'} : Insert / Resource Booklet`}
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
                    <label>
                      Exam Event / Paper Type
                      <span style={{ fontSize: '0.75rem', fontWeight: 400, color: 'var(--color-text-secondary)', marginLeft: 6 }}>
                        (Use this for text like 'Try Out TKA 1', 'Midterm')
                      </span>
                    </label>
                    <input
                      type="text"
                      value={metadataDraft.series}
                      onChange={(e) => setMetadataDraft({ ...metadataDraft, series: e.target.value })}
                      placeholder="e.g. Try Out TKA 1, May/June, Midterm, Semester 1"
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
                    <label>
                      Paper Number
                      <span style={{ fontSize: '0.75rem', fontWeight: 400, color: 'var(--color-text-secondary)', marginLeft: 6 }}>
                        (Must be a number. For text, use Exam Event above)
                      </span>
                    </label>
                    <input
                      type="number"
                      value={metadataDraft.paper_number ?? ''}
                      onChange={(e) => setMetadataDraft({ ...metadataDraft, paper_number: parseInt(e.target.value) || ('' as any) })}
                      placeholder="e.g. 1, 2, 3"
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

                  <div className="review-meta-field" style={{ gridColumn: '1 / -1' }}>
                    <label>
                      📄 Cambridge Question Paper (QP) Link
                      <span style={{ fontSize: '0.75rem', fontWeight: 400, color: 'var(--color-text-secondary)', marginLeft: 6 }}>
                        (schoolsupporthub.cambridge.org item link for ToS citations)
                      </span>
                    </label>
                    <input
                      type="url"
                      value={metadataDraft.cambridge_hub_url || ''}
                      onChange={(e) => setMetadataDraft({ ...metadataDraft, cambridge_hub_url: e.target.value.trim() || null })}
                      placeholder="https://schoolsupporthub.cambridge.org/item/..."
                    />
                  </div>

                  <div className="review-meta-field" style={{ gridColumn: '1 / -1' }}>
                    <label>
                      📝 Cambridge Mark Scheme (MS) Link
                      <span style={{ fontSize: '0.75rem', fontWeight: 400, color: 'var(--color-text-secondary)', marginLeft: 6 }}>
                        (Official mark scheme item link for ToS citations)
                      </span>
                    </label>
                    <input
                      type="url"
                      value={metadataDraft.cambridge_ms_hub_url || ''}
                      onChange={(e) => setMetadataDraft({ ...metadataDraft, cambridge_ms_hub_url: e.target.value.trim() || null })}
                      placeholder="https://schoolsupporthub.cambridge.org/item/..."
                    />
                  </div>

                  <div className="review-meta-field" style={{ gridColumn: '1 / -1' }}>
                    <label>🏷️ Question Tags (Comma or space separated)</label>
                    <input
                      type="text"
                      value={tagsDraft}
                      onChange={(e) => setTagsDraft(e.target.value)}
                      placeholder="e.g. mock2026, tka, chem, #hard"
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
