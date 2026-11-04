import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import {
  fetchDistinctPastPapersSummary,
  batchAttachPastPaperPdf,
  batchDetachPastPaperPdf,
  fetchSyllabuses,
  type PastPaperGroupSummary,
} from '../services/questionBankService';
import { uploadPastPaperPdf } from '../services/storageService';
import type { Syllabus } from '../types/database';
import './PastPaperPdfManagerModal.css';

interface PastPaperPdfManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialSyllabusId?: string;
  syllabusId?: string;
  onPdfsUpdated?: () => void;
}

export function PastPaperPdfManagerModal({
  isOpen,
  onClose,
  initialSyllabusId,
  syllabusId: propSyllabusId,
  onPdfsUpdated,
}: PastPaperPdfManagerModalProps) {
  const [papers, setPapers] = useState<PastPaperGroupSummary[]>([]);
  const [syllabuses, setSyllabuses] = useState<Syllabus[]>([]);
  const [selectedSyllabusId, setSelectedSyllabusId] = useState<string>(
    initialSyllabusId || propSyllabusId || 'all'
  );
  const [isLoading, setIsLoading] = useState(true);
  const [activeUploadKey, setActiveUploadKey] = useState<string | null>(null);
  const [editingUrlKey, setEditingUrlKey] = useState<string | null>(null);
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const backdropDismiss = useBackdropDismiss(onClose);

  // Sync selected syllabus if prop changes on open
  useEffect(() => {
    if (isOpen) {
      setSelectedSyllabusId(initialSyllabusId || propSyllabusId || 'all');
    }
  }, [isOpen, initialSyllabusId, propSyllabusId]);

  // Load list of available syllabuses for filter dropdown
  useEffect(() => {
    if (isOpen) {
      fetchSyllabuses()
        .then((data) => setSyllabuses(data || []))
        .catch((err) => console.error('Failed to load syllabuses in modal:', err));
    }
  }, [isOpen]);

  const loadPapers = async (filterSylId?: string) => {
    setIsLoading(true);
    try {
      const activeSyl = filterSylId !== undefined ? filterSylId : selectedSyllabusId;
      const targetSylId = activeSyl && activeSyl !== 'all' ? activeSyl : undefined;
      const data = await fetchDistinctPastPapersSummary(targetSylId);
      setPapers(data);
    } catch (err) {
      console.error('Failed to load past papers summary:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadPapers(selectedSyllabusId);
      setStatusMessage(null);
    }
  }, [isOpen, selectedSyllabusId]);

  if (!isOpen) return null;

  const handleFileUpload = async (paper: PastPaperGroupSummary, file: File) => {
    if (!paper.syllabusId) {
      setStatusMessage('Error: Paper group is missing syllabus ID.');
      return;
    }

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

      setStatusMessage(`Attached PDF to ${res.updatedCount} questions in ${paper.subjectName} (${paper.subjectCode}).`);
      await loadPapers();
      onPdfsUpdated?.();
    } catch (err: any) {
      setStatusMessage(`Error: ${err?.message || 'Upload failed'}`);
    } finally {
      setActiveUploadKey(null);
    }
  };

  const handleSaveCustomUrl = async (paper: PastPaperGroupSummary) => {
    const url = customUrlInput.trim();
    if (!url) return;

    if (!paper.syllabusId) {
      setStatusMessage('Error: Paper group is missing syllabus ID.');
      return;
    }

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

      setStatusMessage(`Attached URL to ${res.updatedCount} questions in ${paper.subjectName}.`);
      setEditingUrlKey(null);
      setCustomUrlInput('');
      await loadPapers();
      onPdfsUpdated?.();
    } catch (err: any) {
      setStatusMessage(`Error: ${err?.message || 'Failed to attach URL'}`);
    } finally {
      setActiveUploadKey(null);
    }
  };

  const handleUnlinkPdf = async (paper: PastPaperGroupSummary) => {
    if (!paper.syllabusId) return;

    const confirmed = window.confirm(
      `Remove PDF link from ${paper.subjectName} (${paper.subjectCode}) ${paper.year} Paper ${paper.paperNumber}?\n\nThis will remove the past paper citation link from ${paper.linkedPdfCount} questions.`
    );
    if (!confirmed) return;

    const key = `${paper.syllabusId}_${paper.year}_${paper.series}_${paper.paperNumber}`;
    setActiveUploadKey(key);
    setStatusMessage('Unlinking PDF…');

    try {
      const res = await batchDetachPastPaperPdf({
        syllabusId: paper.syllabusId,
        year: paper.year,
        series: paper.series,
        paperNumber: paper.paperNumber,
      });

      setStatusMessage(`Unlinked PDF from ${res.updatedCount} questions in ${paper.subjectName}.`);
      await loadPapers();
      onPdfsUpdated?.();
    } catch (err: any) {
      setStatusMessage(`Error: ${err?.message || 'Failed to unlink PDF'}`);
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
          {/* Subject Filter Bar */}
          <div className="past-paper-filter-bar">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label htmlFor="past-paper-subject-filter" style={{ fontSize: '0.82rem', fontWeight: 600, color: '#475569' }}>
                Filter by Subject:
              </label>
              <select
                id="past-paper-subject-filter"
                className="past-paper-select"
                value={selectedSyllabusId}
                onChange={(e) => setSelectedSyllabusId(e.target.value)}
              >
                <option value="all">All Subjects ({syllabuses.length})</option>
                {syllabuses.map((syl) => (
                  <option key={syl.id} value={syl.id}>
                    {syl.subject_name} ({syl.subject_code})
                  </option>
                ))}
              </select>
            </div>
            <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
              {papers.length} {papers.length === 1 ? 'paper' : 'papers'} found
            </div>
          </div>

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
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <strong>{paper.subjectName}</strong>
                          <span style={{ fontSize: '0.75rem', background: '#e2e8f0', color: '#334155', padding: '1px 6px', borderRadius: '4px', fontWeight: 600 }}>
                            {paper.subjectCode}
                          </span>
                        </div>
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
                            Linked ({paper.linkedPdfCount}/{paper.totalQuestions})
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
                            {paper.hasPdfUrl && (
                              <button
                                type="button"
                                className="past-paper-btn past-paper-btn-danger"
                                title="Unlink PDF from this paper"
                                disabled={isUploading}
                                onClick={() => handleUnlinkPdf(paper)}
                              >
                                Unlink
                              </button>
                            )}
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
