/**
 * Mark-scheme preamble trimming (browser/Node, uses pdfjs + pdf-lib).
 *
 * Sends only the answer-table pages to the model instead of the 4–6 pages of
 * generic marking principles, which are identical across papers and consume
 * context without adding information. See paper5update.md §Phase 4.
 */

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { PDFDocument } from 'pdf-lib';
import { detectMarkSchemeTableStart, shouldTrimMarkScheme } from './markSchemeDetect';

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
  method: 'header' | 'part-label' | 'none';
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

/** Drops the generic marking-principles pages that precede the answer tables. */
export async function trimMarkSchemePreamble(bytes: Uint8Array): Promise<TrimmedMarkScheme> {
  const pageTexts = await readPageTexts(bytes);
  const totalPages = pageTexts.length;
  const start = detectMarkSchemeTableStart(pageTexts);

  if (!shouldTrimMarkScheme(start, totalPages)) {
    return { bytes, startPage: start.startPage, totalPages, trimmed: false, method: start.method };
  }

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
  };
}
