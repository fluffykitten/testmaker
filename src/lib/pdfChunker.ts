import { PDFDocument } from 'pdf-lib';

export interface PdfChunk {
  chunkIndex: number;
  startPage: number; // 1-indexed
  endPage: number;   // 1-indexed
  pdfBase64: string;
}

/**
 * Converts a Uint8Array to a standard base64 string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Inspects a PDF file in memory. If it exceeds 6 pages (e.g. 16-page paper with 40 questions),
 * splits it into 2 (or 3) balanced chunks so that Gemini can process all pages concurrently in parallel.
 * This prevents single-call token exhaustion (which caused papers to truncate at question 22)
 * and accelerates extraction from 2 minutes down to ~10-15 seconds.
 */
export async function splitPdfForParallelExtraction(
  file: File,
  maxPagesPerChunk: number = 8
): Promise<PdfChunk[]> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const doc = await PDFDocument.load(arrayBuffer);
    const totalPages = doc.getPageCount();

    // If PDF is 3 pages or fewer (single section or short worksheet), process in a single pass
    if (totalPages <= 3) {
      const uint8 = new Uint8Array(arrayBuffer);
      return [
        {
          chunkIndex: 0,
          startPage: 1,
          endPage: totalPages,
          pdfBase64: uint8ArrayToBase64(uint8),
        },
      ];
    }

    // Determine number of chunks (50:50 2-chunk split for 4-18 pages, 3 chunks for 19+ pages)
    const numChunks = totalPages <= 18 ? 2 : Math.min(3, Math.ceil(totalPages / maxPagesPerChunk));
    const pagesPerChunk = Math.ceil(totalPages / numChunks);

    const chunks: PdfChunk[] = [];

    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      const rawStart = chunkIdx * pagesPerChunk;
      // 1-page safety overlap for chunks after the first, so questions straddling across page breaks are never severed
      const startIdx = chunkIdx > 0 ? Math.max(0, rawStart - 1) : rawStart;
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
    // Fallback: Return original full base64
    const buffer = await file.arrayBuffer();
    return [
      {
        chunkIndex: 0,
        startPage: 1,
        endPage: 1,
        pdfBase64: uint8ArrayToBase64(new Uint8Array(buffer)),
      },
    ];
  }
}
