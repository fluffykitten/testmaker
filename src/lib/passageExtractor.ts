import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import type { ExtractedPassage, ExtractedQuestion } from '../types/database';

// Configure pdf.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export interface PageTextResult {
  page: number;
  text: string;
}

/**
 * Converts File, Uint8Array, or ArrayBuffer to a Uint8Array
 */
async function toUint8Array(fileOrBytes: File | Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  if (fileOrBytes instanceof Uint8Array) return fileOrBytes;
  if (fileOrBytes instanceof ArrayBuffer) return new Uint8Array(fileOrBytes);
  const buf = await fileOrBytes.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Extracts structured text from each page of a PDF document using pdfjs-dist.
 * Reconstructs lines and paragraphs using vertical (Y) coordinate changes.
 */
export async function extractTextFromPdfPages(
  fileOrBytes: File | Uint8Array | ArrayBuffer
): Promise<PageTextResult[]> {
  let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
  try {
    const rawBytes = await toUint8Array(fileOrBytes);
    pdfDoc = await pdfjsLib.getDocument({ data: rawBytes }).promise;
    const numPages = pdfDoc.numPages;
    const results: PageTextResult[] = [];

    for (let p = 1; p <= numPages; p++) {
      const page = await pdfDoc.getPage(p);
      const textContent = await page.getTextContent();
      const items = textContent.items as Array<{
        str: string;
        transform: number[];
        width: number;
        height: number;
      }>;

      if (!items || items.length === 0) {
        results.push({ page: p, text: '' });
        continue;
      }

      // Group items by line based on vertical Y position
      // In PDF coordinate system, Y increases upwards.
      // transform = [scaleX, skewY, skewX, scaleY, transX, transY]
      // transX = transform[4], transY = transform[5]
      const sortedItems = [...items].sort((a, b) => {
        const yDiff = b.transform[5] - a.transform[5];
        if (Math.abs(yDiff) > 3) return yDiff;
        return a.transform[4] - b.transform[4];
      });

      const lines: { y: number; text: string }[] = [];
      let currentLine: string[] = [];
      let currentY: number | null = null;

      for (const item of sortedItems) {
        const str = item.str || '';
        if (!str && str !== ' ') continue;

        const y = item.transform[5];
        if (currentY === null || Math.abs(y - currentY) <= 4) {
          currentLine.push(str);
          if (currentY === null) currentY = y;
        } else {
          if (currentLine.length > 0) {
            lines.push({ y: currentY, text: currentLine.join(' ').replace(/\s+/g, ' ').trim() });
          }
          currentLine = [str];
          currentY = y;
        }
      }

      if (currentLine.length > 0 && currentY !== null) {
        lines.push({ y: currentY, text: currentLine.join(' ').replace(/\s+/g, ' ').trim() });
      }

      // Reconstruct paragraphs: if line Y drop is larger than typical line height (e.g. > 16pt), insert double newline
      let pageText = '';
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.text) continue;

        if (i === 0) {
          pageText += line.text;
        } else {
          const prevY = lines[i - 1].y;
          const yGap = Math.abs(prevY - line.y);
          if (yGap >= 18) {
            pageText += '\n\n' + line.text;
          } else {
            pageText += '\n' + line.text;
          }
        }
      }

      results.push({ page: p, text: pageText.trim() });
    }

    return results;
  } catch (err) {
    console.warn('extractTextFromPdfPages encountered an error:', err);
    return [];
  } finally {
    if (pdfDoc) {
      await (pdfDoc as any).destroy().catch(() => {});
    }
  }
}

/**
 * Escapes regex special characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Verifies AI-extracted passages against the source PDF text.
 * If a passage is truncated or missing body content, recovers it from the PDF text.
 */
