// ─── Student Name & PIN Word (.docx) Export Service ────────────────────────────
// Generates a clean A4 Word (.docx) document containing:
//   1. Proctor Master Checklist Tables (grouped per class, 1 class per page)
//   2. Cut-Out Individual Student PIN Slips (3x6 = 18 slips/page, 1 class per page)
// Strictly displays Student Name, Class, and 4-digit Exam PIN.

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeightRule,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { normalizeClassLabel, sortClassNames } from '../lib/examSchedule';
import { exportFileUniversal } from './fileExportBridge';
import {
  assignMissingPins,
  type RosterStudent,
} from './studentRosterService';

export interface RosterPinDocxOptions {
  classFilter?: string;
  scopeLabel?: string;
  title?: string;
}

const SLIPS_PER_ROW = 3;
const SLIP_ROWS_PER_PAGE = 6;
const SLIPS_PER_PAGE = SLIPS_PER_ROW * SLIP_ROWS_PER_PAGE;

// A4 geometry: 11906 x 16838 dxa with 567 dxa (10 mm) margins -> 10772 dxa usable width
const A4_WIDTH_DXA = 11906;
const A4_HEIGHT_DXA = 16838;
const PAGE_MARGIN_DXA = 567;
const MASTER_COL_WIDTHS = [700, 5972, 2200, 1900] as const;
const SLIP_COL_WIDTH = 3590;
const SLIP_ROW_HEIGHT_DXA = 2240;

const MASTER_CELL_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
  left: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
  right: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
} as const;

const SLIP_DASHED_BORDERS = {
  top: { style: BorderStyle.DASHED, size: 8, color: '64748B' },
  bottom: { style: BorderStyle.DASHED, size: 8, color: '64748B' },
  left: { style: BorderStyle.DASHED, size: 8, color: '64748B' },
  right: { style: BorderStyle.DASHED, size: 8, color: '64748B' },
} as const;

const SLIP_EMPTY_BORDERS = {
  top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
} as const;

/**
 * Ensures every student in the roster has a globally unique 4-digit PIN,
 * returning the updated roster and how many missing PINs were newly assigned.
 */
export function prepareRosterForPinExport(fullRoster: RosterStudent[]): {
  updatedRoster: RosterStudent[];
  assignedCount: number;
} {
  const missingBefore = fullRoster.filter((s) => !String(s.pin || '').trim()).length;
  if (missingBefore === 0) {
    return { updatedRoster: fullRoster, assignedCount: 0 };
  }
  const updatedRoster = assignMissingPins(fullRoster);
  return { updatedRoster, assignedCount: missingBefore };
}

function groupStudentsByClassSorted(students: RosterStudent[]): Array<{
  className: string;
  students: RosterStudent[];
}> {
  const groups = new Map<string, { displayName: string; list: RosterStudent[] }>();
  for (const s of students) {
    const rawClass = String(s.class || '').trim() || 'Unassigned';
    const key = normalizeClassLabel(rawClass).toLowerCase() || rawClass.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.list.push(s);
    } else {
      groups.set(key, {
        displayName: normalizeClassLabel(rawClass) || rawClass,
        list: [s],
      });
    }
  }

  const orderedNames = sortClassNames(
    Array.from(groups.values()).map((g) => g.displayName)
  );
  const byDisplay = new Map<string, RosterStudent[]>();
  for (const entry of groups.values()) {
    entry.list.sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), undefined, {
        sensitivity: 'base',
      })
    );
    byDisplay.set(entry.displayName, entry.list);
  }

  return orderedNames.map((className) => ({
    className,
    students: byDisplay.get(className) || [],
  }));
}

function buildSectionHeading(
  headingText: string,
  subtitleText: string,
  pageBreakBefore: boolean
): Paragraph[] {
  return [
    new Paragraph({
      pageBreakBefore,
      keepNext: true,
      spacing: { before: 0, after: 40 },
      children: [
        new TextRun({
          text: headingText,
          bold: true,
          size: 26,
          font: 'Calibri',
          color: '0F172A',
        }),
      ],
    }),
    new Paragraph({
      keepNext: true,
      spacing: { before: 0, after: 140 },
      children: [
        new TextRun({
          text: subtitleText,
          size: 18,
          font: 'Calibri',
          color: '475569',
        }),
      ],
    }),
  ];
}

