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
