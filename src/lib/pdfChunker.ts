import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Configure pdf.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export interface PdfChunk {
  chunkIndex: number;
  startPage: number; // 1-indexed
  endPage: number;   // 1-indexed
  pdfBase64: string;
}

export interface InDocumentAnswerKeySplit {
  hasAnswerKey: boolean;
  qpDocBytes: Uint8Array;
  msBase64?: string;
  qpStartPage: number;
  qpEndPage: number;
  msStartPage?: number;
  msEndPage?: number;
}

/**
 * Converts a Uint8Array to a standard base64 string
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts a File, Uint8Array, or ArrayBuffer to a Uint8Array
 */
async function toUint8Array(fileOrBytes: File | Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  if (fileOrBytes instanceof Uint8Array) return fileOrBytes;
  if (fileOrBytes instanceof ArrayBuffer) return new Uint8Array(fileOrBytes);
  const buf = await fileOrBytes.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Inspects a PDF file to detect if it contains an embedded Answer Key / Kunci Jawaban / Pembahasan
 * at the back of the document (e.g. pages 18–23 in a 23-page exam).
 * If detected, splits the document into Question Paper bytes and Mark Scheme base64.
 */
export async function detectAndSplitInDocumentAnswerKey(
  fileOrBytes: File | Uint8Array | ArrayBuffer
): Promise<InDocumentAnswerKeySplit> {
  try {
    const rawBytes = await toUint8Array(fileOrBytes);
    const pdfJsDoc = await pdfjsLib.getDocument({ data: rawBytes }).promise;
    const totalPages = pdfJsDoc.numPages;

    if (totalPages <= 2) {
      return {
        hasAnswerKey: false,
        qpDocBytes: rawBytes,
        qpStartPage: 1,
        qpEndPage: totalPages,
      };
    }

    // Scan pages starting from ~35% into document to find the first answer key header page
    const scanStart = Math.max(2, Math.floor(totalPages * 0.35));
    let answerKeyStartPage: number | null = null;

    for (let p = scanStart; p <= totalPages; p++) {
      const page = await pdfJsDoc.getPage(p);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item: any) => item.str || '')
        .join(' ')
        .toLowerCase();

      // Look for answer key / mark scheme headers
      const isAnswerKeyHeader =
        /kunci\s*jawaban|pembahasan\s*soal|answer\s*key|marking\s*scheme|mark\s*scheme\s*for|solutions\s*and\s*explanations|kunci\s*dan\s*pembahasan/i.test(
          text
        );

      if (isAnswerKeyHeader) {
        answerKeyStartPage = p;
        break;
      }
    }

    if (answerKeyStartPage && answerKeyStartPage > 1) {
      const doc = await PDFDocument.load(rawBytes);

      // Question Paper: pages 1 to answerKeyStartPage - 1
      const qpDoc = await PDFDocument.create();
      const qpIndices = Array.from({ length: answerKeyStartPage - 1 }, (_, i) => i);
      const copiedQp = await qpDoc.copyPages(doc, qpIndices);
      copiedQp.forEach((page) => qpDoc.addPage(page));
      const qpDocBytes = await qpDoc.save();

      // Mark Scheme: pages answerKeyStartPage to totalPages
      const msDoc = await PDFDocument.create();
      const msIndices = Array.from(
        { length: totalPages - answerKeyStartPage + 1 },
        (_, i) => answerKeyStartPage - 1 + i
      );
      const copiedMs = await msDoc.copyPages(doc, msIndices);
      copiedMs.forEach((page) => msDoc.addPage(page));
      const msDocBytes = await msDoc.save();
      const msBase64 = uint8ArrayToBase64(msDocBytes);

      return {
        hasAnswerKey: true,
        qpDocBytes,
        msBase64,
        qpStartPage: 1,
        qpEndPage: answerKeyStartPage - 1,
        msStartPage: answerKeyStartPage,
        msEndPage: totalPages,
      };
    }

    return {
      hasAnswerKey: false,
      qpDocBytes: rawBytes,
      qpStartPage: 1,
      qpEndPage: totalPages,
    };
  } catch (err) {
    console.warn('In-document answer key detection error, treating as single document:', err);
    const fallbackBuffer =
      fileOrBytes instanceof ArrayBuffer
        ? fileOrBytes
        : fileOrBytes instanceof Uint8Array
        ? fileOrBytes.buffer
        : await fileOrBytes.arrayBuffer();
    const rawBytes = new Uint8Array(fallbackBuffer);
    return {
      hasAnswerKey: false,
      qpDocBytes: rawBytes,
      qpStartPage: 1,
      qpEndPage: 1,
    };
  }
}

/**
 * Scans backwards from the end of the PDF to find the last page that actually contains exam questions.
 * Automatically excludes trailing non-question pages such as:
 * - "BLANK PAGE"
 * - "The Periodic Table of Elements"
 * - "Notes for use in qualitative analysis" ("Tests for anions", "Tests for aqueous cations", "Tests for gases", "Flame tests for metal ions")
 * - Pure copyright / permission acknowledgement pages with no question marks
 *
 * Because only trailing pages at the back of the PDF are trimmed, pages 1..effectiveTotalPages
 * preserve their exact 1-based original PDF page numbers for diagram cropping!
 */
