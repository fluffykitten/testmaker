// ─── Word Document (.docx) Export Service ────────────────────────────────────
// Generates professional, publication-quality Microsoft Word (.docx) exam papers,
// answer booklets, and teacher mark schemes using the `docx` library.

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  HeadingLevel,
  Header,
  Footer,
  PageNumber,
  TabStopType,
  TabStopPosition,
  LeaderType,
  UnderlineType,
  TableLayoutType,
  HeightRule,
} from 'docx';
import {
  fitImageDimensions,
  prepareDocxImageBytes,
  type LoadedImageData,
} from '../utils/docxImageUtils';
import {
  parseFormattedTextToDocxChildren,
  normalizeCommonLatexForDocx,
  type DocxRunStyleOpts,
  type DocxInlineChild,
} from '../utils/docxMathUtils';
import { exportFileUniversal } from './fileExportBridge';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';
import type { ExportLayoutOptions } from '../types/exportTemplates';
import { getCambridgeCoverDetails } from './cambridgeCoverService';
import { DEFAULT_SCHOOL_LOGO, DEFAULT_CAMBRIDGE_LOGO } from '../assets/logoConstants';
import { isInsertResource, resolveQuestionResources } from '../utils/questionResourceHelper';
import {
  resolveOptionDiagramUrl,
  resolveQuestionImageUrlsExcludingStandaloneSvg,
  stripInlineMarkdownImage,
} from '../utils/questionDiagramUtils';
import { parseMcqOption } from '../utils/mcqUtils';
import { stripPassageControlTags, parseInstructionLines } from '../lib/readingPassageUtils';
import {
  stripDuplicateOptionsFromStem,
  stripDuplicateSubQuestionsFromStem,
} from '../lib/gemini';

export interface DocxExportOptions extends Partial<ExportLayoutOptions> {
  includeMarkSchemeInStudentPaper?: boolean;
}

/**
 * Decode a data URI or fetch a remote URL and convert/measure it into a valid
 * PNG/JPEG byte buffer with true natural pixel dimensions for Word/OOXML.
 */
async function loadImageData(urlOrBase64: string): Promise<LoadedImageData | null> {
  try {
    if (!urlOrBase64) return null;

    let rawBytes: Uint8Array | null = null;
    if (urlOrBase64.startsWith('data:')) {
      const commaIdx = urlOrBase64.indexOf(',');
      if (commaIdx === -1) return null;
      const meta = urlOrBase64.slice(5, commaIdx).toLowerCase();
      const payload = urlOrBase64.slice(commaIdx + 1);
      if (!payload) return null;

      if (meta.includes(';base64')) {
        const binaryStr = atob(payload.replace(/\s+/g, ''));
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        rawBytes = bytes;
      } else {
        const decoded = decodeURIComponent(payload);
        rawBytes = new TextEncoder().encode(decoded);
      }
    } else {
      const res = await fetch(urlOrBase64);
      if (!res.ok) return null;
      const arrayBuffer = await res.arrayBuffer();
      rawBytes = new Uint8Array(arrayBuffer);
    }

    if (!rawBytes || rawBytes.length === 0) return null;
    return await prepareDocxImageBytes(rawBytes);
  } catch (err) {
    console.warn('Failed to load diagram for DOCX export:', err);
    return null;
  }
}

/**
 * Converts text into inline DOCX runs (TextRun | Math), supporting balanced
 * LaTeX, \\ce{...} chemistry, isotope pre-scripts, Markdown, and HTML sub/sup.
 */
export function parseFormattedTextChildren(
  rawText: string,
  baseOpts: DocxRunStyleOpts = {}
): DocxInlineChild[] {
  if (!rawText) return [];
  const cleanRaw = stripPassageControlTags(rawText);
  if (!cleanRaw) return [];
  return parseFormattedTextToDocxChildren(cleanRaw, baseOpts);
}

/**
 * Transforms raw text containing LaTeX math, Markdown, HTML sub/sup tags,
 * and scientific notation into docx TextRun objects (filtering native Math runs
 * for callers strictly typed to TextRun[]).
 */
export function parseFormattedTextToDocxRuns(
  rawText: string,
  baseOpts: { size?: number; bold?: boolean; color?: string; italics?: boolean; underline?: boolean; font?: string } = {}
): TextRun[] {
  const children = parseFormattedTextChildren(rawText, baseOpts);
  const runs = children.filter((child): child is TextRun => child instanceof TextRun);
  if (runs.length > 0) return runs;
  const fallback = normalizeCommonLatexForDocx(stripPassageControlTags(rawText || ''));
  return fallback
    ? [
      new TextRun({
        text: fallback,
        size: baseOpts.size,
        bold: baseOpts.bold,
        color: baseOpts.color,
        italics: baseOpts.italics,
        underline: baseOpts.underline ? { type: UnderlineType.SINGLE } : undefined,
        font: baseOpts.font,
      }),
    ]
    : [];
}
const A4_CONTENT_WIDTH_DXA = 10206;

/**
 * Scales an image proportionally inside maxW x maxH without upscaling and returns
 * a properly typed `ImageRun` (`'png' | 'jpg'`).
 */
function createDocxImageRun(
  imgData: LoadedImageData,
  maxW: number,
  maxH: number,
  allowUpscale = false
): ImageRun {
  const dims = fitImageDimensions(imgData.naturalWidth, imgData.naturalHeight, maxW, maxH, allowUpscale);
  return new ImageRun({
    type: imgData.type,
    data: imgData.data,
    transformation: dims,
  });
}

/**
 * Strips leaked AI image placeholders, fixes missing space after Table/Fig references,
 * and cleans duplicate adjacent table captions before rendering into DOCX runs.
 */
export function sanitizeExamTextForDocx(
  rawText: string,
  opts: { isStudentPaper?: boolean } = {}
): string {
  if (!rawText) return '';
  let text = stripPassageControlTags(rawText);

  if (opts.isStudentPaper) {
    // Strip leaked AI generation placeholders such as [Figure 3.1: ...] or [Diagram: ...]
    text = text.replace(
      /\[\s*(?:Figure|Fig\.?|Diagram|Insert(?:\s+Diagram)?)\s*(?:\d+(?:\.\d+)*)?\s*:[^\]]*\]/gi,
      ''
    );
  }

  // Repair fused labels like "Table 7.1to" -> "Table 7.1 to" or "Fig. 3.1shows" -> "Fig. 3.1 shows"
  text = text
    .replace(/\b(Tables?|Figs?\.?)\s*(\d+(?:\.\d+)*)([a-zA-Z])/g, '$1 $2 $3')
    .replace(/\bTable\s+\d+(?:\.\d+)*\.\s*(Table\s+\d+(?:\.\d+)*\b)/gi, '$1')
    .replace(/\b(Table\s+\d+(?:\.\d+)*)\s*\1\b/gi, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .trim();

  // Remove redundant standalone "Table X.Y" caption lines when an earlier line already references a Table
  if (/\bTable\s+\d+(?:\.\d+)*\b/i.test(text)) {
    const lines = text.split('\n');
    let seenTableMention = false;
    const filtered: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      const isStandaloneTableCaption = /^Table\s+\d+(?:\.\d+)*\.?$/i.test(trimmed);
      if (isStandaloneTableCaption && seenTableMention) {
        continue;
      }
      if (/\bTable\s+\d+(?:\.\d+)*\b/i.test(trimmed)) {
        seenTableMention = true;
      }
      filtered.push(line);
    }
    text = filtered.join('\n').trim();
  }

  return text;
}

/**
 * Removes redundant repeated sub-question labels from the start of `subText` (and
 * subsequent paragraphs inside `subText`), e.g. `subId = "(b)(i)"`,
 * `subText = "Isotopes...\n(i) Explain..."` -> `"Isotopes...\nExplain..."`.
 */
export function stripDuplicateSubQuestionPrefix(subText: string, subId: string): string {
  if (!subText || !subId) return subText || '';
  const trimmedSubId = subId.trim().toLowerCase();
  const tokenMatches = trimmedSubId.match(/\([a-z0-9]+\)|[a-z0-9]+/gi) || [];
  const candidateTokens = new Set<string>([trimmedSubId, ...tokenMatches.map((t) => t.toLowerCase())]);
  const hasRomanLeaf = /\([ivx]{1,4}\)$/i.test(trimmedSubId);

  const stripLine = (line: string, isFirstLine: boolean): string => {
    let result = line.trimStart();
    for (let pass = 0; pass < 3; pass++) {
      const match = result.match(/^(\([a-z0-9]{1,4}\)(?:\([a-z0-9]{1,4}\))?|[a-z0-9]{1,3}[.)])\s+/i);
      if (!match) break;
      const rawPrefix = match[1].toLowerCase();
      const inner = rawPrefix.replace(/^[.(]+|[.)]+$/g, '');
      const matchesCandidate =
        candidateTokens.has(rawPrefix) || candidateTokens.has(inner) || candidateTokens.has(`(${inner})`);
      const matchesMismatchedRoman = isFirstLine && hasRomanLeaf && /^\([ivx]{1,4}\)$/i.test(rawPrefix);
      if (matchesCandidate || matchesMismatchedRoman) {
        result = result.slice(match[0].length).trimStart();
      } else {
        break;
      }
    }
    return result;
  };

  return subText
    .replace(/\r\n/g, '\n')
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((line, idx) => stripLine(line, idx === 0))
    .join('\n');
}

/**
 * Computes integer DXA column widths that always sum exactly to `totalWidthDxa`.
 */
export function computeFixedTableColumnWidths(
  colCount: number,
  totalWidthDxa: number,
  options: { explicitRatios?: number[]; rows?: string[][] } = {}
): number[] {
  const safeCount = Math.max(1, colCount);
  const { explicitRatios, rows } = options;

  let weights: number[];
  if (explicitRatios && explicitRatios.length === safeCount) {
    weights = explicitRatios.map((r) => Math.max(1, r));
  } else if (rows && rows.length > 0) {
    weights = Array.from({ length: safeCount }, (_, colIdx) => {
      let maxLen = 8;
      for (const row of rows) {
        const raw = (row[colIdx] || '').replace(/\$|\\\(|\\\)|\\text\{|\}/g, '').trim();
        // Give blank / writable columns plenty of writing space
        const effectiveLen = raw.length === 0 ? 18 : Math.min(48, raw.length);
        if (effectiveLen > maxLen) maxLen = effectiveLen;
      }
      return maxLen;
    });
  } else {
    weights = Array.from({ length: safeCount }, () => 1);
  }

  const weightSum = weights.reduce((acc, w) => acc + w, 0) || safeCount;
  const widths = weights.map((w) => Math.max(480, Math.floor((w / weightSum) * totalWidthDxa)));
  const currentSum = widths.reduce((acc, w) => acc + w, 0);
  const delta = totalWidthDxa - currentSum;
  if (delta !== 0) {
    let widestIdx = 0;
    for (let i = 1; i < widths.length; i++) {
      if (widths[i] > widths[widestIdx]) widestIdx = i;
    }
    widths[widestIdx] = Math.max(480, widths[widestIdx] + delta);
  }
  return widths;
}

