import type { Question, QuestionStyle, SubQuestion } from '../types/database';

export interface QuestionVariantClassification {
  action: 'generate' | 'skip';
  reason?: string;
  isPhotoReused?: boolean;
}

const SHARED_PASSAGE_REF_RE =
  /\b(?:questions?\s+\d+\s*(?:to|[-–—])\s*\d+|based\s+on\s+(?:text|passage|reading|wacana|bacaan)\s*[a-z0-9]+|according\s+to\s+(?:text|passage|wacana|bacaan)\s*[a-z0-9]+)\b/i;

const EXPLICIT_PASSAGE_HEADER_RE =
  /###\s*(?:Text|Passage|Reading|Stimulus|Wacana|Bacaan)\s*([A-Za-z0-9]+)/i;

function normalizePassageRefKey(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return cleaned || null;
}

/**
 * Counts how many questions share each passage_ref / passage header in the exam.
 */
export function buildSharedPassageRefSet(allQuestions?: Question[]): Set<string> {
  const counts = new Map<string, number>();
  if (!Array.isArray(allQuestions)) return new Set();

  for (const q of allQuestions) {
    const rawQ = q as Question & { passage_ref?: string | null };
    const refKey = normalizePassageRefKey(rawQ.passage_ref);
    if (refKey) {
      counts.set(refKey, (counts.get(refKey) || 0) + 1);
      continue;
    }
    const headerMatch = (q.question_text || '').match(EXPLICIT_PASSAGE_HEADER_RE);
    if (headerMatch?.[1]) {
      const hdrKey = `header:${headerMatch[1].toLowerCase()}`;
      counts.set(hdrKey, (counts.get(hdrKey) || 0) + 1);
    }
  }

  const shared = new Set<string>();
  counts.forEach((count, key) => {
    if (count >= 2) shared.add(key);
  });
  return shared;
}

/**
 * Classifies a question for Set Variant (Set B) batch generation.
 * - Audio tracks: skipped (cannot synthesize matching audio).
 * - Shared multi-question reading passages: skipped so questions sharing Text 1 stay consistent.
 * - Photo questions: generated with visual asset reuse (same image, grounded new question).
 */
export function classifyQuestionForVariant(
  q: Question,
  allQuestions?: Question[],
  sharedRefs?: Set<string>
): QuestionVariantClassification {
  // 1. Audio questions cannot be auto-synthesized cleanly
  if (q.audio_url || (q.audio_metadata && q.audio_metadata.duration)) {
    return {
      action: 'skip',
      reason: 'Audio/listening track cannot be automatically synthesized',
    };
  }

  // 2. Shared multi-question reading passages (explicit flag, shared passage_ref/header across >=2 questions, or multi-question range cue)
  const rawQ = q as Question & { passage_ref?: string | null; is_shared_passage?: boolean };
  const resolvedShared = sharedRefs || buildSharedPassageRefSet(allQuestions);
  const refKey = normalizePassageRefKey(rawQ.passage_ref);
  const headerMatch = (q.question_text || '').match(EXPLICIT_PASSAGE_HEADER_RE);
  const hdrKey = headerMatch?.[1] ? `header:${headerMatch[1].toLowerCase()}` : null;

  const isSharedPassage = Boolean(
    (rawQ.passage_ref && rawQ.is_shared_passage) ||
    (refKey && resolvedShared.has(refKey)) ||
    (hdrKey && resolvedShared.has(hdrKey)) ||
    SHARED_PASSAGE_REF_RE.test(q.question_text || '')
  );

  if (isSharedPassage) {
    return {
      action: 'skip',
      reason: 'Shared multi-question reading passage',
    };
  }

  // 3. Photograph/visual specimen questions: keep image unchanged and ground variant strictly on it
  const hasPhotoMention =
    /photo/i.test(q.resource_ref || '') ||
    /(?:photograph|micrograph|photo\b|specimen)/i.test(q.question_text || '') ||
    q.sub_questions?.some(
      (s) =>
        s.diagram_type === 'photo' ||
        /photo/i.test(s.resource_ref || '') ||
        /(?:photograph|micrograph|photo\b|specimen)/i.test(s.question_text || '')
    );

  const hasEmbeddedSvg = Boolean(
    q.svg_content ||
    (typeof q.diagram_url === 'string' && q.diagram_url.startsWith('data:image/svg+xml'))
  );

  const isPhoto =
    q.diagram_type === 'photo' ||
    hasPhotoMention ||
    (Boolean(q.diagram_url) &&
      !hasEmbeddedSvg &&
      /(\.png|\.jpe?g|\.webp|photo|micrograph)/i.test(q.diagram_url || ''));

  if (isPhoto) {
    return {
      action: 'generate',
      isPhotoReused: true,
    };
  }

  return {
    action: 'generate',
  };
}

