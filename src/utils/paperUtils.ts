/**
 * Utility functions for formatting and displaying exam paper numbers, series, and badges.
 * Supports both Cambridge numeric papers (Paper 1, Paper 41) and Non-IGCSE alphanumeric
 * labels (Try Out TKA 1, Section A, Paket 01).
 */

export function formatPaperLabel(paperNumber?: string | number | null): string {
  if (paperNumber === undefined || paperNumber === null) return '';
  const str = String(paperNumber).trim();
  if (!str) return '';
  // If pure digits (e.g. "1", "41"), format as "Paper 1"
  if (/^\d+$/.test(str)) {
    return `Paper ${str}`;
  }
  // If it already contains text (e.g. "Try Out TKA 1", "Section A", "Paper 1")
  return str;
}

export function formatPaperBadge(
  paperNumber?: string | number | null,
  series?: string | null,
  year?: number | null
): string {
  const paperStr = formatPaperLabel(paperNumber);
  const seriesStr = series?.trim() || '';
  const yearStr = year ? String(year) : '';
  const sessionInfo = [seriesStr, yearStr].filter(Boolean).join(' ');

  if (paperStr && sessionInfo) {
    return `${paperStr} (${sessionInfo})`;
  }
  if (paperStr) return paperStr;
  if (sessionInfo) return sessionInfo;
  return 'Exam Question';
}