export interface MarkdownBlockOptions {
  prefix?: string;
  textSize?: number;
  fontName?: string;
  indentLeft?: number;
  hanging?: number;
  trailingMarks?: number;
  maxWidthDxa?: number;
  blankFillableCells?: boolean;
  sanitizeStudentPlaceholders?: boolean;
  color?: string;
}

export interface MarkdownBlocksResult {
  elements: (Paragraph | Table)[];
  hasFillableTable: boolean;
  isPureTableCompletion: boolean;
}

function splitMarkdownTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((c) => c.trim());
}

function isPlaceholderOnlyCellText(cellText: string): boolean {
  const cleaned = cellText.trim();
  if (!cleaned) return true;
  return /^(?:☐|☑|\[\s*\]|_{2,}|\.{3,}|[-–—])$/.test(cleaned);
}

/**
 * Converts Markdown/LaTeX question or sub-question text (including multi-line prose,
 * bullet lists, and pipe tables) into properly spaced OOXML Paragraphs and fixed-width Tables.
 */
export function convertMarkdownBlocksToDocxElements(
  rawText: string,
  opts: MarkdownBlockOptions = {}
): MarkdownBlocksResult {
  if (!rawText) {
    return { elements: [], hasFillableTable: false, isPureTableCompletion: false };
  }

  const {
    prefix = '',
    textSize = 22,
    fontName = 'Times New Roman',
    indentLeft = prefix ? 450 : 0,
    hanging = prefix ? 450 : 0,
    trailingMarks,
    maxWidthDxa = Math.max(5000, A4_CONTENT_WIDTH_DXA - (indentLeft || 0)),
    blankFillableCells = false,
    sanitizeStudentPlaceholders = false,
    color = '1f2937',
  } = opts;

  const sanitized = sanitizeExamTextForDocx(rawText, { isStudentPaper: sanitizeStudentPlaceholders });
  const normalized = sanitized.replace(/\r\n/g, '\n').replace(/\\n/g, '\n');
  const rawLines = normalized.split('\n');

  type ParsedBlock =
    | { kind: 'paragraph'; text: string }
    | { kind: 'bullet'; text: string }
    | { kind: 'table'; rows: string[][] };

  const blocks: ParsedBlock[] = [];
  let textBuffer: string[] = [];
  let tableBuffer: string[] = [];

  const flushParagraphBuffer = () => {
    if (textBuffer.length === 0) return;
    const joined = textBuffer.join(' ').replace(/\s{2,}/g, ' ').trim();
    if (joined) blocks.push({ kind: 'paragraph', text: joined });
    textBuffer = [];
  };

  const flushTableBuffer = () => {
    if (tableBuffer.length === 0) return;
    const dataOrHeaderRows = tableBuffer
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^\|?[-:\s|]+\|?$/.test(l) && /-/.test(l) === false ? true : !/^\|?[\s:|-]+\|?$/.test(l));
    if (dataOrHeaderRows.length > 0) {
      const parsedRows = dataOrHeaderRows.map(splitMarkdownTableRow);
      blocks.push({ kind: 'table', rows: parsedRows });
    }
    tableBuffer = [];
  };

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    const isTableLine = trimmed.startsWith('|') && (trimmed.match(/\|/g)?.length || 0) >= 2;
    if (isTableLine) {
      flushParagraphBuffer();
      tableBuffer.push(trimmed);
      continue;
    }

    if (tableBuffer.length > 0) {
      flushTableBuffer();
    }

    if (!trimmed) {
      flushParagraphBuffer();
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*•]\s+(.*)$/);
    if (bulletMatch) {
      flushParagraphBuffer();
      if (bulletMatch[1].trim()) {
        blocks.push({ kind: 'bullet', text: bulletMatch[1].trim() });
      }
      continue;
    }

    textBuffer.push(trimmed);
    // Keep standalone prompt headers ending cleanly in ":" on their own paragraph
    if (trimmed.endsWith(':')) {
      flushParagraphBuffer();
    }
  }
  flushTableBuffer();
  flushParagraphBuffer();

  // Decide which non-table paragraph gets prefix and which gets trailing [marks]
  const firstNonTableIdx = blocks.findIndex((b) => b.kind !== 'table');
  let markTargetIdx = -1;
  const lastTableIdx = blocks.map((b) => b.kind).lastIndexOf('table');
  if (trailingMarks !== undefined) {
    if (lastTableIdx >= 0) {
      // Place marks on the last non-table block after the last table, or before the first table
      const postTableParaIdx = blocks.findIndex((b, i) => i > lastTableIdx && b.kind !== 'table');
      if (postTableParaIdx >= 0) {
        for (let i = blocks.length - 1; i > lastTableIdx; i--) {
          if (blocks[i].kind !== 'table') {
            markTargetIdx = i;
            break;
          }
        }
      } else {
        for (let i = lastTableIdx - 1; i >= 0; i--) {
          if (blocks[i].kind !== 'table') {
            markTargetIdx = i;
            break;
          }
        }
      }
    } else {
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].kind !== 'table') {
          markTargetIdx = i;
          break;
        }
      }
    }
  }

  const elements: (Paragraph | Table)[] = [];
  let hasFillableTable = false;
  let hasPostTablePrompt = false;

  // If the entire block list starts with a table and has prefix/marks, emit an intro line
  if (blocks.length > 0 && firstNonTableIdx !== 0 && (prefix || trailingMarks !== undefined)) {
    const introChildren: DocxInlineChild[] = [];
    if (prefix) {
      introChildren.push(new TextRun({ text: prefix, bold: true, size: textSize, color: '111827', font: fontName }));
    }
    if (trailingMarks !== undefined && markTargetIdx === -1) {
      introChildren.push(new TextRun({ text: `\t[${trailingMarks}]`, bold: true, size: textSize, color: '4b5563', font: fontName }));
    }
    elements.push(
      new Paragraph({
        children: introChildren,
        indent: indentLeft ? { left: indentLeft, hanging: hanging || 0 } : undefined,
        tabStops: trailingMarks !== undefined && markTargetIdx === -1
          ? [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }]
          : undefined,
        spacing: { before: 80, after: 60, line: 276 },
      })
    );
  }

  blocks.forEach((block, idx) => {
    if (idx > lastTableIdx && lastTableIdx >= 0 && block.kind !== 'table') {
      const isTableReminderOnly =
        /^(?:complete|fill\s+in)\s+(?:the\s+)?(?:missing\s+)?(?:values?|cells?|blanks?|table)\.?\s*$/i.test(
          block.text.trim()
        );
      if (!isTableReminderOnly) {
        hasPostTablePrompt = true;
      }
    }

    if (block.kind === 'paragraph') {
      const attachPrefix = idx === firstNonTableIdx && Boolean(prefix);
      const attachMarks = idx === markTargetIdx && trailingMarks !== undefined;
      const children: DocxInlineChild[] = [
        ...(attachPrefix
          ? [new TextRun({ text: prefix, bold: true, size: textSize, color: '111827', font: fontName })]
          : []),
        ...parseFormattedTextChildren(block.text, { size: textSize, color, font: fontName }),
        ...(attachMarks
          ? [new TextRun({ text: `\t[${trailingMarks}]`, bold: true, size: textSize, color: '4b5563', font: fontName })]
          : []),
      ];

      elements.push(
        new Paragraph({
          children,
          indent: indentLeft ? { left: indentLeft, hanging: attachPrefix ? hanging : 0 } : undefined,
          tabStops: attachMarks ? [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }] : undefined,
          spacing: { before: idx === 0 ? 80 : 50, after: 60, line: 276 },
        })
      );
    } else if (block.kind === 'bullet') {
      const attachMarks = idx === markTargetIdx && trailingMarks !== undefined;
      const bulletIndent = (indentLeft || 0) + 360;
      const children: DocxInlineChild[] = [
        new TextRun({ text: '•  ', bold: true, size: textSize, color: '374151', font: fontName }),
        ...parseFormattedTextChildren(block.text, { size: textSize, color, font: fontName }),
        ...(attachMarks
          ? [new TextRun({ text: `\t[${trailingMarks}]`, bold: true, size: textSize, color: '4b5563', font: fontName })]
          : []),
      ];
      elements.push(
        new Paragraph({
          children,
          indent: { left: bulletIndent, hanging: 220 },
          tabStops: attachMarks ? [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }] : undefined,
          spacing: { before: 30, after: 40, line: 264 },
        })
      );
    } else {
      // Fixed-width OOXML Table with normalized cells and clean writable blanks
      const rawRows = block.rows;
      const colCount = Math.max(1, ...rawRows.map((r) => r.length));
      const normalizedRows = rawRows.map((r) =>
        Array.from({ length: colCount }, (_, ci) => (r[ci] ?? '').trim())
      );
      const colWidths = computeFixedTableColumnWidths(colCount, maxWidthDxa, { rows: normalizedRows });
      const cellMargins = { top: 70, bottom: 70, left: 100, right: 100 };

      const headerCells = normalizedRows[0];
      const dataRows = normalizedRows.slice(1);

      const tableRows: TableRow[] = [
        new TableRow({
          tableHeader: true,
          cantSplit: true,
          children: headerCells.map((cellText, colIdx) => {
            const cleanCell =
              blankFillableCells && isPlaceholderOnlyCellText(cellText)
                ? ''
                : cellText.replace(/\[\s*\]|[☐☑]/g, '').trim();
            return new TableCell({
              width: { size: colWidths[colIdx], type: WidthType.DXA },
              margins: cellMargins,
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: parseFormattedTextChildren(cleanCell, { size: Math.min(20, textSize), bold: true, font: fontName }),
                }),
              ],
              shading: { fill: 'f3f4f6' },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 6, color: '374151' },
                bottom: { style: BorderStyle.SINGLE, size: 6, color: '374151' },
                left: { style: BorderStyle.SINGLE, size: 4, color: '9ca3af' },
                right: { style: BorderStyle.SINGLE, size: 4, color: '9ca3af' },
              },
            });
          }),
        }),
      ];

      for (const row of dataRows) {
        let rowHasWritableCell = false;
        const rowCells = row.map((rawCellText, colIdx) => {
          const isBlank =
            isPlaceholderOnlyCellText(rawCellText) || /_{2,}|\[\s*\]|[☐☑]/.test(rawCellText);
          if (isBlank) {
            hasFillableTable = true;
            rowHasWritableCell = true;
          }
          let displayCell = rawCellText;
          if (blankFillableCells) {
            if (isPlaceholderOnlyCellText(rawCellText)) {
              displayCell = '';
            } else {
              displayCell = rawCellText
                .replace(/\[\s*\]|[☐☑]/g, '______')
                .replace(/\s{2,}/g, ' ')
                .trim();
            }
          }
          return new TableCell({
            width: { size: colWidths[colIdx], type: WidthType.DXA },
            margins: cellMargins,
            children: [
              new Paragraph({
                alignment: colIdx === 0 && !isBlank && rawCellText.length > 18 ? AlignmentType.LEFT : AlignmentType.CENTER,
                children: displayCell
                  ? parseFormattedTextChildren(displayCell, { size: Math.min(20, textSize), font: fontName })
                  : [new TextRun({ text: ' ', size: Math.min(20, textSize), font: fontName })],
              }),
            ],
            borders: {
              top: { style: BorderStyle.SINGLE, size: 4, color: 'd1d5db' },
              bottom: { style: BorderStyle.SINGLE, size: 4, color: 'd1d5db' },
              left: { style: BorderStyle.SINGLE, size: 4, color: '9ca3af' },
              right: { style: BorderStyle.SINGLE, size: 4, color: '9ca3af' },
            },
          });
        });

        tableRows.push(
          new TableRow({
            cantSplit: true,
            height: rowHasWritableCell ? { value: 420, rule: HeightRule.ATLEAST } : undefined,
            children: rowCells,
          })
        );
      }

      elements.push(
        new Table({
          width: { size: maxWidthDxa, type: WidthType.DXA },
          columnWidths: colWidths,
          layout: TableLayoutType.FIXED,
          alignment: AlignmentType.CENTER,
          rows: tableRows,
        })
      );
      elements.push(new Paragraph({ text: '', spacing: { before: 70, after: 70 } }));
    }
  });

  const inlineBlankCount = (sanitized.match(/(?:\.{8,}|_{8,})/g) || []).length;
  const hasInlineAnswerBlanks = inlineBlankCount >= 2;
  const isPureTableCompletion =
    (hasFillableTable && !hasPostTablePrompt) || hasInlineAnswerBlanks;

  return { elements, hasFillableTable, isPureTableCompletion };
}

