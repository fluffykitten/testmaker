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
 * Inspects a PDF file or bytes in memory. If it exceeds 6 pages (e.g. 16-page paper with 40 questions),
 * splits it into 2 (or 3) balanced chunks so that Gemini can process all pages concurrently in parallel.
 * This prevents single-call token exhaustion and accelerates extraction.
 */
export async function splitPdfForParallelExtraction(
  fileOrBytes: File | Uint8Array | ArrayBuffer,
  maxPagesPerChunk: number = 8
): Promise<PdfChunk[]> {
  try {
    const rawBytes = await toUint8Array(fileOrBytes);
    const doc = await PDFDocument.load(rawBytes);
    const totalPages = doc.getPageCount();

    // If PDF is 3 pages or fewer (single section or short worksheet), process in a single pass
    if (totalPages <= 3) {
      return [
        {
          chunkIndex: 0,
          startPage: 1,
          endPage: totalPages,
          pdfBase64: uint8ArrayToBase64(rawBytes),
        },
      ];
    }

    // Determine number of chunks (50:50 2-chunk split for 4-18 pages, 3 chunks for 19+ pages)
    const numChunks = totalPages <= 18 ? 2 : Math.min(3, Math.ceil(totalPages / maxPagesPerChunk));
    const pagesPerChunk = Math.ceil(totalPages / numChunks);

    const chunks: PdfChunk[] = [];

    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      const rawStart = chunkIdx * pagesPerChunk;
      // 2-page safety overlap for chunks after the first, so reading passages and straddling questions are never severed
      const startIdx = chunkIdx > 0 ? Math.max(0, rawStart - 2) : rawStart;
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
