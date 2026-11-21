import { normalizeQuestionStyle, type ExtractedQuestion, type MarkScheme } from '../types/database';
import { extractOptionLettersFromMarkScheme, hasAiFallbackTag, isPlaceholderMarkSchemeText } from './markSchemeAudit';

const ARABIC_OPT_TO_LATIN: Record<string, string> = {
  أ: 'A',
  ا: 'A',
  إ: 'A',
  آ: 'A',
  ب: 'B',
  ج: 'C',
  د: 'D',
  هـ: 'E',
  ه: 'E',
  و: 'F',
};

function toCanonicalOptionLetter(raw: string): string | null {
  const cleaned = raw.trim();
  if (ARABIC_OPT_TO_LATIN[cleaned]) return ARABIC_OPT_TO_LATIN[cleaned];
  const upper = cleaned.toUpperCase();
  if (upper.length === 1 && upper >= 'A' && upper <= 'F') return upper;
  return null;
}

const STRUCTURED_PART_RE = /\b\d+\s*\(\s*[a-h]\s*\)|\([a-h]\)\s*\([ivx]+\)/i;
const NON_MCQ_SCHEME_RE =
  /\b(?:generic\s+levels\s+of\s+response|multiple\s*select|pilihan\s*ganda\s*kompleks|tabel\s+benar\s*\/\s*salah|tepat\s*[\/|]\s*tidak\s*tepat)\b/i;
const MCQ_KEY_HEADER_RE =
  /(?:multiple\s*choice\s*mark\s*scheme|answer\s*key|kunci\s*jawaban|(?:question|no\.?|soal)\s+(?:answer|key|kunci)(?:\s+marks?)?)/i;
const PAGE_TABLE_ANCHOR_RE =
  /(?:question|no\.?|soal)\s+(?:answer|key|jawaban|kunci)(?:\s+marks?)?/gi;
const PAIR_RE = /(?:^|\s)(\d{1,3})\s*[.):-]?\s*(هـ|[A-Eأإآابجده])(?=\s|$)/giu;

/**
 * Deterministically parses a tabular Multiple Choice Mark Scheme / Answer Key
 * (e.g. `Question | Answer` with `1 E ... 40 E`, or Cambridge `Question | Answer | Marks`
 * with `1 B 1 ...`) into a Map<questionNumber, canonicalOptionLetter ('A'..'E')>.
 *
 * Returns an empty Map for structured, essay, multi-select, or mixed theory rubrics
 * so only unambiguous single-choice MCQ keys are reconciled.
 */
export function parseOfficialMcqAnswerKey(pageTexts: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(pageTexts) || pageTexts.length === 0) return result;

  const fullText = pageTexts.join(' ').replace(/\s+/g, ' ').trim();
  if (!fullText) return result;

  // Never treat a structured / essay / multi-select mark scheme as a pure MCQ table
  if (STRUCTURED_PART_RE.test(fullText) || NON_MCQ_SCHEME_RE.test(fullText)) {
    return result;
  }

  const hasMcqHeader = MCQ_KEY_HEADER_RE.test(fullText);
  let conflictCount = 0;

  for (const rawPage of pageTexts) {
    const normalized = (rawPage || '').replace(/\s+/g, ' ').trim();
    if (!normalized) continue;

    // If the page prints a table header like "Question Answer", scan only after the header
    // so cover metadata ("Grade X", "Maximum Mark: 20==6") can never produce spurious hits.
    let sliceStart = 0;
    PAGE_TABLE_ANCHOR_RE.lastIndex = 0;
    let anchorMatch: RegExpExecArray | null;
    while ((anchorMatch = PAGE_TABLE_ANCHOR_RE.exec(normalized)) !== null) {
      sliceStart = anchorMatch.index + anchorMatch[0].length;
    }

    const body = sliceStart > 0 ? normalized.slice(sliceStart) : normalized;
    PAIR_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PAIR_RE.exec(body)) !== null) {
      const qNumNum = Number(match[1]);
      if (!Number.isInteger(qNumNum) || qNumNum < 1 || qNumNum > 200) continue;
      const letter = toCanonicalOptionLetter(match[2]);
      if (!letter) continue;

      const key = String(qNumNum);
      const prev = result.get(key);
      if (prev && prev !== letter) {
        conflictCount++;
      } else if (!prev) {
        result.set(key, letter);
      }
    }
  }

  if (result.size === 0 || conflictCount > 0) {
    return new Map();
  }

  // Validate plausibility: either an explicit MCQ MS header with >= 3 keys, or >= 5 mostly sequential keys
  if (hasMcqHeader ? result.size < 3 : result.size < 5) {
    return new Map();
  }

  const nums = Array.from(result.keys()).map(Number).sort((a, b) => a - b);
  let sequentialLinks = 0;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === nums[i - 1] + 1) sequentialLinks++;
  }
  if (!hasMcqHeader && sequentialLinks < Math.floor(nums.length * 0.6)) {
    return new Map();
  }

  return result;
}

