import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import {
  fetchDistinctPastPapersSummary,
  updatePastPapersSummaryCache,
  batchAttachPastPaperPdf,
  batchDetachPastPaperPdf,
  batchAttachCambridgeHubUrl,
  batchDetachCambridgeHubUrl,
  batchAttachCambridgeMsHubUrl,
  batchDetachCambridgeMsHubUrl,
  validateCambridgeHubUrl,
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

type EditingTarget = 'pdf' | 'qp_hub' | 'ms_hub';

export function PastPaperPdfManagerModal({
  isOpen,
  onClose,
  initialSyllabusId,
  syllabusId: propSyllabusId,
  onPdfsUpdated,
}: PastPaperPdfManagerModalProps) {
  const [papers, setPapers] = useState<PastPaperGroupSummary[]>([]);
  const [syllabuses, setSyllabuses] = useState<Syllabus[]>([]);
  const [selectedSyllabusId, setSelectedSyllabusId] = useState<string>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [activeUploadKey, setActiveUploadKey] = useState<string | null>(null);
  const [editingUrlKey, setEditingUrlKey] = useState<string | null>(null);
  const [editingTarget, setEditingTarget] = useState<EditingTarget>('pdf');
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const backdropDismiss = useBackdropDismiss(onClose);

  // Default to 'all' so users see all papers immediately (matching previous behavior),
  // while respecting propSyllabusId or initialSyllabusId if explicitly passed
  useEffect(() => {
    if (isOpen) {
      setSelectedSyllabusId(propSyllabusId || initialSyllabusId || 'all');
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

  const loadPapers = async (filterSylId?: string, forceRefresh = false) => {
    setIsLoading(true);
    try {
      const activeSyl = filterSylId !== undefined ? filterSylId : selectedSyllabusId;
      const targetSylId = activeSyl && activeSyl !== 'all' ? activeSyl : undefined;
      const data = await fetchDistinctPastPapersSummary(targetSylId, { forceRefresh });
      setPapers(data);
    } catch (err) {
      console.error('Failed to load past papers summary:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const updateLocalPaper = (
    paper: PastPaperGroupSummary,
    updates: Partial<PastPaperGroupSummary>
  ) => {
    const filter = {
      syllabusId: paper.syllabusId,
      year: paper.year,
      series: paper.series,
      paperNumber: paper.paperNumber,
    };
    setPapers((prev) =>
      prev.map((p) => {
        const matches =
          p.syllabusId === filter.syllabusId &&
          p.year === filter.year &&
          p.series.toLowerCase() === filter.series.toLowerCase() &&
          String(p.paperNumber) === String(filter.paperNumber);
        if (!matches) return p;
        return { ...p, ...updates };
      })
    );
    updatePastPapersSummaryCache(filter, updates);
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

      updateLocalPaper(paper, {
        hasPdfUrl: true,
        samplePdfUrl: url,
        linkedPdfCount: res.updatedCount || paper.totalQuestions,
      });

      setStatusMessage(`Attached PDF to ${res.updatedCount} questions in ${paper.subjectName} (${paper.subjectCode}).`);
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

    try {
      const filter = {
        syllabusId: paper.syllabusId,
        year: paper.year,
        series: paper.series,
        paperNumber: paper.paperNumber,
      };

      if (editingTarget === 'pdf') {
        setStatusMessage('Attaching Server PDF URL…');
        const res = await batchAttachPastPaperPdf(filter, url);
        updateLocalPaper(paper, {
          hasPdfUrl: true,
          samplePdfUrl: url,
          linkedPdfCount: res.updatedCount || paper.totalQuestions,
        });
        setStatusMessage(`Attached Server PDF URL to ${res.updatedCount} questions in ${paper.subjectName}.`);
      } else if (editingTarget === 'qp_hub') {
        setStatusMessage('Attaching Cambridge QP Hub URL…');
        const res = await batchAttachCambridgeHubUrl(filter, url);
        updateLocalPaper(paper, {
          hasHubUrl: true,
          sampleHubUrl: url,
          linkedHubCount: res.updatedCount || paper.totalQuestions,
        });
        setStatusMessage(`Attached Cambridge QP Hub URL to ${res.updatedCount} questions in ${paper.subjectName}.`);
      } else if (editingTarget === 'ms_hub') {
        setStatusMessage('Attaching Cambridge Mark Scheme Hub URL…');
        const res = await batchAttachCambridgeMsHubUrl(filter, url);
        updateLocalPaper(paper, {
          hasMsHubUrl: true,
          sampleMsHubUrl: url,
          linkedMsHubCount: res.updatedCount || paper.totalQuestions,
        });
        setStatusMessage(`Attached Cambridge Mark Scheme Hub URL to ${res.updatedCount} questions in ${paper.subjectName}.`);
      }

      setEditingUrlKey(null);
      setCustomUrlInput('');
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
      `Remove Server PDF link from ${paper.subjectName} (${paper.subjectCode}) ${paper.year} Paper ${paper.paperNumber}?\n\nThis will remove the server PDF citation link from ${paper.linkedPdfCount} questions.`
    );
    if (!confirmed) return;

    const key = `${paper.syllabusId}_${paper.year}_${paper.series}_${paper.paperNumber}`;
    setActiveUploadKey(key);
    setStatusMessage('Unlinking Server PDF…');

    try {
      const res = await batchDetachPastPaperPdf({
        syllabusId: paper.syllabusId,
        year: paper.year,
        series: paper.series,
        paperNumber: paper.paperNumber,
      });

      updateLocalPaper(paper, {
        hasPdfUrl: false,
        samplePdfUrl: null,
        linkedPdfCount: 0,
      });

      setStatusMessage(`Unlinked Server PDF from ${res.updatedCount} questions in ${paper.subjectName}.`);
      onPdfsUpdated?.();
    } catch (err: any) {
      setStatusMessage(`Error: ${err?.message || 'Failed to unlink PDF'}`);
    } finally {
      setActiveUploadKey(null);
    }
  };

  const handleUnlinkHubUrl = async (paper: PastPaperGroupSummary, target: 'qp_hub' | 'ms_hub') => {
    if (!paper.syllabusId) return;

    const label = target === 'qp_hub' ? 'Cambridge QP Hub' : 'Cambridge Mark Scheme Hub';
    const confirmed = window.confirm(
      `Remove ${label} link from ${paper.subjectName} (${paper.subjectCode}) ${paper.year} Paper ${paper.paperNumber}?`
    );
    if (!confirmed) return;

    const key = `${paper.syllabusId}_${paper.year}_${paper.series}_${paper.paperNumber}`;
    setActiveUploadKey(key);
    setStatusMessage(`Unlinking ${label}…`);

    try {
      const filter = {
        syllabusId: paper.syllabusId,
        year: paper.year,
        series: paper.series,
        paperNumber: paper.paperNumber,
      };
      const res =
        target === 'qp_hub'
          ? await batchDetachCambridgeHubUrl(filter)
          : await batchDetachCambridgeMsHubUrl(filter);

      if (target === 'qp_hub') {
        updateLocalPaper(paper, {
          hasHubUrl: false,
          sampleHubUrl: null,
          linkedHubCount: 0,
        });
      } else {
        updateLocalPaper(paper, {
          hasMsHubUrl: false,
          sampleMsHubUrl: null,
          linkedMsHubCount: 0,
        });
      }

      setStatusMessage(`Removed ${label} link from ${res.updatedCount} questions in ${paper.subjectName}.`);
      setEditingUrlKey(null);
      setCustomUrlInput('');
      onPdfsUpdated?.();
    } catch (err: any) {
      setStatusMessage(`Error: ${err?.message || 'Failed to unlink Hub URL'}`);
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
              Past Paper Source PDF & Cambridge Hub Link Manager
            </h2>
            <div className="past-paper-modal-subtitle">
              Link School Server PDFs and official Cambridge School Support Hub (QP & Mark Scheme) links to power Table of Specifications citations
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
              <button
                type="button"
                className="past-paper-btn past-paper-btn-secondary"
                style={{ padding: '4px 10px', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={() => loadPapers(selectedSyllabusId, true)}
                title="Force refresh database paper summary"
                disabled={isLoading}
              >
                {isLoading ? 'Refreshing…' : '↻ Refresh'}
              </button>
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
              <p style={{ margin: '0 0 12px 0' }}>
                {selectedSyllabusId !== 'all'
                  ? 'No past paper questions found for the selected subject.'
                  : 'No questions found in the question bank. Upload an exam paper first to get started.'}
              </p>
              {selectedSyllabusId !== 'all' && (
                <button
                  type="button"
                  className="past-paper-btn past-paper-btn-primary"
                  onClick={() => setSelectedSyllabusId('all')}
                >
                  Show All Subjects
                </button>
              )}
            </div>
          ) : (
            <table className="past-paper-table">
              <thead>
                <tr>
                  <th>Paper</th>
                  <th>Questions</th>
                  <th>Citation Links Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {papers.map((paper) => {
                  const key = `${paper.syllabusId}_${paper.year}_${paper.series}_${paper.paperNumber}`;
                  const isUploading = activeUploadKey === key;
                  const isEditingUrl = editingUrlKey === key;

                  const hubValidation =
                    isEditingUrl && (editingTarget === 'qp_hub' || editingTarget === 'ms_hub') && customUrlInput.trim()
                      ? validateCambridgeHubUrl(customUrlInput)
                      : null;

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
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                          {paper.hasPdfUrl ? (
                            <span className="past-paper-badge-linked" title="School Server PDF linked">
                              Server PDF ({paper.linkedPdfCount}/{paper.totalQuestions})
                            </span>
                          ) : (
                            <span className="past-paper-badge-missing" title="No School Server PDF linked yet">
                              Missing PDF
                            </span>
                          )}

                          {paper.hasHubUrl ? (
                            <span className="past-paper-badge-hub" title="Cambridge Support Hub QP linked">
                              QP Hub ({paper.linkedHubCount}/{paper.totalQuestions})
                            </span>
                          ) : (
                            <span className="past-paper-badge-missing" title="No Cambridge Support Hub QP URL set">
                              No QP Hub
                            </span>
                          )}

                          {paper.hasMsHubUrl ? (
                            <span className="past-paper-badge-ms-hub" title="Cambridge Support Hub Mark Scheme linked">
                              MS Hub ({paper.linkedMsHubCount}/{paper.totalQuestions})
                            </span>
                          ) : (
                            <span className="past-paper-badge-missing" title="No Cambridge Support Hub Mark Scheme URL set">
                              No MS Hub
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {isEditingUrl ? (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
                            <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#334155' }}>
                                {editingTarget === 'pdf'
                                  ? 'Server PDF URL:'
                                  : editingTarget === 'qp_hub'
                                  ? 'Cambridge QP Hub URL:'
                                  : 'Cambridge MS Hub URL:'}
                              </span>
                              <input
                                type="url"
                                value={customUrlInput}
                                onChange={(e) => setCustomUrlInput(e.target.value)}
                                placeholder={
                                  editingTarget === 'pdf'
                                    ? 'https://.../paper.pdf'
                                    : 'https://schoolsupporthub.cambridge.org/item/...'
                                }
                                style={{
                                  padding: '5px 8px',
                                  fontSize: '0.8rem',
                                  border: '1px solid #cbd5e1',
                                  borderRadius: '4px',
                                  width: '260px',
                                }}
                              />
                              <button
                                type="button"
                                className="past-paper-btn past-paper-btn-primary"
                                disabled={
                                  isUploading ||
                                  !customUrlInput.trim() ||
                                  (hubValidation !== null && !hubValidation.isValid)
                                }
                                onClick={() => handleSaveCustomUrl(paper)}
                              >
                                Save
                              </button>
                              {editingTarget === 'qp_hub' && paper.hasHubUrl && (
                                <button
                                  type="button"
                                  className="past-paper-btn past-paper-btn-danger"
                                  disabled={isUploading}
                                  onClick={() => handleUnlinkHubUrl(paper, 'qp_hub')}
                                >
                                  Clear
                                </button>
                              )}
                              {editingTarget === 'ms_hub' && paper.hasMsHubUrl && (
                                <button
                                  type="button"
                                  className="past-paper-btn past-paper-btn-danger"
                                  disabled={isUploading}
                                  onClick={() => handleUnlinkHubUrl(paper, 'ms_hub')}
                                >
                                  Clear
                                </button>
                              )}
                              <button
                                type="button"
                                className="past-paper-btn"
                                onClick={() => {
                                  setEditingUrlKey(null);
                                  setCustomUrlInput('');
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                            {hubValidation && !hubValidation.isValid && (
                              <div style={{ fontSize: '0.73rem', color: '#dc2626' }}>
                                {hubValidation.error}
                              </div>
                            )}
                            {hubValidation && hubValidation.isValid && hubValidation.warning && (
                              <div style={{ fontSize: '0.73rem', color: '#d97706' }}>
                                {hubValidation.warning}
                              </div>
                            )}
                            {(editingTarget === 'qp_hub' || editingTarget === 'ms_hub') && !customUrlInput.trim() && (
                              <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                                Tip: Paste the official resource URL from schoolsupporthub.cambridge.org/item/...
                              </div>
                            )}
                          </div>
                        ) : (
                          <div style={{ display: 'flex', gap: '5px', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
                            {paper.samplePdfUrl && (
                              <a
                                href={paper.samplePdfUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="past-paper-btn"
                                title="Open Server PDF in new tab"
                              >
                                PDF ↗
                              </a>
                            )}
                            {paper.sampleHubUrl && (
                              <a
                                href={paper.sampleHubUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="past-paper-btn"
                                title="Open Cambridge Support Hub QP in new tab"
                                style={{ color: '#1d4ed8', borderColor: '#bfdbfe' }}
                              >
                                QP Hub ↗
                              </a>
                            )}
                            {paper.sampleMsHubUrl && (
                              <a
                                href={paper.sampleMsHubUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="past-paper-btn"
                                title="Open Cambridge Support Hub Mark Scheme in new tab"
                                style={{ color: '#6d28d9', borderColor: '#ddd6fe' }}
                              >
                                MS Hub ↗
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
                              title="Paste Server PDF URL manually"
                              onClick={() => {
                                setEditingUrlKey(key);
                                setEditingTarget('pdf');
                                setCustomUrlInput(paper.samplePdfUrl || '');
                              }}
                            >
                              Server URL
                            </button>
                            <button
                              type="button"
                              className="past-paper-btn"
                              title="Set official Cambridge Support Hub Question Paper link"
                              onClick={() => {
                                setEditingUrlKey(key);
                                setEditingTarget('qp_hub');
                                setCustomUrlInput(paper.sampleHubUrl || '');
                              }}
                            >
                              {paper.hasHubUrl ? 'Edit QP Hub' : 'Link QP Hub'}
                            </button>
                            <button
                              type="button"
                              className="past-paper-btn"
                              title="Set official Cambridge Support Hub Mark Scheme link"
                              onClick={() => {
                                setEditingUrlKey(key);
                                setEditingTarget('ms_hub');
                                setCustomUrlInput(paper.sampleMsHubUrl || '');
                              }}
                            >
                              {paper.hasMsHubUrl ? 'Edit MS Hub' : 'Link MS Hub'}
                            </button>
                            {paper.hasPdfUrl && (
                              <button
                                type="button"
                                className="past-paper-btn past-paper-btn-danger"
                                title="Unlink Server PDF from this paper"
                                disabled={isUploading}
                                onClick={() => handleUnlinkPdf(paper)}
                              >
                                Unlink PDF
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