/**
 * Builds an authentic Cambridge / IGCSE Candidate Information table with fixed DXA box grids.
 */
function buildCambridgeCandidateTable(totalWidthDxa = A4_CONTENT_WIDTH_DXA): Table {
  const boxBorder = { style: BorderStyle.SINGLE, size: 6, color: '000000' };
  const cellMargins = { top: 60, bottom: 60, left: 80, right: 80 };
  const outerColWidths = computeFixedTableColumnWidths(3, totalWidthDxa, { explicitRatios: [46, 28, 26] });

  const createNumberBoxes = (label: string, count: number, outerCellDxa: number) => {
    const innerTotalDxa = Math.max(1200, outerCellDxa - 160);
    const boxWidths = computeFixedTableColumnWidths(count, innerTotalDxa);
    return new TableCell({
      width: { size: outerCellDxa, type: WidthType.DXA },
      margins: cellMargins,
      children: [
        new Paragraph({
          children: [new TextRun({ text: label, bold: true, size: 15, font: 'Arial' })],
          spacing: { after: 30 },
        }),
        new Table({
          width: { size: innerTotalDxa, type: WidthType.DXA },
          columnWidths: boxWidths,
          layout: TableLayoutType.FIXED,
          rows: [
            new TableRow({
              cantSplit: true,
              children: Array.from({ length: count }).map(
                (_, bi) =>
                  new TableCell({
                    width: { size: boxWidths[bi], type: WidthType.DXA },
                    children: [new Paragraph({ text: ' ', spacing: { before: 30, after: 30 } })],
                    borders: { top: boxBorder, bottom: boxBorder, left: boxBorder, right: boxBorder },
                  })
              ),
            }),
          ],
        }),
      ],
      borders: {
        top: boxBorder,
        bottom: boxBorder,
        left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        right: boxBorder,
      },
    });
  };

  return new Table({
    width: { size: totalWidthDxa, type: WidthType.DXA },
    columnWidths: outerColWidths,
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: outerColWidths[0], type: WidthType.DXA },
            margins: cellMargins,
            children: [
              new Paragraph({
                children: [new TextRun({ text: 'CANDIDATE\nNAME', bold: true, size: 15, font: 'Arial' })],
                spacing: { after: 50 },
              }),
              new Paragraph({
                tabStops: [{ type: TabStopType.RIGHT, position: Math.max(2000, outerColWidths[0] - 240), leader: LeaderType.DOT }],
                children: [new TextRun('\t')],
              }),
            ],
            borders: {
              top: boxBorder,
              bottom: boxBorder,
              left: boxBorder,
              right: boxBorder,
            },
          }),
          createNumberBoxes('CENTRE\nNUMBER', 5, outerColWidths[1]),
          createNumberBoxes('CANDIDATE\nNUMBER', 4, outerColWidths[2]),
        ],
      }),
    ],
  });
}

/**
 * Builds the complete authentic Cambridge IGCSE Cover Page elements for Word documents.
 */
async function buildCambridgeCoverDocxElements(
  headerConfig: ExamHeaderConfig,
  questions: Question[]
): Promise<(Paragraph | Table)[]> {
  const details = getCambridgeCoverDetails(headerConfig, questions);
  const elements: (Paragraph | Table)[] = [];

  // Top 2-Logo Header: School Logo (Left) and Cambridge International Logo (Right)
  try {
    const [schoolImg, cambridgeImg] = await Promise.all([
      loadImageData(details.schoolLogoUrl || DEFAULT_SCHOOL_LOGO),
      loadImageData(details.cambridgeLogoUrl || DEFAULT_CAMBRIDGE_LOGO),
    ]);
    const logoColWidths = computeFixedTableColumnWidths(2, A4_CONTENT_WIDTH_DXA);

    const logoTable = new Table({
      width: { size: A4_CONTENT_WIDTH_DXA, type: WidthType.DXA },
      columnWidths: logoColWidths,
      layout: TableLayoutType.FIXED,
      borders: {
        top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        bottom: { style: BorderStyle.SINGLE, size: 8, color: '111827' },
        left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      },
      rows: [
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({
              width: { size: logoColWidths[0], type: WidthType.DXA },
              margins: { bottom: 120 },
              children: schoolImg
                ? [new Paragraph({ children: [createDocxImageRun(schoolImg, 170, 56)] })]
                : [new Paragraph({ text: '' })],
            }),
            new TableCell({
              width: { size: logoColWidths[1], type: WidthType.DXA },
              margins: { bottom: 120 },
              children: cambridgeImg
                ? [
                  new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    children: [createDocxImageRun(cambridgeImg, 190, 56)],
                  }),
                ]
                : [new Paragraph({ text: '' })],
            }),
          ],
        }),
      ],
    });

    elements.push(logoTable);
    elements.push(new Paragraph({ text: '', spacing: { before: 100, after: 100 } }));
  } catch {
    elements.push(
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({ text: 'Cambridge Assessment International Education', font: 'Arial', size: 21, bold: true }),
        ],
        spacing: { after: 180 },
      })
    );
  }

  // Main Title: Cambridge IGCSE™
  elements.push(
    new Paragraph({
      children: [
        new TextRun({ text: 'Cambridge IGCSE™', font: 'Arial', size: 34, bold: true, color: '000000' }),
      ],
      spacing: { after: 200 },
    })
  );

  // Candidate Details (if Theory or Combined)
  if (!details.isMcqOnly) {
    elements.push(buildCambridgeCandidateTable());
    elements.push(new Paragraph({ text: '', spacing: { before: 100, after: 100 } }));
  }

  // Subject line & Code line
  elements.push(
    new Paragraph({
      children: [
        new TextRun({ text: details.subjectName, font: 'Arial', size: 23, bold: true }),
        new TextRun({ text: `\t${details.paperCodeDisplay}`, font: 'Arial', size: 23, bold: true }),
      ],
      tabStops: [{ type: TabStopType.RIGHT, position: 9600 }],
      spacing: { after: 60 },
    })
  );

  // Paper name ('Multiple Choice', 'Theory', or 'Multiple Choice & Theory') & Year (e.g. 2026)
  elements.push(
    new Paragraph({
      children: [
        new TextRun({ text: details.paperName, font: 'Arial', size: 19 }),
        new TextRun({ text: `\t${details.seriesYear}`, font: 'Arial', size: 19, bold: true }),
      ],
      tabStops: [{ type: TabStopType.RIGHT, position: 9600 }],
      spacing: { after: 60 },
    })
  );

  // Duration
  elements.push(
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [
        new TextRun({ text: details.durationText, font: 'Arial', size: 19, bold: true }),
      ],
      spacing: { after: 140 },
    })
  );

  // Mandatory Notices & Additional Materials
  details.mandatoryNotices.forEach((notice) => {
    elements.push(
      new Paragraph({
        children: [new TextRun({ text: notice, font: 'Arial', size: 17 })],
        spacing: { after: 30 },
      })
    );
  });

  if (details.isMcqOnly && details.additionalMaterials.length > 0) {
    elements.push(
      new Paragraph({
        children: [
          new TextRun({ text: 'You will need:  ', font: 'Arial', size: 17 }),
          new TextRun({ text: details.additionalMaterials.join('\n                '), font: 'Arial', size: 17 }),
        ],
        spacing: { after: 60 },
      })
    );
  }

  // Horizontal Divider Line
  elements.push(
    new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: '000000' } },
      spacing: { before: 60, after: 140 },
    })
  );

  // INSTRUCTIONS Section
  elements.push(
    new Paragraph({
      children: [new TextRun({ text: 'INSTRUCTIONS', font: 'Arial', size: 19, bold: true })],
      spacing: { after: 60 },
    })
  );
  details.instructions.forEach((inst) => {
    elements.push(
      new Paragraph({
        bullet: { level: 0 },
        children: [new TextRun({ text: inst, font: 'Arial', size: 17 })],
        spacing: { after: 30 },
      })
    );
  });

  elements.push(new Paragraph({ text: '', spacing: { before: 60, after: 60 } }));

  // INFORMATION Section
  elements.push(
    new Paragraph({
      children: [new TextRun({ text: 'INFORMATION', font: 'Arial', size: 19, bold: true })],
      spacing: { after: 60 },
    })
  );
  details.information.forEach((info) => {
    elements.push(
      new Paragraph({
        bullet: { level: 0 },
        children: [new TextRun({ text: info, font: 'Arial', size: 17 })],
        spacing: { after: 30 },
      })
    );
  });

  // Footer info (native Word NUMPAGES field so total page count is always accurate)
  elements.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: 'This document has ', font: 'Arial', size: 15 }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], font: 'Arial', size: 15 }),
        new TextRun({ text: ' pages. Any blank pages are indicated.', font: 'Arial', size: 15 }),
      ],
      spacing: { before: 240, after: 80 },
    })
  );

  elements.push(
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [
        new TextRun({ text: '[Turn over', font: 'Arial', size: 17, bold: true }),
      ],
      spacing: { after: 160 },
    })
  );

  // Page break to start Question 1 on Page 2
  elements.push(new Paragraph({ pageBreakBefore: true, text: '' }));

  return elements;
}

