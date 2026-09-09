// ─── Google Forms Question Flattening Service ─────────────────────────────────
// Flattens hierarchical test questions and Cambridge sub-questions into a linear list
// of Google Forms items with natural ordering, deduplication, and math formatting.

import type { Question, SubQuestion } from '../../types/database';
import type { FormFlattenedItem, FormItemType } from './googleFormsTypes';
import {
  cleanTextForGoogleForms,
  formatMarkdownTablesForPlaintext,
} from './googleFormsTextSanitizer';
import { resolveMcqCorrectOptionIndex } from '../deterministicGradingService';
import { stripDuplicateOptionsFromStem, stripDuplicateSubQuestionsFromStem } from '../../lib/gemini';
import { compareQuestionNumbers } from '../questionBankService';
import { extractMarkdownTable, extractStructuredTable, renderTableToPngDataUrl, type ParsedTableData } from '../../lib/tableImageRenderer';

/**
 * Naturally sorts questions if question numbers are out of order (Fixes Issue #2).
 * Replaces narrow 1->10 check with comprehensive natural alphanumeric comparison.
 */
export function getOrderedQuestions(questions: Question[]): Question[] {
  const ordered = [...questions];
  const isOutOfOrder = ordered.some((q, idx) => {
    if (idx > 0 && q.question_number && ordered[idx - 1].question_number) {
      return compareQuestionNumbers(ordered[idx - 1].question_number, q.question_number) > 0;
    }
    return false;
  });

  if (isOutOfOrder) {
    ordered.sort((a, b) => compareQuestionNumbers(a.question_number, b.question_number));
  }
  return ordered;
}

export function getQuestionKey(q: Question, qIndex: number): string {
  return q.id || `${qIndex}`;
}

export function getSubQuestionKey(q: Question, parentIndex: number, subIndex: number): string {
  const pKey = q.id || `${parentIndex}`;
  return `${pKey}_sub_${subIndex}`;
}

export function splitQuestionPromptAndDetails(
  fullQNum: string,
  formattedText: string
): { title: string; description?: string } {
  const clean = formattedText.trim();
  const paragraphs = clean.split('\n\n').map((p) => p.trim()).filter(Boolean);

  if (paragraphs.length > 1) {
    return {
      title: cleanTextForGoogleForms(`${fullQNum} ${paragraphs[0]}`, { preserveNewlines: false }),
      description: cleanTextForGoogleForms(paragraphs.slice(1).join('\n\n'), { preserveNewlines: true }),
    };
  }

  return {
    title: cleanTextForGoogleForms(`${fullQNum} ${clean}`, { preserveNewlines: false }),
    description: undefined,
  };
}

/**
 * Resolves all correct option indices for an MCQ or Multiple Select question.
 */
export function resolveAllMcqCorrectIndices(question: Question, subIndex?: number): number[] {
  const options = (subIndex !== undefined && question.sub_questions?.[subIndex]?.options)
    ? question.sub_questions[subIndex].options
    : question.options;

  if (!options || options.length === 0) return [];

  const foundIndices = new Set<number>();

  // 1. Direct array properties (e.g. correct_options: [0, 2])
  const directArr = (question as any).correct_options || (question as any).correctOptions || (question as any).correct_answers || (question as any).correctAnswers;
  if (Array.isArray(directArr)) {
    for (const item of directArr) {
      if (typeof item === 'number' && item >= 0 && item < options.length) {
        foundIndices.add(item);
      } else if (typeof item === 'string') {
        const clean = item.trim().toUpperCase();
        if (clean.length === 1 && clean >= 'A' && clean <= 'Z') {
          const idx = clean.charCodeAt(0) - 65;
          if (idx < options.length) foundIndices.add(idx);
        }
      }
    }
    if (foundIndices.size > 0) return Array.from(foundIndices).sort((a, b) => a - b);
  }

  // 2. Mark scheme acceptable_answers array (especially for Multiple Select)
  const sq = subIndex !== undefined ? question.sub_questions?.[subIndex] : undefined;
  const ms = sq?.mark_scheme || question.mark_scheme;
  if (ms && typeof ms === 'object' && Array.isArray((ms as any).acceptable_answers)) {
    for (const ans of (ms as any).acceptable_answers) {
      if (typeof ans === 'string') {
        const clean = ans.trim().toUpperCase();
        if (clean.length === 1 && clean >= 'A' && clean <= 'Z') {
          const idx = clean.charCodeAt(0) - 65;
          if (idx < options.length) foundIndices.add(idx);
        } else {
          // Compare against option text
          const cleanAns = cleanTextForGoogleForms(ans);
          options.forEach((opt, optIdx) => {
            if (cleanTextForGoogleForms(opt).toLowerCase() === cleanAns.toLowerCase()) {
              foundIndices.add(optIdx);
            }
          });
        }
      }
    }
    if (foundIndices.size > 0) return Array.from(foundIndices).sort((a, b) => a - b);
  }

  // 3. Fallback to standard deterministic resolver
  const singleIdx = resolveMcqCorrectOptionIndex(question, subIndex);
  if (singleIdx >= 0 && singleIdx < options.length) {
    return [singleIdx];
  }

  return [];
}

