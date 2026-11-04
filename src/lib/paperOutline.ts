/**
 * Deterministic Paper Outline — browser/PDF entry point.
 *
 * Extracts positioned glyph runs with pdfjs and hands them to the pure parser in
 * `paperOutlineParse.ts`. Cheap (no API cost, ~100–300 ms for a 12-page paper)
 * and safe to run before every extraction.
 */

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { parseOutline } from './paperOutlineParse';
import type { OutlineHint, PaperOutline, RawPage } from './paperOutlineParse';

let workerConfigured = false;
function ensureWorker() {
  if (!workerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;
    workerConfigured = true;
  }
}

/** Read the text layer of every page as positioned runs. */
export async function readPdfTextLayout(bytes: Uint8Array): Promise<RawPage[]> {
  ensureWorker();
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  try {
    const pages: RawPage[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items
        .map((item) => {
          const glyph = item as { str?: string; transform?: number[]; width?: number; height?: number };
          const transform = glyph.transform ?? [1, 0, 0, 1, 0, 0];
          return {
            s: glyph.str ?? '',
            x: Math.round(transform[4]),
            y: Math.round(transform[5]),
            w: Math.round(glyph.width ?? 0),
            h: Math.round(glyph.height ?? 0),
          };
        })
        .filter((item) => item.s.trim() !== '');
      pages.push({
        page: pageNumber,
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
        items,
      });
      page.cleanup();
    }
    return pages;
  } finally {
    const disposable = doc as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
    if (typeof disposable.destroy === 'function') await disposable.destroy();
    else if (typeof disposable.cleanup === 'function') await disposable.cleanup();
  }
}

export async function buildPaperOutline(bytes: Uint8Array, hint?: OutlineHint): Promise<PaperOutline> {
  const pages = await readPdfTextLayout(bytes);
  return parseOutline(pages, hint);
}

/** Never throws: an unreadable PDF simply yields null and the caller keeps the vision path. */
export async function tryBuildPaperOutline(bytes: Uint8Array, hint?: OutlineHint): Promise<PaperOutline | null> {
  try {
    return await buildPaperOutline(bytes, hint);
  } catch (error) {
    console.warn('[paperOutline] outline unavailable, falling back to vision extraction:', error);
    return null;
  }
}
