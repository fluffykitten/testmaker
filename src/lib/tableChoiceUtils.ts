import type { MarkScheme } from '../types/database';

export interface TableChoiceRow {
  label: string;
  correctColumn: string;
}

export interface ParsedTableChoice {
  stemText: string;
  itemHeader: string;
  columns: string[];
  rows: TableChoiceRow[];
}

export interface TableChoicePreset {
  id: string;
  label: string;
  columns: string[];
  defaultItemHeader: string;
}

export const TABLE_CHOICE_PRESETS: TableChoicePreset[] = [
  { id: 'tepat', label: 'Tepat / Tidak Tepat', columns: ['Tepat', 'Tidak Tepat'], defaultItemHeader: 'Pernyataan' },
  { id: 'benar', label: 'Benar / Salah', columns: ['Benar', 'Salah'], defaultItemHeader: 'Pernyataan' },
  { id: 'sesuai', label: 'Sesuai / Tidak Sesuai', columns: ['Sesuai', 'Tidak Sesuai'], defaultItemHeader: 'Pernyataan' },
  { id: 'setuju', label: 'Setuju / Tidak Setuju', columns: ['Setuju', 'Tidak Setuju'], defaultItemHeader: 'Pernyataan' },
  { id: 'fakta', label: 'Fakta / Opini', columns: ['Fakta', 'Opini'], defaultItemHeader: 'Pernyataan' },
  { id: 'truefalse', label: 'True / False', columns: ['True', 'False'], defaultItemHeader: 'Statement' },
  { id: 'yatidak', label: 'Ya / Tidak', columns: ['Ya', 'Tidak'], defaultItemHeader: 'Pernyataan' },
];

const MATRIX_COLUMN_HEADER_RE =
  /^(?:benar|salah|true|false|ya|tidak|yes|no|sesuai|tidak\s*sesuai|setuju|tidak\s*setuju|agree|disagree|tepat|tidak\s*tepat|fakta|opini|b|s|t|f)$/i;

const MATRIX_COLUMN_SUBSTRING_RE =
  /\b(?:benar|salah|true|false|sesuai|setuju|tepat|fakta|opini|agree|disagree)\b/i;

export function isInteractiveMatrixColumnHeader(header: string): boolean {
  const clean = (header || '').replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return MATRIX_COLUMN_HEADER_RE.test(clean) || MATRIX_COLUMN_SUBSTRING_RE.test(clean);
}

export function isIndexColumnHeader(header: string): boolean {
  return /^(?:no\.?|#|nomor)$/i.test((header || '').trim());
}

function isSeparatorRow(line: string): boolean {
  const clean = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = clean.split('|').map((c) => c.trim());
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c) || /^[-:\s]+$/.test(c));
}

function parsePipeRow(line: string): string[] {
  let clean = line.trim();
  if (clean.startsWith('|')) clean = clean.slice(1);
  if (clean.endsWith('|')) clean = clean.slice(0, -1);
  return clean.split('|').map((c) => c.trim());
}

function stripLeadingNumbering(label: string): string {
  return label.replace(/^\d+\.\s*/, '').trim();
}

function resolveRowExpectedColumn(
  rowIdx: number,
  rowLabel: string,
  columns: string[],
  markScheme?: Partial<MarkScheme> | string | null
): string {
  const rawPoints: string[] = [];
  if (typeof markScheme === 'string') {
    rawPoints.push(...markScheme.split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean));
  } else if (markScheme && typeof markScheme === 'object') {
    if (Array.isArray(markScheme.marking_points)) {
      rawPoints.push(...markScheme.marking_points.map((p) => String(p || '').trim()).filter(Boolean));
    }
    if (rawPoints.length === 0 && Array.isArray(markScheme.acceptable_answers)) {
      rawPoints.push(...markScheme.acceptable_answers.map((p) => String(p || '').trim()).filter(Boolean));
    }
  }

  // Handle single comma-separated sequence e.g. "Tepat, Tepat, Tidak Tepat"
  if (rawPoints.length === 1 && rawPoints[0].includes(',')) {
    const parts = rawPoints[0].split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > rowIdx) {
      const matched = matchColumnName(parts[rowIdx], columns);
      if (matched) return matched;
    }
  }

  const cleanLabel = stripLeadingNumbering(rowLabel).toLowerCase();
  const rowNum = rowIdx + 1;

  for (const pt of rawPoints) {
    const colonIdx = pt.lastIndexOf(':');
    const ptLeft = colonIdx >= 0 ? pt.slice(0, colonIdx).trim() : '';
    const ptRight = colonIdx >= 0 ? pt.slice(colonIdx + 1).trim() : pt.trim();

    const numMatch = ptLeft.match(/^(\d+)[.)\s]/);
    if (numMatch && Number(numMatch[1]) === rowNum) {
      const matched = matchColumnName(ptRight, columns);
      if (matched) return matched;
    }

    if (cleanLabel && ptLeft.toLowerCase().includes(cleanLabel.slice(0, 24))) {
      const matched = matchColumnName(ptRight, columns);
      if (matched) return matched;
    }
  }

  if (rawPoints[rowIdx]) {
    const pt = rawPoints[rowIdx];
    const val = pt.includes(':') ? pt.slice(pt.lastIndexOf(':') + 1).trim() : pt.trim();
    const matched = matchColumnName(val, columns);
    if (matched) return matched;
  }

  return columns[0] || '';
}

