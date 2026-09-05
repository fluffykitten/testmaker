import React from 'react';
import type { ExamDataTable as ExamDataTableType, ExamDataTableCell } from '../types/database';
import { ExamMathText } from './ExamMathText';
import './ExamDataTable.css';

export interface ExamDataTableProps {
  table?: ExamDataTableType | null;
  tables?: ExamDataTableType[] | null;
  isInteractive?: boolean;
  userAnswers?: Record<string, string>;
  onCellChange?: (cellKey: string, value: string) => void;
  showAnswers?: boolean;
  className?: string;
}

export const ExamDataTable: React.FC<ExamDataTableProps> = ({
  table,
  tables,
  isInteractive = false,
  userAnswers = {},
  onCellChange,
  showAnswers = false,
  className = '',
}) => {
  const tableList: ExamDataTableType[] = [];
  if (table) tableList.push(table);
  if (Array.isArray(tables)) {
    tables.forEach((t) => {
      if (t && Array.isArray(t.headers) && Array.isArray(t.rows)) {
        tableList.push(t);
      }
    });
  }

  if (tableList.length === 0) return null;

  return (
    <div className={`exam-data-tables-wrapper ${className}`}>
      {tableList.map((tbl, tIdx) => {
        const tableId = tbl.id || `Table ${tIdx + 1}`;
        return (
          <div key={tIdx} className="exam-data-table-container">
            {(tbl.id || tbl.title) && (
              <div className="exam-data-table-caption">
                {tbl.id && <span className="exam-table-badge">{tbl.id}</span>}
                {tbl.title && <span className="exam-table-title">{tbl.title}</span>}
              </div>
            )}
            <div className="exam-data-table-scroll">
              <table className="exam-data-table">
                <thead>
                  <tr>
                    {tbl.headers.map((hdr, hIdx) => (
                      <th key={hIdx} className="exam-table-th">
                        <ExamMathText content={hdr} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tbl.rows.map((row, rIdx) => (
                    <tr key={rIdx} className="exam-table-tr">
                      {row.map((cell, cIdx) => {
                        const cellKey = `${tableId}-r${rIdx}-c${cIdx}`;
                        const isObj = cell && typeof cell === 'object';
                        const cellObj: ExamDataTableCell = isObj
                          ? (cell as ExamDataTableCell)
                          : {
                              value: String(cell ?? ''),
                              is_blank:
                                typeof cell === 'string' &&
                                (/^\[\s*\]$/.test(cell.trim()) ||
                                  cell.includes('[       ]') ||
                                  cell.includes('[   ]')),
                            };

                        const isBlank = Boolean(cellObj.is_blank);
                        const expected = cellObj.expected_answer;
                        const studentVal = userAnswers[cellKey] ?? '';

                        return (
                          <td key={cIdx} className={`exam-table-td ${isBlank ? 'is-blank-cell' : ''}`}>
                            {isBlank ? (
                              isInteractive ? (
                                <div className="exam-table-input-wrap">
                                  <input
                                    type="text"
                                    className={`exam-table-blank-input ${
                                      showAnswers && expected
                                        ? studentVal.trim().toLowerCase() === expected.trim().toLowerCase()
                                          ? 'is-correct'
                                          : 'is-incorrect'
                                        : ''
                                    }`}
                                    placeholder="Enter answer…"
                                    value={studentVal}
                                    onChange={(e) => onCellChange?.(cellKey, e.target.value)}
                                  />
                                  {showAnswers && expected && (
                                    <div className="exam-table-expected-pill">
                                      Ans: <ExamMathText content={expected} />
                                    </div>
                                  )}
                                </div>
                              ) : showAnswers && expected ? (
                                <div className="exam-table-answer-display">
                                  <span className="exam-table-blank-line">
                                    <ExamMathText content={expected} />
                                  </span>
                                </div>
                              ) : (
                                <span className="exam-table-blank-placeholder">
                                  [ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ]
                                </span>
                              )
                            ) : (
                              <ExamMathText content={cellObj.value} />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
};