/**
 * Builds a modern school worksheet header table with score box.
 */
function buildWorksheetHeaderTable(schoolName: string, totalMarks: number): Table {
  const borderGrey = { style: BorderStyle.SINGLE, size: 4, color: 'cbd5e1' };
  const cellMargins = { top: 100, bottom: 100, left: 120, right: 120 };
  const colWidths = computeFixedTableColumnWidths(2, A4_CONTENT_WIDTH_DXA, { explicitRatios: [75, 25] });

  return new Table({
    width: { size: A4_CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: colWidths,
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: colWidths[0], type: WidthType.DXA },
            margins: cellMargins,
            children: [
              ...(schoolName
                ? [
                  new Paragraph({
                    children: [new TextRun({ text: schoolName.toUpperCase(), bold: true, size: 22, color: '1e40af', font: 'Arial' })],
                    spacing: { after: 40 },
                  }),
                ]
                : []),
              new Paragraph({
                children: [
                  new TextRun({ text: 'STUDENT NAME: ', bold: true, size: 18, font: 'Arial' }),
                  new TextRun({ text: '__________________________________', color: '9ca3af', size: 18, font: 'Arial' }),
                ],
                spacing: { after: 40 },
              }),
              new Paragraph({
                children: [
                  new TextRun({ text: 'CLASS / SECTION: ', bold: true, size: 18, font: 'Arial' }),
                  new TextRun({ text: '___________   ', color: '9ca3af', size: 18, font: 'Arial' }),
                  new TextRun({ text: 'DATE: ', bold: true, size: 18, font: 'Arial' }),
                  new TextRun({ text: '___________', color: '9ca3af', size: 18, font: 'Arial' }),
                ],
              }),
            ],
            borders: { top: borderGrey, bottom: borderGrey, left: borderGrey, right: { style: BorderStyle.NONE, size: 0, color: 'auto' } },
          }),
          new TableCell({
            width: { size: colWidths[1], type: WidthType.DXA },
            margins: cellMargins,
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: 'SCORE / GRADE', bold: true, size: 16, color: '475569', font: 'Arial' })],
                spacing: { after: 40 },
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: '____ / ', size: 24, bold: true, color: '1e293b', font: 'Arial' }),
                  new TextRun({ text: `${totalMarks}`, size: 24, bold: true, color: '64748b', font: 'Arial' }),
                ],
              }),
            ],
            borders: { top: borderGrey, bottom: borderGrey, left: borderGrey, right: borderGrey },
          }),
        ],
      }),
    ],
  });
}

/**
 * Builds the `docx` `Document` object for a student exam paper without triggering
 * browser download, enabling both browser export and Node verification tests.
 */