function buildMasterClassTable(className: string, students: RosterStudent[]): Table {
  const headerCell = (label: string, width: number, align: typeof AlignmentType[keyof typeof AlignmentType]) =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      borders: MASTER_CELL_BORDERS,
      shading: { fill: '1E293B', type: ShadingType.CLEAR },
      margins: { top: 90, bottom: 90, left: 110, right: 110 },
      children: [
        new Paragraph({
          alignment: align,
          spacing: { before: 0, after: 0 },
          children: [
            new TextRun({
              text: label,
              bold: true,
              size: 19,
              font: 'Calibri',
              color: 'FFFFFF',
            }),
          ],
        }),
      ],
    });

  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: [
      headerCell('No.', MASTER_COL_WIDTHS[0], AlignmentType.CENTER),
      headerCell('Student Name', MASTER_COL_WIDTHS[1], AlignmentType.LEFT),
      headerCell('Class', MASTER_COL_WIDTHS[2], AlignmentType.CENTER),
      headerCell('Exam PIN', MASTER_COL_WIDTHS[3], AlignmentType.CENTER),
    ],
  });

  const dataRows = students.map((student, idx) => {
    const rowFill = idx % 2 === 1 ? 'F8FAFC' : 'FFFFFF';
    const dataCell = (
      text: string,
      width: number,
      align: typeof AlignmentType[keyof typeof AlignmentType],
      opts: { bold?: boolean; font?: string; size?: number; color?: string } = {}
    ) =>
      new TableCell({
        width: { size: width, type: WidthType.DXA },
        borders: MASTER_CELL_BORDERS,
        shading: { fill: rowFill, type: ShadingType.CLEAR },
        margins: { top: 75, bottom: 75, left: 110, right: 110 },
        children: [
          new Paragraph({
            alignment: align,
            spacing: { before: 0, after: 0 },
            children: [
              new TextRun({
                text,
                bold: Boolean(opts.bold),
                size: opts.size ?? 20,
                font: opts.font ?? 'Calibri',
                color: opts.color ?? '0F172A',
              }),
            ],
          }),
        ],
      });

    return new TableRow({
      cantSplit: true,
      children: [
        dataCell(String(idx + 1), MASTER_COL_WIDTHS[0], AlignmentType.CENTER, {
          color: '475569',
          size: 19,
        }),
        dataCell(student.name || 'Unnamed Student', MASTER_COL_WIDTHS[1], AlignmentType.LEFT, {
          bold: true,
          size: 20,
        }),
        dataCell(normalizeClassLabel(student.class) || className, MASTER_COL_WIDTHS[2], AlignmentType.CENTER, {
          color: '334155',
          size: 19,
        }),
        dataCell(String(student.pin || '----'), MASTER_COL_WIDTHS[3], AlignmentType.CENTER, {
          bold: true,
          font: 'Consolas',
          size: 24,
          color: '1E3A8A',
        }),
      ],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

function buildCutOutSlipGrid(className: string, chunkStudents: RosterStudent[]): Table {
  const rows: TableRow[] = [];
  const totalRowCount = Math.ceil(chunkStudents.length / SLIPS_PER_ROW);

  for (let r = 0; r < totalRowCount; r++) {
    const cells: TableCell[] = [];
    for (let c = 0; c < SLIPS_PER_ROW; c++) {
      const student = chunkStudents[r * SLIPS_PER_ROW + c];
      if (!student) {
        cells.push(
          new TableCell({
            width: { size: SLIP_COL_WIDTH, type: WidthType.DXA },
            borders: SLIP_EMPTY_BORDERS,
            children: [new Paragraph({ spacing: { before: 0, after: 0 } })],
          })
        );
        continue;
      }

      const displayClass = normalizeClassLabel(student.class) || className;
      cells.push(
        new TableCell({
          width: { size: SLIP_COL_WIDTH, type: WidthType.DXA },
          borders: SLIP_DASHED_BORDERS,
          margins: { top: 140, bottom: 140, left: 160, right: 160 },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 0, after: 60 },
              children: [
                new TextRun({
                  text: displayClass.toUpperCase(),
                  bold: true,
                  size: 16,
                  font: 'Calibri',
                  color: '475569',
                }),
              ],
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 20, after: 120 },
              children: [
                new TextRun({
                  text: student.name || 'Unnamed Student',
                  bold: true,
                  size: 21,
                  font: 'Calibri',
                  color: '0F172A',
                }),
              ],
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 60, after: 0 },
              children: [
                new TextRun({
                  text: 'PIN: ',
                  bold: true,
                  size: 18,
                  font: 'Calibri',
                  color: '475569',
                }),
                new TextRun({
                  text: String(student.pin || '----'),
                  bold: true,
                  size: 36,
                  font: 'Consolas',
                  color: '1E3A8A',
                }),
              ],
            }),
          ],
        })
      );
    }

    rows.push(
      new TableRow({
        cantSplit: true,
        height: { value: SLIP_ROW_HEIGHT_DXA, rule: HeightRule.ATLEAST },
        children: cells,
      })
    );
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
  });
}