async function detectEffectiveQuestionPageCount(rawBytes: Uint8Array, fallbackTotal: number): Promise<number> {
  if (fallbackTotal <= 2) return fallbackTotal;
  try {
    const pdfJsDoc = await pdfjsLib.getDocument({ data: rawBytes.slice(0) }).promise;
    let effectiveEnd = pdfJsDoc.numPages;

    for (let p = pdfJsDoc.numPages; p >= 2; p--) {
      const page = await pdfJsDoc.getPage(p);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item: any) => item.str || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      const isBlankPage = /\bBLANK\s+PAGE\b/i.test(text) && !/\[\s*\d+\s*\]/.test(text);
      const isPeriodicTable = /\bThe\s+Periodic\s+Table\s+of\s+Elements\b/i.test(text);
      const isQualAnalysisNotes =
        /\bNotes\s+for\s+use\s+in\s+qualitative\s+analysis\b/i.test(text) ||
        (/\bTests\s+for\s+anions\b/i.test(text) && /\bTests\s+for\s+aqueous\s+cations\b/i.test(text)) ||
        (/\bTests\s+for\s+gases\b/i.test(text) && /\bFlame\s+tests\s+for\s+metal\s+ions\b/i.test(text) && !/\[\s*\d+\s*\]/.test(text));
      const isAdditionalBlank = /\bAdditional\s+Page\b/i.test(text) && !/\[\s*\d+\s*\]/.test(text);

      if (isBlankPage || isPeriodicTable || isQualAnalysisNotes || isAdditionalBlank) {
        effectiveEnd = p - 1;
      } else {
        // Reached the last actual question page
        break;
      }
    }

    return Math.max(1, effectiveEnd);
  } catch {
    return fallbackTotal;
  }
}

/**
 * Inspects a PDF file or bytes in memory. If it exceeds 6 pages (e.g. 16-page paper with 40 questions),
 * trims trailing non-question reference/blank pages and splits the active question pages into
 * balanced chunks so that Gemini can process all pages concurrently in parallel.
 * This prevents single-call token exhaustion, avoids hallucinating questions from reference appendices,
 * and accelerates extraction.
 */
export async function splitPdfForParallelExtraction(
  fileOrBytes: File | Uint8Array | ArrayBuffer,
  maxPagesPerChunk: number = 8
): Promise<PdfChunk[]> {
  try {
    const rawBytes = await toUint8Array(fileOrBytes);
    const doc = await PDFDocument.load(rawBytes);
    const rawTotalPages = doc.getPageCount();
    const totalPages = await detectEffectiveQuestionPageCount(rawBytes, rawTotalPages);

    // If active question pages are 4 or fewer, process in a single pass
    if (totalPages <= 4) {
      if (totalPages === rawTotalPages) {
        return [
          {
            chunkIndex: 0,
            startPage: 1,
            endPage: totalPages,
            pdfBase64: uint8ArrayToBase64(rawBytes),
          },
        ];
      }
      const trimmedDoc = await PDFDocument.create();
      const indices = Array.from({ length: totalPages }, (_, i) => i);
      const copied = await trimmedDoc.copyPages(doc, indices);
      copied.forEach((p) => trimmedDoc.addPage(p));
      const trimmedBytes = await trimmedDoc.save();
      return [
        {
          chunkIndex: 0,
          startPage: 1,
          endPage: totalPages,
          pdfBase64: uint8ArrayToBase64(trimmedBytes),
        },
      ];
    }

    // Determine number of chunks (balanced distribution):
    // 1-4 pages: single chunk
    // 5-12 pages (e.g. Paper 5 [9 active pages] or Paper 4 [12 active pages]): 2 chunks (~5-6 pages each)
    // 13-24 pages (e.g. 40-question Paper 2 [15 active pages]): 3 chunks (~5 pages each)
    // 25+ pages: up to 4 chunks
    const numChunks =
      totalPages <= 4 ? 1 :
      totalPages <= 12 ? 2 :
      totalPages <= 24 ? 3 :
      Math.min(4, Math.ceil(totalPages / maxPagesPerChunk));

    const pagesPerChunk = Math.ceil(totalPages / numChunks);
    // Overlap for straddling questions (e.g. 2-3 page structured physics/chemistry/practical questions):
    // Use 3-page overlap for 9+ page papers so 3-page questions (like Paper 5 Q1 or Paper 4 Q2) are never severed across chunks.
    const overlapPages = totalPages >= 9 ? 3 : 2;

    const chunks: PdfChunk[] = [];

    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      const rawStart = chunkIdx * pagesPerChunk;
      // Safety overlap for chunks after the first so multi-page structured questions and reading passages are never severed
      const startIdx = chunkIdx > 0 ? Math.max(0, rawStart - overlapPages) : rawStart;
      const endIdx = Math.min(rawStart + pagesPerChunk, totalPages);

      if (startIdx >= totalPages) break;

      const chunkDoc = await PDFDocument.create();
      const pageIndices = Array.from({ length: endIdx - startIdx }, (_, i) => startIdx + i);
      const copiedPages = await chunkDoc.copyPages(doc, pageIndices);
      copiedPages.forEach((p) => chunkDoc.addPage(p));

      const chunkBytes = await chunkDoc.save();
      chunks.push({
        chunkIndex: chunkIdx,
        startPage: startIdx + 1,
        endPage: endIdx,
        pdfBase64: uint8ArrayToBase64(chunkBytes),
      });
    }

    return chunks;
  } catch (err) {
    console.warn('PDF splitting encountered an error, falling back to single chunk:', err);
    try {
      const rawBytes = await toUint8Array(fileOrBytes);
      return [
        {
          chunkIndex: 0,
          startPage: 1,
          endPage: 1,
          pdfBase64: uint8ArrayToBase64(rawBytes),
        },
      ];
    } catch {
      return [];
    }
  }
}
