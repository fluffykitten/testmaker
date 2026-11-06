/**
 * Mark-scheme preamble trimming (browser/Node, uses pdfjs + pdf-lib).
 *
 * Sends only the pages that matter to the model instead of the generic marking
 * principles at the front, which are identical across papers and consume context.
 * See paper5update.md §Phase 4 and Plan/humanities.md §Step 2.
 */

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { PDFDocument } from 'pdf-lib';
import { detectMarkSchemeTableStart, shouldTrimMarkScheme } from './markSchemeDetect.ts';

let workerConfigured = false;
function ensureWorker() {
  if (!workerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;
    workerConfigured = true;
  }
}

export interface TrimmedMarkScheme {
  bytes: Uint8Array;
  startPage: number;
  totalPages: number;
  trimmed: boolean;
  method: 'header' | 'part-label' | 'rubric' | 'none';
  /** Page that prints the generic level/response grids, when present. */
  rubricPage?: number | null;
}

export interface TrimMarkSchemeOptions {
  /**
   * Humanities mark schemes print level/rubric grids that the answer tables refer to.
   * Only the proven "rubric" boundary is safe there; without it the full mark scheme
   * is sent, which is a few thousand tokens rather than a corrupted mark scheme.
   */
  domain?: 'stem' | 'humanities' | 'languages';
}

async function readPageTexts(bytes: Uint8Array): Promise<string[]> {
  ensureWorker();
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  try {
    const texts: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      texts.push(content.items.map((item) => (item as { str?: string }).str ?? '').join(' '));
      page.cleanup();
    }
    return texts;
  } finally {
    const disposable = doc as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
    if (typeof disposable.destroy === 'function') await disposable.destroy();
    else if (typeof disposable.cleanup === 'function') await disposable.cleanup();
  }
}

/** Drops the generic marking-principles pages that precede the content the model needs. */
export async function trimMarkSchemePreamble(
  bytes: Uint8Array,
  options: TrimMarkSchemeOptions = {}
): Promise<TrimmedMarkScheme> {
  const pageTexts = await readPageTexts(bytes);
  const totalPages = pageTexts.length;
  const start = detectMarkSchemeTableStart(pageTexts);
  const untrimmed: TrimmedMarkScheme = {
    bytes,
    startPage: start.startPage,
    totalPages,
    trimmed: false,
    method: start.method,
    rubricPage: start.rubricPage,
  };

  // Humanities: a header row proves nothing about the level grids printed above it.
  if (options.domain === 'humanities' && start.method !== 'rubric') return untrimmed;
  if (!shouldTrimMarkScheme(start, totalPages)) return untrimmed;

  const source = await PDFDocument.load(bytes);
  const target = await PDFDocument.create();
  const indices = Array.from({ length: totalPages - start.startPage + 1 }, (_, i) => start.startPage - 1 + i);
  const copied = await target.copyPages(source, indices);
  copied.forEach((page) => target.addPage(page));
  const trimmedBytes = await target.save();

  return {
    bytes: trimmedBytes,
    startPage: start.startPage,
    totalPages,
    trimmed: true,
    method: start.method,
    rubricPage: start.rubricPage,
  };
}
