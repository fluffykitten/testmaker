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
} from 'docx';
import { saveAs } from 'file-saver';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';
import type { ExportLayoutOptions } from '../types/exportTemplates';
import { getCambridgeCoverDetails } from './cambridgeCoverService';
import { DEFAULT_SCHOOL_LOGO, DEFAULT_CAMBRIDGE_LOGO } from '../assets/logoConstants';
import { parseMcqOption } from '../utils/mcqUtils';

export interface DocxExportOptions extends Partial<ExportLayoutOptions> {
  includeMarkSchemeInStudentPaper?: boolean;
}

/**
 * Fetches and prepares image data (PNG/JPEG) for Word ImageRun embedding.
 */
async function loadImageData(urlOrBase64: string): Promise<{ data: Uint8Array; width: number; height: number } | null> {
  try {
    if (!urlOrBase64) return null;

    if (urlOrBase64.startsWith('data:')) {
      const parts = urlOrBase64.split(',');
      const base64Part = parts[1];
      if (!base64Part) return null;
      const binaryStr = atob(base64Part);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      return { data: bytes, width: 380, height: 220 };
    }

    const res = await fetch(urlOrBase64);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    return { data: bytes, width: 380, height: 220 };
  } catch (err) {
    console.warn('Failed to load diagram for DOCX export:', err);
    return null;
  }
}

/**
 * Transforms raw text containing LaTeX math, Markdown, HTML sub/sup tags,
 * and scientific notation into docx `TextRun` objects with native `subScript` and `superScript`.
 */
