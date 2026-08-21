// ─── Word Document (.docx) Export Service ────────────────────────────────────
// Generates professional, fully editable Microsoft Word (.docx) exam papers
// and standalone Teacher Mark Scheme documents using the `docx` library.

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  HeadingLevel,
} from 'docx';
import { saveAs } from 'file-saver';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';

export interface DocxExportOptions {
  includeAnswerLines?: boolean;
  linesPerMark?: number;
  includeMarkSchemeInStudentPaper?: boolean;
}

/**
 * Transforms raw text containing LaTeX math, Markdown, HTML sub/sup tags,
 * and scientific notation into docx `TextRun` objects with native `subScript` and `superScript`.
 */
export function parseFormattedTextToDocxRuns(
  rawText: string,
  baseOpts: { size?: number; bold?: boolean; color?: string; italics?: boolean } = {}
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
    .replace(/\\degree/g, '°')
    .replace(/\\circ/g, '°')
    .replace(/\^\{\\circ\}/g, '°')
    .replace(/\^\\circ/g, '°')
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
    .replace(/\\qquad/g, '      ')
    // Convert HTML tags to standard bracketed markers for tokenization
    .replace(/<sub>(.*?)<\/sub>/gi, '_{$1}')
    .replace(/<sup>(.*?)<\/sup>/gi, '^{$1}')
    // Remove outer LaTeX math delimiters while keeping content
    .replace(/\$\$(.*?)\$\$/g, '$1')
    .replace(/\$(.*?)\$/g, '$1')
    .replace(/\\\[(.*?)\\\]/g, '$1')
    .replace(/\\\((.*?)\\\)/g, '$1');

  // Step 2: Convert single-character sub/super syntax (e.g. H_2O -> H_{2}O, 10^3 -> 10^{3})
  processed = processed.replace(/([a-zA-Z0-9\)\]])_([0-9a-zA-Z\+\-\*])/g, '$1_{$2}');
  processed = processed.replace(/\^([0-9a-zA-Z\+\-\*])/g, '^{$1}');

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

  for (const [uSub, norm] of Object.entries(unicodeSubMap)) {
    processed = processed.replaceAll(uSub, `_{${norm}}`);
  }
  for (const [uSuper, norm] of Object.entries(unicodeSuperMap)) {
    processed = processed.replaceAll(uSuper, `^{${norm}}`);
  }

  // Step 3: Tokenize the text into runs (Normal, Subscript, Superscript, Bold)
  const runs: TextRun[] = [];
  const tokenRegex = /(\_\{[^{}]*\}|\^\{[^{}]*\}|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(processed)) !== null) {
    if (match.index > lastIndex) {
      const normalText = processed.substring(lastIndex, match.index);
      if (normalText) {
        runs.push(
          new TextRun({
            text: normalText,
            size: baseOpts.size,
            bold: baseOpts.bold,
            color: baseOpts.color,
            italics: baseOpts.italics,
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
        })
      );
    }
  }

  return runs.length > 0
    ? runs
    : [new TextRun({ text: rawText, size: baseOpts.size, bold: baseOpts.bold, color: baseOpts.color })];
}

/**
 * Fallback string cleaner for contexts requiring a plain string
 */
export function cleanLatexForWord(text: string): string {
  if (!text) return '';
  return text
    .replace(/\\xrightarrow\[(.*?)\]\{(.*?)\}/g, ' ──[$1]($2)──> ')
    .replace(/\\xrightarrow\{(.*?)\}/g, ' ──($1)──> ')
    .replace(/\\rightarrow/g, ' → ')
    .replace(/\\leftarrow/g, ' ← ')
    .replace(/\\rightleftharpoons/g, ' ⇌ ')
    .replace(/\\times/g, ' × ')
    .replace(/\\div/g, ' ÷ ')
    .replace(/\\Delta/g, 'Δ')
    .replace(/\\delta/g, 'δ')
    .replace(/\\alpha/g, 'α')
    .replace(/\\beta/g, 'β')
    .replace(/\\gamma/g, 'γ')
    .replace(/\\theta/g, 'θ')
    .replace(/\\pi/g, 'π')
    .replace(/\\mu/g, 'μ')
    .replace(/\\sigma/g, 'σ')
    .replace(/\\pm/g, '±')
    .replace(/\\approx/g, '≈')
    .replace(/\\neq/g, '≠')
    .replace(/\\le/g, '≤')
    .replace(/\\ge/g, '≥')
    .replace(/\\text\{(.*?)\}/g, '$1')
    .replace(/\\mathrm\{(.*?)\}/g, '$1')
    .replace(/\\mathbf\{(.*?)\}/g, '$1')
    .replace(/\\frac\{(.*?)\}\{(.*?)\}/g, '($1 / $2)')
    .replace(/\\quad/g, '   ')
    .replace(/\\qquad/g, '      ')
    .replace(/\$\$(.*?)\$\$/g, '$1')
    .replace(/\$(.*?)\$/g, '$1')
    .replace(/\\\[(.*?)\\\]/g, '$1')
    .replace(/\\\((.*?)\\\)/g, '$1');
}

