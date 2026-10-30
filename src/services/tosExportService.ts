// ─── Table of Specifications (ToS) Word Export Service ────────────────────────
// Generates a publication-quality Landscape A4 Microsoft Word (.docx)
// Table of Specifications (ToS) matching Cambridge school curriculum requirements,
// including Bloom's Taxonomy cognitive classification (C1 to C6), embedded diagrams,
// formatted question tables, ICM/Cambridge header logos, teacher metadata fill-in box,
// and clickable deep-linked past paper citations.

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
  VerticalAlign,
  BorderStyle,
  Header,
  Footer,
  PageNumber,
  PageOrientation,
  ExternalHyperlink,
  UnderlineType,
} from 'docx';
import { exportFileUniversal } from './fileExportBridge';
import type { Question, CognitiveLevel } from '../types/database';
import { COGNITIVE_LEVEL_META } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';
import { parseFormattedTextToDocxRuns } from './docxExportService';
import { DEFAULT_SCHOOL_LOGO, DEFAULT_CAMBRIDGE_LOGO } from '../assets/logoConstants';
import { parseMcqOption } from '../utils/mcqUtils';
import { extractSvgFromDiagramUrl } from '../lib/gemini';

export interface TosExportOptions {
  schoolName?: string;
  expandSubQuestions?: boolean;
  includeCognitiveSummary?: boolean;
  fontName?: string;
  teacherName?: string;
  gradeSemester?: string;
  examDate?: string;
}

interface TosRowItem {
  no: string;
  topic: string;
  subTopic?: string;
  questionType: 'MC' | 'Essay';
  cognitiveLevel: CognitiveLevel;
  questionElements: (Paragraph | Table)[];
  answerElements: Paragraph[];
  marks: number;
  citationPrefix: string;
  citationBody: string;
  citationText: string;
  citationUrl?: string;
  pageNumber?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Image & Diagram Processing Helpers
// ─────────────────────────────────────────────────────────────────────────────

function base64ToUint8Array(base64: string): Uint8Array {
  const cleanBase64 = base64.replace(/^data:image\/\w+;base64,/, '');
  const binaryString = typeof atob === 'function' ? atob(cleanBase64) : Buffer.from(cleanBase64, 'base64').toString('binary');
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function svgToPngBytes(svgXml: string, targetWidth = 360, targetHeight = 200): Promise<Uint8Array | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  return new Promise((resolve) => {
    try {
      let clean = svgXml.trim();
      if (!clean.includes('xmlns=')) {
        clean = clean.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      const blob = new Blob([clean], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const w = img.naturalWidth || targetWidth;
          const h = img.naturalHeight || targetHeight;
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            canvas.toBlob((b) => {
              URL.revokeObjectURL(url);
              if (!b) { resolve(null); return; }
              b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))).catch(() => resolve(null));
            }, 'image/png');
          } else {
            URL.revokeObjectURL(url);
            resolve(null);
          }
        } catch {
          URL.revokeObjectURL(url);
          resolve(null);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    } catch {
      resolve(null);
    }
  });
}

async function imageUrlToPngBytes(url: string): Promise<Uint8Array | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || 360;
          canvas.height = img.naturalHeight || 200;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((b) => {
              if (!b) { resolve(null); return; }
              b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))).catch(() => resolve(null));
            }, 'image/png');
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    } catch {
      resolve(null);
    }
  });
}

async function loadQuestionImage(
  urlOrSvg: string | null | undefined
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
  if (!urlOrSvg || typeof urlOrSvg !== 'string') return null;
  const trimmed = urlOrSvg.trim();
  if (!trimmed) return null;

  try {
    // 1. Raw SVG string or SVG data URL
    if (trimmed.startsWith('<svg') || trimmed.startsWith('data:image/svg+xml')) {
      const svgXml = trimmed.startsWith('data:image/svg+xml')
        ? decodeURIComponent(trimmed.replace(/^data:image\/svg\+xml;?(?:utf8|base64)?,/, ''))
        : trimmed;
      const pngBytes = await svgToPngBytes(svgXml);
      if (pngBytes) return { data: pngBytes, width: 320, height: 180 };
      return null;
    }

    // 2. Base64 raster data URL (PNG/JPEG)
    if (trimmed.startsWith('data:image/')) {
      const bytes = base64ToUint8Array(trimmed);
      return { data: bytes, width: 320, height: 180 };
    }

    // 3. Remote URL (R2 proxy or Supabase Storage)
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        const pngBytes = await imageUrlToPngBytes(trimmed);
        if (pngBytes) return { data: pngBytes, width: 320, height: 180 };
      }
      const res = await fetch(trimmed);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      return { data: new Uint8Array(buf), width: 320, height: 180 };
    }
  } catch (err) {
    console.warn('Failed to load diagram for ToS export:', err);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown Table & Stem Parser
// ─────────────────────────────────────────────────────────────────────────────

interface ContentBlock {
  type: 'text' | 'table';
  text?: string;
  tableRows?: string[][];
}

function parseStemContentBlocks(rawText: string): ContentBlock[] {
  if (!rawText) return [];

  // Normalize literal \n string escapes to actual newlines
  const text = rawText.replace(/\\n/g, '\n');
  const lines = text.split('\n');
  const blocks: ContentBlock[] = [];
  let currentTextLines: string[] = [];
  let currentTableLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableRow = /^\s*\|(.+)\|\s*$/.test(line);

    if (isTableRow) {
      if (currentTextLines.length > 0) {
        blocks.push({ type: 'text', text: currentTextLines.join('\n') });
        currentTextLines = [];
      }
      currentTableLines.push(line);
    } else {
      if (currentTableLines.length > 0) {
        const tableRows = currentTableLines
          .map((l) => l.trim())
          .filter((l) => l.startsWith('|') && l.endsWith('|'))
          .filter((l) => !/^[\|\s\-:]+$/.test(l))
          .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));

        if (tableRows.length > 0) {
          blocks.push({ type: 'table', tableRows });
        }
        currentTableLines = [];
      }
      currentTextLines.push(line);
    }
  }

  if (currentTableLines.length > 0) {
    const tableRows = currentTableLines
      .map((l) => l.trim())
      .filter((l) => l.startsWith('|') && l.endsWith('|'))
      .filter((l) => !/^[\|\s\-:]+$/.test(l))
      .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));

    if (tableRows.length > 0) {
      blocks.push({ type: 'table', tableRows });
    }
  }

  if (currentTextLines.length > 0) {
    blocks.push({ type: 'text', text: currentTextLines.join('\n') });
  }

  return blocks;
}