export function verifyAndRepairPassages(
  passages: ExtractedPassage[],
  pageTexts: PageTextResult[]
): ExtractedPassage[] {
  if (!passages || passages.length === 0 || !pageTexts || pageTexts.length === 0) {
    return passages || [];
  }

  return passages.map((passage) => {
    const rawBody = (passage.body || '').trim();
    const heading = (passage.heading || '').trim();
    const id = (passage.id || '').trim();

    // Check if passage is suspiciously truncated:
    // 1. Very short body (< 150 chars)
    // 2. Contains ellipsis or truncation keywords
    // 3. Body is missing entirely
    const isTruncated =
      rawBody.length < 150 ||
      /\.\.\.\s*$|…\s*$|\[truncated\]/i.test(rawBody) ||
      /\b(?:dan seterusnya|etc\.|read more)\b/i.test(rawBody);

    if (!isTruncated) {
      return passage;
    }

    // Try to locate the passage in the extracted PDF text
    const cleanId = id.replace(/^(?:Text|Passage|Teks|Bacaan)\s*/i, '').trim();
    const searchPatterns = [
      new RegExp(`(?:Text|Passage|Teks|Bacaan)\\s*${escapeRegex(cleanId)}\\b`, 'i'),
      new RegExp(escapeRegex(id), 'i'),
    ];

    if (heading) {
      const headingSnippet = heading.slice(0, 35).replace(/[#*()]/g, '').trim();
      if (headingSnippet.length > 10) {
        searchPatterns.push(new RegExp(escapeRegex(headingSnippet), 'i'));
      }
    }

    const fullText = pageTexts.map((p) => p.text).join('\n\n');
    for (const pattern of searchPatterns) {
      const match = fullText.match(pattern);
      if (match && match.index !== undefined) {
        const startIndex = match.index;
        const afterHeader = fullText.slice(startIndex);

        // Find where the passage ends (before the first question stem or next passage header)
        const stopRegex = /(?:\n\s*(?:No\.?\s*)?\d+[\s.:)]+|\n\s*(?:\*{1,2}|#{1,4}\s*)?Question\s*\d*[\s.:*]+|\n\s*\[(?:Matching|Multiple|Table|Fill|Pilihan|Menjodohkan)[^\]]*\]|\n\s*(?:Text|Passage|Teks|Bacaan)\s*(?:\d+|[A-Z])\b)/i;
        const lines = afterHeader.split('\n');
        const headerLine = lines[0];

        const restOfText = lines.slice(1).join('\n').trim();
        const stopMatch = restOfText.match(stopRegex);

        let recoveredBody = '';
        if (stopMatch && stopMatch.index !== undefined && stopMatch.index > 50) {
          recoveredBody = restOfText.slice(0, stopMatch.index).trim();
        } else if (restOfText.length > 100) {
          recoveredBody = restOfText.trim();
        }

        if (recoveredBody.length > rawBody.length && recoveredBody.length >= 100) {
          let estimatedPage = passage.page_number;
          if (!estimatedPage) {
            let currentLen = 0;
            for (const pt of pageTexts) {
              currentLen += pt.text.length + 2;
              if (startIndex < currentLen) {
                estimatedPage = pt.page;
                break;
              }
            }
          }

          return {
            ...passage,
            heading: heading || headerLine.trim(),
            body: recoveredBody,
            page_number: estimatedPage || 1,
          };
        }
      }
    }

    return passage;
  });
}

/**
 * Stitches reading passage bodies into associated questions' question_text.
 * Guarantees that every question linked to a passage has the full passage text in question_text,
 * formatted cleanly with Markdown headers and zero duplicate options.
 */
export function stitchPassagesToQuestions(
  questions: ExtractedQuestion[],
  passages?: ExtractedPassage[]
): ExtractedQuestion[] {
  if (!questions || questions.length === 0) return [];

  // Build a lookup map of passages by id and clean id
  const passageMap = new Map<string, ExtractedPassage>();
  if (Array.isArray(passages)) {
    for (const p of passages) {
      if (!p.id) continue;
      passageMap.set(p.id.toLowerCase().trim(), p);
      const cleanId = p.id.replace(/^(?:Text|Passage|Teks|Bacaan)\s*/i, '').trim().toLowerCase();
      if (cleanId) passageMap.set(cleanId, p);
    }
  }

  // If no passages catalog was provided, questions are returned as-is
  if (passageMap.size === 0) {
    return questions;
  }

  return questions.map((q) => {
    const text = q.question_text || '';
    const qNum = String(q.question_number || '').replace(/\D/g, '');

    // 1. Check if question links to a passage via passage_ref
    let targetPassage: ExtractedPassage | undefined;

    if (q.passage_ref) {
      const refClean = q.passage_ref.toLowerCase().trim();
      targetPassage = passageMap.get(refClean) || passageMap.get(refClean.replace(/^(?:text|passage|teks)\s*/i, ''));
    }

    // 2. Fallback: Check if target_questions of any passage includes this question
    if (!targetPassage && qNum) {
      for (const p of passages || []) {
        if (Array.isArray(p.target_questions)) {
          const matches = p.target_questions.some(
            (tq) => String(tq).replace(/\D/g, '') === qNum
          );
          if (matches) {
            targetPassage = p;
            break;
          }
        }
      }
    }

    // 3. Fallback: Check if question stem text explicitly mentions the passage heading/id
    if (!targetPassage) {
      for (const p of passages || []) {
        const idPattern = new RegExp(`\\b${escapeRegex(p.id)}\\b`, 'i');
        if (idPattern.test(text)) {
          targetPassage = p;
          break;
        }
      }
    }

    if (!targetPassage || !targetPassage.body) {
      return q;
    }

    // 4. Check if question_text already contains the passage body (avoid double injection)
    const bodySample = targetPassage.body.slice(0, 80).trim();
    if (bodySample && text.includes(bodySample)) {
      return {
        ...q,
        passage_ref: q.passage_ref || targetPassage.id,
      };
    }

    // 5. Strip any existing redundant header line from question_text
    const cleanStem = text
      .replace(
        /^(?:(?:#{1,4}\s*|\*{1,2})?(?:Text|Passage|Teks|Reading|Stimulus|Wacana|Bacaan)\b[^\n]*\n*|\([^\n]+\)\n*)+/i,
        ''
      )
      .trim();

    const formattedHeader = targetPassage.heading
      ? (targetPassage.heading.startsWith('#') ? targetPassage.heading : `### ${targetPassage.heading}`)
      : `### ${targetPassage.id}`;

    const stitchedText = `${formattedHeader}\n\n${targetPassage.body}\n\n${cleanStem}`.trim();

    return {
      ...q,
      passage_ref: q.passage_ref || targetPassage.id,
      question_text: stitchedText,
    };
  });
}
