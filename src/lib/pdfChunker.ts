import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Configure pdf.js worker in browser
if (typeof window !== 'undefined' && pdfjsWorker) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;
}

export interface PdfChunk {
  chunkIndex: number;
  startPage: number; // 1-indexed
  endPage: number;   // 1-indexed
  pdfBase64: string;
  targetSection?: 'Easy' | 'Medium' | 'Hard';
  topicHint?: string;
  expectedCount?: number;
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
  if (fileOrBytes instanceof Uint8Array) {
    const freshBuf = fileOrBytes.buffer.slice(fileOrBytes.byteOffset, fileOrBytes.byteOffset + fileOrBytes.byteLength);
    return new Uint8Array(freshBuf);
  }
  if (fileOrBytes instanceof ArrayBuffer) return new Uint8Array(fileOrBytes.slice(0));
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
    const pdfJsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength) }).promise;
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
    const pdfJsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength) }).promise;
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

export interface SaveMyExamsSection {
  name: 'Easy' | 'Medium' | 'Hard';
  startPage: number;
  endPage: number;
  expectedCount?: number;
}

export interface SaveMyExamsMeta {
  isSaveMyExams: boolean;
  topic?: string;
  subTopics?: string;
  numPages: number;
  effectiveEndPage: number;
  easyExpected?: number;
  medExpected?: number;
  hardExpected?: number;
  totalExpected?: number;
  sections: SaveMyExamsSection[];
}

/**
 * Detects Save My Exams / PMA topic question structure:
 * - Cover page with Topic, Subtopics, and Difficulty Question Count breakdown
 * - Distinct sections: "Easy Questions", "Medium Questions", "Hard Questions"
 */
export async function detectSaveMyExamsMetadata(
  fileOrBytes: File | Uint8Array | ArrayBuffer
): Promise<SaveMyExamsMeta> {
  const rawBytes = await toUint8Array(fileOrBytes);
  const pdfJsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength) }).promise;
  const numPages = pdfJsDoc.numPages;

  if (numPages <= 1) {
    return { isSaveMyExams: false, numPages, effectiveEndPage: numPages, sections: [] };
  }

  // 1. Inspect Page 1 Cover
  const page1 = await pdfJsDoc.getPage(1);
  const textContent1 = await page1.getTextContent();
  const page1Text = textContent1.items.map((it: any) => it.str || '').join(' ');

  const isSaveMyExams =
    /save\s*my\s*exams/i.test(page1Text) ||
    /savemyexams\.com/i.test(page1Text) ||
    (/easy\s*\(\s*\d+\s*questions?\s*\)/i.test(page1Text) &&
      /medium\s*\(\s*\d+\s*questions?\s*\)/i.test(page1Text));

  if (!isSaveMyExams) {
    return { isSaveMyExams: false, numPages, effectiveEndPage: numPages, sections: [] };
  }

  // Extract Topic from Page 1
  let topic = '';
  let subTopics = '';
  const mcMatch = page1Text.match(
    /Multiple\s*Choice\s*Questions\s*(.*?)(?:Easy\s*\(|\/\s*\d+|\bCIE\b|\bIGCSE\b)/i
  );
  if (mcMatch && mcMatch[1]) {
    const rawTopic = mcMatch[1].trim();
    const parts = rawTopic
      .split(/\s{2,}|\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      topic = parts[0];
      if (parts.length > 1) subTopics = parts.slice(1).join(' / ');
    }
  }

  // Extract expected counts
  const easyCountMatch = page1Text.match(/Easy\s*\(\s*(\d+)\s*questions?\s*\)/i);
  const medCountMatch = page1Text.match(/Medium\s*\(\s*(\d+)\s*questions?\s*\)/i);
  const hardCountMatch = page1Text.match(/Hard\s*\(\s*(\d+)\s*questions?\s*\)/i);
  const totalCountMatch = page1Text.match(/(\d+)\s*questions/i);

  const easyExpected = easyCountMatch ? parseInt(easyCountMatch[1], 10) : undefined;
  const medExpected = medCountMatch ? parseInt(medCountMatch[1], 10) : undefined;
  const hardExpected = hardCountMatch ? parseInt(hardCountMatch[1], 10) : undefined;
  const totalExpected = totalCountMatch ? parseInt(totalCountMatch[1], 10) : undefined;

  // 2. Scan section start pages
  let easyStartPage = 2;
  let mediumStartPage: number | null = null;
  let hardStartPage: number | null = null;

  for (let p = 2; p <= numPages; p++) {
    const page = await pdfJsDoc.getPage(p);
    const content = await page.getTextContent();
    const txt = content.items.map((it: any) => it.str || '').join(' ');

    if (/easy\s+questions/i.test(txt) && !easyStartPage) {
      easyStartPage = p;
    } else if (/medium\s+questions/i.test(txt)) {
      mediumStartPage = p;
    } else if (/hard\s+questions/i.test(txt)) {
      hardStartPage = p;
    }
  }

  // Exclude trailing blank / copyright-only pages
  let effectiveEndPage = numPages;
  for (let p = numPages; p >= (hardStartPage || 2); p--) {
    const page = await pdfJsDoc.getPage(p);
    const content = await page.getTextContent();
    const txt = content.items.map((it: any) => it.str || '').join(' ');
    const hasQuestions =
      /\(\s*\d+\s*marks?\s*\)|\bquestions?\b|Extended Only|[A-D]\.\s+/i.test(txt);
    if (!hasQuestions && txt.length < 200) {
      effectiveEndPage = p - 1;
    } else {
      break;
    }
  }

  const sections: SaveMyExamsSection[] = [];
  if (mediumStartPage && hardStartPage) {
    sections.push({
      name: 'Easy',
      startPage: 1, // Include Page 1 cover with Easy so metadata is available
      endPage: mediumStartPage - 1,
      expectedCount: easyExpected,
    });
    sections.push({
      name: 'Medium',
      startPage: mediumStartPage,
      endPage: hardStartPage - 1,
      expectedCount: medExpected,
    });
    sections.push({
      name: 'Hard',
      startPage: hardStartPage,
      endPage: effectiveEndPage,
      expectedCount: hardExpected,
    });
  }

  return {
    isSaveMyExams: true,
    numPages,
    effectiveEndPage,
    topic: topic || 'Topic Questions',
    subTopics,
    easyExpected,
    medExpected,
    hardExpected,
    totalExpected,
    sections,
  };
}