/**
 * Converts text containing potential Markdown tables into Docx Paragraphs and Table objects
 */
function convertTextAndTablesToDocxElements(rawText: string, prefix = '', textSize = 22): (Paragraph | Table)[] {
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
          ...(activePrefix ? [new TextRun({ text: activePrefix, bold: true, size: textSize })] : []),
          ...parseFormattedTextToDocxRuns(textStr, { size: textSize }),
        ],
        spacing: { before: 100, after: 80 },
      })
    );
    activePrefix = '';
    currentTextLines = [];
  };

  const flushTable = () => {
    if (currentTableLines.length === 0) return;
    const rawRows = currentTableLines
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^\|[-:\s|]+\|$/.test(l));

    if (rawRows.length > 0) {
      const headerCells = rawRows[0].slice(1, -1).split('|').map((c) => c.trim());
      const bodyRows = rawRows.slice(1).map((rowStr) =>
        rowStr.slice(1, -1).split('|').map((c) => c.trim())
      );

      const tableRows: TableRow[] = [
        new TableRow({
          tableHeader: true,
          children: headerCells.map((h) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: parseFormattedTextToDocxRuns(h, { bold: true, size: 18 }),
                  alignment: AlignmentType.CENTER,
                }),
              ],
              shading: { fill: 'f3f4f6' },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: '374151' },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: '374151' },
                left: { style: BorderStyle.SINGLE, size: 4, color: '374151' },
                right: { style: BorderStyle.SINGLE, size: 4, color: '374151' },
              },
            })
          ),
        }),
        ...bodyRows.map((row) =>
          new TableRow({
            children: row.map((cell) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: parseFormattedTextToDocxRuns(cell, { size: 18 }),
                    alignment: AlignmentType.CENTER,
                  }),
                ],
                borders: {
                  top: { style: BorderStyle.SINGLE, size: 2, color: '9ca3af' },
                  bottom: { style: BorderStyle.SINGLE, size: 2, color: '9ca3af' },
                  left: { style: BorderStyle.SINGLE, size: 2, color: '9ca3af' },
                  right: { style: BorderStyle.SINGLE, size: 2, color: '9ca3af' },
                },
              })
            ),
          })
        ),
      ];

      elements.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
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
 * Generates and downloads a student exam paper as a .docx file
 */