/**
 * Determines appropriate form item type (Fixes Issue #23).
 * Detects Short Answer and Fill in the Blank instead of dumping everything into PARAGRAPH.
 */
function resolveItemType(
  hasOptions: boolean,
  questionStyle?: string | null,
  marks?: number
): FormItemType {
  if (hasOptions) {
    return questionStyle === 'Multiple Select' ? 'CHECKBOX' : 'RADIO';
  }

  if (
    questionStyle === 'Short Answer' ||
    questionStyle === 'Fill in the Blank' ||
    (marks === 1 && questionStyle === 'Calculation')
  ) {
    return 'SHORT_ANSWER';
  }

  return 'PARAGRAPH';
}

/**
 * Extracts clean acceptable answers for Short Answer grading.
 */
function extractCorrectAnswersForTextItem(
  question: Question,
  subQuestion?: SubQuestion
): string[] | undefined {
  const answers: string[] = [];

  const rawAnswer = (subQuestion as any)?.correct_answer || (question as any)?.correct_answer;
  if (rawAnswer && typeof rawAnswer === 'string' && rawAnswer.trim()) {
    answers.push(cleanTextForGoogleForms(rawAnswer, { preserveNewlines: false }));
  }

  const ms = subQuestion?.mark_scheme || question.mark_scheme;
  if (ms && typeof ms === 'object' && Array.isArray(ms.acceptable_answers)) {
    for (const ans of ms.acceptable_answers) {
      if (typeof ans === 'string' && ans.trim()) {
        const cleaned = cleanTextForGoogleForms(ans, { preserveNewlines: false });
        if (cleaned && !answers.includes(cleaned)) {
          answers.push(cleaned);
        }
      }
    }
  }

  return answers.length > 0 ? answers : undefined;
}

/**
 * Detects if a question represents a classification / matching / Benar-Salah matrix table
 * that should be exported as a native Google Forms Multiple Choice Grid (questionGroupItem).
 */
