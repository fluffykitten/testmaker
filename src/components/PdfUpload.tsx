import { useCallback, useState, useRef } from 'react';
import { getSavedSettings } from '../lib/settings';
import { getGeminiApiKeys, type SubjectDomain } from '../lib/gemini';
import './PdfUpload.css';

interface PdfUploadProps {
  onFilesSelected: (
    questionPaper: File,
    markScheme: File | null,
    insertFile: File | null,
    options: { includeGuidance: boolean; domain: SubjectDomain }
  ) => void;
  isProcessing: boolean;
}

/**
 * Subject-Aware Multi-Document Upload Component:
 * - Tab 1: 🔬 STEM & Sciences (Physics, Chemistry, Biology, Math) -> QP + Mark Scheme
 * - Tab 2: 🌍 Humanities & Languages (Geography, History, Economics, English) -> QP + Mark Scheme + Insert / Resource Booklet
 * - AI Teacher Guidance & Misconceptions Toggle
 */
export function PdfUpload({ onFilesSelected, isProcessing }: PdfUploadProps) {
  const [domain, setDomain] = useState<SubjectDomain>('stem');

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

  // Insert Booklet Handlers
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
    if (qpFile) {
      onFilesSelected(qpFile, msFile, domain === 'humanities' ? insertFile : null, {
        includeGuidance,
        domain,
      });
    }
  };

  return (
    <div className="upload-container">
      {/* ─── Subject Domain Mode Switcher Tabs ───────────────────────────── */}
      <div className="upload-tabs-container">
        <button
          type="button"
          className={`upload-tab ${domain === 'stem' ? 'upload-tab--active' : ''}`}
          onClick={() => setDomain('stem')}
        >
          <span className="upload-tab-icon">🔬</span>
          <div className="upload-tab-text">
            <span className="upload-tab-title">STEM & Sciences</span>
            <span className="upload-tab-desc">Physics, Chemistry, Biology, Math, CS</span>
          </div>
        </button>

        <button
          type="button"
          className={`upload-tab ${domain === 'humanities' ? 'upload-tab--active' : ''}`}
          onClick={() => setDomain('humanities')}
        >
          <span className="upload-tab-icon">🌍</span>
          <div className="upload-tab-text">
            <span className="upload-tab-title">Geography & Humanities</span>
            <span className="upload-tab-desc">Geography (0460), History, Economics</span>
          </div>
          <span className="upload-tab-badge">Insert Support</span>
        </button>

        <button
          type="button"
          className={`upload-tab ${domain === 'languages' ? 'upload-tab--active' : ''}`}
          onClick={() => setDomain('languages')}
        >
          <span className="upload-tab-icon">📖</span>
          <div className="upload-tab-text">
            <span className="upload-tab-title">English & Languages / TKA</span>
            <span className="upload-tab-desc">Reading Passages, 5-Option MCQs, Multi-Select</span>
          </div>
          <span className="upload-tab-badge">Smart Keys</span>
        </button>
      </div>

      {domain === 'humanities' && (
        <div className="upload-humanities-hint animate-fade-in">
          <span className="upload-hint-icon">💡</span>
          <span>
            <strong>Geography & Humanities Mode:</strong> Supports separate Cambridge IGCSE / O-Level / A-Level <strong>Insert & Resource Booklets</strong> (0460, 0470, 0455, 0680). Figures and maps in the insert are automatically extracted and cross-referenced with their questions.
          </span>
        </div>
      )}

      {domain === 'languages' && (
        <div
          className="upload-humanities-hint animate-fade-in"
          style={{ borderColor: '#93c5fd', background: '#eff6ff' }}
        >
          <span className="upload-hint-icon">📖</span>
          <span style={{ color: '#1e40af' }}>
            <strong>English & Language Exam Mode:</strong> Specialized for Reading Comprehension passages, 5-option MCQs (A–E), complex multi-select (<em>Pilihan Ganda Kompleks</em>), and matching tables (<em>Menjodohkan</em>). <strong>In-document answer keys ("Kunci Jawaban & Pembahasan") are automatically detected and matched to all questions!</strong>
          </span>
        </div>
      )}

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
                <p className="file-preview-size">{(qpFile.size / 1024 / 1024).toFixed(2)} MB • Main Question Paper</p>
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

      {/* ─── Insert / Resource Booklet Drop Zone (Humanities Mode Only) ─────── */}
      {domain === 'humanities' && (
        <div className="upload-section animate-fade-in">
          <div className="upload-section-header">
            <span className="upload-section-title">2. Insert / Resource Booklet PDF</span>
            <span className="upload-badge upload-badge--optional">Recommended for Geography/History</span>
          </div>

          <div
            className={`drop-zone drop-zone--insert ${insertDragOver ? 'drop-zone--active' : ''} ${
              insertFile ? 'drop-zone--has-file' : ''
            }`}
            onDrop={handleInsertDrop}
            onDragOver={(e) => { e.preventDefault(); setInsertDragOver(true); }}
            onDragLeave={() => setInsertDragOver(false)}
            onClick={() => !insertFile && insertInputRef.current?.click()}
          >
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
              className="drop-zone-input"
              id="insert-upload-input"
            />

            {!insertFile ? (
              <div className="drop-zone-content">
                <div className="drop-zone-icon" style={{ color: '#0ea5e9' }}>📖</div>
                <p className="drop-zone-title-sm" style={{ color: '#0284c7' }}>
                  + Add Insert / Resource Booklet PDF (Optional)
                </p>
                <p className="drop-zone-hint">
                  Attach Cambridge Insert containing maps, aerial photos, figures, and case studies (e.g. Fig 1.1, Photograph A).
                </p>
              </div>
            ) : (
              <div className="file-preview">
                <div className="file-preview-icon">🗺️</div>
                <div className="file-preview-info">
                  <p className="file-preview-name">{insertFile.name}</p>
                  <p className="file-preview-size">{(insertFile.size / 1024 / 1024).toFixed(2)} MB • Resource Booklet / Insert</p>
                </div>
                <button
                  type="button"
                  className="file-preview-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    setInsertFile(null);
                    if (insertInputRef.current) insertInputRef.current.value = '';
                  }}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Mark Scheme Drop Zone (Optional) ────────────────────────────── */}
      <div className="upload-section">
        <div className="upload-section-header">
          <span className="upload-section-title">
            {domain === 'humanities' ? '3. Official Mark Scheme PDF' : '2. Official Mark Scheme PDF'}
          </span>
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

      {/* ─── AI Teacher Guidance Toggle ──────────────────────────────────── */}
      <div className="upload-ai-options-card">
        <label className="upload-toggle-label" htmlFor="ai-guidance-toggle">
          <div className="upload-toggle-info">
            <div className="upload-toggle-heading">
              <span className="upload-toggle-icon">✨</span>
              <span className="upload-toggle-title">AI Teacher Guidance & Misconceptions</span>
              <span className="upload-badge upload-badge--new">{includeGuidance ? 'Deep Mode (~20s)' : '⚡ Fast Mode (~5s)'}</span>
            </div>
            <p className="upload-toggle-desc">
              {includeGuidance
                ? 'Deep Mode: Auto-generates detailed examiner marking tips, method marks, and common student errors for each question (~20s).'
                : '⚡ Fast Mode (Default): Extracts questions, tables, and answers in ~5 seconds. Guidance can still be generated on-demand later.'}
            </p>
          </div>

          <div className="upload-switch-wrapper">
            <input
              type="checkbox"
              id="ai-guidance-toggle"
              checked={includeGuidance}
              onChange={(e) => setIncludeGuidance(e.target.checked)}
              className="upload-switch-input"
            />
            <span className="upload-switch-slider" />
          </div>
        </label>
      </div>

      {/* ─── API Key Engine Status Indicator ─────────────────────────────── */}
      {(() => {
        const apiKeys = getGeminiApiKeys();
        const isMultiKey = apiKeys.length >= 2;
        return (
          <div
            className="upload-engine-status animate-fade-in"
            style={{
              marginBottom: '16px',
              padding: '10px 16px',
              borderRadius: '10px',
              background: isMultiKey
                ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(6, 182, 212, 0.1))'
                : 'rgba(255, 255, 255, 0.03)',
              border: `1px solid ${isMultiKey ? 'rgba(16, 185, 129, 0.25)' : 'rgba(255, 255, 255, 0.07)'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              fontSize: '0.82rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '1.1rem' }}>{isMultiKey ? '⚡' : '🔑'}</span>
              <span style={{ color: '#cbd5e1' }}>
                {isMultiKey ? (
                  <>
                    <strong style={{ color: '#10b981' }}>Dual-Key Turbo Mode Active:</strong> Extracting with {apiKeys.length} Google AI accounts concurrently (50:50 parallel split for 2× speed).
                  </>
                ) : (
                  <>
                    <strong style={{ color: '#94a3b8' }}>Standard Mode (1 Key):</strong> Add <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: '4px', color: '#38bdf8' }}>VITE_GEMINI_API_KEY_2</code> in <code style={{ color: '#e2e8f0' }}>.env.local</code> for 2× parallel speed.
                  </>
                )}
              </span>
            </div>
            <span
              style={{
                fontSize: '0.72rem',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: '12px',
                background: isMultiKey ? '#10b981' : 'rgba(255, 255, 255, 0.08)',
                color: isMultiKey ? '#ffffff' : '#94a3b8',
                whiteSpace: 'nowrap',
              }}
            >
              {apiKeys.length} {apiKeys.length === 1 ? 'Key' : 'Keys'} Connected
            </span>
          </div>
        );
      })()}

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
              Analyzing {domain === 'languages' ? 'English / Language Paper' : domain === 'humanities' ? 'Humanities Paper' : 'STEM Paper'} with AI…
            </>
          ) : (
            <>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M10 2L10 14M6 10l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 15v2a2 2 0 002 2h10a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Extract {domain === 'languages' ? 'English / Language' : domain === 'humanities' ? 'Geography / Humanities' : 'STEM'} Questions {insertFile ? '(with Insert Resources)' : ''} {msFile ? '(Using Mark Scheme)' : '(Auto-Solved)'}
            </>
          )}
        </button>
      )}
    </div>
  );
}