/**
 * Builds a clean nested Word table for Markdown tables embedded in question stems.
 */
function buildNestedDocxTable(tableRows: string[][], fontName: string): Table {
  const borderThin = { style: BorderStyle.SINGLE, size: 4, color: '9CA3AF' };
  const cellBorders = {
    top: borderThin,
    bottom: borderThin,
    left: borderThin,
    right: borderThin,
  };

  const colCount = Math.max(...tableRows.map((r) => r.length), 1);
  const colWidthPct = Math.floor(100 / colCount);

  const rows = tableRows.map((rowCells, rIdx) => {
    const isHeader = rIdx === 0;
    return new TableRow({
      tableHeader: isHeader,
      children: rowCells.map((cellText) => {
        return new TableCell({
          width: { size: colWidthPct, type: WidthType.PERCENTAGE },
          borders: cellBorders,
          shading: isHeader ? { fill: 'F3F4F6' } : undefined,
          verticalAlign: VerticalAlign.CENTER,
          margins: { top: 70, bottom: 70, left: 90, right: 90 },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  text: cellText,
                  bold: isHeader || /^[A-D]$/i.test(cellText),
                  size: 17,
                  font: fontName,
                  color: isHeader ? '111827' : '374151',
                }),
              ],
            }),
          ],
        });
      }),
    });
  });

  return new Table({
    width: { size: 95, type: WidthType.PERCENTAGE },
    alignment: AlignmentType.CENTER,
    rows,
  });
}

/**
 * Builds formatted past paper citation text and direct page link URL.
 */
function buildCitationInfo(
  q: Question,
  subPart?: string
): { citationPrefix: string; citationBody: string; citationText: string; citationUrl?: string; pageNumber?: number | null } {
  const parts: string[] = [];

  const paper = q.paper_number !== null && q.paper_number !== undefined ? `Paper ${q.paper_number}` : '';
  const season = q.series || '';
  const year = q.year ? String(q.year) : '';
  const qNum = q.question_number ? `Q${q.question_number}${subPart ? `(${subPart})` : ''}` : '';

  if (paper) parts.push(paper);
  if (season || year) parts.push([season, year].filter(Boolean).join(' '));
  if (qNum) parts.push(qNum);

  const citationPrefix = 'IGCSE Level:';
  let citationBody = parts.length > 0 ? parts.join(' ') : 'Past Paper Reference';

  const pageNum = q.page_number ?? (q.mark_scheme as any)?._page_number ?? null;
  let citationUrl = q.source_pdf_url || (q.mark_scheme as any)?._source_pdf_url || undefined;

  if (citationUrl && pageNum && !citationUrl.includes('#page=')) {
    citationUrl = `${citationUrl}#page=${pageNum}`;
  }

  if (pageNum && !citationBody.includes('p.')) {
    citationBody += ` (p. ${pageNum})`;
  }

  const citationText = `${citationPrefix} ${citationBody}`;

  return { citationPrefix, citationBody, citationText, citationUrl, pageNumber: pageNum };
}

/**
 * Checks whether MCQ options are redundant with rows already in an embedded table.
 */
function areOptionsRedundant(options: string[] | undefined, tableRows?: string[][]): boolean {
  if (!options || options.length === 0) return true;
  if (!tableRows || tableRows.length === 0) return false;

  // If options are literally ['A', 'B', 'C', 'D']
  const isPureLetters = options.every((opt, idx) => {
    const expected = String.fromCharCode(65 + idx);
    const cleaned = opt.trim().toUpperCase();
    return cleaned === expected || cleaned === `${expected}.` || cleaned === `OPTION ${expected}`;
  });

  if (isPureLetters) return true;

  // If first column of table rows matches A, B, C, D
  const tableRowKeys = tableRows.slice(1).map((r) => r[0]?.trim().toUpperCase());
  const hasMatchingKeys = ['A', 'B', 'C', 'D'].every((k) => tableRowKeys.includes(k));
  return hasMatchingKeys;
}

