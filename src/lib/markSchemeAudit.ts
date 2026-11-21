import {
  normalizeQuestionStyle,
  type ExtractedQuestion,
  type MarkScheme,
  type SubQuestion,
} from '../types/database';
import { parseTableChoiceFromQuestion } from './tableChoiceUtils';

export type MarkSchemeAuditIssueCode =
  | 'missing_mark_scheme'
  | 'missing_sub_mark_scheme'
  | 'ai_fallback_used'
  | 'mcq_missing_letter'
  | 'multi_select_missing_letters'
  | 'table_choice_row_mismatch'
  | 'marks_sum_mismatch'
  | 'sub_marks_sum_mismatch';

export interface MarkSchemeAuditIssue {
  code: MarkSchemeAuditIssueCode;
  severity: 'error' | 'warning';
  message: string;
  subId?: string;
}

export interface MarkSchemeAuditResult {
  status: 'ok' | 'warning' | 'error';
  issues: MarkSchemeAuditIssue[];
}

export interface ExtractionMarkSchemeAuditSummary {
  byIndex: MarkSchemeAuditResult[];
  errorCount: number;
  warningCount: number;
  okCount: number;
  flaggedIndices: number[];
}

const PLACEHOLDER_MS_RE =
  /^(?:see\s+mark(?:ing)?\s+(?:criteria|scheme)|refer\s+to\s+mark\s*scheme|n\/a|none|tbd|to\s+be\s+determined|-+|\.+)$/i;