export async function buildStudentPaperDocxDocument(
  headerConfig: ExamHeaderConfig,
  rawQuestions: Question[],
  options: DocxExportOptions = {}
): Promise<Document> {
  const questions = resolveQuestionResources(rawQuestions, {
    autoRenumberFigures: options.autoRenumberFigures ?? true,
  });
  const {
    template = 'cambridge_official',
    includeAnswerLines = true,
    linesPerMark = 2,
    answerLineStyle = 'dotted',
    schoolName = '',
    showTurnOverNotice = true,
  } = options;

  const isCambridge = template === 'cambridge_official';
  const fontName = isCambridge ? 'Times New Roman' : 'Arial';
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);
  const docParagraphs: (Paragraph | Table)[] = [];

  // ─── 1. Cover Page / Header ───────────────────────────────────────────────
  if (isCambridge) {
    docParagraphs.push(...(await buildCambridgeCoverDocxElements(headerConfig, questions)));
  } else {
    if (template === 'school_worksheet') {
      docParagraphs.push(buildWorksheetHeaderTable(schoolName || headerConfig.schoolName || '', totalMarks));
    }

    docParagraphs.push(new Paragraph({ text: '', spacing: { before: 120, after: 120 } }));

    // Title & Subject Header
    docParagraphs.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [
          new TextRun({
            text: headerConfig.title || 'Examination Assessment',
            bold: true,
            size: 26,
            color: '111827',
            font: fontName,
          }),
        ],
        spacing: { after: 60 },
      })
    );

    const metaParts: string[] = [];
    if (headerConfig.subject) {
      metaParts.push(headerConfig.subject + (headerConfig.subjectCode ? ` (${headerConfig.subjectCode})` : ''));
    }
    metaParts.push(`Duration: ${headerConfig.durationMinutes || 45} minutes`);
    metaParts.push(`Total Marks: ${totalMarks}`);

    docParagraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: metaParts.join('   •   '),
            bold: true,
            size: 19,
            color: '4b5563',
            font: fontName,
          }),
        ],
        spacing: { after: 140 },
      })
    );

    // Candidate Instructions Box
    const instructionText =
      headerConfig.instructions ||
      'Read each question carefully before answering. Write your answers neatly in the spaces provided.';
    const instructionBlocks = parseInstructionLines(instructionText);
    const singlePlainLine = instructionBlocks.length === 1 && instructionBlocks[0].type === 'paragraph';
    const instructionParagraphs = instructionBlocks.map(
      (b) =>
        new Paragraph({
          children: [
            ...(b.type === 'bullet' || singlePlainLine
              ? [new TextRun({ text: '• ', size: 16, font: 'Arial' })]
              : []),
            ...parseFormattedTextChildren(b.text, { size: 16, font: 'Arial' }),
          ],
          spacing: { after: 30 },
        })
    );

    const instTable = new Table({
      width: { size: A4_CONTENT_WIDTH_DXA, type: WidthType.DXA },
      columnWidths: [A4_CONTENT_WIDTH_DXA],
      layout: TableLayoutType.FIXED,
      rows: [
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({
              width: { size: A4_CONTENT_WIDTH_DXA, type: WidthType.DXA },
              margins: { top: 80, bottom: 80, left: 100, right: 100 },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: 'INSTRUCTIONS TO CANDIDATES:', bold: true, size: 16, font: 'Arial' })],
                  spacing: { after: 40 },
                }),
                ...instructionParagraphs,
                ...(headerConfig.additionalMaterials
                  ? [
                    new Paragraph({
                      children: [new TextRun({ text: `• Additional Materials: ${headerConfig.additionalMaterials}`, size: 16, font: 'Arial' })],
                    }),
                  ]
                  : []),
                new Paragraph({
                  children: [new TextRun({ text: '• The number of marks is given in brackets [ ] at the end of each question.', size: 16, font: 'Arial' })],
                }),
              ],
              borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: '9ca3af' },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: '9ca3af' },
                left: { style: BorderStyle.SINGLE, size: 4, color: '9ca3af' },
                right: { style: BorderStyle.SINGLE, size: 4, color: '9ca3af' },
              },
            }),
          ],
        }),
      ],
    });

    docParagraphs.push(instTable);
    docParagraphs.push(new Paragraph({ text: '', spacing: { before: 160, after: 160 } }));
  }

  // ─── 4. Question Stream with Hanging Indents & Right Tab-Stop Marks ───────
  const leaderStyle = answerLineStyle === 'dotted' ? LeaderType.DOT : LeaderType.UNDERSCORE;

  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    const qNum = idx + 1;

    // Stem with markdown table rendering and hanging indent
    const cleanStem = stripDuplicateSubQuestionsFromStem(
      stripDuplicateOptionsFromStem(q.question_text || '', q.options),
      q.sub_questions
    );
    const stemBlocks = convertMarkdownBlocksToDocxElements(cleanStem, {
      prefix: `${qNum}.  `,
      textSize: 22,
      fontName,
      indentLeft: 450,
      hanging: 450,
      blankFillableCells: true,
      sanitizeStudentPlaceholders: true,
    });
    docParagraphs.push(...stemBlocks.elements);

    // Embed Main Question Diagrams if present (only if NOT an insert diagram when booklet is attached)
    const stemDiagramUrls = resolveQuestionImageUrlsExcludingStandaloneSvg({
      diagram_url: q.diagram_url || (q as any).image_url || (q as any).diagram_base64,
      diagram_urls: q.diagram_urls,
      svg_content: q.svg_content,
      mark_scheme: q.mark_scheme,
    });
    const isParentInsert = isInsertResource(q);
    if (stemDiagramUrls.length > 0 && (!options.includeInsertBooklet || !isParentInsert)) {
      for (let dIdx = 0; dIdx < stemDiagramUrls.length; dIdx++) {
        const imgData = await loadImageData(stemDiagramUrls[dIdx]);
        if (imgData) {
          docParagraphs.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [createDocxImageRun(imgData, 420, 260)],
              spacing: { before: 120, after: 60 },
            })
          );
          const figLabel = q.resource_ref
            ? (stemDiagramUrls.length > 1 ? `${q.resource_ref} (${dIdx + 1})` : q.resource_ref)
            : `Fig. ${qNum}.${dIdx + 1}`;
          docParagraphs.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  text: figLabel,
                  bold: true,
                  size: 20,
                  font: fontName,
                }),
              ],
              spacing: { before: 0, after: 120 },
            })
          );
        }
      }
    }

    // Options for Multiple Choice (Supports per-option diagrams)
    if (q.options && q.options.length > 0) {
      for (let optIdx = 0; optIdx < q.options.length; optIdx++) {
        const opt = q.options[optIdx];
        const { letter, text } = parseMcqOption(stripInlineMarkdownImage(opt), optIdx);
        docParagraphs.push(
          new Paragraph({
            indent: { left: 800, hanging: 380 },
            children: [
              new TextRun({ text: `${letter}    `, bold: true, size: 20, font: fontName }),
              ...(text ? parseFormattedTextChildren(text, { size: 20, color: '374151', font: fontName }) : []),
            ],
            spacing: { before: 50, after: 40, line: 260 },
          })
        );
        const optDiagramUrl = resolveOptionDiagramUrl(q, optIdx, opt);
        if (optDiagramUrl) {
          const optImgData = await loadImageData(optDiagramUrl);
          if (optImgData) {
            docParagraphs.push(
              new Paragraph({
                indent: { left: 800 },
                children: [createDocxImageRun(optImgData, 240, 140)],
                spacing: { before: 20, after: 80 },
              })
            );
          }
        }
      }
    }

    // Sub-questions with hanging indent (a), Markdown table support, and right-aligned mark tab
    if (q.sub_questions && q.sub_questions.length > 0) {
      for (const sq of q.sub_questions) {
        const cleanSubText = stripDuplicateSubQuestionPrefix(
          stripDuplicateOptionsFromStem(sq.question_text || '', (sq as any).options || q.options),
          sq.sub_id || ''
        );
        const subBlocks = convertMarkdownBlocksToDocxElements(cleanSubText, {
          prefix: `${sq.sub_id}  `,
          textSize: 20,
          fontName,
          indentLeft: 800,
          hanging: 380,
          trailingMarks: sq.marks || 1,
          blankFillableCells: true,
          sanitizeStudentPlaceholders: true,
        });
        docParagraphs.push(...subBlocks.elements);

        // Sub-question diagrams if present (only if NOT an insert resource when booklet is attached)
        const subDiagramUrls = resolveQuestionImageUrlsExcludingStandaloneSvg({
          diagram_url: (sq as any).diagram_url || (sq as any).image_url || (sq as any).diagram_base64,
          diagram_urls: sq.diagram_urls,
        });
        const isSubInsert = isInsertResource(sq);
        if (subDiagramUrls.length > 0 && (!options.includeInsertBooklet || !isSubInsert)) {
          for (let sdIdx = 0; sdIdx < subDiagramUrls.length; sdIdx++) {
            const subImgData = await loadImageData(subDiagramUrls[sdIdx]);
            if (subImgData) {
              docParagraphs.push(
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [createDocxImageRun(subImgData, 360, 220)],
                  spacing: { before: 100, after: 40 },
                })
              );
              const subFigLabel = sq.resource_ref
                ? (subDiagramUrls.length > 1 ? `${sq.resource_ref} (${sdIdx + 1})` : sq.resource_ref)
                : `Fig. ${qNum}.${sdIdx + 2}`;
              docParagraphs.push(
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({
                      text: subFigLabel,
                      bold: true,
                      size: 20,
                      font: fontName,
                    }),
                  ],
                  spacing: { before: 0, after: 100 },
                })
              );
            }
          }
        }

        // Native full-width answer lines (suppressed when the sub-question is purely table-completion)
        if (includeAnswerLines && template !== 'separate_answer_booklet' && !subBlocks.isPureTableCompletion) {
          const subLinesCount = Math.max(1, (sq.marks || 1) * linesPerMark);
          for (let li = 0; li < subLinesCount; li++) {
            docParagraphs.push(
              new Paragraph({
                indent: { left: 800 },
                tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX, leader: leaderStyle }],
                children: [new TextRun({ text: '\t', size: 24, font: fontName })],
                spacing: { before: 200, after: 200, line: 420 },
              })
            );
          }
        }
      }
    } else if (
      includeAnswerLines &&
      template !== 'separate_answer_booklet' &&
      q.question_style !== 'Multiple Choice' &&
      !stemBlocks.isPureTableCompletion
    ) {
      // Main Question Native Full-Width Answer Lines
      const lineCount = Math.max(1, (q.marks || 1) * linesPerMark);
      for (let li = 0; li < lineCount; li++) {
        docParagraphs.push(
          new Paragraph({
            indent: { left: 450 },
            tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX, leader: leaderStyle }],
            children: [new TextRun({ text: '\t', size: 24, font: fontName })],
            spacing: { before: 200, after: 200, line: 420 },
          })
        );
      }
    }

    // Question Total Marks Indicator (Right-aligned)
    docParagraphs.push(
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            text: `[Total: ${q.marks || 1}]`,
            bold: true,
            size: 20,
            color: '374151',
            font: fontName,
          }),
        ],
        spacing: { before: 40, after: 180 },
      })
    );
  }

  // ─── 4b. Attached Cambridge Insert / Resource Booklet ────────────────────
  if (options.includeInsertBooklet) {
    docParagraphs.push(
      new Paragraph({
        pageBreakBefore: true,
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: `${(headerConfig.subject || 'GEOGRAPHY').toUpperCase()} — INSERT / RESOURCE BOOKLET`,
            bold: true,
            size: 26,
            font: fontName,
            color: '111827',
          }),
        ],
        spacing: { before: 180, after: 80 },
      })
    );

    docParagraphs.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: `${headerConfig.title || 'Assessment Resources'} • ${headerConfig.subjectCode || '0460'}`,
            bold: true,
            size: 20,
            font: fontName,
            color: '4B5563',
          }),
        ],
        spacing: { after: 180 },
      })
    );

    // Information Box
    docParagraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: 'INFORMATION & INSTRUCTIONS:',
            bold: true,
            size: 18,
            font: fontName,
          }),
        ],
        spacing: { before: 80, after: 40 },
      })
    );
    docParagraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: '• This insert contains all the resources, figures, maps, tables, case studies, and source extracts referred to in the question paper.\n• You may make any necessary annotations or highlights directly on the insert.\n• This Insert is not assessed. Write your answers only in the question paper / answer booklet.',
            size: 18,
            font: fontName,
            color: '374151',
          }),
        ],
        spacing: { after: 240 },
      })
    );

    // Append each resource / diagram that belongs to the Cambridge Insert Booklet
    for (let qIdx = 0; qIdx < questions.length; qIdx++) {
      const q = questions[qIdx];
      const qImg = q.diagram_url || (q as any).image_url || (q as any).diagram_base64;
      const qRef = q.resource_ref;
      const isParentInsert = isInsertResource(q) || Boolean(options.includeAllFiguresInBooklet);

      if (qImg && isParentInsert) {
        let topic = q.topic || undefined;
        const titleMatch =
          (q.question_text || '').match(/Study\s+Figs?\.?\s*[0-9.]+\s*(?:\(Insert\))?,?\s*([^.\n]+)/i) ||
          (q.sub_questions?.[0]?.question_text || '').match(
            /Study\s+Figs?\.?\s*[0-9.]+\s*(?:\(Insert\))?,?\s*([^.\n]+)/i
          );
        if (titleMatch) {
          topic = titleMatch[1].trim();
        }

        const headerText = qRef
          ? (/^figs?/i.test(qRef)
            ? `${qRef} for Question ${q.question_number || qIdx + 1}${topic ? ` — ${topic}` : ''}`
            : `${qRef} — Resource for Question ${q.question_number || qIdx + 1}${topic ? ` — ${topic}` : ''}`)
          : `Resource for Question ${q.question_number || qIdx + 1}${topic ? ` — ${topic}` : ''}`;

        docParagraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: headerText,
                bold: true,
                size: 22,
                color: '1E3A8A',
                font: fontName,
              }),
            ],
            spacing: { before: 180, after: 100 },
          })
        );

        const imgData = await loadImageData(qImg);
        if (imgData) {
          docParagraphs.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [createDocxImageRun(imgData, 500, 350)],
              spacing: { before: 100, after: 180 },
            })
          );
        }
      }

      // Check sub-questions
      for (const sq of q.sub_questions || []) {
        const sqImg = sq.diagram_url || (sq as any).image_url || (sq as any).diagram_base64;
        const sqRef = sq.resource_ref;
        const isSubInsert = isInsertResource(sq) || Boolean(options.includeAllFiguresInBooklet);

        if (sqImg && isSubInsert) {
          let sqTopic = q.topic || undefined;
          const subTitleMatch = (sq.question_text || '').match(
            /Study\s+Figs?\.?\s*[0-9.]+\s*(?:\(Insert\))?,?\s*([^.\n]+)/i
          );
          if (subTitleMatch) {
            sqTopic = subTitleMatch[1].trim();
          }

          const sqHeaderText = sqRef
            ? (/^figs?/i.test(sqRef)
              ? `${sqRef} for Question ${q.question_number || qIdx + 1}${sqTopic ? ` — ${sqTopic}` : ''}`
              : `${sqRef} — Resource for Question ${q.question_number || qIdx + 1} ${sq.sub_id}${sqTopic ? ` — ${sqTopic}` : ''}`)
            : `Resource for Question ${q.question_number || qIdx + 1} ${sq.sub_id}${sqTopic ? ` — ${sqTopic}` : ''}`;

          docParagraphs.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: sqHeaderText,
                  bold: true,
                  size: 20,
                  color: '1E3A8A',
                  font: fontName,
                }),
              ],
              spacing: { before: 160, after: 80 },
            })
          );

          const sqImgData = await loadImageData(sqImg);
          if (sqImgData) {
            docParagraphs.push(
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [createDocxImageRun(sqImgData, 500, 320)],
                spacing: { before: 80, after: 180 },
              })
            );
          }
        }
      }
    }
  }

  // ─── 5. Document Assemble & Download ──────────────────────────────────────
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: fontName,
            size: 22,
          },
        },
      },
    },
    sections: [
      {
        properties: {
          titlePage: true,
          page: {
            margin: {
              top: 850,
              bottom: 850,
              left: 850,
              right: 850,
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    bold: true,
                    size: 22,
                    font: fontName,
                  }),
                ],
              }),
            ],
          }),
          first: new Header({
            children: [],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  ...(showTurnOverNotice
                    ? [new TextRun({ text: '[Turn over]', italics: true, size: 18, color: '6b7280', font: fontName })]
                    : []),
                ],
              }),
            ],
          }),
        },
        children: docParagraphs,
      },
    ],
  });

  return doc;
}

/**
 * Generates and downloads a student exam paper as a .docx file
 */