/**
 * Asynchronously normalizes question and sub-question items into flat ToS table rows,
 * loading embedded diagrams and parsing nested markdown tables.
 */
async function prepareTosRowsAsync(
  questions: Question[],
  expandSubQuestions: boolean,
  fontName: string
): Promise<TosRowItem[]> {
  const rows: TosRowItem[] = [];

  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const q = questions[qIdx];
    const qIndex = qIdx + 1;
    const isMcq = q.question_style === 'Multiple Choice' || (Array.isArray(q.options) && q.options.length > 0);
    const mainTopic = q.topic?.trim() || 'General';
    const subTopic = q.sub_topic?.trim() || '';
    const hasSubQuestions = Boolean(q.sub_questions && q.sub_questions.length > 0);

    if (expandSubQuestions && hasSubQuestions && !isMcq) {
      // Expand each sub-question into its own distinct row
      for (let sIdx = 0; sIdx < q.sub_questions!.length; sIdx++) {
        const sq = q.sub_questions![sIdx];
        const subPart = sq.sub_id ? sq.sub_id.replace(/[()]/g, '') : String.fromCharCode(97 + sIdx);
        const cogLevel: CognitiveLevel = sq.cognitive_level || q.cognitive_level || 'C2';
        const { citationPrefix, citationBody, citationText, citationUrl, pageNumber } = buildCitationInfo(q, subPart);

        const questionElements: (Paragraph | Table)[] = [];

        // Check if subquestion or parent has a diagram
        const diagramRef = sq.diagram_url || sq.svg_content || (sIdx === 0 ? (q.diagram_url || q.svg_content) : null);
        const imgData = await loadQuestionImage(diagramRef);

        const cleanText = (sq.question_text || '').replace(/\\n/g, '\n');
        const blocks = parseStemContentBlocks(cleanText);

        blocks.forEach((b) => {
          if (b.type === 'text' && b.text) {
            const lines = b.text.split('\n').filter((l) => l.trim().length > 0);
            lines.forEach((line) => {
              questionElements.push(
                new Paragraph({
                  alignment: AlignmentType.LEFT,
                  spacing: { before: 40, after: 60, line: 260 },
                  children: parseFormattedTextToDocxRuns(line, { size: 18, font: fontName }),
                })
              );
            });
          } else if (b.type === 'table' && b.tableRows) {
            questionElements.push(buildNestedDocxTable(b.tableRows, fontName));
          }
        });

        // Insert diagram image if present
        if (imgData) {
          questionElements.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 80, after: 80 },
              children: [
                new ImageRun({
                  data: imgData.data,
                  transformation: { width: Math.min(imgData.width, 320), height: Math.min(imgData.height, 180) },
                  type: 'png',
                }),
              ],
            })
          );
        }

        // Answer / Mark scheme
        const answerElements: Paragraph[] = [];
        const answerText = sq.mark_scheme || '';
        if (answerText) {
          const lines = answerText.replace(/\\n/g, '\n').split('\n').filter((l) => l.trim().length > 0);
          lines.forEach((line) => {
            answerElements.push(
              new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 40, after: 60, line: 260 },
                children: parseFormattedTextToDocxRuns(line, { size: 18, font: fontName }),
              })
            );
          });
        } else {
          answerElements.push(
            new Paragraph({
              children: [
                new TextRun({ text: 'Answer on student script', italics: true, size: 18, font: fontName, color: '6B7280' }),
              ],
            })
          );
        }

        rows.push({
          no: `${qIndex}(${subPart})`,
          topic: mainTopic,
          subTopic,
          questionType: 'Essay',
          cognitiveLevel: cogLevel,
          questionElements,
          answerElements,
          marks: sq.marks || 1,
          citationPrefix,
          citationBody,
          citationText,
          citationUrl,
          pageNumber,
        });
      }
    } else {
      // Single row for parent question
      const cogLevel: CognitiveLevel = q.cognitive_level || 'C2';
      const { citationPrefix, citationBody, citationText, citationUrl, pageNumber } = buildCitationInfo(q);

      const questionElements: (Paragraph | Table)[] = [];

      // Check if question has a diagram
      const diagramRef = q.diagram_url || q.svg_content || extractSvgFromDiagramUrl(q.diagram_url);
      const imgData = await loadQuestionImage(diagramRef);

      const cleanStem = (q.question_text || '').replace(/\\n/g, '\n');
      const blocks = parseStemContentBlocks(cleanStem);

      let embeddedTableRows: string[][] | undefined;

      blocks.forEach((b) => {
        if (b.type === 'text' && b.text) {
          const lines = b.text.split('\n').filter((l) => l.trim().length > 0);
          lines.forEach((line) => {
            questionElements.push(
              new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 40, after: 60, line: 260 },
                children: parseFormattedTextToDocxRuns(line, { size: 18, font: fontName }),
              })
            );
          });
        } else if (b.type === 'table' && b.tableRows) {
          embeddedTableRows = b.tableRows;
          questionElements.push(buildNestedDocxTable(b.tableRows, fontName));
        }
      });

      // Insert diagram image if present
      if (imgData) {
        questionElements.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 80, after: 80 },
            children: [
              new ImageRun({
                data: imgData.data,
                transformation: { width: Math.min(imgData.width, 320), height: Math.min(imgData.height, 180) },
                type: 'png',
              }),
            ],
          })
        );
      }

      // If MCQ, append choices A, B, C, D unless redundant with embedded table
      if (isMcq && q.options && q.options.length > 0) {
        const redundant = areOptionsRedundant(q.options, embeddedTableRows);
        if (!redundant) {
          q.options.forEach((opt, optIdx) => {
            const { letter, text } = parseMcqOption(opt, optIdx);
            questionElements.push(
              new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 30, after: 40, line: 240 },
                children: [
                  new TextRun({ text: `${letter}.  `, bold: true, size: 18, font: fontName, color: '111827' }),
                  ...parseFormattedTextToDocxRuns(text, { size: 18, font: fontName }),
                ],
              })
            );
          });
        }
      }

      // Build answer elements
      const answerElements: Paragraph[] = [];
      if (isMcq) {
        const msAny = q.mark_scheme as any;
        const rawAns =
          (q as any).correct_answer ||
          (Array.isArray(msAny?.marking_points) ? msAny.marking_points[0] : null) ||
          (Array.isArray(msAny?.acceptable_answers) ? msAny.acceptable_answers[0] : null) ||
          (typeof q.mark_scheme === 'string' ? q.mark_scheme : '');
        const match = String(rawAns).match(/\b([A-D])\b/i);
        const letter = match ? match[1].toUpperCase() : String(rawAns).trim();

        answerElements.push(
          new Paragraph({
            alignment: AlignmentType.LEFT,
            spacing: { before: 40, after: 60 },
            children: [
              new TextRun({
                text: letter ? `The Answer is ${letter}` : 'Refer to mark scheme',
                bold: true,
                size: 19,
                font: fontName,
                color: '111827',
              }),
            ],
          })
        );

        if (msAny && Array.isArray(msAny.marking_points) && msAny.marking_points.length > 1) {
          const addPoints = msAny.marking_points.slice(1);
          addPoints.forEach((pt: string) => {
            answerElements.push(
              new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 30, after: 30 },
                children: parseFormattedTextToDocxRuns(String(pt), { size: 17, font: fontName }),
              })
            );
          });
        }
      } else {
        let msText = '';
        if (typeof q.mark_scheme === 'string') {
          msText = q.mark_scheme;
        } else if (q.mark_scheme && Array.isArray(q.mark_scheme.marking_points)) {
          msText = q.mark_scheme.marking_points.join('\n');
        }

        if (msText) {
          const lines = msText.replace(/\\n/g, '\n').split('\n').filter((l) => l.trim().length > 0);
          lines.forEach((line) => {
            answerElements.push(
              new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 40, after: 60, line: 260 },
                children: parseFormattedTextToDocxRuns(line, { size: 18, font: fontName }),
              })
            );
          });
        } else {
          answerElements.push(
            new Paragraph({
              children: [
                new TextRun({ text: 'Answer on student script', italics: true, size: 18, font: fontName, color: '6B7280' }),
              ],
            })
          );
        }
      }

      rows.push({
        no: String(qIndex),
        topic: mainTopic,
        subTopic,
        questionType: isMcq ? 'MC' : 'Essay',
        cognitiveLevel: cogLevel,
        questionElements,
        answerElements,
        marks: q.marks || 1,
        citationPrefix,
        citationBody,
        citationText,
        citationUrl,
        pageNumber,
      });
    }
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document Structure & Table Builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the top header table displaying ICM and Cambridge International logos.
 */