/**
 * Checks if a PDF document is a Save My Exams / PMA topic assessment pack.
 */
export async function isSaveMyExamsDocument(
  fileOrBytes: File | Uint8Array | ArrayBuffer
): Promise<boolean> {
  try {
    const meta = await detectSaveMyExamsMetadata(fileOrBytes);
    return meta.isSaveMyExams && meta.sections.length > 0;
  } catch {
    return false;
  }
}

/**
 * Splits a Save My Exams / PMA PDF document strictly along section boundaries (Easy, Medium, Hard).
 * Each chunk maps 1-to-1 to a difficulty tier, preventing duplicate "Question 1" collisions across sections.
 */
export async function splitSaveMyExamsPdfBySections(
  fileOrBytes: File | Uint8Array | ArrayBuffer
): Promise<{ chunks: PdfChunk[]; meta: SaveMyExamsMeta }> {
  const rawBytes = await toUint8Array(fileOrBytes);
  const meta = await detectSaveMyExamsMetadata(rawBytes);

  if (!meta.isSaveMyExams || meta.sections.length === 0) {
    const fallbackChunks = await splitPdfForParallelExtraction(rawBytes);
    return { chunks: fallbackChunks, meta };
  }

  const doc = await PDFDocument.load(rawBytes);
  const chunks: PdfChunk[] = [];

  for (let idx = 0; idx < meta.sections.length; idx++) {
    const sec = meta.sections[idx];
    const chunkDoc = await PDFDocument.create();
    const count = sec.endPage - sec.startPage + 1;
    const pageIndices = Array.from({ length: count }, (_, i) => sec.startPage - 1 + i);
    const copiedPages = await chunkDoc.copyPages(doc, pageIndices);
    copiedPages.forEach((p) => chunkDoc.addPage(p));

    const chunkBytes = await chunkDoc.save();
    chunks.push({
      chunkIndex: idx,
      startPage: sec.startPage,
      endPage: sec.endPage,
      pdfBase64: uint8ArrayToBase64(chunkBytes),
      targetSection: sec.name,
      topicHint: meta.topic,
      expectedCount: sec.expectedCount,
    });
  }

  return { chunks, meta };
}