/**
 * Builds an A4 Microsoft Word (.docx) Document with:
 *   Part 1: Proctor Master Tables (1 class per page)
 *   Part 2: Cut-Out Student PIN Slips (3x6 = 18 slips/page, 1 class per page)
 */
export async function buildRosterPinDocxDocument(
  roster: RosterStudent[],
  options: RosterPinDocxOptions = {}
): Promise<Document> {
  const filterNorm =
    options.classFilter && options.classFilter !== 'ALL'
      ? normalizeClassLabel(options.classFilter).toLowerCase()
      : '';
  const scopedStudents = filterNorm
    ? roster.filter((s) => normalizeClassLabel(s.class).toLowerCase() === filterNorm)
    : roster;

  const grouped = groupStudentsByClassSorted(scopedStudents);
  const children: Array<Paragraph | Table> = [];
  const docTitle = options.title || 'Candidate Name & Exam PIN Sheet';

  // Part 1: Proctor Master Checklist Tables (each class on a new page)
  grouped.forEach((group, idx) => {
    children.push(
      ...buildSectionHeading(
        `${docTitle} — ${group.className}`,
        `Proctor Master List • ${group.students.length} student${group.students.length === 1 ? '' : 's'} (sorted alphabetically)`,
        idx > 0
      )
    );
    children.push(buildMasterClassTable(group.className, group.students));
  });

  // Part 2: Cut-Out Individual Student PIN Slips (each class starts on a fresh page, 18 per page)
  grouped.forEach((group) => {
    const totalChunks = Math.max(1, Math.ceil(group.students.length / SLIPS_PER_PAGE));
    for (let cIdx = 0; cIdx < totalChunks; cIdx++) {
      const slice = group.students.slice(cIdx * SLIPS_PER_PAGE, (cIdx + 1) * SLIPS_PER_PAGE);
      if (slice.length === 0) continue;
      const pageSuffix = totalChunks > 1 ? ` (Page ${cIdx + 1}/${totalChunks})` : '';
      children.push(
        ...buildSectionHeading(
          `Cut-Out Student PIN Slips — ${group.className}${pageSuffix}`,
          `Cut along dashed lines and distribute privately • ${group.students.length} students in class`,
          true
        )
      );
      children.push(buildCutOutSlipGrid(group.className, slice));
    }
  });

  return new Document({
    sections: [
      {
        properties: {
          page: {
            size: {
              width: A4_WIDTH_DXA,
              height: A4_HEIGHT_DXA,
            },
            margin: {
              top: PAGE_MARGIN_DXA,
              bottom: PAGE_MARGIN_DXA,
              left: PAGE_MARGIN_DXA,
              right: PAGE_MARGIN_DXA,
            },
          },
        },
        children,
      },
    ],
  });
}

/**
 * Generates and downloads a Word (.docx) file containing the Proctor Master Table
 * and 3x6 Cut-Out Student PIN Slips for the supplied roster.
 */
export async function exportRosterPinSheetDocx(
  roster: RosterStudent[],
  options: RosterPinDocxOptions = {}
): Promise<{ fileName: string; exportedCount: number }> {
  const filterNorm =
    options.classFilter && options.classFilter !== 'ALL'
      ? normalizeClassLabel(options.classFilter).toLowerCase()
      : '';
  const scoped = filterNorm
    ? roster.filter((s) => normalizeClassLabel(s.class).toLowerCase() === filterNorm)
    : roster;

  if (scoped.length === 0) {
    throw new Error('No students found in the selected roster scope.');
  }

  const doc = await buildRosterPinDocxDocument(roster, options);
  const blob = await Packer.toBlob(doc);

  const scopeTag = (options.scopeLabel || options.classFilter || 'All_Classes')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const dateTag = new Date().toISOString().slice(0, 10);
  const fileName = `Student_PIN_Sheet_${scopeTag || 'All_Classes'}_${dateTag}.docx`;

  await exportFileUniversal(
    blob,
    fileName,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );

  return { fileName, exportedCount: scoped.length };
}