export async function exportStudentPaperDocx(
  headerConfig: ExamHeaderConfig,
  questions: Question[],
  options: DocxExportOptions = {}
): Promise<void> {
  const { includeAnswerLines = true, linesPerMark = 2 } = options;
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);

  const docParagraphs: (Paragraph | Table)[] = [];

  // ─── 1. Candidate Identification Box ───────────────────────────────────────
  const candTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: 'NAME: ', bold: true, size: 20 }),
                  new TextRun({ text: '............................................................', color: '888888', size: 20 }),
                ],
              }),
            ],
            borders: {
              top: { style: BorderStyle.SINGLE, size: 8, color: '333333' },
              bottom: { style: BorderStyle.SINGLE, size: 8, color: '333333' },
              left: { style: BorderStyle.SINGLE, size: 8, color: '333333' },
              right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
            },
          }),
          new TableCell({
            width: { size: 25, type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: 'CLASS: ', bold: true, size: 20 }),
                  new TextRun({ text: '..................', color: '888888', size: 20 }),
                ],
              }),
            ],
            borders: {
              top: { style: BorderStyle.SINGLE, size: 8, color: '333333' },
              bottom: { style: BorderStyle.SINGLE, size: 8, color: '333333' },
              left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
              right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
            },
          }),
          new TableCell({
            width: { size: 25, type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: 'DATE: ', bold: true, size: 20 }),
                  new TextRun({ text: '..................', color: '888888', size: 20 }),
                ],
              }),
            ],
            borders: {
              top: { style: BorderStyle.SINGLE, size: 8, color: '333333' },
              bottom: { style: BorderStyle.SINGLE, size: 8, color: '333333' },
              left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
              right: { style: BorderStyle.SINGLE, size: 8, color: '333333' },
            },
          }),
        ],
      }),
    ],
  });

  docParagraphs.push(candTable);
  docParagraphs.push(new Paragraph({ text: '', spacing: { before: 120, after: 120 } }));

  // ─── 2. Title & Subject Header ─────────────────────────────────────────────
  docParagraphs.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [
        new TextRun({
          text: headerConfig.title || 'Examination Assessment',
          bold: true,
          size: 28,
          color: '111827',
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
          size: 20,
          color: '4b5563',
        }),
      ],
      spacing: { after: 160 },
    })
  );

  // ─── 3. Candidate Instructions Box ─────────────────────────────────────────
  if (headerConfig.instructions) {
    const instTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              children: [
                new Paragraph({
                  children: [new TextRun({ text: 'INSTRUCTIONS TO CANDIDATES:', bold: true, size: 18 })],
                  spacing: { after: 60 },
                }),
                new Paragraph({
                  children: [new TextRun({ text: `• ${headerConfig.instructions}`, size: 18 })],
                }),
                ...(headerConfig.additionalMaterials
                  ? [
                      new Paragraph({
                        children: [new TextRun({ text: `• Additional Materials: ${headerConfig.additionalMaterials}`, size: 18 })],
                      }),
                    ]
                  : []),
                new Paragraph({
                  children: [new TextRun({ text: '• The number of marks is given in brackets [ ] at the end of each question.', size: 18 })],
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
    docParagraphs.push(new Paragraph({ text: '', spacing: { before: 200, after: 200 } }));
  }

  // ─── 4. Question Stream ───────────────────────────────────────────────────
  questions.forEach((q, idx) => {
    const qNum = idx + 1;

    // Stem (and tables within stem)
    const stemElements = convertTextAndTablesToDocxElements(q.question_text, `${qNum}.  `, 22);
    docParagraphs.push(...stemElements);

    // MCQ Choices
    if (q.options && q.options.length > 0) {
      q.options.forEach((opt) => {
        docParagraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: '     ', size: 20 }),
              ...parseFormattedTextToDocxRuns(opt, { size: 20 }),
            ],
            spacing: { before: 40, after: 40 },
          })
        );
      });
    }

    // Structured Sub-Questions
    if (q.sub_questions && q.sub_questions.length > 0) {
      q.sub_questions.forEach((sub) => {
        const subElements = convertTextAndTablesToDocxElements(
          sub.question_text,
          `     ${sub.sub_id}  `,
          20
        );
        docParagraphs.push(...subElements);

        docParagraphs.push(
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({ text: `[${sub.marks}]`, bold: true, size: 20 }),
            ],
            spacing: { before: 40, after: 60 },
          })
        );

        // Sub-question handwriting answer lines
        if (includeAnswerLines) {
          const lineCount = Math.min(6, Math.max(2, (sub.marks || 1) * linesPerMark));
          for (let li = 0; li < lineCount; li++) {
            docParagraphs.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: '     ...............................................................................................................................................',
                    color: '9ca3af',
                    size: 18,
                  }),
                ],
                spacing: { before: 60, after: 60 },
              })
            );
          }
        }
      });
    } else if (includeAnswerLines && (!q.options || q.options.length === 0)) {
      // Single question answer lines
      const lineCount = Math.min(6, Math.max(2, (q.marks || 1) * linesPerMark));
      for (let li = 0; li < lineCount; li++) {
        docParagraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: '     ...............................................................................................................................................',
                color: '9ca3af',
                size: 18,
              }),
            ],
            spacing: { before: 60, after: 60 },
          })
        );
      }
    }

    // Question Total Marks Marker
    docParagraphs.push(
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            text: `[Total: ${q.marks}]`,
            bold: true,
            size: 20,
          }),
        ],
        spacing: { before: 100, after: 200 },
      })
    );
  });

  // Build document
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440, // 1 inch
              bottom: 1440,
              left: 1440,
              right: 1440,
            },
          },
        },
        children: docParagraphs,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const cleanTitle = (headerConfig.title || 'Exam_Paper').replace(/[^a-zA-Z0-9_-]/g, '_');
  saveAs(blob, `${cleanTitle}_Student_Paper.docx`);
}

