/**
 * Cambridge mark-scheme preamble detection (pure — no pdfjs, no DOM).
 *
 * Published mark schemes open with generic marking principles followed by the real
 * answer tables. For science papers the answer tables always begin with a
 * "Question Answer Marks" header row, which survives even where the prose text
 * layer interleaves columns — verified on 24 practical mark schemes.
 *
 * Humanities mark schemes break that assumption: Sociology prints its generic
 * Levels of Response grids (Tables A–D) *before* the "Question Answer Marks"
 * header, and the answer tables then say "Use Table A to mark answers to this
 * question". Trimming to the header would delete the rubric the answer table
 * points at, so a rubric page found before the header wins (Plan/humanities.md).
 */

const HEADER_RE = /Question\s+Answer\s+Marks/i;
const PART_LABEL_RE = /\b\d\s*\(\s*[a-h]\s*\)/;
/** Sociology/Economics level grids: "Generic levels of response grids", "Table A – use this table…". */
const RUBRIC_GRID_RE = /Generic\s+levels\s+of\s+response(?:\s+grids)?|Table\s+[A-D]\s*[–—-]\s*use\s+this\s+table/i;
/** Generic Cambridge front-matter phrases proving preceded pages are boilerplate preamble. */
const CAMBRIDGE_PREAMBLE_RE =
  /generic\s+marking\s+principles|science-specific\s+marking|cambridge\s+(?:international|assessment)|mark\s+scheme\s+abbreviations|ucl?es/i;
/** Early answer content (e.g. "1. B  2. A" or answer-key headings) that must never be dropped. */
const EARLY_ANSWER_CONTENT_RE =
  /(?:^|\s)1\s*[.)]\s*[A-E]\b|\b(?:answer\s*key|kunci\s*jawaban|pedoman\s*penskoran)\b/i;

export interface TableStart {
  /** 1-based page where the retained content begins. 1 means "no trim". */
  startPage: number;
  method: 'header' | 'part-label' | 'rubric' | 'none';
  /** 1-based page holding the generic level/response grids, when the paper prints them. */
  rubricPage: number | null;
}

export function detectMarkSchemeTableStart(pageTexts: string[]): TableStart {
  const normalised = pageTexts.map((text) => text.replace(/\s+/g, ' '));

  const headerIndex = normalised.findIndex((text) => HEADER_RE.test(text));
  const rubricIndex = normalised.findIndex((text) => RUBRIC_GRID_RE.test(text));
  const rubricPage = rubricIndex >= 0 ? rubricIndex + 1 : null;

  // A rubric grid printed before the answer tables must be kept: the tables refer to it.
  if (rubricIndex >= 0 && (headerIndex < 0 || rubricIndex < headerIndex)) {
    return { startPage: rubricIndex + 1, method: 'rubric', rubricPage };
  }

  if (headerIndex >= 0) return { startPage: headerIndex + 1, method: 'header', rubricPage };

  // Fallback: the first page that prints an answer part label like "1(a)".
  // When trimming earlier pages (labelIndex > 0), verify those pages actually look like
  // Cambridge generic preamble and do NOT contain MCQ / answer-key content.
  const labelIndex = normalised.findIndex((text) => PART_LABEL_RE.test(text));
  if (labelIndex === 0) {
    return { startPage: 1, method: 'part-label', rubricPage };
  }
  if (labelIndex > 0) {
    const preceding = normalised.slice(0, labelIndex);
    const hasCambridgePreamble = preceding.some((t) => CAMBRIDGE_PREAMBLE_RE.test(t));
    const hasEarlyAnswers = preceding.some((t) => EARLY_ANSWER_CONTENT_RE.test(t));
    if (hasCambridgePreamble && !hasEarlyAnswers) {
      return { startPage: labelIndex + 1, method: 'part-label', rubricPage };
    }
  }

  return { startPage: 1, method: 'none', rubricPage };
}

/** Should the preamble be dropped? Never trim to an empty or implausible document. */
export function shouldTrimMarkScheme(start: TableStart, totalPages: number): boolean {
  if (start.method === 'none') return false;
  if (totalPages <= 1) return false;
  if (start.startPage <= 1) return false;
  if (start.startPage >= totalPages) return false;
  return true;
}

const STRONG_ANSWER_KEY_HEADING_RE =
  /\b(?:kunci\s*jawaban|kunci\s*dan\s*pembahasan|pembahasan\s*soal|pedoman\s*penskoran|rubrik\s*penilaian|answer\s*key|answer\s*scheme|marking\s*scheme|solutions\s*and\s*explanations|model\s*answers)\b/i;
const MARK_SCHEME_HEADING_RE = /\bmark\s*scheme(?:\s+for)?\b/i;
const PROSE_BEFORE_MS_RE =
  /\b(?:use|read|check|see|from|in|according\s+to|using|with|refer\s+to)\s+(?:the|a|this)?\s*$/i;

/**
 * Checks whether a single page's extracted text opens an embedded Answer Key / Mark Scheme section.
 * Inspects the top heading zone (and guards "mark scheme" against mid-sentence question prose).
 */
export function isAnswerKeyStartPageText(rawPageText: string): boolean {
  const headingZone = (rawPageText || '').replace(/\s+/g, ' ').trim().slice(0, 450);
  if (!headingZone) return false;
  if (STRONG_ANSWER_KEY_HEADING_RE.test(headingZone)) return true;

  const msZone = headingZone.slice(0, 350);
  const msMatch = MARK_SCHEME_HEADING_RE.exec(msZone);
  if (!msMatch) return false;

  const lookbehind = msZone.slice(Math.max(0, msMatch.index - 40), msMatch.index);
  return !PROSE_BEFORE_MS_RE.test(lookbehind);
}