export async function exportStudentPaperDocx(
  headerConfig: ExamHeaderConfig,
  rawQuestions: Question[],
  options: DocxExportOptions = {}
): Promise<void> {
  const doc = await buildStudentPaperDocxDocument(headerConfig, rawQuestions, options);
  const blob = await Packer.toBlob(doc);
  const safeTitle = (headerConfig.title || 'Exam_Paper').replace(/[^a-zA-Z0-9_-]/g, '_');
  await exportFileUniversal(
    blob,
    `${safeTitle}_Student_Paper.docx`,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

/**
 * Generates and downloads a separate Answer Booklet as a .docx file
 */
export async function exportAnswerBookletDocx(
  headerConfig: ExamHeaderConfig,
  rawQuestions: Question[],
  options: DocxExportOptions = {}
): Promise<void> {
  const questions = resolveQuestionResources(rawQuestions, {
    autoRenumberFigures: options.autoRenumberFigures ?? true,
  });
  const {
    linesPerMark = 3,
    answerLineStyle = 'dotted',
    showTurnOverNotice = true,
  } = options;

  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);
  const docParagraphs: (Paragraph | Table)[] = [];
  const leaderStyle = answerLineStyle === 'dotted' ? LeaderType.DOT : LeaderType.UNDERSCORE;

  // Header Box
  docParagraphs.push(buildCambridgeCandidateTable());
  docParagraphs.push(new Paragraph({ text: '', spacing: { before: 100, after: 100 } }));

  docParagraphs.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [
        new TextRun({
          text: `${headerConfig.title || 'Examination'} — CANDIDATE ANSWER BOOKLET`,
          bold: true,
          size: 26,
          color: '111827',
          font: 'Times New Roman',
        }),
      ],
      spacing: { after: 60 },
    })
  );

  docParagraphs.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Subject: ${headerConfig.subject || 'Assessment'}   •   Total Marks: ${totalMarks}`,
          bold: true,
          size: 18,
          color: '6b7280',
          font: 'Times New Roman',
        }),
      ],
      spacing: { after: 160 },
    })
  );

  questions.forEach((q, idx) => {
    const qNum = idx + 1;

    docParagraphs.push(
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children: [
          new TextRun({ text: `Question ${qNum}`, bold: true, size: 22, color: '1e40af', font: 'Times New Roman' }),
          new TextRun({ text: `\t[${q.marks || 1} mark${q.marks !== 1 ? 's' : ''}]`, bold: true, size: 18, color: '4b5563', font: 'Times New Roman' }),
        ],
        spacing: { before: 160, after: 80 },
      })
    );

    if (q.sub_questions && q.sub_questions.length > 0) {
      q.sub_questions.forEach((sq) => {
        docParagraphs.push(
          new Paragraph({
            indent: { left: 400 },
            tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
            children: [
              new TextRun({ text: `${sq.sub_id}  `, bold: true, size: 20, font: 'Times New Roman' }),
              new TextRun({ text: `\t[${sq.marks || 1}]`, bold: true, size: 18, color: '6b7280', font: 'Times New Roman' }),
            ],
            spacing: { before: 60, after: 40 },
          })
        );

        const subLinesCount = Math.max(2, (sq.marks || 1) * linesPerMark);
        for (let li = 0; li < subLinesCount; li++) {
          docParagraphs.push(
            new Paragraph({
              indent: { left: 400 },
              tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX, leader: leaderStyle }],
              children: [new TextRun('\t')],
              spacing: { before: 200, after: 200, line: 420 },
            })
          );
        }
      });
    } else {
      const lineCount = Math.max(2, (q.marks || 1) * linesPerMark);
      for (let li = 0; li < lineCount; li++) {
        docParagraphs.push(
          new Paragraph({
            tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX, leader: leaderStyle }],
            children: [new TextRun('\t')],
            spacing: { before: 200, after: 200, line: 420 },
          })
        );
      }
    }
  });

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Times New Roman', size: 22 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 850, bottom: 850, left: 850, right: 850 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  ...(showTurnOverNotice
                    ? [new TextRun({ text: '[Turn over]     ', italics: true, size: 18, color: '6b7280' })]
                    : []),
                  new TextRun({ text: 'Answer Booklet — Page ', size: 18, color: '6b7280' }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '6b7280' }),
                  new TextRun({ text: ' of ', size: 18, color: '6b7280' }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: '6b7280' }),
                ],
              }),
            ],
          }),
        },
        children: docParagraphs,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const safeTitle = (headerConfig.title || 'Exam').replace(/[^a-zA-Z0-9_-]/g, '_');
  await exportFileUniversal(blob, `${safeTitle}_Answer_Booklet.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

/**
 * Generates and downloads a publication-quality Comprehensive Teacher Mark Scheme & Solutions document (.docx)
 */