function matchColumnName(candidate: string, columns: string[]): string | null {
  const norm = (candidate || '').replace(/\[\d+\]/g, '').trim().toLowerCase();
  if (!norm) return null;
  for (const col of columns) {
    if (col.trim().toLowerCase() === norm) return col;
  }
  for (const col of columns) {
    if (norm.includes(col.trim().toLowerCase())) return col;
  }
  return null;
}

export function parseTableChoiceFromQuestion(
  questionText?: string | null,
  markScheme?: Partial<MarkScheme> | string | null
): ParsedTableChoice {
  const normalizedText = (questionText || '')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const lines = normalizedText.split('\n');
  let tableStart = -1;
  let tableEnd = lines.length;
  const tableLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const isPipe = trimmed.startsWith('|') || (trimmed.match(/\|/g) || []).length >= 2;
    if (isPipe) {
      if (tableStart === -1) tableStart = i;
      tableLines.push(lines[i]);
    } else if (tableStart !== -1 && tableLines.length >= 2) {
      tableEnd = i;
      break;
    } else {
      tableStart = -1;
      tableLines.length = 0;
    }
  }

  if (tableStart === -1 || tableLines.length < 2) {
    return {
      stemText: normalizedText.trim(),
      itemHeader: 'Pernyataan',
      columns: ['Tepat', 'Tidak Tepat'],
      rows: [{ label: '', correctColumn: 'Tepat' }],
    };
  }

  const nonSepRows = tableLines.filter((l) => l.trim().length > 0 && !isSeparatorRow(l));
  if (nonSepRows.length < 2) {
    return {
      stemText: normalizedText.trim(),
      itemHeader: 'Pernyataan',
      columns: ['Tepat', 'Tidak Tepat'],
      rows: [{ label: '', correctColumn: 'Tepat' }],
    };
  }

  const headerCells = parsePipeRow(nonSepRows[0]);
  const hasIndexCol = headerCells.length >= 4 && isIndexColumnHeader(headerCells[0]);
  const itemHeader = (hasIndexCol ? headerCells[1] : headerCells[0]) || 'Pernyataan';
  const rawChoiceCols = (hasIndexCol ? headerCells.slice(2) : headerCells.slice(1)).filter(Boolean);
  const columns = rawChoiceCols.length >= 2 ? rawChoiceCols : ['Tepat', 'Tidak Tepat'];

  const rows: TableChoiceRow[] = nonSepRows.slice(1).map((rawRow, idx) => {
    const cells = parsePipeRow(rawRow);
    const label = stripLeadingNumbering(hasIndexCol ? cells[1] || '' : cells[0] || '');
    return {
      label,
      correctColumn: resolveRowExpectedColumn(idx, label, columns, markScheme),
    };
  });

  const before = lines.slice(0, tableStart).join('\n').trim();
  const after = lines.slice(tableEnd).join('\n').trim();
  const stemText = [before, after].filter(Boolean).join('\n\n').trim();

  return {
    stemText,
    itemHeader,
    columns,
    rows: rows.length > 0 ? rows : [{ label: '', correctColumn: columns[0] || 'Tepat' }],
  };
}

export function serializeTableChoiceToQuestion(parsed: ParsedTableChoice): {
  questionText: string;
  markingPoints: string[];
} {
  const cleanItemHeader = (parsed.itemHeader || 'Pernyataan').trim() || 'Pernyataan';
  const cleanCols = parsed.columns.map((c) => c.trim()).filter(Boolean);
  const effectiveCols = cleanCols.length >= 2 ? cleanCols : ['Tepat', 'Tidak Tepat'];
  const cleanRows = parsed.rows.filter((r) => r.label.trim().length > 0);

  const escapePipe = (val: string) => val.replace(/\|/g, '\\|').trim();
  const headerLine = `| No. | ${escapePipe(cleanItemHeader)} | ${effectiveCols.map(escapePipe).join(' | ')} |`;
  const sepLine = `|---|---|${effectiveCols.map(() => '---').join('|')}|`;
  const blankCells = effectiveCols.map(() => '[ ]').join(' | ');
  const bodyLines = cleanRows.map((r, idx) => `| ${idx + 1} | ${escapePipe(r.label)} | ${blankCells} |`);

  const tableMarkdown = [headerLine, sepLine, ...bodyLines].join('\n');
  const stem = (parsed.stemText || '').trim();
  const questionText = stem ? `${stem}\n\n${tableMarkdown}` : tableMarkdown;

  const markingPoints = cleanRows.map((r, idx) => {
    const col = effectiveCols.includes(r.correctColumn) ? r.correctColumn : effectiveCols[0];
    return `${idx + 1}. ${r.label.trim()}: ${col}`;
  });

  return { questionText, markingPoints };
}
