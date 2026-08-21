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
 * Cleanly converts LaTeX math formulas into clear, readable typography for Word
 */
export function cleanLatexForWord(text: string): string {
  if (!text) return '';
  return text
    // Replace arrows & special math symbols
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
    // Remove remaining math wrappers
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
          new TextRun({ text: cleanLatexForWord(textStr), size: textSize }),
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
                  children: [new TextRun({ text: cleanLatexForWord(h), bold: true, size: 18 })],
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
                    children: [new TextRun({ text: cleanLatexForWord(cell), size: 18 })],
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
              new TextRun({ text: `     ${cleanLatexForWord(opt)}`, size: 20 }),
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
                children: [new Paragraph({ children: [new TextRun({ text: cleanLatexForWord(msText), size: 18 })] })],
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
              children: [new Paragraph({ children: [new TextRun({ text: cleanLatexForWord(msPoints), size: 18 })] })],
            }),
            new TableCell({
              width: { size: 15, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ children: [new TextRun({ text: acceptable, size: 18 })] })],
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