function buildLogosHeaderTable(): Table {
  try {
    const schoolBytes = base64ToUint8Array(DEFAULT_SCHOOL_LOGO);
    const cambridgeBytes = base64ToUint8Array(DEFAULT_CAMBRIDGE_LOGO);

    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        bottom: { style: BorderStyle.SINGLE, size: 10, color: '1E3A8A' },
        left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              borders: {
                top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
                bottom: { style: BorderStyle.SINGLE, size: 10, color: '1E3A8A' },
                left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
                right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
              },
              margins: { bottom: 120, top: 40, left: 0, right: 0 },
              verticalAlign: VerticalAlign.CENTER,
              children: [
                new Paragraph({
                  alignment: AlignmentType.LEFT,
                  children: [
                    new ImageRun({
                      data: schoolBytes,
                      transformation: { width: 147, height: 47 },
                      type: 'png',
                    }),
                  ],
                }),
              ],
            }),
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              borders: {
                top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
                bottom: { style: BorderStyle.SINGLE, size: 10, color: '1E3A8A' },
                left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
                right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
              },
              margins: { bottom: 120, top: 40, left: 0, right: 0 },
              verticalAlign: VerticalAlign.CENTER,
              children: [
                new Paragraph({
                  alignment: AlignmentType.RIGHT,
                  children: [
                    new ImageRun({
                      data: cambridgeBytes,
                      transformation: { width: 158, height: 47 },
                      type: 'png',
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    });
  } catch (err) {
    console.warn('Failed to build logos table for ToS:', err);
    return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [] });
  }
}

/**
 * Builds the Assessment and Teacher Fill-in Information Box.
 */
