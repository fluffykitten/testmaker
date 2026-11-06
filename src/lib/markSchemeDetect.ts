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
  const labelIndex = normalised.findIndex((text) => PART_LABEL_RE.test(text));
  if (labelIndex >= 0) return { startPage: labelIndex + 1, method: 'part-label', rubricPage };

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