export function detectGridDetails(
  extractedTable: ParsedTableData | null,
  stemText: string,
  question: Question,
  subIndex?: number
): {
  isGrid: boolean;
  gridRows?: string[];
  gridColumns?: string[];
  gridRowCorrectAnswers?: Record<string, string>;
} {
  if (!extractedTable || !extractedTable.headers || extractedTable.headers.length < 2) {
    return { isGrid: false };
  }

  const { headers, rows } = extractedTable;
  if (!rows || rows.length < 2) {
    return { isGrid: false };
  }

  // 1. Candidate Columns (Options):
  // Column 0 is typically the row item title (e.g. Place, Pernyataan, Statement)
  // Columns 1..N are the categories/choices (e.g. Conservation, Natural Beauty or Benar, Salah)
  const potentialColumns = headers
    .slice(1)
    .map((h) => cleanTextForGoogleForms(h, { preserveNewlines: false }))
    .filter(Boolean);

  if (potentialColumns.length < 1) {
    return { isGrid: false };
  }

  // 2. Check indicators that this table is an interactive response / classification matrix:
  const lowerStem = (stemText || '').toLowerCase();
  const lowerHeaders = potentialColumns.map((c) => c.toLowerCase());

  const hasBinaryHeaders = lowerHeaders.some((h) =>
    ['benar', 'salah', 'true', 'false', 'ya', 'tidak', 'yes', 'no', 'agree', 'disagree', 'sesuai', 'tidak sesuai'].includes(h)
  );

  const hasMatchingKeywords =
    /\[matching/i.test(lowerStem) ||
    /menjodohkan/i.test(lowerStem) ||
    /benar[\s/]*salah/i.test(lowerStem) ||
    /true[\s/]*false/i.test(lowerStem) ||
    /tabel\s*(?:benar|jawaban|menjodohkan)/i.test(lowerStem) ||
    /click\s+[a-z\s]+\s+for\s+each/i.test(lowerStem) ||
    /centang\s*(?:kolom|pada)/i.test(lowerStem) ||
    /pilihlah\s*(?:salah\s*satu|kolom)/i.test(lowerStem);

  // Check if inner cells in columns 1..N are empty, brackets, or tickmarks (indicative of student checkboxes/tickboxes)
  let blankOrMarkerCellCount = 0;
  let totalDataCells = 0;
  for (const r of rows) {
    for (let c = 1; c < r.length; c++) {
      totalDataCells++;
      const val = (r[c] || '').trim();
      if (
        !val ||
        val === '[ ]' ||
        val === '[  ]' ||
        val === '[   ]' ||
        val === '[x]' ||
        val === '[X]' ||
        val === '✓' ||
        val === 'v' ||
        val === 'V' ||
        val === '-' ||
        val === '—'
      ) {
        blankOrMarkerCellCount++;
      }
    }
  }

  const isMostlyBlankMatrix = totalDataCells > 0 && blankOrMarkerCellCount / totalDataCells >= 0.6;

  const isGrid = hasBinaryHeaders || hasMatchingKeywords || isMostlyBlankMatrix;
  if (!isGrid) {
    return { isGrid: false };
  }

  const gridRows = rows
    .map((r) => cleanTextForGoogleForms(r[0] || '', { preserveNewlines: false }))
    .filter(Boolean);

  if (gridRows.length < 2) {
    return { isGrid: false };
  }

  // 3. Extract row -> correct column answers from mark scheme
  const sq = subIndex !== undefined ? question.sub_questions?.[subIndex] : undefined;
  const ms = sq?.mark_scheme || question.mark_scheme;
  const gridRowCorrectAnswers: Record<string, string> = {};

  const answerCandidates: string[] = [];
  if (ms && typeof ms === 'object') {
    if (Array.isArray((ms as any).acceptable_answers)) {
      answerCandidates.push(...(ms as any).acceptable_answers.filter((a: any) => typeof a === 'string'));
    }
    if (Array.isArray((ms as any).marking_points)) {
      answerCandidates.push(...(ms as any).marking_points.filter((a: any) => typeof a === 'string'));
    }
  } else if (typeof ms === 'string') {
    answerCandidates.push(ms);
  }

  for (const cand of answerCandidates) {
    const clauses = cand.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
    for (const clause of clauses) {
      // Clean clause of marks e.g. " [1]"
      const cleanClause = clause.replace(/\s*\[\d+\]\s*$/, '').trim();
      const splitIdx = cleanClause.search(/[:=→\-]/);
      if (splitIdx !== -1) {
        const rawK = cleanClause.substring(0, splitIdx).trim();
        const rawV = cleanClause.substring(splitIdx + 1).trim();

        const normK = rawK.toLowerCase().replace(/[^a-z0-9]/g, '');
        const matchedRow = gridRows.find((r) => {
          const normR = r.toLowerCase().replace(/[^a-z0-9]/g, '');
          return normR === normK || (normR.length >= 4 && normK.includes(normR)) || (normK.length >= 4 && normR.includes(normK));
        });

        const normV = rawV.toLowerCase().replace(/[^a-z0-9]/g, '');
        const matchedCol = potentialColumns.find((c) => {
          const normC = c.toLowerCase().replace(/[^a-z0-9]/g, '');
          return normC === normV || normV.includes(normC) || normC.includes(normV);
        });

        if (matchedRow && matchedCol) {
          gridRowCorrectAnswers[matchedRow] = matchedCol;
        }
      }
    }
  }

  return {
    isGrid: true,
    gridRows,
    gridColumns: potentialColumns,
    gridRowCorrectAnswers: Object.keys(gridRowCorrectAnswers).length > 0 ? gridRowCorrectAnswers : undefined,
  };
}

/**
 * Flattens test questions and nested Cambridge sub-questions into a linear list of Google Forms items.
 */
export function flattenQuestionsForForms(
  questions: Question[],
  imageBase64Map?: Record<string, string>,
  imageUrlMap?: Record<string, string>,
  skipSort?: boolean
): FormFlattenedItem[] {
  const items: FormFlattenedItem[] = [];
  const orderedQuestions = skipSort ? questions : getOrderedQuestions(questions);

  orderedQuestions.forEach((q, qIndex) => {
    const testQNum = qIndex + 1;
    const fullQNum = `Q${testQNum}`;
    const topic = q.topic || (q as any).subject_topic || undefined;

    if (q.sub_questions && q.sub_questions.length > 0) {
      // Cambridge Structured / Multi-part Question
      const parentQKey = getQuestionKey(q, qIndex);
      const parentExtractedTable = extractMarkdownTable(q.question_text || '').table || extractStructuredTable(q.data_tables);
      const parentHasImage = Boolean(
        parentExtractedTable ||
        imageUrlMap?.[parentQKey] ||
        imageBase64Map?.[parentQKey]
      );

      let rawParentStem = stripDuplicateOptionsFromStem(q.question_text || '', q.options);
      rawParentStem = stripDuplicateSubQuestionsFromStem(rawParentStem, q.sub_questions);
      rawParentStem = rawParentStem.replace(/^\s*(?:Question\s*|Q\s*)?\d+[\.\)\:\-]\s*/i, '').trim();

      const formattedParentStem = formatMarkdownTablesForPlaintext(rawParentStem, q.data_tables, { hasImageTable: parentHasImage });
      const stemContext = cleanTextForGoogleForms(formattedParentStem, { preserveNewlines: true });
      const isInformativeStem = stemContext.length > 0 && !/^question\s*\d+$/i.test(stemContext);

      q.sub_questions.forEach((sq: SubQuestion, subIdx: number) => {
        const rawSubId = (sq.sub_id || '').trim();
        const subIdStr = rawSubId
          ? (rawSubId.startsWith('(') ? rawSubId : `(${rawSubId})`)
          : `(${String.fromCharCode(97 + subIdx)})`;

        const fullSubQNum = `${fullQNum}${subIdStr}`;
        const qSubKey = getSubQuestionKey(q, qIndex, subIdx);

        // Detect if this sub-question is a matching/classification grid
        const subExtractedTable = extractMarkdownTable(sq.question_text || '').table || extractStructuredTable((sq as any).data_tables);
        const gridInfo = detectGridDetails(subExtractedTable, sq.question_text || '', q, subIdx);
        const isGrid = gridInfo.isGrid && Boolean(gridInfo.gridRows && gridInfo.gridColumns);

        let subFallbackTablePng: string | null = null;
        if (subExtractedTable && !isGrid && !imageUrlMap?.[qSubKey] && !imageBase64Map?.[qSubKey]) {
          try {
            subFallbackTablePng = renderTableToPngDataUrl(subExtractedTable);
          } catch {}
        }

        const subHasImage = Boolean(
          isGrid ||
          subExtractedTable ||
          imageUrlMap?.[qSubKey] ||
          imageBase64Map?.[qSubKey] ||
          subFallbackTablePng ||
          (subIdx === 0 && parentHasImage)
        );

        let rawSubText = stripDuplicateOptionsFromStem(sq.question_text || '', (sq as any).options || q.options);
        rawSubText = rawSubText.replace(/^\s*(?:Question\s*|Q\s*)?(?:\d+[\.\)\:\-]?\s*)?(?:\([a-z0-9]+\)|[a-z0-9]+[\.\)])\s*/i, '').trim();

        const formattedSubText = formatMarkdownTablesForPlaintext(rawSubText, (sq as any).data_tables, { hasImageTable: subHasImage });
        const { title: itemTitle, description: subDesc } = splitQuestionPromptAndDetails(fullSubQNum, formattedSubText);

        const pointValue = Math.max(1, Math.round(Number(sq.marks) || 1));
        const hasOptions = Array.isArray(sq.options) && sq.options.length > 0;
        const subStyle = (sq as any).question_style || q.question_style;
        const itemType: FormItemType = isGrid ? 'GRID' : resolveItemType(hasOptions, subStyle, pointValue);

        let cleanedOptions: string[] | undefined;
        let correctOptionIndices: number[] | undefined;
        let correctAnswers: string[] | undefined;

        if (hasOptions && sq.options && !isGrid) {
          cleanedOptions = sq.options.map((opt) => cleanTextForGoogleForms(opt, { preserveNewlines: false }));
          const resolvedIndices = resolveAllMcqCorrectIndices(q, subIdx);
          if (resolvedIndices.length > 0) {
            correctOptionIndices = resolvedIndices;
            correctAnswers = resolvedIndices.map((idx) => cleanedOptions![idx]).filter(Boolean);
          }
        } else if (itemType === 'SHORT_ANSWER') {
          correctAnswers = extractCorrectAnswersForTextItem(q, sq);
        }

        // Feedback / Mark Scheme: Store clean text without hardcoded "Mark Scheme: " prefix (Fixes Issue #8)
        let feedback = '';
        if (sq.mark_scheme) {
          feedback = cleanTextForGoogleForms(
            typeof sq.mark_scheme === 'string' ? sq.mark_scheme : String(sq.mark_scheme),
            { preserveNewlines: true }
          );
        }

        // Image resolving (if grid, only attach if an explicit diagram exists)
        const rawDiagram = (sq as any).diagram_url || (sq as any).image_url || (sq as any).diagram_base64 ||
          (subIdx === 0 ? (q.diagram_url || (q as any).image_url || (q as any).diagram_base64) : null);

        const base64FromMap = imageBase64Map
          ? (imageBase64Map[qSubKey] || (subIdx === 0 ? imageBase64Map[parentQKey] : null) || (rawDiagram ? imageBase64Map[rawDiagram] : null))
          : null;
        const isDirectBase64 = typeof rawDiagram === 'string' && rawDiagram.startsWith('data:image/');
        const imageBase64 = base64FromMap || (!isGrid ? subFallbackTablePng : null) || (isDirectBase64 ? rawDiagram : null);

        const urlFromMap = imageUrlMap
          ? (imageUrlMap[qSubKey] || (subIdx === 0 ? imageUrlMap[parentQKey] : null) || (rawDiagram ? imageUrlMap[rawDiagram] : null))
          : null;
        const imageUrl = urlFromMap || ((!isDirectBase64 && typeof rawDiagram === 'string' && rawDiagram.startsWith('http')) ? rawDiagram : null);

        const combinedDescription = [
          isInformativeStem ? `Context: ${stemContext}` : '',
          subDesc,
        ].filter(Boolean).join('\n\n') || undefined;

        items.push({
          id: qSubKey,
          title: itemTitle,
          description: combinedDescription,
          pointValue,
          type: itemType,
          options: cleanedOptions,
          correctOptionIndices,
          correctAnswers,
          feedbackRight: 'Correct!',
          feedbackWrong: feedback || undefined,
          imageUrl,
          imageBase64,
          altText: `Diagram for ${fullSubQNum}`,
          topic,
          isSubQuestion: true,
          gridRows: gridInfo.gridRows,
          gridColumns: gridInfo.gridColumns,
          gridRowCorrectAnswers: gridInfo.gridRowCorrectAnswers,
        });
      });
    } else {
      // Standalone Question
      const qKey = getQuestionKey(q, qIndex);
      const rawDiagram = q.diagram_url || (q as any).image_url || (q as any).diagram_base64;

      const extractedTable = extractMarkdownTable(q.question_text || '').table || extractStructuredTable(q.data_tables);
      const gridInfo = detectGridDetails(extractedTable, q.question_text || '', q);
      const isGrid = gridInfo.isGrid && Boolean(gridInfo.gridRows && gridInfo.gridColumns);

      let fallbackTablePng: string | null = null;
      if (extractedTable && !isGrid && !imageUrlMap?.[qKey] && !imageBase64Map?.[qKey]) {
        try {
          fallbackTablePng = renderTableToPngDataUrl(extractedTable);
        } catch {}
      }

      const hasTable = Boolean(extractedTable);
      const hasImageTable = Boolean(
        isGrid ||
        hasTable ||
        imageUrlMap?.[qKey] ||
        imageBase64Map?.[qKey] ||
        fallbackTablePng ||
        (rawDiagram && (imageUrlMap?.[rawDiagram] || imageBase64Map?.[rawDiagram]))
      );

      let rawStem = stripDuplicateOptionsFromStem(q.question_text || '', q.options);
      rawStem = stripDuplicateSubQuestionsFromStem(rawStem, q.sub_questions);
      rawStem = rawStem.replace(/^\s*(?:Question\s*|Q\s*)?\d+[\.\)\:\-]\s*/i, '').trim();

      const formattedStem = formatMarkdownTablesForPlaintext(rawStem, q.data_tables, { hasImageTable });
      const { title: itemTitle, description: itemDescription } = splitQuestionPromptAndDetails(fullQNum, formattedStem);

      const pointValue = Math.max(1, Math.round(Number(q.marks) || 1));
      const hasOptions = Array.isArray(q.options) && q.options.length > 0;
      const itemType: FormItemType = isGrid ? 'GRID' : resolveItemType(hasOptions, q.question_style, pointValue);

      let cleanedOptions: string[] | undefined;
      let correctOptionIndices: number[] | undefined;
      let correctAnswers: string[] | undefined;

      if (hasOptions && q.options && !isGrid) {
        cleanedOptions = q.options.map((opt) => cleanTextForGoogleForms(opt, { preserveNewlines: false }));
        const resolvedIndices = resolveAllMcqCorrectIndices(q);
        if (resolvedIndices.length > 0) {
          correctOptionIndices = resolvedIndices;
          correctAnswers = resolvedIndices.map((idx) => cleanedOptions![idx]).filter(Boolean);
        }
      } else if (itemType === 'SHORT_ANSWER') {
        correctAnswers = extractCorrectAnswersForTextItem(q);
      }

      // Feedback / Mark Scheme: Store clean text without hardcoded "Mark Scheme: " prefix (Fixes Issue #8)
      let feedback = '';
      if (q.mark_scheme) {
        if (q.mark_scheme.marking_points && q.mark_scheme.marking_points.length > 0) {
          feedback = q.mark_scheme.marking_points.map((p) => cleanTextForGoogleForms(p, { preserveNewlines: true })).join('; ');
        } else if (q.mark_scheme.acceptable_answers && q.mark_scheme.acceptable_answers.length > 0) {
          feedback = q.mark_scheme.acceptable_answers.map((a) => cleanTextForGoogleForms(a, { preserveNewlines: true })).join('; ');
        }
      }

      const base64FromMap = imageBase64Map ? (imageBase64Map[qKey] || (rawDiagram ? imageBase64Map[rawDiagram] : null)) : null;
      const isDirectBase64 = typeof rawDiagram === 'string' && rawDiagram.startsWith('data:image/');
      const imageBase64 = base64FromMap || (!isGrid ? fallbackTablePng : null) || (isDirectBase64 ? rawDiagram : null);

      const urlFromMap = imageUrlMap ? (imageUrlMap[qKey] || (rawDiagram ? imageUrlMap[rawDiagram] : null)) : null;
      const imageUrl = urlFromMap || ((!isDirectBase64 && typeof rawDiagram === 'string' && rawDiagram.startsWith('http')) ? rawDiagram : null);

      items.push({
        id: qKey,
        title: itemTitle,
        description: itemDescription,
        pointValue,
        type: itemType,
        options: cleanedOptions,
        correctOptionIndices,
        correctAnswers,
        feedbackRight: 'Correct!',
        feedbackWrong: feedback || undefined,
        imageUrl,
        imageBase64,
        altText: `Diagram for ${fullQNum}`,
        topic,
        isSubQuestion: false,
        gridRows: gridInfo.gridRows,
        gridColumns: gridInfo.gridColumns,
        gridRowCorrectAnswers: gridInfo.gridRowCorrectAnswers,
      });
    }
  });

  return items;
}
