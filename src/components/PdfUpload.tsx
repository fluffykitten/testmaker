import { useCallback, useState, useRef } from 'react';
import { getSavedSettings } from '../lib/settings';
import { getGeminiApiKeys, type SubjectDomain } from '../lib/gemini';
import './PdfUpload.css';

interface PdfUploadProps {
  onFilesSelected: (
    questionPaper: File,
    markScheme: File | null,
    insertFile: File | null,
    options: { includeGuidance: boolean; domain: SubjectDomain; isIgcse: boolean; tags?: string }
  ) => void;
  isProcessing: boolean;
}

/**
 * Minimalist Document Staging & Processing Configuration Component:
 * - Left Column: Clean drag-and-drop file staging area (Question Paper, Mark Scheme, Resource Insert)
 * - Right Column: Processing parameters (Subject Domain, Cambridge Structure Profile, Examiner Guidance, Catalog Tags)
 * - Zero emoji soup, zero AI hype, consistent with ICM examination design system
 */
export function PdfUpload({ onFilesSelected, isProcessing }: PdfUploadProps) {
  const [domain, setDomain] = useState<SubjectDomain>('stem');
  const [isIgcse, setIsIgcse] = useState<boolean>(true);
  const [tags, setTags] = useState<string>('');

  const [qpDragOver, setQpDragOver] = useState(false);
  const [msDragOver, setMsDragOver] = useState(false);
  const [insertDragOver, setInsertDragOver] = useState(false);

  const [qpFile, setQpFile] = useState<File | null>(null);
  const [msFile, setMsFile] = useState<File | null>(null);
  const [insertFile, setInsertFile] = useState<File | null>(null);

  const [includeGuidance, setIncludeGuidance] = useState<boolean>(() => {
    return getSavedSettings().defaultAiGuidanceEnabled ?? false;
  });
  const [error, setError] = useState<string | null>(null);

  const qpInputRef = useRef<HTMLInputElement>(null);
  const msInputRef = useRef<HTMLInputElement>(null);
  const insertInputRef = useRef<HTMLInputElement>(null);

  const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

  const validateFile = useCallback((file: File): string | null => {
    if (file.type !== 'application/pdf') {
      return 'Only PDF files are supported.';
    }
    if (file.size > MAX_FILE_SIZE) {
      return `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum size is 25 MB.`;
    }
    return null;
  }, [MAX_FILE_SIZE]);

  // Question Paper Drop Handlers
  const handleQpDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setQpDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      const err = validateFile(file);
      if (err) setError(err);
      else {
        setError(null);
        setQpFile(file);
      }
    }
  };

  // Mark Scheme Drop Handlers
  const handleMsDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      const err = validateFile(file);
      if (err) setError(err);
      else {
        setError(null);
        setMsFile(file);
      }
    }
  };

  // Insert Booklet Drop Handlers
  const handleInsertDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setInsertDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      const err = validateFile(file);
      if (err) setError(err);
      else {
        setError(null);
        setInsertFile(file);
      }
    }
  };

  const handleExtract = () => {
    if (!qpFile) {
      setError('Please provide at least a Question Paper PDF to begin.');
      return;
    }
    setError(null);
    onFilesSelected(qpFile, msFile, insertFile, {
      includeGuidance,
      domain,
      isIgcse,
      tags: tags.trim() || undefined,
    });
  };

  const apiKeys = getGeminiApiKeys();

  return (
    <div className="upload-two-col-layout">
      {/* ─── LEFT COLUMN: Document Staging Workspace ──────────────────────── */}
      <div className="upload-col-main">
        <div className="upload-card">
          <div className="upload-card-header">
            <div>
              <h2 className="upload-card-title">Document Staging</h2>
              <p className="upload-card-subtitle">
                Stage past examination papers, official mark schemes, and resource inserts.
              </p>
            </div>
            <span className="upload-format-badge">PDF • Max 25 MB</span>
          </div>

          <div className="upload-card-body">
            {/* Slot 1: Main Question Paper (Required) */}
            <div className="upload-slot">
              <div className="upload-slot-header">
                <span className="upload-slot-title">1. Main Question Paper</span>
                <span className="upload-slot-badge upload-slot-badge--required">Required</span>
              </div>

              <input
                ref={qpInputRef}
                type="file"
                accept="application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const err = validateFile(file);
                    if (err) setError(err);
                    else { setError(null); setQpFile(file); }
                  }
                }}
                className="upload-hidden-input"
                id="qp-upload-input"
              />

              {!qpFile ? (
                <div
                  className={`upload-dropzone upload-dropzone--primary ${qpDragOver ? 'upload-dropzone--active' : ''}`}
                  onDrop={handleQpDrop}
                  onDragOver={(e) => { e.preventDefault(); setQpDragOver(true); }}
                  onDragLeave={() => setQpDragOver(false)}
                  onClick={() => qpInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && qpInputRef.current?.click()}
                >
                  <div className="upload-dropzone-icon">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="17 8 12 3 7 8"/>
                      <line x1="12" y1="3" x2="12" y2="15"/>
                    </svg>
                  </div>
                  <div className="upload-dropzone-text">
                    <span className="upload-dropzone-prompt">
                      Click to upload or drag Question Paper here
                    </span>
                    <span className="upload-dropzone-hint">
                      Standard Cambridge assessment papers (Paper 1, 2, 3, 4, 6)
                    </span>
                  </div>
                </div>
              ) : (
                <div className="upload-staged-file">
                  <div className="upload-staged-info">
                    <div className="upload-staged-icon upload-staged-icon--qp">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="16" y1="13" x2="8" y2="13"/>
                        <line x1="16" y1="17" x2="8" y2="17"/>
                        <polyline points="10 9 9 9 8 9"/>
                      </svg>
                    </div>
                    <div className="upload-staged-details">
                      <span className="upload-staged-name" title={qpFile.name}>{qpFile.name}</span>
                      <span className="upload-staged-meta">
                        {(qpFile.size / 1024 / 1024).toFixed(2)} MB • Main Paper
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="upload-staged-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      setQpFile(null);
                      if (qpInputRef.current) qpInputRef.current.value = '';
                    }}
                    title="Remove question paper"
                    aria-label="Remove question paper"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/>
                      <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              )}
            </div>

            {/* Slot 2: Official Mark Scheme (Optional) */}
            <div className="upload-slot">
              <div className="upload-slot-header">
                <span className="upload-slot-title">2. Official Mark Scheme</span>
                <span className="upload-slot-badge upload-slot-badge--optional">Optional</span>
              </div>

              <input
                ref={msInputRef}
                type="file"
                accept="application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const err = validateFile(file);
                    if (err) setError(err);
                    else { setError(null); setMsFile(file); }
                  }
                }}
                className="upload-hidden-input"
                id="ms-upload-input"
              />

              {!msFile ? (
                <div
                  className={`upload-dropzone upload-dropzone--secondary ${msDragOver ? 'upload-dropzone--active' : ''}`}
                  onDrop={handleMsDrop}
                  onDragOver={(e) => { e.preventDefault(); setMsDragOver(true); }}
                  onDragLeave={() => setMsDragOver(false)}
                  onClick={() => msInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && msInputRef.current?.click()}
                >
                  <div className="upload-dropzone-icon upload-dropzone-icon--sm">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                  </div>
                  <div className="upload-dropzone-text">
                    <span className="upload-dropzone-prompt">
                      Attach Official Mark Scheme (Optional)
                    </span>
                    <span className="upload-dropzone-hint">
                      Correlates questions with official marking criteria. When omitted, solutions are generated automatically.
                    </span>
                  </div>
                </div>
              ) : (
                <div className="upload-staged-file">
                  <div className="upload-staged-info">
                    <div className="upload-staged-icon upload-staged-icon--ms">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <path d="M9 15l2 2 4-4"/>
                      </svg>
                    </div>
                    <div className="upload-staged-details">
                      <span className="upload-staged-name" title={msFile.name}>{msFile.name}</span>
                      <span className="upload-staged-meta">
                        {(msFile.size / 1024 / 1024).toFixed(2)} MB • Official Mark Scheme
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="upload-staged-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMsFile(null);
                      if (msInputRef.current) msInputRef.current.value = '';
                    }}
                    title="Remove mark scheme"
                    aria-label="Remove mark scheme"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/>
                      <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              )}
            </div>

            {/* Slot 3: Resource Booklet / Insert (Optional) */}
            <div className="upload-slot">
              <div className="upload-slot-header">
                <span className="upload-slot-title">3. Resource Booklet / Insert</span>
                <span className="upload-slot-badge upload-slot-badge--optional">
                  {domain === 'humanities' ? 'Recommended for Humanities' : 'Optional'}
                </span>
              </div>

              <input
                ref={insertInputRef}
                type="file"
                accept="application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const err = validateFile(file);
                    if (err) setError(err);
                    else { setError(null); setInsertFile(file); }
                  }
                }}
                className="upload-hidden-input"
                id="insert-upload-input"
              />

              {!insertFile ? (
                <div
                  className={`upload-dropzone upload-dropzone--secondary ${insertDragOver ? 'upload-dropzone--active' : ''}`}
                  onDrop={handleInsertDrop}
                  onDragOver={(e) => { e.preventDefault(); setInsertDragOver(true); }}
                  onDragLeave={() => setInsertDragOver(false)}
                  onClick={() => insertInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && insertInputRef.current?.click()}
                >
                  <div className="upload-dropzone-icon upload-dropzone-icon--sm">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                    </svg>
                  </div>
                  <div className="upload-dropzone-text">
                    <span className="upload-dropzone-prompt">
                      Attach Resource Booklet / Insert (Optional)
                    </span>
                    <span className="upload-dropzone-hint">
                      Separate inserts containing maps, source texts, case studies, or reference diagrams.
                    </span>
                  </div>
                </div>
              ) : (
                <div className="upload-staged-file">
                  <div className="upload-staged-info">
                    <div className="upload-staged-icon upload-staged-icon--insert">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="12 2 2 7 12 12 22 7 12 2"/>
                        <polyline points="2 17 12 22 22 17"/>
                        <polyline points="2 12 12 17 22 12"/>
                      </svg>
                    </div>
                    <div className="upload-staged-details">
                      <span className="upload-staged-name" title={insertFile.name}>{insertFile.name}</span>
                      <span className="upload-staged-meta">
                        {(insertFile.size / 1024 / 1024).toFixed(2)} MB • Resource Booklet
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="upload-staged-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      setInsertFile(null);
                      if (insertInputRef.current) insertInputRef.current.value = '';
                    }}
                    title="Remove resource insert"
                    aria-label="Remove resource insert"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/>
                      <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Informational Callout */}
        <div className="upload-info-callout">
          <svg className="upload-info-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          <p className="upload-info-text">
            The assessment parser correlates question items directly with official mark scheme criteria when both documents are staged. When mark schemes are omitted, solutions are generated in accordance with syllabus specifications.
          </p>
        </div>
      </div>

      {/* ─── RIGHT COLUMN: Processing Parameters Sidebar ───────────────────── */}
      <aside className="upload-col-sidebar">
        <div className="upload-card">
          <div className="upload-card-header">
            <h2 className="upload-card-title">Processing Parameters</h2>
          </div>

          <div className="upload-card-body upload-sidebar-body">
            {/* 1. Subject Domain */}
            <div className="upload-param-group">
              <label className="upload-param-label">Subject Domain</label>
              <div className="upload-segmented-control">
                <button
                  type="button"
                  className={`upload-segmented-btn ${domain === 'stem' ? 'upload-segmented-btn--active' : ''}`}
                  onClick={() => setDomain('stem')}
                >
                  STEM
                </button>
                <button
                  type="button"
                  className={`upload-segmented-btn ${domain === 'humanities' ? 'upload-segmented-btn--active' : ''}`}
                  onClick={() => setDomain('humanities')}
                >
                  Humanities
                </button>
                <button
                  type="button"
                  className={`upload-segmented-btn ${domain === 'languages' ? 'upload-segmented-btn--active' : ''}`}
                  onClick={() => setDomain('languages')}
                >
                  Languages
                </button>
              </div>
            </div>

            {/* 2. Processing Profile Toggles */}
            <div className="upload-param-group">
              <label className="upload-param-label">Processing Profile</label>
              <div className="upload-toggle-stack">
                {/* Cambridge IGCSE Structure Toggle */}
                <label className="upload-toggle-card" htmlFor="exam-format-toggle">
                  <div className="upload-toggle-text">
                    <span className="upload-toggle-name">Cambridge IGCSE</span>
                    <span className="upload-toggle-hint">
                      Group (a), (b)(i), (c) sub-parts hierarchically
                    </span>
                  </div>
                  <div className="upload-switch">
                    <input
                      type="checkbox"
                      id="exam-format-toggle"
                      checked={isIgcse}
                      onChange={(e) => setIsIgcse(e.target.checked)}
                      className="upload-switch-input"
                    />
                    <span className="upload-slider" />
                  </div>
                </label>

                {/* Examiner Guidance Toggle */}
                <label className="upload-toggle-card" htmlFor="guidance-toggle">
                  <div className="upload-toggle-text">
                    <span className="upload-toggle-name">Examiner Guidance</span>
                    <span className="upload-toggle-hint">
                      Extract marking notes, method marks & tips
                    </span>
                  </div>
                  <div className="upload-switch">
                    <input
                      type="checkbox"
                      id="guidance-toggle"
                      checked={includeGuidance}
                      onChange={(e) => setIncludeGuidance(e.target.checked)}
                      className="upload-switch-input"
                    />
                    <span className="upload-slider" />
                  </div>
                </label>
              </div>
            </div>

            {/* 3. Catalog Tags Input */}
            <div className="upload-param-group">
              <label className="upload-param-label" htmlFor="tags-input-field">Catalog Tags</label>
              <input
                id="tags-input-field"
                type="text"
                className="upload-input"
                placeholder="e.g. mock2026, chapter1, term2"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
              <span className="upload-param-help">Optional tags for filtering in Question Bank</span>
            </div>

            {/* Engine Status Indicator */}
            <div className="upload-engine-pill">
              <span className="upload-engine-dot" />
              <span className="upload-engine-label">
                Engine Status • {apiKeys.length} {apiKeys.length === 1 ? 'Connection' : 'Parallel Connections'}
              </span>
            </div>

            {/* Error Message */}
            {error && (
              <div className="upload-error-banner animate-fade-in">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span>{error}</span>
              </div>
            )}

            {/* Primary Action Button */}
            <button
              type="button"
              className="upload-action-btn upload-action-btn--primary"
              onClick={handleExtract}
              disabled={!qpFile || isProcessing}
              id="extract-questions-btn"
            >
              {isProcessing ? (
                <>
                  <span className="upload-spinner" />
                  <span>Processing Documents…</span>
                </>
              ) : (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 16 12 12 8 16"/>
                    <line x1="12" y1="12" x2="12" y2="21"/>
                    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
                  </svg>
                  <span>{qpFile ? 'Run Processing' : 'Select Paper to Begin'}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
