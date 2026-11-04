/**
 * Cambridge mark-scheme preamble detection (pure — no pdfjs, no DOM).
 *
 * Published mark schemes open with 4–6 pages of generic marking principles,
 * science-specific guidance and list-rule examples, followed by the real answer
 * tables. The answer tables always begin with a "Question Answer Marks" header
 * row, which survives even where the prose text layer interleaves columns.
 *
 * Verified on 24 practical mark schemes: the detected page is exactly the first
 * page containing an answer part label, and no answer content precedes it.
 */

const HEADER_RE = /Question\s+Answer\s+Marks/i;
const PART_LABEL_RE = /\b\d\s*\(\s*[a-h]\s*\)/;

export interface TableStart {
  /** 1-based page where the answer tables begin. 1 means "no trim". */
  startPage: number;
  method: 'header' | 'part-label' | 'none';
}

export function detectMarkSchemeTableStart(pageTexts: string[]): TableStart {
  const normalised = pageTexts.map((text) => text.replace(/\s+/g, ' '));

  const headerIndex = normalised.findIndex((text) => HEADER_RE.test(text));
  if (headerIndex >= 0) return { startPage: headerIndex + 1, method: 'header' };

  // Fallback: the first page that prints an answer part label like "1(a)".
  const labelIndex = normalised.findIndex((text) => PART_LABEL_RE.test(text));
  if (labelIndex >= 0) return { startPage: labelIndex + 1, method: 'part-label' };

  return { startPage: 1, method: 'none' };
}

/** Should the preamble be dropped? Never trim to an empty or implausible document. */
export function shouldTrimMarkScheme(start: TableStart, totalPages: number): boolean {
  if (start.method === 'none') return false;
  if (totalPages <= 1) return false;
  if (start.startPage <= 1) return false;
  if (start.startPage >= totalPages) return false;
  return true;
}
