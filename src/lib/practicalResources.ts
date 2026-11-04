/**
 * Reference-page resources for practical papers.
 *
 * Pages 11–12 of every 0620/5x paper carry the qualitative-analysis notes
 * (anions, aqueous cations, gases, flame tests). They are reference material,
 * not questions, so the outline classifies them and this module turns them into
 * Resource Booklet items the exam runner can open from Question 2.
 *
 * The catalogue is built purely from the outline (testable in Node); the page
 * images are filled in by `renderNotePagesToDataUrls`, which needs a browser.
 */

import type { InsertResourceItem } from '../types/database';
import type { PaperOutline } from './paperOutlineParse';

const FALLBACK_TITLES = [
  'Notes for use in qualitative analysis — tests for anions and aqueous cations',
  'Notes for use in qualitative analysis — tests for gases and flame tests',
];

/** Metadata-only resources for the qualitative-analysis notes pages. */
export function buildQualitativeNotesResources(outline: PaperOutline): InsertResourceItem[] {
  const notes = outline.pages.filter((page) => page.kind === 'notes');
  return notes.map((page, index) => ({
    id: `qualitative-notes-${index + 1}`,
    title: (page.title ?? '').trim() || FALLBACK_TITLES[index] || `Notes for use in qualitative analysis (page ${page.index})`,
    page_number: page.index,
    diagram_url: null,
    text_content: null,
    target_questions: ['2'],
  }));
}

/**
 * Renders each notes page to a data URL and attaches it. Browser-only.
 * Failures are swallowed per page: a missing image must never fail an extraction.
 */
export async function renderNotePagesToDataUrls(
  pdfBytes: Uint8Array,
  resources: InsertResourceItem[],
  renderPage: (bytes: Uint8Array, pageNumber: number) => Promise<HTMLCanvasElement>,
): Promise<InsertResourceItem[]> {
  const out: InsertResourceItem[] = [];
  for (const resource of resources) {
    try {
      const canvas = await renderPage(pdfBytes, resource.page_number);
      const diagram_url = canvas.toDataURL('image/webp', 0.82);
      out.push({ ...resource, diagram_url });
    } catch (error) {
      console.warn(`[practicalResources] could not render notes page ${resource.page_number}:`, error);
      out.push(resource);
    }
  }
  return out;
}