/**
 * Generates and downloads a complete Teacher Mark Scheme & Solutions document as a .docx file
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
          text: `TEACHER MARK SCHEME: ${headerConfig.title || 'Assessment'}`,
          bold: true,
          size: 28,
          color: '1e3a8a',
        }),
      ],
      spacing: { after: 60 },
    })
  );

  docParagraphs.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Subject: ${headerConfig.subject || 'Exam'} (${headerConfig.subjectCode || 'General'})   •   Maximum Mark: ${totalMarks}`,
          bold: true,
          size: 20,
          color: '4b5563',
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // Mark Scheme Table
  const tableRows: TableRow[] = [
    // Header Row
    new TableRow({
      tableHeader: true,
      children: [
        new TableCell({
          width: { size: 15, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: 'Question', bold: true, size: 20, color: 'ffffff' })] })],
          shading: { fill: '1e3a8a' },
        }),
        new TableCell({
          width: { size: 55, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: 'Answer / Marking Criteria', bold: true, size: 20, color: 'ffffff' })] })],
          shading: { fill: '1e3a8a' },
        }),
        new TableCell({
          width: { size: 15, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: 'Acceptable', bold: true, size: 20, color: 'ffffff' })] })],
          shading: { fill: '1e3a8a' },
        }),
        new TableCell({
          width: { size: 15, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: 'Marks', bold: true, size: 20, color: 'ffffff' })] })],
          shading: { fill: '1e3a8a' },
        }),
      ],
    }),
  ];

  // Question Rows
  questions.forEach((q, idx) => {
    const qNum = idx + 1;

    if (q.sub_questions && q.sub_questions.length > 0) {
      q.sub_questions.forEach((sub) => {
        const msText =
          typeof sub.mark_scheme === 'string'
            ? sub.mark_scheme
            : Array.isArray(sub.mark_scheme)
              ? (sub.mark_scheme as string[]).join('; ')
              : 'See marking scheme points';

        tableRows.push(
          new TableRow({
            children: [
              new TableCell({
                width: { size: 15, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun({ text: `${qNum} ${sub.sub_id}`, bold: true, size: 18 })] })],
              }),
              new TableCell({
                width: { size: 55, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: parseFormattedTextToDocxRuns(msText, { size: 18 }) })],
              }),
              new TableCell({
                width: { size: 15, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun({ text: '—', size: 18 })] })],
              }),
              new TableCell({
                width: { size: 15, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun({ text: `${sub.marks}`, bold: true, size: 18 })] })],
              }),
            ],
          })
        );
      });
    } else {
      const msPoints = q.mark_scheme?.marking_points?.join('\n• ') || 'Award mark according to standard criteria.';
      const acceptable = q.mark_scheme?.acceptable_answers?.join(', ') || '—';

      tableRows.push(
        new TableRow({
          children: [
            new TableCell({
              width: { size: 15, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: [new TextRun({ text: `${qNum}`, bold: true, size: 18 })] })],
            }),
            new TableCell({
              width: { size: 55, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: parseFormattedTextToDocxRuns(msPoints, { size: 18 }) })],
            }),
            new TableCell({
              width: { size: 15, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: parseFormattedTextToDocxRuns(acceptable, { size: 18 }) })],
            }),
            new TableCell({
              width: { size: 15, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: [new TextRun({ text: `${q.marks}`, bold: true, size: 18 })] })],
            }),
          ],
        })
      );
    }
  });

  const msTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: tableRows,
  });

  docParagraphs.push(msTable);

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,
              bottom: 1440,
              left: 1440,
              right: 1440,
            },
          },
        },
        children: docParagraphs,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const cleanTitle = (headerConfig.title || 'Exam').replace(/[^a-zA-Z0-9_-]/g, '_');
  saveAs(blob, `${cleanTitle}_Teacher_Mark_Scheme.docx`);
}
