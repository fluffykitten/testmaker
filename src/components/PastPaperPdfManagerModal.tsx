import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import {
  fetchDistinctPastPapersSummary,
  batchAttachPastPaperPdf,
  type PastPaperGroupSummary,
} from '../services/questionBankService';
import { uploadPastPaperPdf } from '../services/storageService';
import './PastPaperPdfManagerModal.css';

interface PastPaperPdfManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  syllabusId?: string;
  onPdfsUpdated?: () => void;
}

export function PastPaperPdfManagerModal({
  isOpen,
  onClose,
  syllabusId,
}: PastPaperPdfManagerModalProps) {
  const [papers, setPapers] = useState<PastPaperGroupSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeUploadKey, setActiveUploadKey] = useState<string | null>(null);
  const [editingUrlKey, setEditingUrlKey] = useState<string | null>(null);
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const backdropDismiss = useBackdropDismiss(onClose);

  const loadPapers = async () => {
    setIsLoading(true);
    try {
      const data = await fetchDistinctPastPapersSummary(syllabusId);
      setPapers(data);
    } catch (err) {
      console.error('Failed to load past papers summary:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadPapers();
      setStatusMessage(null);
    }
  }, [isOpen, syllabusId]);

  if (!isOpen) return null;

  const handleFileUpload = async (paper: PastPaperGroupSummary, file: File) => {
    const key = `${paper.syllabusId}_${paper.year}_${paper.series}_${paper.paperNumber}`;
    setActiveUploadKey(key);
    setStatusMessage(`Uploading PDF for ${paper.subjectCode} ${paper.year} Paper ${paper.paperNumber}…`);

    try {
      const url = await uploadPastPaperPdf(file, {
        subject_code: paper.subjectCode,
        year: paper.year,
        series: paper.series,
        paper_number: paper.paperNumber,
      });

      if (!url) {
        throw new Error('Upload failed to return a storage URL.');
      }

      const res = await batchAttachPastPaperPdf(
        {
          syllabusId: paper.syllabusId,
          year: paper.year,
          series: paper.series,
          paperNumber: paper.paperNumber,
        },
        url
      );

      setStatusMessage(`Attached PDF to ${res.updatedCount} questions in this paper.`);
      await loadPapers();
    } catch (err: any) {
      setStatusMessage(`Error: ${err?.message || 'Upload failed'}`);
    } finally {
      setActiveUploadKey(null);
    }
  };

  const handleSaveCustomUrl = async (paper: PastPaperGroupSummary) => {
    const url = customUrlInput.trim();
    if (!url) return;

    const key = `${paper.syllabusId}_${paper.year}_${paper.series}_${paper.paperNumber}`;
    setActiveUploadKey(key);
    setStatusMessage('Attaching PDF URL…');

    try {
      const res = await batchAttachPastPaperPdf(
        {
          syllabusId: paper.syllabusId,
          year: paper.year,
          series: paper.series,
          paperNumber: paper.paperNumber,
        },
        url
      );

      setStatusMessage(`Attached URL to ${res.updatedCount} questions.`);
      setEditingUrlKey(null);
      setCustomUrlInput('');
      await loadPapers();
    } catch (err: any) {
      setStatusMessage(`Error: ${err?.message || 'Failed to attach URL'}`);
    } finally {
      setActiveUploadKey(null);
    }
  };

  return createPortal(
    <div
      className="past-paper-modal-overlay"
      onMouseDown={backdropDismiss.onMouseDown}
      onClick={backdropDismiss.onClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="past-paper-manager-title"
    >
      <div className="past-paper-modal-card">
        <div className="past-paper-modal-header">
          <div>
            <h2 id="past-paper-manager-title" className="past-paper-modal-title">
              Past Paper Source PDF Manager
            </h2>
            <div className="past-paper-modal-subtitle">
              Link Question Paper PDFs to past papers in your bank to power Table of Specifications citation links
            </div>
          </div>
          <button
            type="button"
            className="past-paper-modal-close"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        <div className="past-paper-modal-body">
          {statusMessage && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: '6px',
                marginBottom: '16px',
                fontSize: '0.85rem',
                background: statusMessage.startsWith('Error') ? '#fef2f2' : '#f0fdf4',
                color: statusMessage.startsWith('Error') ? '#b91c1c' : '#15803d',
                border: `1px solid ${statusMessage.startsWith('Error') ? '#fecaca' : '#bbf7d0'}`,
              }}
            >
              {statusMessage}
            </div>
          )}

          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#64748b' }}>
              Scanning question bank for past papers…
            </div>
          ) : papers.length === 0 ? (
            <div className="past-paper-empty">
              No questions found for the selected syllabus. Upload an exam paper first to get started.
            </div>
          ) : (
            <table className="past-paper-table">
              <thead>
                <tr>
                  <th>Paper</th>
                  <th>Questions</th>
                  <th>PDF Link Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {papers.map((paper) => {
                  const key = `${paper.syllabusId}_${paper.year}_${paper.series}_${paper.paperNumber}`;
                  const isUploading = activeUploadKey === key;
                  const isEditingUrl = editingUrlKey === key;

                  return (
                    <tr key={key} className="past-paper-row">
                      <td>
                        <strong>{paper.subjectName} ({paper.subjectCode})</strong>
                        <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '2px' }}>
                          {paper.year} • {paper.series} • Paper {paper.paperNumber}
                        </div>
                      </td>
                      <td>
                        {paper.totalQuestions} questions
                      </td>
                      <td>
                        {paper.hasPdfUrl ? (
                          <span className="past-paper-badge-linked">
                            Linked
                          </span>
                        ) : (
                          <span className="past-paper-badge-missing">
                            Missing PDF
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {isEditingUrl ? (
                          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', alignItems: 'center' }}>
                            <input
                              type="text"
                              value={customUrlInput}
                              onChange={(e) => setCustomUrlInput(e.target.value)}
                              placeholder="https://.../paper.pdf"
                              style={{
                                padding: '4px 8px',
                                fontSize: '0.8rem',
                                border: '1px solid #cbd5e1',
                                borderRadius: '4px',
                                width: '200px',
                              }}
                            />
                            <button
                              type="button"
                              className="past-paper-btn past-paper-btn-primary"
                              disabled={isUploading || !customUrlInput.trim()}
                              onClick={() => handleSaveCustomUrl(paper)}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="past-paper-btn"
                              onClick={() => setEditingUrlKey(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', alignItems: 'center' }}>
                            {paper.samplePdfUrl && (
                              <a
                                href={paper.samplePdfUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="past-paper-btn"
                                title="Open current PDF link in new tab"
                              >
                                View PDF ↗
                              </a>
                            )}
                            <label className="past-paper-btn past-paper-btn-primary" style={{ cursor: isUploading ? 'not-allowed' : 'pointer', margin: 0 }}>
                              {isUploading ? 'Uploading…' : paper.hasPdfUrl ? 'Replace PDF' : 'Upload PDF'}
                              <input
                                type="file"
                                accept="application/pdf"
                                style={{ display: 'none' }}
                                disabled={isUploading}
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) handleFileUpload(paper, file);
                                }}
                              />
                            </label>
                            <button
                              type="button"
                              className="past-paper-btn"
                              title="Paste URL manually"
                              onClick={() => {
                                setEditingUrlKey(key);
                                setCustomUrlInput(paper.samplePdfUrl || '');
                              }}
                            >
                              Paste URL
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="past-paper-modal-footer">
          <button type="button" className="past-paper-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