export async function exportTeacherMarkSchemeDocx(
  headerConfig: ExamHeaderConfig,
  rawQuestions: Question[],
  options: DocxExportOptions = {}
): Promise<void> {
  const questions = resolveQuestionResources(rawQuestions, {
    autoRenumberFigures: options.autoRenumberFigures ?? true,
  });
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);
  const docParagraphs: (Paragraph | Table)[] = [];

  // Title Header
  docParagraphs.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [
        new TextRun({
          text: `COMPREHENSIVE TEACHER MARK SCHEME & SOLUTIONS`,
          bold: true,
          size: 26,
          color: '1e3a8a',
          font: 'Arial',
        }),
      ],
      spacing: { after: 40 },
    })
  );

  docParagraphs.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `${headerConfig.title || 'Assessment'}   •   Subject: ${headerConfig.subject || 'General'} (${headerConfig.subjectCode || ''})   •   Total Marks: ${totalMarks}`,
          bold: true,
          size: 19,
          color: '4b5563',
          font: 'Arial',
        }),
      ],
      spacing: { after: 180 },
    })
  );

  // Question-by-Question Comprehensive Breakdown
  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    const qNum = idx + 1;

    // Question Section Banner
    docParagraphs.push(
      new Paragraph({
        children: [
          new TextRun({ text: `QUESTION ${qNum}`, bold: true, size: 22, color: '1e3a8a', font: 'Arial' }),
          new TextRun({
            text: `   [Total: ${q.marks || 1} mark${q.marks !== 1 ? 's' : ''}]`,
            bold: true,
            size: 19,
            color: '1e40af',
            font: 'Arial',
          }),
          ...(q.topic
            ? [new TextRun({ text: `   •   Topic: ${q.topic}${q.sub_topic ? ` (${q.sub_topic})` : ''}`, italics: true, size: 17, color: '6b7280', font: 'Arial' })]
            : []),
        ],
        spacing: { before: 180, after: 60 },
      })
    );

    // Stem Box (So teacher sees question context)
    const cleanStem = stripDuplicateSubQuestionsFromStem(
      stripDuplicateOptionsFromStem(q.question_text || '', q.options),
      q.sub_questions
    );
    const stemElements = convertMarkdownBlocksToDocxElements(cleanStem, {
      textSize: 19,
      fontName: 'Arial',
      color: '1f2937',
    }).elements;
    docParagraphs.push(...stemElements);

    // Embed Question Diagrams if present
    const msStemUrls = resolveQuestionImageUrlsExcludingStandaloneSvg({
      diagram_url: q.diagram_url || (q as any).image_url || (q as any).diagram_base64,
      diagram_urls: q.diagram_urls,
      mark_scheme: q.mark_scheme,
    });
    for (const msDiagramUrl of msStemUrls) {
      const imgData = await loadImageData(msDiagramUrl);
      if (imgData) {
        docParagraphs.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [createDocxImageRun(imgData, 360, 200)],
            spacing: { before: 100, after: 100 },
          })
        );
      }
    }

    // If MCQ, list options (including per-option diagrams)
    if (q.options && q.options.length > 0) {
      for (let optIdx = 0; optIdx < q.options.length; optIdx++) {
        const opt = q.options[optIdx];
        const { letter, text } = parseMcqOption(stripInlineMarkdownImage(opt), optIdx);
        docParagraphs.push(
          new Paragraph({
            indent: { left: 400, hanging: 240 },
            children: [
              new TextRun({ text: `${letter}   `, bold: true, size: 18, color: '1e3a8a', font: 'Arial' }),
              ...(text ? parseFormattedTextChildren(text, { size: 18, color: '4b5563', font: 'Arial' }) : []),
            ],
            spacing: { before: 20, after: 20 },
          })
        );
        const msOptImg = resolveOptionDiagramUrl(q, optIdx, opt);
        if (msOptImg) {
          const optImgData = await loadImageData(msOptImg);
          if (optImgData) {
            docParagraphs.push(
              new Paragraph({
                indent: { left: 400 },
                children: [createDocxImageRun(optImgData, 220, 130)],
                spacing: { before: 20, after: 60 },
              })
            );
          }
        }
      }
    }

    // Mark Scheme Table for this Question
    const msColWidths = computeFixedTableColumnWidths(4, A4_CONTENT_WIDTH_DXA, { explicitRatios: [15, 55, 18, 12] });
    const rows: TableRow[] = [
      new TableRow({
        tableHeader: true,
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: msColWidths[0], type: WidthType.DXA },
            children: [new Paragraph({ children: [new TextRun({ text: 'Part', bold: true, size: 17, color: 'ffffff', font: 'Arial' })] })],
            shading: { fill: '1e3a8a' },
            margins: { top: 60, bottom: 60, left: 60, right: 60 },
          }),
          new TableCell({
            width: { size: msColWidths[1], type: WidthType.DXA },
            children: [new Paragraph({ children: [new TextRun({ text: 'Marking Criteria & Model Answer', bold: true, size: 17, color: 'ffffff', font: 'Arial' })] })],
            shading: { fill: '1e3a8a' },
            margins: { top: 60, bottom: 60, left: 60, right: 60 },
          }),
          new TableCell({
            width: { size: msColWidths[2], type: WidthType.DXA },
            children: [new Paragraph({ children: [new TextRun({ text: 'Acceptable / ECF', bold: true, size: 17, color: 'ffffff', font: 'Arial' })] })],
            shading: { fill: '1e3a8a' },
            margins: { top: 60, bottom: 60, left: 60, right: 60 },
          }),
          new TableCell({
            width: { size: msColWidths[3], type: WidthType.DXA },
            children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Marks', bold: true, size: 17, color: 'ffffff', font: 'Arial' })] })],
            shading: { fill: '1e3a8a' },
            margins: { top: 60, bottom: 60, left: 60, right: 60 },
          }),
        ],
      }),
    ];

    if (q.sub_questions && q.sub_questions.length > 0) {
      q.sub_questions.forEach((sub) => {
        const msText =
          typeof sub.mark_scheme === 'string'
            ? sub.mark_scheme
            : Array.isArray(sub.mark_scheme)
              ? (sub.mark_scheme as string[]).join('\n• ')
              : 'Credit scientifically accurate answer with appropriate working.';

        const subStemClean = stripDuplicateSubQuestionPrefix(sub.question_text || '', sub.sub_id || '');
        const cellParagraphs: Paragraph[] = [
          new Paragraph({
            children: [
              ...(subStemClean
                ? [
                  new TextRun({ text: 'Stem: ', italics: true, size: 16, color: '6b7280', font: 'Arial' }),
                  ...parseFormattedTextChildren(subStemClean, { size: 16, italics: true, color: '6b7280', font: 'Arial' }),
                  new TextRun({ text: '\n', size: 16, font: 'Arial' }),
                ]
                : []),
              ...parseFormattedTextChildren(msText, { size: 18, font: 'Arial' }),
            ],
            spacing: { after: 40 },
          }),
        ];

        if (sub.guidance) {
          cellParagraphs.push(
            new Paragraph({
              children: [
                new TextRun({ text: '💡 Examiner Guidance: ', bold: true, size: 16, color: '2563eb', font: 'Arial' }),
                ...parseFormattedTextChildren(sub.guidance, { size: 16, italics: true, font: 'Arial' }),
              ],
              spacing: { before: 40 },
            })
          );
        }

        if (sub.common_misconceptions && sub.common_misconceptions.length > 0) {
          cellParagraphs.push(
            new Paragraph({
              children: [
                new TextRun({ text: '⚠️ Common Trap: ', bold: true, size: 16, color: 'd97706', font: 'Arial' }),
                ...parseFormattedTextChildren(sub.common_misconceptions.join('; '), { size: 16, italics: true, font: 'Arial' }),
              ],
              spacing: { before: 40 },
            })
          );
        }

        rows.push(
          new TableRow({
            cantSplit: true,
            children: [
              new TableCell({
                width: { size: msColWidths[0], type: WidthType.DXA },
                margins: { top: 60, bottom: 60, left: 60, right: 60 },
                children: [new Paragraph({ children: [new TextRun({ text: sub.sub_id, bold: true, size: 18, font: 'Arial' })] })],
              }),
              new TableCell({
                width: { size: msColWidths[1], type: WidthType.DXA },
                margins: { top: 60, bottom: 60, left: 60, right: 60 },
                children: cellParagraphs,
              }),
              new TableCell({
                width: { size: msColWidths[2], type: WidthType.DXA },
                margins: { top: 60, bottom: 60, left: 60, right: 60 },
                children: [new Paragraph({ children: [new TextRun({ text: 'Allow ECF from previous part', size: 16, italics: true, color: '4b5563', font: 'Arial' })] })],
              }),
              new TableCell({
                width: { size: msColWidths[3], type: WidthType.DXA },
                margins: { top: 60, bottom: 60, left: 60, right: 60 },
                children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `[${sub.marks || 1}]`, bold: true, size: 18, font: 'Arial' })] })],
              }),
            ],
          })
        );
      });
    } else {
      const ms = q.mark_scheme;
      const points = ms?.marking_points || ['Credit scientifically accurate answer with appropriate working.'];
      const acceptable = ms?.acceptable_answers?.join(', ') || 'Synonymous scientific formulations accepted';
      const guidance = ms?.guidance?.join('; ') || '';
      const traps = ms?.common_misconceptions?.join('; ') || '';

      const cellParagraphs: Paragraph[] = points.map(
        (p) => new Paragraph({ children: [new TextRun({ text: '• ', bold: true, font: 'Arial' }), ...parseFormattedTextChildren(p, { size: 18, font: 'Arial' })], spacing: { after: 30 } })
      );

      if (guidance) {
        cellParagraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: '💡 Examiner Guidance: ', bold: true, size: 16, color: '2563eb', font: 'Arial' }),
              ...parseFormattedTextChildren(guidance, { size: 16, italics: true, font: 'Arial' }),
            ],
            spacing: { before: 40 },
          })
        );
      }

      if (traps) {
        cellParagraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: '⚠️ Common Trap: ', bold: true, size: 16, color: 'd97706', font: 'Arial' }),
              ...parseFormattedTextChildren(traps, { size: 16, italics: true, font: 'Arial' }),
            ],
            spacing: { before: 40 },
          })
        );
      }

      rows.push(
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({
              width: { size: msColWidths[0], type: WidthType.DXA },
              margins: { top: 60, bottom: 60, left: 60, right: 60 },
              children: [new Paragraph({ children: [new TextRun({ text: `Q${qNum}`, bold: true, size: 18, font: 'Arial' })] })],
            }),
            new TableCell({
              width: { size: msColWidths[1], type: WidthType.DXA },
              margins: { top: 60, bottom: 60, left: 60, right: 60 },
              children: cellParagraphs,
            }),
            new TableCell({
              width: { size: msColWidths[2], type: WidthType.DXA },
              margins: { top: 60, bottom: 60, left: 60, right: 60 },
              children: [new Paragraph({ children: parseFormattedTextChildren(acceptable, { size: 16, color: '4b5563', font: 'Arial' }) })],
            }),
            new TableCell({
              width: { size: msColWidths[3], type: WidthType.DXA },
              margins: { top: 60, bottom: 60, left: 60, right: 60 },
              children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `[${q.marks || 1}]`, bold: true, size: 18, font: 'Arial' })] })],
            }),
          ],
        })
      );
    }

    docParagraphs.push(
      new Table({
        width: { size: A4_CONTENT_WIDTH_DXA, type: WidthType.DXA },
        columnWidths: msColWidths,
        layout: TableLayoutType.FIXED,
        rows: rows,
      })
    );

    docParagraphs.push(new Paragraph({ text: '', spacing: { before: 140, after: 140 } }));
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Arial', size: 20 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 850, bottom: 850, left: 850, right: 850 } },
        },
        children: docParagraphs,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const safeTitle = (headerConfig.title || 'Exam_Solutions').replace(/[^a-zA-Z0-9_-]/g, '_');
  await exportFileUniversal(blob, `${safeTitle}_Comprehensive_MarkScheme.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

/**
 * Generates and downloads a dedicated Multiple Choice Bubble Answer Sheet as a .docx file
 */
export async function exportMcqAnswerSheetDocx(
  headerConfig: ExamHeaderConfig,
  questions: Question[],
  options: Partial<ExportLayoutOptions> = {}
) {
  const details = getCambridgeCoverDetails(headerConfig, questions);
  const elements: (Paragraph | Table)[] = [];

  const mcqContentWidthDxa = 10706; // A4 (11906) - left 600 - right 600
  const mcqHeaderColWidths = computeFixedTableColumnWidths(3, mcqContentWidthDxa, { explicitRatios: [35, 30, 35] });

  // Top 2-Logo Header
  try {
    const [schoolImg, cambridgeImg] = await Promise.all([
      loadImageData(options.schoolLogoUrl || details.schoolLogoUrl || DEFAULT_SCHOOL_LOGO),
      loadImageData(details.cambridgeLogoUrl || DEFAULT_CAMBRIDGE_LOGO),
    ]);

    elements.push(
      new Table({
        width: { size: mcqContentWidthDxa, type: WidthType.DXA },
        columnWidths: mcqHeaderColWidths,
        layout: TableLayoutType.FIXED,
        borders: {
          top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
          bottom: { style: BorderStyle.SINGLE, size: 8, color: '111827' },
          left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
          right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        },
        rows: [
          new TableRow({
            cantSplit: true,
            children: [
              new TableCell({
                width: { size: mcqHeaderColWidths[0], type: WidthType.DXA },
                children: schoolImg
                  ? [new Paragraph({ children: [createDocxImageRun(schoolImg, 150, 48)] })]
                  : [new Paragraph({ text: '' })],
              }),
              new TableCell({
                width: { size: mcqHeaderColWidths[1], type: WidthType.DXA },
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new TextRun({ text: 'MULTIPLE CHOICE ANSWER SHEET', bold: true, size: 18, font: 'Arial' }),
                    ],
                  }),
                ],
              }),
              new TableCell({
                width: { size: mcqHeaderColWidths[2], type: WidthType.DXA },
                children: cambridgeImg
                  ? [
                    new Paragraph({
                      alignment: AlignmentType.RIGHT,
                      children: [createDocxImageRun(cambridgeImg, 160, 48)],
                    }),
                  ]
                  : [new Paragraph({ text: '' })],
              }),
            ],
          }),
        ],
      })
    );
  } catch {
    elements.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: 'MULTIPLE CHOICE ANSWER SHEET', bold: true, size: 24, font: 'Arial' })],
        spacing: { after: 120 },
      })
    );
  }

  elements.push(new Paragraph({ text: '', spacing: { before: 80, after: 80 } }));

  // Candidate Box
  elements.push(buildCambridgeCandidateTable(mcqContentWidthDxa));
  elements.push(new Paragraph({ text: '', spacing: { before: 100, after: 100 } }));

  // Instructions
  elements.push(
    new Paragraph({
      children: [
        new TextRun({
          text: 'INSTRUCTIONS: Use a soft pencil (B or HB). Shade ONE letter clearly for each question:  [ A ]  [ B ]  [ C ]  [ D ]',
          italics: true,
          size: 17,
          font: 'Arial',
          color: '334155',
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Bubble Grid (2 or 3 Columns)
  const totalQuestions = questions.length || 40;
  const numCols = totalQuestions > 30 ? 3 : 2;
  const perCol = Math.ceil(totalQuestions / numCols);
  const gridColWidths = computeFixedTableColumnWidths(numCols, mcqContentWidthDxa);

  const gridCells: TableCell[] = [];
  for (let c = 0; c < numCols; c++) {
    const colParagraphs: Paragraph[] = [];
    colParagraphs.push(
      new Paragraph({
        children: [new TextRun({ text: 'Q      A    B    C    D', bold: true, size: 17, font: 'Courier New' })],
        spacing: { after: 60 },
      })
    );

    for (let r = 0; r < perCol; r++) {
      const qNum = c * perCol + r + 1;
      if (qNum <= totalQuestions) {
        const numStr = qNum < 10 ? `0${qNum}` : `${qNum}`;
        colParagraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${numStr}.   (A)  (B)  (C)  (D)`, size: 18, font: 'Courier New' }),
            ],
            spacing: { before: 30, after: 30 },
          })
        );
      }
    }

    gridCells.push(
      new TableCell({
        width: { size: gridColWidths[c], type: WidthType.DXA },
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
        children: colParagraphs,
        borders: {
          top: { style: BorderStyle.SINGLE, size: 4, color: 'cbd5e1' },
          bottom: { style: BorderStyle.SINGLE, size: 4, color: 'cbd5e1' },
          left: { style: BorderStyle.SINGLE, size: 4, color: 'cbd5e1' },
          right: { style: BorderStyle.SINGLE, size: 4, color: 'cbd5e1' },
        },
      })
    );
  }

  elements.push(
    new Table({
      width: { size: mcqContentWidthDxa, type: WidthType.DXA },
      columnWidths: gridColWidths,
      layout: TableLayoutType.FIXED,
      rows: [new TableRow({ cantSplit: true, children: gridCells })],
    })
  );

  elements.push(new Paragraph({ text: '', spacing: { before: 160, after: 160 } }));

  // Score Box
  elements.push(
    new Table({
      width: { size: mcqContentWidthDxa, type: WidthType.DXA },
      columnWidths: [mcqContentWidthDxa],
      layout: TableLayoutType.FIXED,
      rows: [
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({
              width: { size: mcqContentWidthDxa, type: WidthType.DXA },
              margins: { top: 80, bottom: 80, left: 100, right: 100 },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text: 'FOR EXAMINER USE ONLY:   ', bold: true, size: 18, font: 'Arial' }),
                    new TextRun({ text: `Raw Score: _____ / ${details.totalMarks}       Percentage: _____ %       Grade: [       ]`, size: 18, font: 'Arial' }),
                  ],
                }),
              ],
              borders: {
                top: { style: BorderStyle.SINGLE, size: 6, color: '111827' },
                bottom: { style: BorderStyle.SINGLE, size: 6, color: '111827' },
                left: { style: BorderStyle.SINGLE, size: 6, color: '111827' },
                right: { style: BorderStyle.SINGLE, size: 6, color: '111827' },
              },
            }),
          ],
        }),
      ],
    })
  );

  const doc = new Document({
    sections: [
      {
        properties: {
          page: { margin: { top: 600, bottom: 600, left: 600, right: 600 } },
        },
        children: elements,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const safeTitle = (headerConfig.title || 'Exam').replace(/[^a-zA-Z0-9_-]/g, '_');
  await exportFileUniversal(blob, `${safeTitle}_Multiple_Choice_Answer_Sheet.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

/**
 * Generates and downloads a dedicated Cambridge Insert / Resource Booklet as a .docx file.
 * Formatted with Cambridge headers, information box, and high-resolution resource cards matching the PDF layout.
 */
export async function exportInsertBookletDocx(
  headerConfig: Partial<ExamHeaderConfig> = {},
  rawQuestions: Question[] = [],
  options: DocxExportOptions = {}
): Promise<void> {
  const questions = resolveQuestionResources(rawQuestions, {
    autoRenumberFigures: options.autoRenumberFigures ?? true,
  });
  const fontName = 'Arial';
  const schoolLogo = options.schoolLogoUrl || DEFAULT_SCHOOL_LOGO;
  const cambridgeLogo = DEFAULT_CAMBRIDGE_LOGO;

  const docParagraphs: (Paragraph | Table)[] = [];

  // 1. Top Header with Logos
  const insertContentWidthDxa = 10466; // A4 (11906) - left 720 - right 720
  const insertLogoColWidths = computeFixedTableColumnWidths(2, insertContentWidthDxa);
  const schoolImg = await loadImageData(schoolLogo);
  const cambImg = await loadImageData(cambridgeLogo);

  if (schoolImg || cambImg) {
    docParagraphs.push(
      new Table({
        width: { size: insertContentWidthDxa, type: WidthType.DXA },
        columnWidths: insertLogoColWidths,
        layout: TableLayoutType.FIXED,
        rows: [
          new TableRow({
            cantSplit: true,
            children: [
              new TableCell({
                width: { size: insertLogoColWidths[0], type: WidthType.DXA },
                children: [
                  ...(schoolImg
                    ? [
                      new Paragraph({
                        children: [createDocxImageRun(schoolImg, 160, 56)],
                      }),
                    ]
                    : []),
                ],
                borders: {
                  top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
                  bottom: { style: BorderStyle.SINGLE, size: 12, color: '111827' },
                  left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
                  right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
                },
              }),
              new TableCell({
                width: { size: insertLogoColWidths[1], type: WidthType.DXA },
                children: [
                  ...(cambImg
                    ? [
                      new Paragraph({
                        alignment: AlignmentType.RIGHT,
                        children: [createDocxImageRun(cambImg, 180, 56)],
                      }),
                    ]
                    : []),
                ],
                borders: {
                  top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
                  bottom: { style: BorderStyle.SINGLE, size: 12, color: '111827' },
                  left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
                  right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
                },
              }),
            ],
          }),
        ],
      })
    );
    docParagraphs.push(new Paragraph({ text: '', spacing: { before: 120, after: 120 } }));
  }

  // 2. Title & Subject Banner
  const subjectUpper = (headerConfig.subject || 'GEOGRAPHY').toUpperCase();
  docParagraphs.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `${subjectUpper} — INSERT / RESOURCE BOOKLET`,
          bold: true,
          size: 26,
          color: '111827',
          font: fontName,
        }),
      ],
      spacing: { before: 140, after: 60 },
    })
  );

  docParagraphs.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `${headerConfig.title || 'Assessment Resources'}  •  ${headerConfig.subjectCode || '0460'}`,
          bold: true,
          size: 20,
          color: '4B5563',
          font: fontName,
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 3. Information & Instructions Box
  docParagraphs.push(
    new Table({
      width: { size: insertContentWidthDxa, type: WidthType.DXA },
      columnWidths: [insertContentWidthDxa],
      layout: TableLayoutType.FIXED,
      rows: [
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({
              width: { size: insertContentWidthDxa, type: WidthType.DXA },
              margins: { top: 120, bottom: 120, left: 160, right: 160 },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: 'INFORMATION & INSTRUCTIONS:',
                      bold: true,
                      size: 18,
                      font: fontName,
                      color: '111827',
                    }),
                  ],
                  spacing: { after: 80 },
                }),
                new Paragraph({
                  children: [
                    new TextRun({
                      text: '• This insert contains all the resources, figures, maps, tables, case studies, and source extracts referred to in the question paper.\n• You may make any necessary annotations or highlights directly on the insert.\n• This Insert is not assessed. Write your answers only in the question paper / answer booklet.',
                      size: 18,
                      font: fontName,
                      color: '374151',
                    }),
                  ],
                }),
              ],
              borders: {
                top: { style: BorderStyle.SINGLE, size: 8, color: '111827' },
                bottom: { style: BorderStyle.SINGLE, size: 8, color: '111827' },
                left: { style: BorderStyle.SINGLE, size: 8, color: '111827' },
                right: { style: BorderStyle.SINGLE, size: 8, color: '111827' },
              },
            }),
          ],
        }),
      ],
    })
  );

  docParagraphs.push(new Paragraph({ text: '', spacing: { before: 180, after: 180 } }));

  // 4. Resource Cards List
  let itemCount = 0;
  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const q = questions[qIdx];
    const qImg = q.diagram_url || (q as any).image_url || (q as any).diagram_base64;
    const qRef = q.resource_ref;
    const isParentInsert = isInsertResource(q) || Boolean(options.includeAllFiguresInBooklet);

    if (qImg && isParentInsert) {
      itemCount++;
      let topic = q.topic || undefined;
      const titleMatch =
        (q.question_text || '').match(/Study\s+Figs?\.?\s*[0-9.]+\s*(?:\(Insert\))?,?\s*([^.\n]+)/i) ||
        (q.sub_questions?.[0]?.question_text || '').match(
          /Study\s+Figs?\.?\s*[0-9.]+\s*(?:\(Insert\))?,?\s*([^.\n]+)/i
        );
      if (titleMatch) {
        topic = titleMatch[1].trim();
      }

      const headerText = qRef
        ? (/^figs?/i.test(qRef)
          ? `${qRef} for Question ${q.question_number || qIdx + 1}${topic ? ` (${topic})` : ''}`
          : `${qRef} — Resource for Question ${q.question_number || qIdx + 1}${topic ? ` (${topic})` : ''}`)
        : `Resource for Question ${q.question_number || qIdx + 1}${topic ? ` (${topic})` : ''}`;

      docParagraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: headerText,
              bold: true,
              size: 22,
              color: '1E3A8A',
              font: fontName,
            }),
          ],
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E2E8F0', space: 4 },
          },
          spacing: { before: 240, after: 140 },
        })
      );

      const imgData = await loadImageData(qImg);
      if (imgData) {
        docParagraphs.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [createDocxImageRun(imgData, 500, 440)],
            spacing: { before: 100, after: 200 },
          })
        );
      }
    }

    // Check Sub-questions
    for (const sq of q.sub_questions || []) {
      const sqImg = sq.diagram_url || (sq as any).image_url || (sq as any).diagram_base64;
      const sqRef = sq.resource_ref;
      const isSubInsert = isInsertResource(sq) || Boolean(options.includeAllFiguresInBooklet);

      if (sqImg && isSubInsert) {
        itemCount++;
        let sqTopic = q.topic || undefined;
        const subTitleMatch = (sq.question_text || '').match(
          /Study\s+Figs?\.?\s*[0-9.]+\s*(?:\(Insert\))?,?\s*([^.\n]+)/i
        );
        if (subTitleMatch) {
          sqTopic = subTitleMatch[1].trim();
        }

        const sqHeaderText = sqRef
          ? (/^figs?/i.test(sqRef)
            ? `${sqRef} for Question ${q.question_number || qIdx + 1}${sqTopic ? ` (${sqTopic})` : ''}`
            : `${sqRef} — Resource for Question ${q.question_number || qIdx + 1} ${sq.sub_id}${sqTopic ? ` (${sqTopic})` : ''}`)
          : `Resource for Question ${q.question_number || qIdx + 1} ${sq.sub_id}${sqTopic ? ` (${sqTopic})` : ''}`;

        docParagraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: sqHeaderText,
                bold: true,
                size: 22,
                color: '1E3A8A',
                font: fontName,
              }),
            ],
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E2E8F0', space: 4 },
            },
            spacing: { before: 240, after: 140 },
          })
        );

        const sqImgData = await loadImageData(sqImg);
        if (sqImgData) {
          docParagraphs.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [createDocxImageRun(sqImgData, 500, 440)],
              spacing: { before: 100, after: 200 },
            })
          );
        }
      }
    }
  }

  if (itemCount === 0) {
    docParagraphs.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: 'No figures or maps were attached to the questions in this paper.',
            italics: true,
            size: 20,
            color: '64748B',
            font: fontName,
          }),
        ],
        spacing: { before: 300, after: 300 },
      })
    );
  }

  // Assemble Document
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: fontName,
            size: 22,
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 720,
              bottom: 720,
              left: 720,
              right: 720,
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: `${subjectUpper} INSERT — Page `,
                    size: 18,
                    color: '9CA3AF',
                    font: fontName,
                  }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    bold: true,
                    size: 18,
                    color: '4B5563',
                    font: fontName,
                  }),
                ],
              }),
            ],
          }),
        },
        children: docParagraphs,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const safeTitle = (headerConfig.title || 'Exam').replace(/[^a-zA-Z0-9_-]/g, '_');
  await exportFileUniversal(
    blob,
    `${safeTitle}_Insert_Resource_Booklet.docx`,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