/**
 * Reconciles extracted single-choice MCQ questions against a deterministically parsed
 * Official MCQ Answer Key Map so no valid MCQ is left tagged `[NOT IN MARK SCHEME — AI SOLVED]`
 * or given an overridden AI letter when an official key entry exists (including Arabic أ–هـ vs A–E papers).
 */
export function reconcileQuestionsWithOfficialMcqKey(
  questions: ExtractedQuestion[],
  officialMcqKey: Map<string, string>
): ExtractedQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0 || !officialMcqKey || officialMcqKey.size === 0) {
    return questions;
  }

  return questions.map((q) => {
    if (Array.isArray(q.sub_questions) && q.sub_questions.length > 0) return q;

    const style = normalizeQuestionStyle(q.question_style, q.options);
    if (style !== 'Multiple Choice') return q;

    const qNumKey = String(q.question_number || '')
      .replace(/^(?:Question|Q|Soal|No\.?)\s*/i, '')
      .replace(/[.:]$/, '')
      .trim();
    const officialLetter = officialMcqKey.get(qNumKey);
    if (!officialLetter) return q;

    const optCount = Array.isArray(q.options) && q.options.length > 0 ? q.options.length : 5;
    const officialIdx = officialLetter.charCodeAt(0) - 65;
    if (officialIdx < 0 || officialIdx >= optCount) return q;

    const existingMs = (typeof q.mark_scheme === 'object' && q.mark_scheme !== null ? q.mark_scheme : {}) as MarkScheme;
    const existingLetters = extractOptionLettersFromMarkScheme(existingMs, optCount);
    const hasFallback =
      (Array.isArray(existingMs.marking_points) && existingMs.marking_points.some((p) => hasAiFallbackTag(p))) ||
      (Array.isArray(existingMs.acceptable_answers) && existingMs.acceptable_answers.some((a) => hasAiFallbackTag(a)));
    const hasValidExisting =
      !hasFallback &&
      existingLetters.length === 1 &&
      existingLetters[0] === officialLetter &&
      Array.isArray(existingMs.marking_points) &&
      existingMs.marking_points.some((p) => !isPlaceholderMarkSchemeText(p));

    if (hasValidExisting) {
      return q;
    }

    const preservedMeta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(existingMs)) {
      if (k.startsWith('_') && v !== undefined) preservedMeta[k] = v;
    }

    const markTag = Math.max(1, Number(q.total_marks) || 1);
    const filteredGuidance = Array.isArray(existingMs.guidance)
      ? existingMs.guidance.filter((g) => typeof g === 'string' && !/not in mark scheme|absent from.*mark scheme/i.test(g))
      : undefined;

    return {
      ...q,
      mark_scheme: {
        ...preservedMeta,
        marking_points: [`${officialLetter} [${markTag}]`],
        acceptable_answers: [officialLetter],
        ...(filteredGuidance && filteredGuidance.length > 0 ? { guidance: filteredGuidance } : {}),
        ...(Array.isArray(existingMs.common_misconceptions) && existingMs.common_misconceptions.length > 0
          ? { common_misconceptions: existingMs.common_misconceptions }
          : {}),
      } as MarkScheme,
    };
  });
}