export type VariantModeType = 'parallel' | 'scaffold' | 'extension' | 'mcq' | 'structured';

export interface ResolvedVariantShape {
  questionStyle: QuestionStyle;
  options: string[] | null;
  subQuestions: SubQuestion[] | undefined;
  marks: number;
}

/**
 * Resolves final question_style, options, sub_questions, and marks cleanly across modes.
 * Fixes scaffold-on-MCQ dropping guided sub_questions and enforces mark consistency.
 */
export function resolveVariantStyleAndSubs(params: {
  mode: VariantModeType;
  originalStyle?: QuestionStyle | null;
  parsedStyle?: string | null;
  normalizedOptions: string[] | null;
  sanitizedSubs: SubQuestion[];
  originalMarks?: number | null;
  parsedMarks?: unknown;
}): ResolvedVariantShape {
  const {
    mode,
    originalStyle,
    parsedStyle,
    normalizedOptions,
    sanitizedSubs,
    originalMarks,
    parsedMarks,
  } = params;

  let questionStyle: QuestionStyle = 'Structured';
  let options: string[] | null = null;
  let subQuestions: SubQuestion[] | undefined = undefined;

  if (mode === 'mcq') {
    questionStyle = 'Multiple Choice';
    options =
      normalizedOptions && normalizedOptions.length > 0
        ? normalizedOptions
        : ['A. Option A', 'B. Option B', 'C. Option C', 'D. Option D'];
    subQuestions = undefined;
  } else if (mode === 'structured') {
    questionStyle = 'Structured';
    options = null;
    subQuestions = sanitizedSubs.length > 0 ? sanitizedSubs : undefined;
  } else if (mode === 'scaffold' && sanitizedSubs.length > 0) {
    // Scaffolding an MCQ (or structured question) into step-by-step guided sub-parts
    questionStyle = 'Structured';
    options = null;
    subQuestions = sanitizedSubs;
  } else {
    questionStyle = (parsedStyle as QuestionStyle) || originalStyle || 'Structured';
    options = questionStyle === 'Multiple Choice' ? normalizedOptions : null;
    subQuestions =
      questionStyle !== 'Multiple Choice' && sanitizedSubs.length > 0
        ? sanitizedSubs
        : undefined;
  }

  const parsedNum = Number(parsedMarks);
  const fallbackOrigMarks = Number(originalMarks) || 1;
  let marks: number;

  if (mode === 'mcq') {
    marks = 1;
  } else if (mode === 'parallel') {
    // Parallel twin must retain original mark total for exam equivalence
    marks = fallbackOrigMarks;
  } else if (subQuestions && subQuestions.length > 0) {
    marks = subQuestions.reduce((sum, s) => sum + (Number(s.marks) || 1), 0);
  } else {
    marks = Number.isFinite(parsedNum) && parsedNum > 0 ? parsedNum : fallbackOrigMarks;
  }

  return { questionStyle, options, subQuestions, marks };
}

/**
 * Merges diagnostic distractor notes into common_misconceptions while filtering out the CORRECT option rationale.
 */
export function buildMisconceptionsWithDistractors(
  baseMisconceptions: string[],
  distractorAnalysis?: Record<string, unknown> | null
): string[] {
  const out = [...baseMisconceptions];
  if (distractorAnalysis && typeof distractorAnalysis === 'object') {
    Object.entries(distractorAnalysis).forEach(([letter, desc]) => {
      const descStr = String(desc || '').trim();
      if (!descStr) return;
      // Exclude the correct answer calculation from the misconceptions list
      if (/^correct(?:\s+answer)?\b/i.test(descStr)) return;
      out.push(`Option ${letter}: ${descStr}`);
    });
  }
  return out;
}

/**
 * Prunes Set A questionOverrides that point to replaced question IDs when saving Set B.
 */
export function pruneQuestionOverridesForVariantSet(
  originalOverrides: Record<string, Question> | undefined,
  keptOriginalIds: Set<string>
): Record<string, Question> | undefined {
  if (!originalOverrides || typeof originalOverrides !== 'object') return undefined;
  const pruned: Record<string, Question> = {};
  for (const [qId, qVal] of Object.entries(originalOverrides)) {
    if (keptOriginalIds.has(qId)) {
      pruned[qId] = qVal;
    }
  }
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}