export function parseFormattedTextToDocxRuns(
  rawText: string,
  baseOpts: { size?: number; bold?: boolean; color?: string; italics?: boolean; font?: string } = {}
): TextRun[] {
  if (!rawText) return [];

  // Step 1: Pre-process common LaTeX math symbols and standard chemistry/physics replacements
  let processed = rawText
    // Replace arrows & special math symbols
    .replace(/\\xrightarrow\[(.*?)\]\{(.*?)\}/g, ' ──[$1]($2)──> ')
    .replace(/\\xrightarrow\{(.*?)\}/g, ' ──($1)──> ')
    .replace(/\\rightarrow/g, ' → ')
    .replace(/\\leftarrow/g, ' ← ')
    .replace(/\\rightleftharpoons/g, ' ⇌ ')
    .replace(/\\times/g, ' × ')
    .replace(/\\cdot/g, ' · ')
    .replace(/\\div/g, ' ÷ ')
    .replace(/\\pm/g, ' ± ')
    .replace(/\\mp/g, ' ∓ ')
    .replace(/\\approx/g, ' ≈ ')
    .replace(/\\neq/g, ' ≠ ')
    .replace(/\\le(q)?/g, ' ≤ ')
    .replace(/\\ge(q)?/g, ' ≥ ')
    .replace(/\\infty/g, ' ∞ ')
    // Checkboxes / Tickboxes
    .replace(/(?:[-*]\s*)?\[\s*\]/g, '☐ ')
    .replace(/(?:[-*]\s*)?\[\s*[✓xXvV]\s*\]/g, '☑ ')
    // LaTeX spacing commands: \, \: \; \! \ ~
    .replace(/\\,/g, ' ')
    .replace(/\\:/g, ' ')
    .replace(/\\;/g, ' ')
    .replace(/\\!/g, '')
    .replace(/\\ /g, ' ')
    .replace(/~/g, ' ')
    // Comprehensive Temperature formats: 25^\circ C, 25^{\circ}\text{C}, 25\degree C, 25\celsius, 45\,°C
    .replace(/\\(degreeC|celsius)\b/g, '°C')
    .replace(/\\degree\s*\\text\{\s*C\s*\}/gi, '°C')
    .replace(/\\degree\s*\\mathrm\{\s*C\s*\}/gi, '°C')
    .replace(/\\degree\s*C\b/gi, '°C')
    .replace(/\^\{\\circ\s*\\text\{\s*C\s*\}\}/gi, '°C')
    .replace(/\^\{\\circ\s*\\mathrm\{\s*C\s*\}\}/gi, '°C')
    .replace(/\^\{\\circ\s*C\}/gi, '°C')
    .replace(/(\^\{?\\circ\}?)\s*\\text\{\s*C\s*\}/gi, '°C')
    .replace(/(\^\{?\\circ\}?)\s*\\mathrm\{\s*C\s*\}/gi, '°C')
    .replace(/(\^\{?\\circ\}?)\s*C\b/gi, '°C')
    .replace(/(\^\{?\\circ\}?)\s*\\text\{\s*F\s*\}/gi, '°F')
    .replace(/(\^\{?\\circ\}?)\s*F\b/gi, '°F')
    .replace(/\^\{\\circ\}/g, '°')
    .replace(/\^\\circ/g, '°')
    .replace(/\\degree\b/g, '°')
    .replace(/\\circ\b/g, '°')
    // Greek letters
    .replace(/\\Delta/g, 'Δ')
    .replace(/\\delta/g, 'δ')
    .replace(/\\alpha/g, 'α')
    .replace(/\\beta/g, 'β')
    .replace(/\\gamma/g, 'γ')
    .replace(/\\theta/g, 'θ')
    .replace(/\\pi/g, 'π')
    .replace(/\\mu/g, 'μ')
    .replace(/\\sigma/g, 'σ')
    .replace(/\\omega/g, 'ω')
    .replace(/\\Omega/g, 'Ω')
    .replace(/\\lambda/g, 'λ')
    .replace(/\\phi/g, 'ϕ')
    // Fractions: \frac{a}{b} -> (a / b)
    .replace(/\\frac\{(.*?)\}\{(.*?)\}/g, '($1 / $2)')
    // Font wrappers inside LaTeX
    .replace(/\\text\{(.*?)\}/g, '$1')
    .replace(/\\mathrm\{(.*?)\}/g, '$1')
    .replace(/\\mathbf\{(.*?)\}/g, '$1')
    .replace(/\\mathit\{(.*?)\}/g, '$1')
    .replace(/\\quad/g, '   ')
    // Convert HTML tags to standard bracketed markers for tokenization
    .replace(/<sub>(.*?)<\/sub>/gi, '_{$1}')
    .replace(/<sup>(.*?)<\/sup>/gi, '^{$1}')
    // Nuclide / Isotope notation: _^{40}_{20}W or {}^{40}_{20}W -> ^{40}_{20}W
    .replace(/_?\^\{([^{}]+)\}_\{([^{}]+)\}/g, '^{$1}_{$2}')
    .replace(/_\{([^{}]+)\}\^\{([^{}]+)\}/g, '^{$2}_{$1}')
    .replace(/_?\^([0-9a-zA-Z]+)_([0-9a-zA-Z]+)/g, '^{$1}_{$2}')
    .replace(/_([0-9a-zA-Z]+)\^([0-9a-zA-Z]+)/g, '^{$2}_{$1}')
    .replace(/_?\^\{([^{}]+)\}/g, '^{$1}')
    // Clean percentage escaping
    .replace(/\\%/g, '%')
    // Remove outer LaTeX math delimiters while keeping content
    .replace(/\$\$(.*?)\$\$/g, '$1')
    .replace(/\$(.*?)\$/g, '$1')
    .replace(/\\\[(.*?)\\\]/g, '$1')
    .replace(/\\\((.*?)\\\)/g, '$1');

  // Step 2: Convert single-character sub/super syntax (e.g. Fe_3O_4 -> Fe_{3}O_{4}, H_2O -> H_{2}O, 10^3 -> 10^{3})
  processed = processed.replace(/([a-zA-Z0-9)\]])_([0-9a-zA-Z+\-*]+)/g, '$1_{$2}');
  processed = processed.replace(/\^([0-9a-zA-Z+\-*]+)/g, '^{$1}');

  // Convert unicode sub/superscripts to standard markers
  const unicodeSubMap: Record<string, string> = {
    '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
    '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
    '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')',
    'ₐ': 'a', 'ₑ': 'e', 'ₕ': 'h', 'ᵢ': 'i', 'ⱼ': 'j',
    'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₒ': 'o',
    'ₚ': 'p', 'ᵣ': 'r', 'ₛ': 's', 'ₜ': 't', 'ᵤ': 'u', 'ᵥ': 'v', 'ₓ': 'x',
  };
  const unicodeSuperMap: Record<string, string> = {
    '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
    '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
    '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')',
    'ⁿ': 'n', 'ⁱ': 'i',
  };

  for (const [uni, asc] of Object.entries(unicodeSubMap)) {
    processed = processed.replaceAll(uni, `_{${asc}}`);
  }
  for (const [uni, asc] of Object.entries(unicodeSuperMap)) {
    processed = processed.replaceAll(uni, `^{${asc}}`);
  }

  // Tokenize string by subscript _{...}, superscript ^{...}, and bold **...**
  const runs: TextRun[] = [];
  const tokenRegex = /(_\{[^{}]*\}|\^\{[^{}]*\}|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(processed)) !== null) {
    if (match.index > lastIndex) {
      const plainText = processed.substring(lastIndex, match.index);
      if (plainText) {
        runs.push(
          new TextRun({
            text: plainText,
            size: baseOpts.size,
            bold: baseOpts.bold,
            color: baseOpts.color,
            italics: baseOpts.italics,
            font: baseOpts.font,
          })
        );
      }
    }

    const matchedStr = match[0];
    if (matchedStr.startsWith('_{') && matchedStr.endsWith('}')) {
      const subContent = matchedStr.slice(2, -1);
      if (subContent) {
        runs.push(
          new TextRun({
            text: subContent,
            subScript: true,
            size: baseOpts.size,
            bold: baseOpts.bold,
            color: baseOpts.color,
            font: baseOpts.font,
          })
        );
      }
    } else if (matchedStr.startsWith('^{') && matchedStr.endsWith('}')) {
      const superContent = matchedStr.slice(2, -1);
      if (superContent) {
        runs.push(
          new TextRun({
            text: superContent,
            superScript: true,
            size: baseOpts.size,
            bold: baseOpts.bold,
            color: baseOpts.color,
            font: baseOpts.font,
          })
        );
      }
    } else if (matchedStr.startsWith('**') && matchedStr.endsWith('**')) {
      const boldContent = matchedStr.slice(2, -2);
      if (boldContent) {
        const innerRuns = parseFormattedTextToDocxRuns(boldContent, {
          ...baseOpts,
          bold: true,
        });
        runs.push(...innerRuns);
      }
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < processed.length) {
    const trailing = processed.substring(lastIndex);
    if (trailing) {
      runs.push(
        new TextRun({
          text: trailing,
          size: baseOpts.size,
          bold: baseOpts.bold,
          color: baseOpts.color,
          italics: baseOpts.italics,
          font: baseOpts.font,
        })
      );
    }
  }

  return runs.length > 0
    ? runs
    : [new TextRun({ text: rawText, size: baseOpts.size, bold: baseOpts.bold, color: baseOpts.color, font: baseOpts.font })];
}

