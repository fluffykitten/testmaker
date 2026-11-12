/**
 * Does this text already carry a printed table as Markdown?
 *
 * A question can hold the same table twice — once as a Markdown block inside
 * "question_text" (the printed text) and once as a structured "data_tables"
 * entry (for grading and export). Renderers must show exactly one of them, so
 * they ask this before falling back to `data_tables`.
 *
 * The predicate is deliberately identical to the one the PDF exporter has always
 * used: a pipe somewhere plus a row that starts a line with a pipe.
 */
export function hasMarkdownTable(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.includes('|') && text.includes('\n|');
}

/**
 * Removes contiguous Markdown pipe-table blocks when an interactive structured
 * `<ExamDataTable>` replaces the static printed table in the exam runner.
 */
export function stripMarkdownTables(text: string | null | undefined): string {
  if (!text || !hasMarkdownTable(text)) return text || '';
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const isPipeRow = trimmed.startsWith('|') && (trimmed.match(/\|/g) || []).length >= 2;
    if (isPipeRow) continue;
    kept.push(lines[i]);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