const AI_FALLBACK_TAG_RE = /\[NOT IN MARK SCHEME/i;

/**
 * Normalizes a sub-question identifier (e.g. "(a)(ii)", "a(ii)", " a.ii ")
 * so AI responses and existing extracted sub-questions match reliably.
 */
export function normalizeSubIdKey(subId?: string | null): string {
  return String(subId || '')
    .trim()
    .toLowerCase()
    .replace(/[\s()[\].\-_:]/g, '');
}

/**
 * Returns true if a mark scheme string/entry is empty or only a placeholder stub.
 */
export function isPlaceholderMarkSchemeText(text?: string | null): boolean {
  const cleaned = (text || '').trim();
  if (!cleaned) return true;
  return PLACEHOLDER_MS_RE.test(cleaned);
}

/**
 * Returns true if the mark scheme text carries the honest fallback marker
 * indicating the item was absent from an attached Official Mark Scheme PDF.
 */
export function hasAiFallbackTag(text?: string | null): boolean {
  return AI_FALLBACK_TAG_RE.test(text || '');
}

/**
 * Sums bracketed/parenthesized mark tags across one or more mark-scheme strings
 * (e.g. "Formula [1]; Substitution [1]; 1.2 dm^3 [1]" -> 3).
 * Leading blank index markers like "[18] fortress [1]" are ignored so "[18]" is
 * never added to the mark count. Respects explicit "(max N)" / "[max N]" caps.
 * Returns null if no numeric mark tags exist at all.
 */
export function sumBracketedMarks(input: string | string[] | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const lines = Array.isArray(input) ? input : [input];
  const combinedParts: string[] = [];
  let sum = 0;
  let foundTag = false;

  for (const rawLine of lines) {
    if (typeof rawLine !== 'string') continue;
    let cleaned = rawLine.trim();
    if (!cleaned) continue;

    // Strip leading Fill-in-the-Blank index markers like "[18] fortress [1]" -> "fortress [1]"
    // only when followed by non-empty answer text on the same line.
    cleaned = cleaned.replace(/^\s*\[\d+\]\s+(?=\S)/, '');
    combinedParts.push(cleaned);

    const tagMatches = cleaned.matchAll(/\[(\d{1,2})(?:\s*marks?)?\]|\((\d{1,2})\s*marks?\)/gi);
    for (const match of tagMatches) {
      const val = Number(match[1] ?? match[2]);
      if (Number.isFinite(val) && val > 0 && val <= 40) {
        sum += val;
        foundTag = true;
      }
    }
  }

  if (!foundTag) return null;

  const combinedText = combinedParts.join(' ');
  const maxCapMatch = /\bmax(?:imum)?\s*[:=]?\s*\[?(\d{1,2})\]?/i.exec(combinedText);
  if (maxCapMatch) {
    const cap = Number(maxCapMatch[1]);
    if (Number.isFinite(cap) && cap > 0 && sum > cap) {
      return cap;
    }
  }

  return sum;
}

const ARABIC_TO_LATIN_OPTION: Record<string, string> = {
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

function normalizeOptionTokenToLatin(token: string): string {
  const cleaned = token.trim();
  if (ARABIC_TO_LATIN_OPTION[cleaned]) return ARABIC_TO_LATIN_OPTION[cleaned];
  return cleaned.toUpperCase();
}

/**
 * Extracts distinct valid uppercase MCQ/Multi-Select option letters (A..H, mapped cleanly from
 * either Latin A–H or Arabic أ، ب، ج، د، هـ، و option labels)
 * from a MarkScheme object's acceptable_answers and marking_points.
 */
export function extractOptionLettersFromMarkScheme(
  markScheme: MarkScheme | null | undefined,
  maxOptions: number = 5
): string[] {
  if (!markScheme || typeof markScheme !== 'object') return [];

  const cappedCount = Math.max(2, Math.min(8, Number(maxOptions) || 5));
  const maxCharCode = 64 + cappedCount; // e.g. 64 + 4 = 'D' (68)
  const isValidLetter = (ch: string) => {
    const code = ch.charCodeAt(0);
    return code >= 65 && code <= maxCharCode;
  };

  const letters = new Set<string>();
  const addTokenIfValid = (rawTok: string) => {
    const ch = normalizeOptionTokenToLatin(rawTok);
    if (ch.length === 1 && isValidLetter(ch)) letters.add(ch);
  };

  const scanTokenString = (raw: string, allowLeadingRationale: boolean) => {
    const s = (raw || '').trim();
    if (!s || isPlaceholderMarkSchemeText(s)) return;

    // Exact single Latin or Arabic option letter: "B", "(B)", "B.", "أ", "(هـ)", "ج."
    const singleMatch = /^\(?\s*(هـ|[A-Hأإآابجدهو])\s*\)?\.?$/iu.exec(s);
    if (singleMatch) {
      addTokenIfValid(singleMatch[1]);
      return;
    }

    // Comma / Arabic comma / "and" / semicolon-separated list: "A, C", "B and D", "أ، ج", "ب, هـ"
    const strippedTags = s.replace(/\[\d+\]/g, '').trim();
    const listCheck = strippedTags
      .replace(/^(?:correct\s+options?|answers?|options?|الخيار(?:ات)?|الإجاب(?:ة|ات)|الجواب)\s*[:\-]?\s*/i, '')
      .trim();
    if (/^(?:هـ|[A-Hأإآابجدهو])(?:\s*(?:[,،;&]|\band\b|\bو\b|\s)\s*(?:هـ|[A-Hأإآابجدهو]))+$/iu.test(listCheck)) {
      const found = listCheck.match(/(?:هـ|\b[A-H]\b|[أإآابجدهو])/giu) || [];
      for (const f of found) {
        addTokenIfValid(f);
      }
      return;
    }

    if (allowLeadingRationale) {
      // "Answer: D", "Option B", "الخيار أ", "الجواب: ب", "الإجابة: هـ"
      const prefixed = /^(?:(?:correct\s+)?answer|option|key|الخيار|الإجابة|الجواب)\s*[:\-]?\s*\(?(هـ|[A-Hأإآابجدهو])\)?(?:[\s\]\).,:;–—-]|$)/iu.exec(s);
      if (prefixed) {
        addTokenIfValid(prefixed[1]);
        return;
      }

      const leading = /^\(?(هـ|[A-Hأإآابجدهو])\)?(?:\s*[.:—–-]\s+|\s+(?=[A-Z0-9\[\u0600-\u06FF]))/u.exec(s);
      if (leading) {
        addTokenIfValid(leading[1]);
      }
    }
  };

  const acceptable = Array.isArray(markScheme.acceptable_answers) ? markScheme.acceptable_answers : [];
  for (const ans of acceptable) {
    if (typeof ans === 'string') scanTokenString(ans, true);
  }

  const points = Array.isArray(markScheme.marking_points) ? markScheme.marking_points : [];
  for (const pt of points) {
    if (typeof pt === 'string') scanTokenString(pt, true);
  }

  return Array.from(letters).sort();
}

export type AuditableQuestionShape = {
  question_text: string;
  question_style?: ExtractedQuestion['question_style'] | null;
  options?: string[] | null;
  sub_questions?: SubQuestion[] | null;
  mark_scheme?: MarkScheme | null;
  total_marks?: number | null;
  marks?: number | null;
};

/**
 * Runs deterministic QA checks on a single question's Mark Scheme and sub-question schemes.
 */
export function auditQuestionMarkScheme(
  question: AuditableQuestionShape,
  options: { hasOfficialMarkScheme?: boolean } = {}
): MarkSchemeAuditResult {
  const issues: MarkSchemeAuditIssue[] = [];
  const expectedTotal = Number(question.total_marks ?? question.marks ?? 0);
  const style = normalizeQuestionStyle(question.question_style, question.options);
  const subs = Array.isArray(question.sub_questions) ? question.sub_questions : [];
  const ms = question.mark_scheme;

  if (subs.length > 0) {
    let subMarksSum = 0;

    for (const sq of subs) {
      const sqMarks = Number(sq.marks) || 0;
      subMarksSum += sqMarks;
      const sqText = typeof sq.mark_scheme === 'string'
        ? sq.mark_scheme
        : sq.mark_scheme
          ? JSON.stringify(sq.mark_scheme)
          : '';

      if (isPlaceholderMarkSchemeText(sqText)) {
        issues.push({
          code: 'missing_sub_mark_scheme',
          severity: 'error',
          subId: sq.sub_id,
          message: `Sub-question ${sq.sub_id} is missing a mark scheme`,
        });
        continue;
      }

      if (hasAiFallbackTag(sqText)) {
        issues.push({
          code: 'ai_fallback_used',
          severity: 'warning',
          subId: sq.sub_id,
          message: `Sub-question ${sq.sub_id} was marked [NOT IN MARK SCHEME — AI SOLVED]`,
        });
      }

      if (sqMarks > 0) {
        const sqTagged = sumBracketedMarks(sqText);
        if (sqTagged !== null && sqTagged !== sqMarks) {
          issues.push({
            code: 'marks_sum_mismatch',
            severity: 'warning',
            subId: sq.sub_id,
            message: `Sub-part ${sq.sub_id} mark tags total [${sqTagged}] vs [${sqMarks}] marks`,
          });
        }
      }
    }

    if (expectedTotal > 0 && subMarksSum > 0 && subMarksSum !== expectedTotal) {
      issues.push({
        code: 'sub_marks_sum_mismatch',
        severity: 'warning',
        message: `Sub-part marks sum to ${subMarksSum} vs question total ${expectedTotal}`,
      });
    }
  } else {
    const rawPoints = Array.isArray(ms?.marking_points) ? ms.marking_points : [];
    const rawAcceptable = Array.isArray(ms?.acceptable_answers) ? ms.acceptable_answers : [];
    const validPoints = rawPoints.filter((p) => typeof p === 'string' && !isPlaceholderMarkSchemeText(p));
    const validAcceptable = rawAcceptable.filter((a) => typeof a === 'string' && !isPlaceholderMarkSchemeText(a));

    if (validPoints.length === 0 && validAcceptable.length === 0) {
      issues.push({
        code: 'missing_mark_scheme',
        severity: 'error',
        message: options.hasOfficialMarkScheme
          ? 'Missing mark scheme — click "Re-align from MS" to match with attached official mark scheme'
          : 'Missing or placeholder mark scheme',
      });
    } else {
      if (validPoints.some((p) => hasAiFallbackTag(p)) || validAcceptable.some((a) => hasAiFallbackTag(a))) {
        issues.push({
          code: 'ai_fallback_used',
          severity: 'warning',
          message: 'Question was flagged [NOT IN MARK SCHEME — AI SOLVED]',
        });
      }

      if (style === 'Multiple Choice') {
        const optionCount = Array.isArray(question.options) && question.options.length > 0 ? question.options.length : 4;
        const letters = extractOptionLettersFromMarkScheme(ms, optionCount);
        if (letters.length === 0) {
          issues.push({
            code: 'mcq_missing_letter',
            severity: 'error',
            message: 'Multiple Choice mark scheme has no valid option letter (A–E) in acceptable_answers/marking_points',
          });
        }
      } else if (style === 'Multiple Select') {
        const optionCount = Array.isArray(question.options) && question.options.length > 0 ? question.options.length : 5;
        const letters = extractOptionLettersFromMarkScheme(ms, optionCount);
        const minNeeded = expectedTotal >= 2 ? 2 : 1;
        if (letters.length < minNeeded) {
          issues.push({
            code: 'multi_select_missing_letters',
            severity: 'error',
            message: `Multiple Select requires at least ${minNeeded} valid option letter(s) in acceptable_answers`,
          });
        }
      } else if (style === 'Table Choice') {
        const parsedTable = parseTableChoiceFromQuestion(question.question_text, ms);
        if (parsedTable && parsedTable.rows.length > 0 && validPoints.length > 0 && validPoints.length !== parsedTable.rows.length) {
          issues.push({
            code: 'table_choice_row_mismatch',
            severity: 'warning',
            message: `Table Choice has ${parsedTable.rows.length} row(s) vs ${validPoints.length} marking point(s)`,
          });
        }
      }

      if (expectedTotal > 0 && validPoints.length > 0) {
        const tagSum = sumBracketedMarks(validPoints);
        if (tagSum !== null && tagSum !== expectedTotal) {
          issues.push({
            code: 'marks_sum_mismatch',
            severity: 'warning',
            message: `Mark tags sum to [${tagSum}] vs printed [${expectedTotal}]`,
          });
        }
      }
    }
  }

  const hasError = issues.some((i) => i.severity === 'error');
  const hasWarning = issues.some((i) => i.severity === 'warning');
  return {
    status: hasError ? 'error' : hasWarning ? 'warning' : 'ok',
    issues,
  };
}

/**
 * Audits an entire extracted paper's questions list.
 */
export function auditExtractionMarkSchemes(
  questions: AuditableQuestionShape[],
  options: { hasOfficialMarkScheme?: boolean } = {}
): ExtractionMarkSchemeAuditSummary {
  const byIndex: MarkSchemeAuditResult[] = [];
  const flaggedIndices: number[] = [];
  let errorCount = 0;
  let warningCount = 0;
  let okCount = 0;

  questions.forEach((q, idx) => {
    const res = auditQuestionMarkScheme(q, options);
    byIndex.push(res);
    if (res.status === 'error') {
      errorCount++;
      flaggedIndices.push(idx);
    } else if (res.status === 'warning') {
      warningCount++;
      flaggedIndices.push(idx);
    } else {
      okCount++;
    }
  });

  return { byIndex, errorCount, warningCount, okCount, flaggedIndices };
}

function scoreMarkSchemeCandidate(ms: MarkScheme | null | undefined, expectedMarks?: number): number {
  if (!ms || typeof ms !== 'object') return -100;

  const rawPoints = Array.isArray(ms.marking_points) ? ms.marking_points : [];
  const validPoints = rawPoints.filter((p) => typeof p === 'string' && !isPlaceholderMarkSchemeText(p));
  const rawAnswers = Array.isArray(ms.acceptable_answers) ? ms.acceptable_answers : [];
  const validAnswers = rawAnswers.filter((a) => typeof a === 'string' && !isPlaceholderMarkSchemeText(a));

  if (validPoints.length === 0 && validAnswers.length === 0) return -100;

  let score = 0;
  if (validPoints.length > 0) {
    const totalChars = validPoints.reduce((acc, p) => acc + p.trim().length, 0);
    score += 30 + Math.min(validPoints.length * 4, 20) + Math.min(totalChars / 40, 15);
  }
  if (validAnswers.length > 0) score += 10;
  if (Array.isArray(ms.guidance) && ms.guidance.length > 0) score += 5;
  if (Array.isArray(ms.common_misconceptions) && ms.common_misconceptions.length > 0) score += 5;

  if (validPoints.some((p) => hasAiFallbackTag(p)) || validAnswers.some((a) => hasAiFallbackTag(a))) {
    score -= 25;
  }

  if (expectedMarks && expectedMarks > 0 && validPoints.length > 0) {
    const tagged = sumBracketedMarks(validPoints);
    if (tagged !== null && tagged === expectedMarks) {
      score += 20;
    }
  }

  return score;
}

function scoreSubMarkSchemeCandidate(text?: string | null, expectedMarks?: number): number {
  if (!text || isPlaceholderMarkSchemeText(text)) return -100;
  let score = 30 + Math.min(text.trim().length / 30, 20);
  if (hasAiFallbackTag(text)) score -= 25;
  if (expectedMarks && expectedMarks > 0) {
    const tagged = sumBracketedMarks(text);
    if (tagged !== null && tagged === expectedMarks) score += 20;
  }
  return score;
}

/**
 * Merges two MarkScheme candidates across straddling PDF chunks, keeping the higher-quality
 * / mark-aligned / official mark scheme, backfilling missing guidance/acceptable_answers,
 * and preserving all internal underscore-prefixed metadata keys.
 */
export function chooseBetterMarkScheme(
  existing: MarkScheme | null | undefined,
  incoming: MarkScheme | null | undefined,
  expectedMarks?: number
): MarkScheme | undefined {
  if (!existing && !incoming) return undefined;
  if (!existing) return incoming ?? undefined;
  if (!incoming) return existing;

  const existingScore = scoreMarkSchemeCandidate(existing, expectedMarks);
  const incomingScore = scoreMarkSchemeCandidate(incoming, expectedMarks);

  const winner = incomingScore > existingScore ? incoming : existing;
  const loser = incomingScore > existingScore ? existing : incoming;

  const mergedMeta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(loser)) {
    if (k.startsWith('_') && v !== undefined) mergedMeta[k] = v;
  }
  for (const [k, v] of Object.entries(winner)) {
    if (k.startsWith('_') && v !== undefined) mergedMeta[k] = v;
  }

  const winnerAcceptable = Array.isArray(winner.acceptable_answers) ? winner.acceptable_answers.filter(Boolean) : [];
  const loserAcceptable = Array.isArray(loser.acceptable_answers) ? loser.acceptable_answers.filter(Boolean) : [];
  const winnerGuidance = Array.isArray(winner.guidance) ? winner.guidance.filter(Boolean) : [];
  const loserGuidance = Array.isArray(loser.guidance) ? loser.guidance.filter(Boolean) : [];
  const winnerMisc = Array.isArray(winner.common_misconceptions) ? winner.common_misconceptions.filter(Boolean) : [];
  const loserMisc = Array.isArray(loser.common_misconceptions) ? loser.common_misconceptions.filter(Boolean) : [];

  return {
    ...mergedMeta,
    marking_points: Array.isArray(winner.marking_points) && winner.marking_points.length > 0
      ? winner.marking_points
      : (Array.isArray(loser.marking_points) ? loser.marking_points : []),
    acceptable_answers: winnerAcceptable.length > 0 ? winnerAcceptable : loserAcceptable,
    ...(winnerGuidance.length > 0 ? { guidance: winnerGuidance } : loserGuidance.length > 0 ? { guidance: loserGuidance } : {}),
    ...(winnerMisc.length > 0 ? { common_misconceptions: winnerMisc } : loserMisc.length > 0 ? { common_misconceptions: loserMisc } : {}),
  };
}

/**
 * Merges two sub-question mark scheme strings across overlapping PDF chunks, preferring
 * non-placeholder, non-AI-fallback, mark-sum-aligned entries over raw string length.
 */
export function chooseBetterSubMarkScheme(
  existing?: string | null,
  incoming?: string | null,
  expectedMarks?: number
): string | undefined {
  const cleanExisting = (existing || '').trim();
  const cleanIncoming = (incoming || '').trim();
  if (!cleanExisting && !cleanIncoming) return undefined;
  if (!cleanExisting) return cleanIncoming;
  if (!cleanIncoming) return cleanExisting;

  const existingScore = scoreSubMarkSchemeCandidate(cleanExisting, expectedMarks);
  const incomingScore = scoreSubMarkSchemeCandidate(cleanIncoming, expectedMarks);
  return incomingScore > existingScore ? cleanIncoming : cleanExisting;
}

/**
 * Re-exported from markSchemePrompt so prompt builders can stay dependency-free.
 */
export { buildMarkSchemeStrictnessBlock } from './markSchemePrompt';