/**
 * Converts text containing Markdown tables into Docx Paragraphs and Table objects
 */
function convertTextAndTablesToDocxElements(
  rawText: string,
  prefix = '',
  textSize = 22,
  fontName = 'Times New Roman'
): (Paragraph | Table)[] {
  if (!rawText) return [];
  const normalized = rawText.replace(/\\n/g, '\n');
  const lines = normalized.split('\n');
  const elements: (Paragraph | Table)[] = [];

  let currentTextLines: string[] = [];
  let currentTableLines: string[] = [];
  let inTable = false;
  let activePrefix = prefix;

  const flushText = () => {
    if (currentTextLines.length === 0) return;
    const textStr = currentTextLines.join(' ');
    elements.push(
      new Paragraph({
        children: [
          ...(activePrefix
            ? [new TextRun({ text: activePrefix, bold: true, size: textSize, color: '111827', font: fontName })]
            : []),
          ...parseFormattedTextToDocxRuns(textStr, { size: textSize, color: '1f2937', font: fontName }),
        ],
        indent: prefix ? { left: 450, hanging: 450 } : undefined,
        spacing: { before: 80, after: 60, line: 276 },
      })
    );
    currentTextLines = [];
    activePrefix = '';
  };

  const flushTable = () => {
    if (currentTableLines.length === 0) return;
    const rawRows = currentTableLines
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^\|[-:\s|]+\|$/.test(l));

    if (rawRows.length > 0) {
      const headerLine = rawRows[0];
      const headerCells = headerLine
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());

      const dataRows = rawRows.slice(1);
      const colCount = Math.max(1, headerCells.length);
      const cellWidth = Math.floor(100 / colCount);

      const tableRows: TableRow[] = [
        new TableRow({
          tableHeader: true,
          children: headerCells.map(
            (cellText) =>
              new TableCell({
                width: { size: cellWidth, type: WidthType.PERCENTAGE },
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: parseFormattedTextToDocxRuns(cellText, { size: 20, bold: true, font: fontName }),
                  }),
                ],
                shading: { fill: 'f3f4f6' },
                borders: {
                  top: { style: BorderStyle.SINGLE, size: 6, color: '374151' },
                  bottom: { style: BorderStyle.SINGLE, size: 6, color: '374151' },
                  left: { style: BorderStyle.SINGLE, size: 4, color: '9ca3af' },
                  right: { style: BorderStyle.SINGLE, size: 4, color: '9ca3af' },
                },
              })
          ),
        }),
      ];

      dataRows.forEach((rowLine) => {
        const cells = rowLine
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim());

        tableRows.push(
          new TableRow({
            children: cells.map(
              (cellText) =>
                new TableCell({
                  width: { size: cellWidth, type: WidthType.PERCENTAGE },
                  children: [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      children: parseFormattedTextToDocxRuns(cellText, { size: 20, font: fontName }),
                    }),
                  ],
                  borders: {
                    top: { style: BorderStyle.SINGLE, size: 4, color: 'd1d5db' },
                    bottom: { style: BorderStyle.SINGLE, size: 4, color: 'd1d5db' },
                    left: { style: BorderStyle.SINGLE, size: 4, color: '9ca3af' },
                    right: { style: BorderStyle.SINGLE, size: 4, color: '9ca3af' },
                  },
                })
            ),
          })
        );
      });

      elements.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          alignment: AlignmentType.CENTER,
          rows: tableRows,
        })
      );
      elements.push(new Paragraph({ text: '', spacing: { before: 80, after: 80 } }));
    }
    currentTableLines = [];
  };

  for (const line of lines) {
    const isTableLine = line.trim().startsWith('|') && line.trim().endsWith('|');
    if (isTableLine) {
      if (!inTable) {
        flushText();
        inTable = true;
      }
      currentTableLines.push(line);
    } else {
      if (inTable) {
        flushTable();
        inTable = false;
      }
      currentTextLines.push(line);
    }
  }

  if (inTable) flushTable();
  else flushText();

  return elements;
}

