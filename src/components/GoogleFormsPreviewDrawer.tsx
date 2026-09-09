// ─── Google Forms Quiz Pre-Export Preview Drawer ──────────────────────────────
// Allows teachers to visually inspect all flattened questions, point allocations,
// correct answer keys, and diagram attachments before exporting to Google.

import React, { useState, useMemo } from 'react';
import type { Question } from '../types/database';
import { flattenQuestionsForForms } from '../services/googleFormsExportService';

interface GoogleFormsPreviewDrawerProps {
  questions: Question[];
  imageBase64Map?: Record<string, string>;
  imageUrlMap?: Record<string, string>;
}

export const GoogleFormsPreviewDrawer: React.FC<GoogleFormsPreviewDrawerProps> = ({
  questions,
  imageBase64Map,
  imageUrlMap,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const items = useMemo(() => {
    return flattenQuestionsForForms(questions, imageBase64Map, imageUrlMap);
  }, [questions, imageBase64Map, imageUrlMap]);

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase();
    return items.filter(
      (it) =>
        it.title.toLowerCase().includes(q) ||
        (it.description && it.description.toLowerCase().includes(q)) ||
        (it.options && it.options.some((opt) => opt.toLowerCase().includes(q)))
    );
  }, [items, searchQuery]);

  const totalPoints = useMemo(() => items.reduce((sum, it) => sum + it.pointValue, 0), [items]);

  return (
    <div className="gf-preview-wrapper">
      <button
        type="button"
        className={`gf-preview-toggle-btn ${isOpen ? 'active' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        <span className="gf-preview-toggle-left">
          <span className="gf-preview-icon">👁️</span>
          <span className="gf-preview-title">
            Preview Parsed Questions &amp; Answer Keys
          </span>
          <span className="gf-preview-badge">
            {items.length} items &bull; {totalPoints} marks
          </span>
        </span>
        <span className="gf-preview-toggle-arrow">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div className="gf-preview-content">
          <div className="gf-preview-toolbar">
            <input
              type="text"
              className="gf-preview-search-input"
              placeholder="Filter preview questions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <span className="gf-preview-count-label">
              Showing {filteredItems.length} of {items.length} items
            </span>
          </div>

          <div className="gf-preview-card-list">
            {filteredItems.map((item, idx) => {
              const hasDiagram = Boolean(item.imageUrl || item.imageBase64);
              let typeBadgeClass = 'gf-badge-paragraph';
              let typeLabel = 'Paragraph';

              if (item.type === 'RADIO') {
                typeBadgeClass = 'gf-badge-mcq';
                typeLabel = 'Multiple Choice';
              } else if (item.type === 'CHECKBOX') {
                typeBadgeClass = 'gf-badge-select';
                typeLabel = 'Multiple Select';
              } else if (item.type === 'SHORT_ANSWER') {
                typeBadgeClass = 'gf-badge-short';
                typeLabel = 'Short Answer (Auto-graded)';
              } else if (item.type === 'GRID') {
                typeBadgeClass = 'gf-badge-mcq';
                typeLabel = `Multiple Choice Grid (${item.gridRows?.length || 0} rows)`;
              }

              return (
                <div key={item.id || idx} className="gf-preview-item-card">
                  <div className="gf-preview-item-header">
                    <div className="gf-preview-item-badges">
                      <span className={`gf-type-pill ${typeBadgeClass}`}>
                        {typeLabel}
                      </span>
                      <span className="gf-marks-pill">
                        {item.pointValue} {item.pointValue === 1 ? 'Mark' : 'Marks'}
                      </span>
                      {hasDiagram && (
                        <span className="gf-diagram-pill">🖼️ Has Diagram</span>
                      )}
                    </div>
                  </div>

                  <div className="gf-preview-item-title">{item.title}</div>

                  {item.description && (
                    <div className="gf-preview-item-desc">{item.description}</div>
                  )}

                  {/* Grid Rows and Columns Preview */}
                  {item.type === 'GRID' && item.gridRows && item.gridColumns && (
                    <div className="gf-preview-grid-box" style={{ marginTop: '8px', marginBottom: '8px', overflowX: 'auto' }}>
                      <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse', border: '1px solid #cbd5e1', borderRadius: '4px' }}>
                        <thead>
                          <tr style={{ background: '#f1f5f9' }}>
                            <th style={{ padding: '6px 10px', textAlign: 'left', borderBottom: '1px solid #cbd5e1' }}>Statement / Item</th>
                            {item.gridColumns.map((col, cIdx) => (
                              <th key={cIdx} style={{ padding: '6px 10px', textAlign: 'center', borderBottom: '1px solid #cbd5e1' }}>{col}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {item.gridRows.map((row, rIdx) => {
                            const correctCol = item.gridRowCorrectAnswers?.[row];
                            return (
                              <tr key={rIdx} style={{ borderBottom: '1px solid #e2e8f0' }}>
                                <td style={{ padding: '6px 10px', fontWeight: 500 }}>{row}</td>
                                {item.gridColumns!.map((col, cIdx) => {
                                  const isSelected = correctCol && correctCol.toLowerCase() === col.toLowerCase();
                                  return (
                                    <td key={cIdx} style={{ padding: '6px 10px', textAlign: 'center' }}>
                                      {isSelected ? (
                                        <span style={{ color: '#16a34a', fontWeight: 700 }}>● (Key)</span>
                                      ) : (
                                        <span style={{ color: '#94a3b8' }}>○</span>
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Options List */}
                  {item.options && item.options.length > 0 && (
                    <div className="gf-preview-options-list">
                      {item.options.map((opt, optIdx) => {
                        const isCorrect = item.correctOptionIndices?.includes(optIdx);
                        return (
                          <div
                            key={optIdx}
                            className={`gf-preview-option-row ${isCorrect ? 'is-correct' : ''}`}
                          >
                            <span className="gf-option-indicator">
                              {isCorrect ? '✓' : '○'}
                            </span>
                            <span className="gf-option-text">{opt}</span>
                            {isCorrect && (
                              <span className="gf-correct-tag">Correct Key</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Short Answer Keys */}
                  {item.type === 'SHORT_ANSWER' && item.correctAnswers && item.correctAnswers.length > 0 && (
                    <div className="gf-preview-short-answers">
                      <span className="gf-answer-key-label">Accepted Answers:</span>
                      <span className="gf-answer-key-values">
                        {item.correctAnswers.join('  |  ')}
                      </span>
                    </div>
                  )}

                  {/* Feedback / Mark Scheme */}
                  {item.feedbackWrong && (
                    <div className="gf-preview-markscheme-box">
                      <span className="gf-markscheme-label">Mark Scheme:</span>{' '}
                      {item.feedbackWrong}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