function buildMetadataFillinTable(
  headerConfig: ExamHeaderConfig,
  totalItems: number,
  totalMarks: number,
  options: TosExportOptions,
  fontName: string
): Table {
  const borderBox = { style: BorderStyle.SINGLE, size: 6, color: '9CA3AF' };
  const cellBorders = {
    top: borderBox,
    bottom: borderBox,
    left: borderBox,
    right: borderBox,
  };

  const schoolTitle = options.schoolName || headerConfig.schoolName || 'Insan Cendekia Madani';
  const assessmentTitle = headerConfig.title || 'Curriculum Assessment';
  const subjectDisplay = headerConfig.subject
    ? `${headerConfig.subject}${headerConfig.subjectCode ? ` (${headerConfig.subjectCode})` : ''}`
    : 'Cambridge Assessment (0620)';
  const teacherDisplay = options.teacherName || '........................................................................';
  const gradeSemesterDisplay = options.gradeSemester || 'Grade 10 / Semester 1';
  const dateDisplay = options.examDate || '................................................';
  const durationDisplay = `${headerConfig.durationMinutes || 60} Minutes`;

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: cellBorders,
    rows: [
      new TableRow({
        children: [
          // Left Metadata Column
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: cellBorders,
            shading: { fill: 'F9FAFB' },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 90, bottom: 90, left: 140, right: 140 },
            children: [
              new Paragraph({
                spacing: { before: 20, after: 40 },
                children: [
                  new TextRun({ text: 'Institution: ', bold: true, size: 19, font: fontName, color: '1E3A8A' }),
                  new TextRun({ text: schoolTitle, size: 19, font: fontName, color: '111827' }),
                ],
              }),
              new Paragraph({
                spacing: { before: 20, after: 40 },
                children: [
                  new TextRun({ text: 'Subject / Syllabus: ', bold: true, size: 19, font: fontName, color: '1E3A8A' }),
                  new TextRun({ text: subjectDisplay, size: 19, font: fontName, color: '111827' }),
                ],
              }),
              new Paragraph({
                spacing: { before: 20, after: 40 },
                children: [
                  new TextRun({ text: 'Teacher Name: ', bold: true, size: 19, font: fontName, color: '1E3A8A' }),
                  new TextRun({ text: teacherDisplay, size: 19, font: fontName, color: '111827' }),
                ],
              }),
              new Paragraph({
                spacing: { before: 20, after: 20 },
                children: [
                  new TextRun({ text: 'Grade / Semester: ', bold: true, size: 19, font: fontName, color: '1E3A8A' }),
                  new TextRun({ text: gradeSemesterDisplay, size: 19, font: fontName, color: '111827' }),
                ],
              }),
            ],
          }),

          // Right Metadata Column
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: cellBorders,
            shading: { fill: 'F9FAFB' },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 90, bottom: 90, left: 140, right: 140 },
            children: [
              new Paragraph({
                spacing: { before: 20, after: 40 },
                children: [
                  new TextRun({ text: 'Assessment Title: ', bold: true, size: 19, font: fontName, color: '1E3A8A' }),
                  new TextRun({ text: assessmentTitle, bold: true, size: 19, font: fontName, color: '111827' }),
                ],
              }),
              new Paragraph({
                spacing: { before: 20, after: 40 },
                children: [
                  new TextRun({ text: 'Date: ', bold: true, size: 19, font: fontName, color: '1E3A8A' }),
                  new TextRun({ text: dateDisplay, size: 19, font: fontName, color: '111827' }),
                ],
              }),
              new Paragraph({
                spacing: { before: 20, after: 40 },
                children: [
                  new TextRun({ text: 'Time Allocation: ', bold: true, size: 19, font: fontName, color: '1E3A8A' }),
                  new TextRun({ text: durationDisplay, size: 19, font: fontName, color: '111827' }),
                ],
              }),
              new Paragraph({
                spacing: { before: 20, after: 20 },
                children: [
                  new TextRun({ text: 'Total Items: ', bold: true, size: 19, font: fontName, color: '1E3A8A' }),
                  new TextRun({ text: `${totalItems} items    |    `, size: 19, font: fontName, color: '111827' }),
                  new TextRun({ text: 'Total Marks: ', bold: true, size: 19, font: fontName, color: '1E3A8A' }),
                  new TextRun({ text: `${totalMarks} marks`, bold: true, size: 19, font: fontName, color: '111827' }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

/**
 * Builds the Bloom's Taxonomy Cognitive Level Summary Distribution Table.
 */
function buildCognitiveSummaryTable(rows: TosRowItem[], fontName: string): Table {
  const borderThin = { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' };
  const cellBorders = {
    top: borderThin,
    bottom: borderThin,
    left: borderThin,
    right: borderThin,
  };

  const levelOrder: CognitiveLevel[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
  const totalMarks = rows.reduce((acc, r) => acc + (r.marks || 0), 0);
  const totalItems = rows.length;

  const headerCells = [
    { text: 'Cognitive Level', width: 2000, align: AlignmentType.LEFT },
    { text: 'Category / Descriptor', width: 4400, align: AlignmentType.LEFT },
    { text: 'Question Items', width: 2200, align: AlignmentType.CENTER },
    { text: 'Marks', width: 2200, align: AlignmentType.CENTER },
    { text: 'Mark Share (%)', width: 2400, align: AlignmentType.CENTER },
  ];

  const summaryRows: TableRow[] = [
    // Header Row
    new TableRow({
      tableHeader: true,
      children: headerCells.map(
        (col) =>
          new TableCell({
            width: { size: col.width, type: WidthType.DXA },
            shading: { fill: 'E5E7EB' },
            borders: cellBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: [
              new Paragraph({
                alignment: col.align,
                children: [new TextRun({ text: col.text, bold: true, size: 18, font: fontName, color: '111827' })],
              }),
            ],
          })
      ),
    }),
  ];

  levelOrder.forEach((lvl) => {
    const meta = COGNITIVE_LEVEL_META[lvl];
    const itemsInLevel = rows.filter((r) => r.cognitiveLevel === lvl);
    const count = itemsInLevel.length;
    const marks = itemsInLevel.reduce((acc, r) => acc + (r.marks || 0), 0);
    const pct = totalMarks > 0 ? ((marks / totalMarks) * 100).toFixed(1) : '0.0';

    summaryRows.push(
      new TableRow({
        children: [
          new TableCell({
            width: { size: 2000, type: WidthType.DXA },
            borders: cellBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: lvl, bold: true, size: 18, font: fontName, color: '1E3A8A' }),
                ],
              }),
            ],
          }),
          new TableCell({
            width: { size: 4400, type: WidthType.DXA },
            borders: cellBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: `${meta.category} (${meta.actionVerbs.slice(0, 3).join(', ')})`, size: 18, font: fontName, color: '374151' }),
                ],
              }),
            ],
          }),
          new TableCell({
            width: { size: 2200, type: WidthType.DXA },
            borders: cellBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: String(count), size: 18, font: fontName, color: '111827' })],
              }),
            ],
          }),
          new TableCell({
            width: { size: 2200, type: WidthType.DXA },
            borders: cellBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: String(marks), bold: true, size: 18, font: fontName, color: '111827' })],
              }),
            ],
          }),
          new TableCell({
            width: { size: 2400, type: WidthType.DXA },
            borders: cellBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: `${pct}%`, size: 18, font: fontName, color: '111827' })],
              }),
            ],
          }),
        ],
      })
    );
  });

  // Total Summary Row
  summaryRows.push(
    new TableRow({
      children: [
        new TableCell({
          width: { size: 2000, type: WidthType.DXA },
          shading: { fill: 'F3F4F6' },
          borders: cellBorders,
          verticalAlign: VerticalAlign.CENTER,
          margins: { top: 90, bottom: 90, left: 120, right: 120 },
          children: [
            new Paragraph({
              children: [new TextRun({ text: 'Total', bold: true, size: 18, font: fontName, color: '111827' })],
            }),
          ],
        }),
        new TableCell({
          width: { size: 4400, type: WidthType.DXA },
          shading: { fill: 'F3F4F6' },
          borders: cellBorders,
          verticalAlign: VerticalAlign.CENTER,
          margins: { top: 90, bottom: 90, left: 120, right: 120 },
          children: [
            new Paragraph({
              children: [new TextRun({ text: 'Complete Assessment Distribution', italics: true, size: 18, font: fontName, color: '4B5563' })],
            }),
          ],
        }),
        new TableCell({
          width: { size: 2200, type: WidthType.DXA },
          shading: { fill: 'F3F4F6' },
          borders: cellBorders,
          verticalAlign: VerticalAlign.CENTER,
          margins: { top: 90, bottom: 90, left: 120, right: 120 },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: String(totalItems), bold: true, size: 18, font: fontName, color: '111827' })],
            }),
          ],
        }),
        new TableCell({
          width: { size: 2200, type: WidthType.DXA },
          shading: { fill: 'F3F4F6' },
          borders: cellBorders,
          verticalAlign: VerticalAlign.CENTER,
          margins: { top: 90, bottom: 90, left: 120, right: 120 },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: String(totalMarks), bold: true, size: 18, font: fontName, color: '111827' })],
            }),
          ],
        }),
        new TableCell({
          width: { size: 2400, type: WidthType.DXA },
          shading: { fill: 'F3F4F6' },
          borders: cellBorders,
          verticalAlign: VerticalAlign.CENTER,
          margins: { top: 90, bottom: 90, left: 120, right: 120 },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: '100.0%', bold: true, size: 18, font: fontName, color: '111827' })],
            }),
          ],
        }),
      ],
    })
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: summaryRows,
  });
}