/**
 * Builds an authentic Cambridge / IGCSE Candidate Information table with box grids.
 */
function buildCambridgeCandidateTable(): Table {
  const boxBorder = { style: BorderStyle.SINGLE, size: 6, color: '000000' };
  const cellMargins = { top: 60, bottom: 60, left: 80, right: 80 };

  const createNumberBoxes = (label: string, count: number, cellPercent: number) => {
    return new TableCell({
      width: { size: cellPercent, type: WidthType.PERCENTAGE },
      margins: cellMargins,
      children: [
        new Paragraph({
          children: [new TextRun({ text: label, bold: true, size: 15, font: 'Arial' })],
          spacing: { after: 30 },
        }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: Array.from({ length: count }).map(
                () =>
                  new TableCell({
                    width: { size: Math.round(100 / count), type: WidthType.PERCENTAGE },
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
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 46, type: WidthType.PERCENTAGE },
            margins: cellMargins,
            children: [
              new Paragraph({
                children: [new TextRun({ text: 'CANDIDATE\nNAME', bold: true, size: 15, font: 'Arial' })],
                spacing: { after: 50 },
              }),
              new Paragraph({
                tabStops: [{ type: TabStopType.RIGHT, position: 4000, leader: LeaderType.DOT }],
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
          createNumberBoxes('CENTRE\nNUMBER', 5, 28),
          createNumberBoxes('CANDIDATE\nNUMBER', 4, 26),
        ],
      }),
    ],
  });
}

function base64ToUint8Array(base64: string): Uint8Array {
  const cleanBase64 = base64.replace(/^data:image\/\w+;base64,/, '');
  const binaryString = atob(cleanBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Builds the complete authentic Cambridge IGCSE Cover Page elements for Word documents.
 */
function buildCambridgeCoverDocxElements(headerConfig: ExamHeaderConfig, questions: Question[]): (Paragraph | Table)[] {
  const details = getCambridgeCoverDetails(headerConfig, questions);
  const elements: (Paragraph | Table)[] = [];

  // Top 2-Logo Header: School Logo (Left) and Cambridge International Logo (Right)
  try {
    const schoolBytes = base64ToUint8Array(details.schoolLogoUrl || DEFAULT_SCHOOL_LOGO);
    const cambridgeBytes = base64ToUint8Array(details.cambridgeLogoUrl || DEFAULT_CAMBRIDGE_LOGO);

    const logoTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        bottom: { style: BorderStyle.SINGLE, size: 8, color: '111827' },
        left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              margins: { bottom: 120 },
              children: [
                new Paragraph({
                  children: [
                    new ImageRun({
                      data: schoolBytes,
                      transformation: { width: 170, height: 42 },
                      type: 'png',
                    }),
                  ],
                }),
              ],
            }),
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              margins: { bottom: 120 },
              children: [
                new Paragraph({
                  alignment: AlignmentType.RIGHT,
                  children: [
                    new ImageRun({
                      data: cambridgeBytes,
                      transformation: { width: 190, height: 42 },
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

  // Footer info
  elements.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `This document has ${details.estimatedPages} pages. Any blank pages are indicated.`,
          font: 'Arial',
          size: 15,
        }),
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

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 75, type: WidthType.PERCENTAGE },
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
            width: { size: 25, type: WidthType.PERCENTAGE },
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
 * Generates and downloads a student exam paper as a .docx file
 */
export async function exportStudentPaperDocx(
  headerConfig: ExamHeaderConfig,
  questions: Question[],
  options: DocxExportOptions = {}
): Promise<void> {
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
    docParagraphs.push(...buildCambridgeCoverDocxElements(headerConfig, questions));
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

    const instTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              margins: { top: 80, bottom: 80, left: 100, right: 100 },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: 'INSTRUCTIONS TO CANDIDATES:', bold: true, size: 16, font: 'Arial' })],
                  spacing: { after: 40 },
                }),
                new Paragraph({
                  children: [new TextRun({ text: `• ${instructionText}`, size: 16, font: 'Arial' })],
                }),
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
    const stemElements = convertTextAndTablesToDocxElements(q.question_text || '', `${qNum}.  `, 22, fontName);
    docParagraphs.push(...stemElements);

    // Embed Main Question Diagram if present
    const diagramUrl = q.diagram_url || (q as any).image_url || (q as any).diagram_base64;
    if (diagramUrl) {
      const imgData = await loadImageData(diagramUrl);
      if (imgData) {
        docParagraphs.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                type: 'png',
                data: imgData.data,
                transformation: {
                  width: imgData.width,
                  height: imgData.height,
                },
              }),
            ],
            spacing: { before: 120, after: 120 },
          })
        );
      }
    }

    // Options for Multiple Choice
    if (q.options && q.options.length > 0) {
      q.options.forEach((opt, optIdx) => {
        const { letter, text } = parseMcqOption(opt, optIdx);
        docParagraphs.push(
          new Paragraph({
            indent: { left: 800, hanging: 380 },
            children: [
              new TextRun({ text: `${letter}    `, bold: true, size: 20, font: fontName }),
              ...parseFormattedTextToDocxRuns(text, { size: 20, color: '374151', font: fontName }),
            ],
            spacing: { before: 50, after: 50, line: 260 },
          })
        );
      });
    }

    // Sub-questions with hanging indent (a) and right-aligned mark tab
    if (q.sub_questions && q.sub_questions.length > 0) {
      for (const sq of q.sub_questions) {
        docParagraphs.push(
          new Paragraph({
            indent: { left: 800, hanging: 380 },
            tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
            children: [
              new TextRun({ text: `${sq.sub_id}  `, bold: true, size: 20, font: fontName }),
              ...parseFormattedTextToDocxRuns(sq.question_text || '', { size: 20, font: fontName }),
              new TextRun({ text: `\t[${sq.marks || 1}]`, bold: true, size: 20, color: '4b5563', font: fontName }),
            ],
            spacing: { before: 80, after: 60, line: 260 },
          })
        );

        // Sub-question diagram if present
        const subDiagramUrl = (sq as any).diagram_url || (sq as any).image_url || (sq as any).diagram_base64;
        if (subDiagramUrl) {
          const subImgData = await loadImageData(subDiagramUrl);
          if (subImgData) {
            docParagraphs.push(
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new ImageRun({
                    type: 'png',
                    data: subImgData.data,
                    transformation: {
                      width: Math.min(340, subImgData.width),
                      height: Math.min(180, subImgData.height),
                    },
                  }),
                ],
                spacing: { before: 100, after: 100 },
              })
            );
          }
        }

        // Native full-width answer lines
        if (includeAnswerLines && template !== 'separate_answer_booklet') {
          const subLinesCount = Math.max(1, (sq.marks || 1) * linesPerMark);
          for (let li = 0; li < subLinesCount; li++) {
            docParagraphs.push(
              new Paragraph({
                indent: { left: 800 },
                tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX, leader: leaderStyle }],
                children: [new TextRun({ text: '\t', size: 24, font: fontName })],
                spacing: { before: 160, after: 160, line: 360 },
              })
            );
          }
        }
      }
    } else if (includeAnswerLines && template !== 'separate_answer_booklet' && q.question_style !== 'Multiple Choice') {
      // Main Question Native Full-Width Answer Lines
      const lineCount = Math.max(1, (q.marks || 1) * linesPerMark);
      for (let li = 0; li < lineCount; li++) {
        docParagraphs.push(
          new Paragraph({
            indent: { left: 450 },
            tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX, leader: leaderStyle }],
            children: [new TextRun({ text: '\t', size: 24, font: fontName })],
            spacing: { before: 160, after: 160, line: 360 },
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

  const blob = await Packer.toBlob(doc);
  const safeTitle = (headerConfig.title || 'Exam_Paper').replace(/[^a-zA-Z0-9_-]/g, '_');
  saveAs(blob, `${safeTitle}_Student_Paper.docx`);
}

/**
 * Generates and downloads a separate Answer Booklet as a .docx file
 */
export async function exportAnswerBookletDocx(
  headerConfig: ExamHeaderConfig,
  questions: Question[],
  options: DocxExportOptions = {}
): Promise<void> {
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
              spacing: { before: 80, after: 80 },
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
            spacing: { before: 80, after: 80 },
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
  saveAs(blob, `${safeTitle}_Answer_Booklet.docx`);
}

/**
 * Generates and downloads a publication-quality Comprehensive Teacher Mark Scheme & Solutions document (.docx)
 */
export async function exportTeacherMarkSchemeDocx(
  headerConfig: ExamHeaderConfig,
  questions: Question[]
): Promise<void> {
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
    const stemElements = convertTextAndTablesToDocxElements(q.question_text || '', '', 19, 'Arial');
    docParagraphs.push(...stemElements);

    // Embed Question Diagram if present
    const diagramUrl = q.diagram_url || (q as any).image_url || (q as any).diagram_base64;
    if (diagramUrl) {
      const imgData = await loadImageData(diagramUrl);
      if (imgData) {
        docParagraphs.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                type: 'png',
                data: imgData.data,
                transformation: {
                  width: Math.min(360, imgData.width),
                  height: Math.min(200, imgData.height),
                },
              }),
            ],
            spacing: { before: 100, after: 100 },
          })
        );
      }
    }

    // If MCQ, list options
    if (q.options && q.options.length > 0) {
      q.options.forEach((opt, optIdx) => {
        const { letter, text } = parseMcqOption(opt, optIdx);
        docParagraphs.push(
          new Paragraph({
            indent: { left: 400, hanging: 240 },
            children: [
              new TextRun({ text: `${letter}   `, bold: true, size: 18, color: '1e3a8a', font: 'Arial' }),
              ...parseFormattedTextToDocxRuns(text, { size: 18, color: '4b5563', font: 'Arial' }),
            ],
            spacing: { before: 20, after: 20 },
          })
        );
      });
    }

    // Mark Scheme Table for this Question
    const rows: TableRow[] = [
      new TableRow({
        tableHeader: true,
        children: [
          new TableCell({
            width: { size: 15, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: 'Part', bold: true, size: 17, color: 'ffffff', font: 'Arial' })] })],
            shading: { fill: '1e3a8a' },
            margins: { top: 60, bottom: 60, left: 60, right: 60 },
          }),
          new TableCell({
            width: { size: 55, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: 'Marking Criteria & Model Answer', bold: true, size: 17, color: 'ffffff', font: 'Arial' })] })],
            shading: { fill: '1e3a8a' },
            margins: { top: 60, bottom: 60, left: 60, right: 60 },
          }),
          new TableCell({
            width: { size: 18, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: 'Acceptable / ECF', bold: true, size: 17, color: 'ffffff', font: 'Arial' })] })],
            shading: { fill: '1e3a8a' },
            margins: { top: 60, bottom: 60, left: 60, right: 60 },
          }),
          new TableCell({
            width: { size: 12, type: WidthType.PERCENTAGE },
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

        const cellParagraphs: Paragraph[] = [
          new Paragraph({
            children: [
              new TextRun({ text: `${sub.question_text ? `Stem: ${sub.question_text}\n` : ''}`, italics: true, size: 16, color: '6b7280', font: 'Arial' }),
              ...parseFormattedTextToDocxRuns(msText, { size: 18, font: 'Arial' }),
            ],
            spacing: { after: 40 },
          }),
        ];

        if (sub.guidance) {
          cellParagraphs.push(
            new Paragraph({
              children: [
                new TextRun({ text: '💡 Examiner Guidance: ', bold: true, size: 16, color: '2563eb', font: 'Arial' }),
                ...parseFormattedTextToDocxRuns(sub.guidance, { size: 16, italics: true, font: 'Arial' }),
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
                ...parseFormattedTextToDocxRuns(sub.common_misconceptions.join('; '), { size: 16, italics: true, font: 'Arial' }),
              ],
              spacing: { before: 40 },
            })
          );
        }

        rows.push(
          new TableRow({
            children: [
              new TableCell({
                width: { size: 15, type: WidthType.PERCENTAGE },
                margins: { top: 60, bottom: 60, left: 60, right: 60 },
                children: [new Paragraph({ children: [new TextRun({ text: sub.sub_id, bold: true, size: 18, font: 'Arial' })] })],
              }),
              new TableCell({
                width: { size: 55, type: WidthType.PERCENTAGE },
                margins: { top: 60, bottom: 60, left: 60, right: 60 },
                children: cellParagraphs,
              }),
              new TableCell({
                width: { size: 18, type: WidthType.PERCENTAGE },
                margins: { top: 60, bottom: 60, left: 60, right: 60 },
                children: [new Paragraph({ children: [new TextRun({ text: 'Allow ECF from previous part', size: 16, italics: true, color: '4b5563', font: 'Arial' })] })],
              }),
              new TableCell({
                width: { size: 12, type: WidthType.PERCENTAGE },
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
        (p) => new Paragraph({ children: [new TextRun({ text: '• ', bold: true, font: 'Arial' }), ...parseFormattedTextToDocxRuns(p, { size: 18, font: 'Arial' })], spacing: { after: 30 } })
      );

      if (guidance) {
        cellParagraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: '💡 Examiner Guidance: ', bold: true, size: 16, color: '2563eb', font: 'Arial' }),
              ...parseFormattedTextToDocxRuns(guidance, { size: 16, italics: true, font: 'Arial' }),
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
              ...parseFormattedTextToDocxRuns(traps, { size: 16, italics: true, font: 'Arial' }),
            ],
            spacing: { before: 40 },
          })
        );
      }

      rows.push(
        new TableRow({
          children: [
            new TableCell({
              width: { size: 15, type: WidthType.PERCENTAGE },
              margins: { top: 60, bottom: 60, left: 60, right: 60 },
              children: [new Paragraph({ children: [new TextRun({ text: `Q${qNum}`, bold: true, size: 18, font: 'Arial' })] })],
            }),
            new TableCell({
              width: { size: 55, type: WidthType.PERCENTAGE },
              margins: { top: 60, bottom: 60, left: 60, right: 60 },
              children: cellParagraphs,
            }),
            new TableCell({
              width: { size: 18, type: WidthType.PERCENTAGE },
              margins: { top: 60, bottom: 60, left: 60, right: 60 },
              children: [new Paragraph({ children: parseFormattedTextToDocxRuns(acceptable, { size: 16, color: '4b5563', font: 'Arial' }) })],
            }),
            new TableCell({
              width: { size: 12, type: WidthType.PERCENTAGE },
              margins: { top: 60, bottom: 60, left: 60, right: 60 },
              children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `[${q.marks || 1}]`, bold: true, size: 18, font: 'Arial' })] })],
            }),
          ],
        })
      );
    }

    docParagraphs.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
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
  saveAs(blob, `${safeTitle}_Comprehensive_MarkScheme.docx`);
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

  // Top 2-Logo Header
  try {
    const schoolBytes = base64ToUint8Array(options.schoolLogoUrl || details.schoolLogoUrl || DEFAULT_SCHOOL_LOGO);
    const cambridgeBytes = base64ToUint8Array(details.cambridgeLogoUrl || DEFAULT_CAMBRIDGE_LOGO);

    elements.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
          bottom: { style: BorderStyle.SINGLE, size: 8, color: '111827' },
          left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
          right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
        },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                width: { size: 35, type: WidthType.PERCENTAGE },
                children: [
                  new Paragraph({
                    children: [new ImageRun({ data: schoolBytes, transformation: { width: 150, height: 38 }, type: 'png' })],
                  }),
                ],
              }),
              new TableCell({
                width: { size: 30, type: WidthType.PERCENTAGE },
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
                width: { size: 35, type: WidthType.PERCENTAGE },
                children: [
                  new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    children: [new ImageRun({ data: cambridgeBytes, transformation: { width: 160, height: 36 }, type: 'png' })],
                  }),
                ],
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
  elements.push(buildCambridgeCandidateTable());
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

  // Bubble Grid (3 Columns)
  const totalQuestions = questions.length || 40;
  const numCols = totalQuestions > 30 ? 3 : 2;
  const perCol = Math.ceil(totalQuestions / numCols);

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
        width: { size: Math.floor(100 / numCols), type: WidthType.PERCENTAGE },
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
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({ children: gridCells })],
    })
  );

  elements.push(new Paragraph({ text: '', spacing: { before: 160, after: 160 } }));

  // Score Box
  elements.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 100, type: WidthType.PERCENTAGE },
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
  saveAs(blob, `${safeTitle}_Multiple_Choice_Answer_Sheet.docx`);
}
