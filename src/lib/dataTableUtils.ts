import type { ExamDataTable, ExamDataTableCell, Question } from '../types/database';

export interface DataTableBlankTarget {
  tableId: string;
  tableTitle?: string;
  rowIndex: number;
  colIndex: number;
  cellKey: string;
  rowLabel: string;
  colHeader: string;
  expectedAnswer?: string;
}

/**
 * Checks whether a single table cell represents a fillable blank cell.
 */
export function isBlankTableCell(cell: string | ExamDataTableCell | null | undefined): boolean {
  if (cell && typeof cell === 'object') {
    return Boolean(cell.is_blank);
  }
  if (typeof cell === 'string') {
    const trimmed = cell.trim();
    return /^\[\s*\]$/.test(trimmed) || cell.includes('[       ]') || cell.includes('[   ]');
  }
  return false;
}

/**
 * Extracts all fillable blank cell coordinates & expected answers from `tables`.
 * Cell keys use `${tableId}-r${rowIndex}-c${colIndex}`, matching `<ExamDataTable />`.
 */
export function extractDataTableBlankTargets(
  tables?: ExamDataTable[] | null
): DataTableBlankTarget[] {
  if (!Array.isArray(tables) || tables.length === 0) return [];
  const targets: DataTableBlankTarget[] = [];

  tables.forEach((tbl, tIdx) => {
    if (!tbl || !Array.isArray(tbl.headers) || !Array.isArray(tbl.rows)) return;
    const tableId = tbl.id || `Table ${tIdx + 1}`;

    tbl.rows.forEach((row, rIdx) => {
      if (!Array.isArray(row)) return;
      const firstCell = row[0];
      const rowLabel =
        firstCell && typeof firstCell === 'object'
          ? String(firstCell.value ?? '')
          : String(firstCell ?? '');

      row.forEach((cell, cIdx) => {
        if (!isBlankTableCell(cell)) return;
        const expected =
          cell && typeof cell === 'object' && cell.expected_answer !== undefined
            ? String(cell.expected_answer).trim()
            : undefined;
        targets.push({
          tableId,
          tableTitle: tbl.title,
          rowIndex: rIdx,
          colIndex: cIdx,
          cellKey: `${tableId}-r${rIdx}-c${cIdx}`,
          rowLabel: rowLabel.trim() || `Row ${rIdx + 1}`,
          colHeader: String(tbl.headers[cIdx] ?? `Column ${cIdx + 1}`).trim(),
          expectedAnswer: expected || undefined,
        });
      });
    });
  });

  return targets;
}

export function hasBlankDataTableCells(tables?: ExamDataTable[] | null): boolean {
  return extractDataTableBlankTargets(tables).length > 0;
}

/**
 * Parses serialized interactive table cell answers (e.g. `{"Table 6.1-r2-c1":"350"}`).
 */
export function parseTableCellAnswers(
  rawAnswer: string | number | Record<string, string> | undefined | null
): Record<string, string> {
  const result: Record<string, string> = {};
  if (rawAnswer === undefined || rawAnswer === null) return result;

  if (typeof rawAnswer === 'object') {
    Object.entries(rawAnswer).forEach(([k, v]) => {
      if (v !== undefined && v !== null) {
        result[k] = String(v).trim();
      }
    });
    return result;
  }

  const str = String(rawAnswer).trim();
  if (!str) return result;

  if (str.startsWith('{') && str.endsWith('}')) {
    try {
      const parsed = JSON.parse(str);
      if (parsed && typeof parsed === 'object') {
        Object.entries(parsed).forEach(([k, v]) => {
          if (v !== undefined && v !== null) {
            result[k] = String(v).trim();
          }
        });
        return result;
      }
    } catch {
      // Fall through if malformed JSON
    }
  }

  return result;
}

/**
 * Strips `expected_answer` from table cells before handing payload to a student browser.
 */
export function stripDataTableExpectedAnswers(
  tables?: ExamDataTable[] | null
): ExamDataTable[] | undefined {
  if (!Array.isArray(tables)) return tables ?? undefined;
  return tables.map((tbl) => {
    if (!tbl || !Array.isArray(tbl.rows)) return tbl;
    return {
      ...tbl,
      rows: tbl.rows.map((row) =>
        Array.isArray(row)
          ? row.map((cell) => {
              if (cell && typeof cell === 'object') {
                const { expected_answer: _stripped, ...rest } = cell as ExamDataTableCell;
                return rest;
              }
              return cell;
            })
          : row
      ),
    };
  });
}

/**
 * Identifies which sub-question (if any) owns completing the blank cells of parent `question.data_tables`.
 */
export function findTableCompletionSubIndex(question: Question): number {
  if (!hasBlankDataTableCells(question.data_tables) || !question.sub_questions?.length) {
    return -1;
  }
  const explicitIdx = question.sub_questions.findIndex((sq) =>
    /complete\b[^.!?\n]*\btable|blank\s*cell|empty\s*cell|fill\s+in\b[^.!?\n]*\btable|missing\s+values?\s+(?:in|into)\b[^.!?\n]*\btable/i.test(
      sq.question_text || ''
    )
  );
  return explicitIdx >= 0 ? explicitIdx : 0;
}