/**
 * Generates and downloads the Table of Specifications Word (.docx) document.
 */
export async function exportTableOfSpecificationsDocx(
  headerConfig: ExamHeaderConfig,
  questions: Question[],
  options: TosExportOptions = {}
): Promise<void> {
  const fontName = options.fontName || 'Calibri';
  const expandSubQuestions = options.expandSubQuestions ?? true;
  const includeCognitiveSummary = options.includeCognitiveSummary ?? true;

  // 1. Asynchronously prepare rows, loading diagrams and parsing content blocks
  const rows = await prepareTosRowsAsync(questions, expandSubQuestions, fontName);
  const totalMarks = rows.reduce((acc, r) => acc + (r.marks || 0), 0);
  const totalItems = rows.length;

  // Column definitions matching the user's school Table of Specifications
  // Printable landscape width: 16838 - 1440 = 15398 dxa
  const colWidths = {
    no: 600,
    coreSupplement: 1750,
    typeOfQuestion: 750,
    cognitiveLevels: 800,
    question: 5100,
    answer: 2848,
    marks: 550,
    citation: 3000,
  };

  const borderBlack = { style: BorderStyle.SINGLE, size: 6, color: '111827' };
  const borderCell = { style: BorderStyle.SINGLE, size: 4, color: '9CA3AF' };

  const cellBorders = {
    top: borderCell,
    bottom: borderCell,
    left: borderCell,
    right: borderCell,
  };

  const headerBorders = {
    top: borderBlack,
    bottom: borderBlack,
    left: borderBlack,
    right: borderBlack,
  };

  // 2. Build Main ToS Table Header Row
  const headerCols = [
    { text: 'No', width: colWidths.no, align: AlignmentType.CENTER },
    { text: 'Core/Supplement', width: colWidths.coreSupplement, align: AlignmentType.CENTER },
    { text: 'Type of Question\u00B9', width: colWidths.typeOfQuestion, align: AlignmentType.CENTER },
    { text: 'Cognitive Levels\u00B2', width: colWidths.cognitiveLevels, align: AlignmentType.CENTER },
    { text: 'Question', width: colWidths.question, align: AlignmentType.CENTER },
    { text: 'Answer', width: colWidths.answer, align: AlignmentType.CENTER },
    { text: 'Marks', width: colWidths.marks, align: AlignmentType.CENTER },
    { text: 'Citation\u2074', width: colWidths.citation, align: AlignmentType.CENTER },
  ];

  const mainTableRows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: headerCols.map(
        (col) =>
          new TableCell({
            width: { size: col.width, type: WidthType.DXA },
            shading: { fill: 'D9D9D9' },
            borders: headerBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 120, bottom: 120, left: 100, right: 100 },
            children: [
              new Paragraph({
                alignment: col.align,
                children: [new TextRun({ text: col.text, bold: true, size: 18, font: fontName, color: '111827' })],
              }),
            ],
          })
      ),
    }),
  ];

  // 3. Build Question Item Rows
  rows.forEach((row) => {
    // Citation cell children: shows source reference and the raw clickable URL
    const citationChildren: Paragraph[] = [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { before: 20, after: 20, line: 240 },
        children: [
          new TextRun({
            text: `${row.citationPrefix} ${row.citationBody}`,
            bold: true,
            size: 16,
            font: fontName,
            color: '111827',
          }),
        ],
      }),
    ];

    if (row.citationUrl) {
      citationChildren.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { before: 0, after: 20, line: 220 },
          children: [
            new ExternalHyperlink({
              children: [
                new TextRun({
                  text: row.citationUrl,
                  size: 12,
                  font: fontName,
                  color: '0563C1',
                  underline: { type: UnderlineType.SINGLE },
                }),
              ],
              link: row.citationUrl,
            }),
          ],
        })
      );
    } else {
      citationChildren.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { before: 0, after: 20 },
          children: [
            new TextRun({ text: '(PDF link pending)', italics: true, size: 13, font: fontName, color: '9CA3AF' }),
          ],
        })
      );
    }

    mainTableRows.push(
      new TableRow({
        children: [
          // No
          new TableCell({
            width: { size: colWidths.no, type: WidthType.DXA },
            borders: cellBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 90, bottom: 90, left: 80, right: 80 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: row.no, bold: true, size: 18, font: fontName, color: '111827' })],
              }),
            ],
          }),

          // Core / Supplement
          new TableCell({
            width: { size: colWidths.coreSupplement, type: WidthType.DXA },
            borders: cellBorders,
            verticalAlign: VerticalAlign.TOP,
            margins: { top: 90, bottom: 90, left: 100, right: 100 },
            children: [
              new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 0, after: row.subTopic ? 20 : 40, line: 240 },
                children: [new TextRun({ text: row.topic || 'General', bold: true, size: 17, font: fontName, color: '111827' })],
              }),
              ...(row.subTopic
                ? [
                    new Paragraph({
                      alignment: AlignmentType.LEFT,
                      spacing: { before: 0, after: 40, line: 230 },
                      children: [new TextRun({ text: row.subTopic, size: 16, font: fontName, color: '374151' })],
                    }),
                  ]
                : []),
            ],
          }),

          // Type of Question
          new TableCell({
            width: { size: colWidths.typeOfQuestion, type: WidthType.DXA },
            borders: cellBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 90, bottom: 90, left: 80, right: 80 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: row.questionType, bold: true, size: 18, font: fontName, color: '111827' })],
              }),
            ],
          }),

          // Cognitive Levels
          new TableCell({
            width: { size: colWidths.cognitiveLevels, type: WidthType.DXA },
            borders: cellBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 90, bottom: 90, left: 80, right: 80 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: row.cognitiveLevel, bold: true, size: 19, font: fontName, color: '111827' })],
              }),
            ],
          }),

          // Question (includes stem, embedded tables, diagrams, and options)
          new TableCell({
            width: { size: colWidths.question, type: WidthType.DXA },
            borders: cellBorders,
            verticalAlign: VerticalAlign.TOP,
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: row.questionElements,
          }),

          // Answer
          new TableCell({
            width: { size: colWidths.answer, type: WidthType.DXA },
            borders: cellBorders,
            verticalAlign: VerticalAlign.TOP,
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: row.answerElements,
          }),

          // Marks
          new TableCell({
            width: { size: colWidths.marks, type: WidthType.DXA },
            borders: cellBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 90, bottom: 90, left: 80, right: 80 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: String(row.marks), bold: true, size: 19, font: fontName, color: '111827' })],
              }),
            ],
          }),

          // Citation
          new TableCell({
            width: { size: colWidths.citation, type: WidthType.DXA },
            borders: cellBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 90, bottom: 90, left: 100, right: 100 },
            children: citationChildren,
          }),
        ],
      })
    );
  });

  const tosTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: mainTableRows,
  });

  // 4. Assemble complete document body
  const docChildren: (Paragraph | Table)[] = [];

  // A. Top Logos Header Table (ICM on left, Cambridge on right)
  docChildren.push(buildLogosHeaderTable());
  docChildren.push(new Paragraph({ text: '', spacing: { before: 100, after: 80 } }));

  // B. Document Title
  docChildren.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 40, after: 60 },
      children: [
        new TextRun({
          text: 'TABLE OF SPECIFICATIONS (TOS)',
          bold: true,
          size: 28,
          font: fontName,
          color: '111827',
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 140 },
      children: [
        new TextRun({
          text: 'CAMBRIDGE CURRICULUM ASSESSMENT BLUEPRINT',
          bold: true,
          size: 18,
          font: fontName,
          color: '1E3A8A',
        }),
      ],
    })
  );

  // C. Metadata Fill-in Table
  docChildren.push(buildMetadataFillinTable(headerConfig, totalItems, totalMarks, options, fontName));
  docChildren.push(new Paragraph({ text: '', spacing: { before: 100, after: 120 } }));

  // D. Cognitive Taxonomy Summary (optional)
  if (includeCognitiveSummary) {
    docChildren.push(
      new Paragraph({
        spacing: { before: 80, after: 80 },
        children: [
          new TextRun({
            text: "Bloom's Taxonomy Cognitive Distribution Summary",
            bold: true,
            size: 20,
            font: fontName,
            color: '1F2937',
          }),
        ],
      })
    );
    docChildren.push(buildCognitiveSummaryTable(rows, fontName));
    docChildren.push(new Paragraph({ text: '', spacing: { before: 140, after: 160 } }));
  }

  // E. Section heading for Main Specifications Table
  docChildren.push(
    new Paragraph({
      spacing: { before: 80, after: 80 },
      children: [
        new TextRun({
          text: 'Item Specifications & Citations Table',
          bold: true,
          size: 20,
          font: fontName,
          color: '1F2937',
        }),
      ],
    })
  );

  // F. Main ToS Table
  docChildren.push(tosTable);

  // G. Footnotes at bottom
  docChildren.push(
    new Paragraph({
      spacing: { before: 200, after: 40 },
      children: [
        new TextRun({
          text: '\u00B9 Type of Question: ',
          bold: true,
          size: 16,
          font: fontName,
          color: '374151',
        }),
        new TextRun({
          text: 'MC = Multiple Choice, Essay = Structured / Short Answer / Extended Theory',
          size: 16,
          font: fontName,
          color: '4B5563',
        }),
      ],
    }),
    new Paragraph({
      spacing: { before: 40, after: 40 },
      children: [
        new TextRun({
          text: '\u00B2 Cognitive Levels: ',
          bold: true,
          size: 16,
          font: fontName,
          color: '374151',
        }),
        new TextRun({
          text: "Bloom's Taxonomy: C1 (Remembering), C2 (Understanding), C3 (Applying), C4 (Analyzing), C5 (Evaluating), C6 (Creating)",
          size: 16,
          font: fontName,
          color: '4B5563',
        }),
      ],
    }),
    new Paragraph({
      spacing: { before: 40, after: 120 },
      children: [
        new TextRun({
          text: '\u2074 Citation: ',
          bold: true,
          size: 16,
          font: fontName,
          color: '374151',
        }),
        new TextRun({
          text: 'Cambridge past paper source reference with clickable deep-link to the exact question page in the Question Paper PDF',
          size: 16,
          font: fontName,
          color: '4B5563',
        }),
      ],
    })
  );

  // 5. Construct complete Word Document in Landscape A4
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: {
              orientation: PageOrientation.LANDSCAPE,
              width: 11906,
              height: 16838,
            },
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
                    text: 'Insan Cendekia Madani  |  Cambridge Assessment International Education : Table of Specifications (ToS)',
                    size: 15,
                    color: '9CA3AF',
                    font: fontName,
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: 'Page ',
                    size: 16,
                    color: '9CA3AF',
                    font: fontName,
                  }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    bold: true,
                    size: 16,
                    color: '4B5563',
                    font: fontName,
                  }),
                ],
              }),
            ],
          }),
        },
        children: docChildren,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const safeTitle = (headerConfig.title || 'Exam').replace(/[^a-zA-Z0-9_-]/g, '_');
  await exportFileUniversal(
    blob,
    `${safeTitle}_Table_of_Specifications.docx`,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}
