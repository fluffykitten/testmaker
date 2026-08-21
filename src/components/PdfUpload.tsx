import { useCallback, useState, useRef } from 'react';
import './PdfUpload.css';

interface PdfUploadProps {
  onFilesSelected: (questionPaper: File, markScheme: File | null) => void;
  isProcessing: boolean;
}

/**
 * Dual-slot upload component:
 * 1. Question Paper PDF (Required)
 * 2. Mark Scheme PDF (Optional - auto-generates if omitted)
 */
export function PdfUpload({ onFilesSelected, isProcessing }: PdfUploadProps) {
  const [qpDragOver, setQpDragOver] = useState(false);
  const [msDragOver, setMsDragOver] = useState(false);

  const [qpFile, setQpFile] = useState<File | null>(null);
  const [msFile, setMsFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const qpInputRef = useRef<HTMLInputElement>(null);
  const msInputRef = useRef<HTMLInputElement>(null);

  const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

  const validateFile = useCallback((file: File): string | null => {
    if (file.type !== 'application/pdf') {
      return 'Only PDF files are accepted.';
    }
    if (file.size > MAX_FILE_SIZE) {
      return `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is 25 MB.`;
    }
    return null;
  }, [MAX_FILE_SIZE]);

  // Question Paper Handlers
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

  // Mark Scheme Handlers
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

  const handleExtract = () => {
    if (qpFile) {
      onFilesSelected(qpFile, msFile);
    }
  };

  return (
    <div className="upload-container">
      {/* ─── Question Paper Drop Zone (Required) ─────────────────────────── */}
      <div className="upload-section">
        <div className="upload-section-header">
          <span className="upload-section-title">1. Question Paper PDF</span>
          <span className="upload-badge upload-badge--required">Required</span>
        </div>

        <div
          className={`drop-zone ${qpDragOver ? 'drop-zone--active' : ''} ${
            qpFile ? 'drop-zone--has-file' : ''
          }`}
          onDrop={handleQpDrop}
          onDragOver={(e) => { e.preventDefault(); setQpDragOver(true); }}
          onDragLeave={() => setQpDragOver(false)}
          onClick={() => !qpFile && qpInputRef.current?.click()}
        >
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
            className="drop-zone-input"
            id="qp-upload-input"
          />

          {!qpFile ? (
            <div className="drop-zone-content">
              <div className="drop-zone-icon">
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                  <rect x="4" y="4" width="32" height="32" rx="8" stroke="currentColor" strokeWidth="2" strokeDasharray="3 3" />
                  <path d="M20 14v12M14 20h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              <p className="drop-zone-title">Drop Question Paper PDF</p>
              <p className="drop-zone-subtitle">or <span className="drop-zone-browse">browse files</span></p>
            </div>
          ) : (
            <div className="file-preview">
              <div className="file-preview-icon">📄</div>
              <div className="file-preview-info">
                <p className="file-preview-name">{qpFile.name}</p>
                <p className="file-preview-size">{(qpFile.size / 1024 / 1024).toFixed(2)} MB</p>
              </div>
              <button
                type="button"
                className="file-preview-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  setQpFile(null);
                  if (qpInputRef.current) qpInputRef.current.value = '';
                }}
              >
                ✕
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ─── Mark Scheme Drop Zone (Optional) ────────────────────────────── */}
      <div className="upload-section">
        <div className="upload-section-header">
          <span className="upload-section-title">2. Official Mark Scheme PDF</span>
          <span className="upload-badge upload-badge--optional">Optional (Auto-solved if omitted)</span>
        </div>

        <div
          className={`drop-zone drop-zone--secondary ${msDragOver ? 'drop-zone--active' : ''} ${
            msFile ? 'drop-zone--has-file' : ''
          }`}
          onDrop={handleMsDrop}
          onDragOver={(e) => { e.preventDefault(); setMsDragOver(true); }}
          onDragLeave={() => setMsDragOver(false)}
          onClick={() => !msFile && msInputRef.current?.click()}
        >
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
            className="drop-zone-input"
            id="ms-upload-input"
          />

          {!msFile ? (
            <div className="drop-zone-content">
              <p className="drop-zone-title-sm">
                + Add Official Mark Scheme PDF (Optional)
              </p>
              <p className="drop-zone-hint">
                Attach official mark scheme for exact marking criteria, or leave empty for AI auto-generation.
              </p>
            </div>
          ) : (
            <div className="file-preview">
              <div className="file-preview-icon">📑</div>
              <div className="file-preview-info">
                <p className="file-preview-name">{msFile.name}</p>
                <p className="file-preview-size">{(msFile.size / 1024 / 1024).toFixed(2)} MB • Official Mark Scheme</p>
              </div>
              <button
                type="button"
                className="file-preview-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  setMsFile(null);
                  if (msInputRef.current) msInputRef.current.value = '';
                }}
              >
                ✕
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="upload-error animate-fade-in">
          <span>⚠</span> {error}
        </div>
      )}

      {/* Extract Button */}
      {qpFile && !error && (
        <button
          className="extract-btn animate-fade-in"
          onClick={handleExtract}
          disabled={isProcessing}
          id="extract-questions-btn"
        >
          {isProcessing ? (
            <>
              <span className="extract-btn-spinner" />
              Analyzing with AI…
            </>
          ) : (
            <>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M10 2L10 14M6 10l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 15v2a2 2 0 002 2h10a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Extract Questions {msFile ? '(Using Official Mark Scheme)' : '(With AI Auto-Generated Mark Scheme)'}
            </>
          )}
        </button>
      )}
    </div>
  );
}
