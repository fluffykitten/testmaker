// ─── Google Forms Export Modal Component ───────────────────────────────────────
// Modal offering 3 ways to export: 1-Click Native API, Google Apps Script, and Form Builder CSV.

import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from '../services/testBuilderService';
import {
  createGoogleFormQuiz,
  generateGoogleAppsScript,
  flattenQuestionsForForms,
  getOrderedQuestions,
  getQuestionKey,
  getSubQuestionKey,
  FORMS_API_CONSOLE_URL,
  type GoogleFormResult,
  type GoogleFormsProgress,
} from '../services/googleFormsExportService';
import { exportGoogleFormsQuiz } from '../services/lmsExportService';
import { loadGsiScript } from '../services/googleDriveService';
import { getSavedSettings } from '../lib/settings';
import {
  extractMarkdownTable,
  extractStructuredTable,
  renderTableToPngDataUrl,
  compositeTableAndDiagram,
  dataUrlToBlob,
} from '../lib/tableImageRenderer';
import { uploadDiagramImage } from '../services/storageService';
import './GoogleFormsExportModal.css';

interface GoogleFormsExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  headerConfig: ExamHeaderConfig;
  questions: Question[];
}


export const GoogleFormsExportModal: React.FC<GoogleFormsExportModalProps> = ({
  isOpen,
  onClose,
  headerConfig,
  questions,
}) => {
  const [activeTab, setActiveTab] = useState<'api' | 'script' | 'csv'>('api');
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<GoogleFormsProgress | null>(null);
  const [result, setResult] = useState<GoogleFormResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isGcpLinkNeeded, setIsGcpLinkNeeded] = useState(false);
  const [copiedScript, setCopiedScript] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [imageBase64Map, setImageBase64Map] = useState<Record<string, string>>({});
  const [imageUrlMap, setImageUrlMap] = useState<Record<string, string>>({});
  const [isConvertingImages, setIsConvertingImages] = useState(false);
  const uploadPromiseRef = useRef<Promise<{ b64Map: Record<string, string>; urlMap: Record<string, string> }> | null>(null);

  // 1. Instantly render tables to crisp PNG images synchronously on open
  // 2. Upload table images in parallel to Cloudflare R2 for zero-delay public URLs
  useEffect(() => {
    let isMounted = true;
    if (!isOpen || !questions || questions.length === 0) return;

    const ordered = getOrderedQuestions(questions);

    // Step A: Immediate synchronous canvas render of all tables (<5ms)
    // Ensures question stems strip markdown tables immediately and show table figures
    const initialB64Map: Record<string, string> = {};
    const initialUrlMap: Record<string, string> = {};

    ordered.forEach((q, qIndex) => {
      const qKey = getQuestionKey(q, qIndex);
      const existingDiagram = q.diagram_url || (q as any).image_url || (q as any).diagram_base64;
      if (existingDiagram && typeof existingDiagram === 'string' && existingDiagram.startsWith('http')) {
        initialUrlMap[qKey] = existingDiagram;
      }

      const extractedMd = extractMarkdownTable(q.question_text || '');
      const extractedStruct = extractStructuredTable(q.data_tables);
      const tableData = extractedMd.table || extractedStruct;
      if (tableData) {
        try {
          const png = renderTableToPngDataUrl(tableData);
          if (png) initialB64Map[qKey] = png;
        } catch {}
      }

      if (q.sub_questions && q.sub_questions.length > 0) {
        q.sub_questions.forEach((sq, sIdx) => {
          const sqKey = getSubQuestionKey(q, qIndex, sIdx);
          const sqDiagram = (sq as any).diagram_url || (sq as any).image_url || (sq as any).diagram_base64;
          if (sqDiagram && typeof sqDiagram === 'string' && sqDiagram.startsWith('http')) {
            initialUrlMap[sqKey] = sqDiagram;
          }

          const sqMd = extractMarkdownTable(sq.question_text || '');
          const sqStruct = extractStructuredTable((sq as any).data_tables);
          const sqTable = sqMd.table || sqStruct;
          if (sqTable) {
            try {
              const sqPng = renderTableToPngDataUrl(sqTable);
              if (sqPng) initialB64Map[sqKey] = sqPng;
            } catch {}
          }
        });
      }
    });

    setImageBase64Map(initialB64Map);
    setImageUrlMap(initialUrlMap);

    // Step B: Asynchronously upload to Cloudflare R2 in parallel & composite diagrams if needed
    async function loadImages(): Promise<{ b64Map: Record<string, string>; urlMap: Record<string, string> }> {
      setIsConvertingImages(true);
      const b64Map: Record<string, string> = { ...initialB64Map };
      const urlMap: Record<string, string> = { ...initialUrlMap };
      const uploadPromises: Promise<void>[] = [];

      try {
        for (let qIndex = 0; qIndex < ordered.length; qIndex++) {
          const q = ordered[qIndex];
          const qKey = getQuestionKey(q, qIndex);
          const existingDiagram = q.diagram_url || (q as any).image_url || (q as any).diagram_base64;
          const tablePngDataUrl = b64Map[qKey] || null;

          if (tablePngDataUrl && existingDiagram && typeof existingDiagram === 'string') {
            uploadPromises.push((async () => {
              try {
                const compositeDataUrl = await compositeTableAndDiagram(tablePngDataUrl, existingDiagram);
                b64Map[qKey] = compositeDataUrl;
                const blob = dataUrlToBlob(compositeDataUrl);
                if (blob) {
                  const r2Key = `tables/table_${qKey}.png`;
                  const upUrl = await uploadDiagramImage(blob, r2Key);
                  if (upUrl) urlMap[qKey] = upUrl;
                }
              } catch {
                b64Map[qKey] = tablePngDataUrl;
              }
            })());
          } else if (tablePngDataUrl) {
            uploadPromises.push((async () => {
              const blob = dataUrlToBlob(tablePngDataUrl);
              if (blob) {
                const r2Key = `tables/table_${qKey}.png`;
                const upUrl = await uploadDiagramImage(blob, r2Key);
                if (upUrl) urlMap[qKey] = upUrl;
              }
            })());
          } else if (existingDiagram && typeof existingDiagram === 'string') {
            if (existingDiagram.startsWith('http')) {
              urlMap[qKey] = existingDiagram;
              urlMap[existingDiagram] = existingDiagram;
            } else if (existingDiagram.startsWith('data:image/')) {
              b64Map[qKey] = existingDiagram;
              b64Map[existingDiagram] = existingDiagram;
            }
          }

          // Sub-questions
          if (q.sub_questions && q.sub_questions.length > 0) {
            for (let sIdx = 0; sIdx < q.sub_questions.length; sIdx++) {
              const sq = q.sub_questions[sIdx];
              const sqKey = getSubQuestionKey(q, qIndex, sIdx);
              const sqDiagram = (sq as any).diagram_url || (sq as any).image_url || (sq as any).diagram_base64;
              const sqTablePng = b64Map[sqKey] || null;

              if (sqTablePng && sqDiagram && typeof sqDiagram === 'string') {
                uploadPromises.push((async () => {
                  try {
                    const comp = await compositeTableAndDiagram(sqTablePng, sqDiagram);
                    b64Map[sqKey] = comp;
                    const blob = dataUrlToBlob(comp);
                    if (blob) {
                      const r2Key = `tables/table_${sqKey}.png`;
                      const upUrl = await uploadDiagramImage(blob, r2Key);
                      if (upUrl) urlMap[sqKey] = upUrl;
                    }
                  } catch {
                    b64Map[sqKey] = sqTablePng;
                  }
                })());
              } else if (sqTablePng) {
                uploadPromises.push((async () => {
                  const blob = dataUrlToBlob(sqTablePng);
                  if (blob) {
                    const r2Key = `tables/table_${sqKey}.png`;
                    const upUrl = await uploadDiagramImage(blob, r2Key);
                    if (upUrl) urlMap[sqKey] = upUrl;
                  }
                })());
              } else if (sqDiagram && typeof sqDiagram === 'string') {
                if (sqDiagram.startsWith('http')) {
                  urlMap[sqKey] = sqDiagram;
                  urlMap[sqDiagram] = sqDiagram;
                } else if (sqDiagram.startsWith('data:image/')) {
                  b64Map[sqKey] = sqDiagram;
                  b64Map[sqDiagram] = sqDiagram;
                }
              }
            }
          }
        }

        // Wait for all cloud uploads to complete in parallel
        await Promise.all(uploadPromises);
      } catch (err) {
        console.warn('Image pre-processing error:', err);
      }

      if (isMounted) {
        setImageBase64Map({ ...b64Map });
        setImageUrlMap({ ...urlMap });
        setIsConvertingImages(false);
      }
      return { b64Map, urlMap };
    }

    uploadPromiseRef.current = loadImages();
    return () => {
      isMounted = false;
    };
  }, [isOpen, questions]);

  // Pre-calculate flattened summary
  const summary = useMemo(() => {
    const items = flattenQuestionsForForms(questions, imageBase64Map, imageUrlMap);
    const mcqCount = items.filter((i) => i.type === 'RADIO' || i.type === 'CHECKBOX').length;
    const totalMarks = items.reduce((sum, i) => sum + i.pointValue, 0);
    return {
      totalItems: items.length,
      mcqCount,
      totalMarks,
      openEndedCount: items.length - mcqCount,
    };
  }, [questions, imageBase64Map, imageUrlMap]);

  // Pre-generate Google Apps Script
  const appsScriptCode = useMemo(() => {
    return generateGoogleAppsScript(headerConfig, questions, imageBase64Map, imageUrlMap);
  }, [headerConfig, questions, imageBase64Map, imageUrlMap]);

  // Pre-load Google Identity Services SDK on modal open so the popup isn't blocked
  useEffect(() => {
    loadGsiScript().catch(() => {});
  }, []);

  if (!isOpen) return null;

  const handleStartApiExport = async () => {
    setError(null);
    setIsGcpLinkNeeded(false);
    setResult(null);

    const settings = getSavedSettings();
    const clientId = settings.googleDriveClientId;

    if (!clientId) {
      setError(
        'Google Client ID is not configured. Please set your Google OAuth Client ID in Settings → Integrations, or use the Zero-Setup Google Apps Script tab!'
      );
      return;
    }

    setIsExporting(true);
    setProgress({ stage: 'creating', message: 'Optimizing diagrams and uploading to Cloudflare R2...' });

    let activeB64 = imageBase64Map;
    let activeUrl = imageUrlMap;

    if (uploadPromiseRef.current) {
      try {
        const completed = await uploadPromiseRef.current;
        activeB64 = completed.b64Map;
        activeUrl = completed.urlMap;
      } catch (e) {
        console.warn('Waiting for table upload failed:', e);
      }
    }

    try {
      const res = await createGoogleFormQuiz(
        headerConfig,
        questions,
        clientId,
        (prog) => {
          setProgress(prog);
        },
        activeB64,
        activeUrl
      );
      setResult(res);
    } catch (err: any) {
      console.error('Google Forms API export failed:', err);
      let errMsg: string = err?.message || 'Unknown error occurred.';

      if (errMsg === 'popup_closed_by_user') {
        errMsg = 'The Google sign-in popup was closed before authorization completed.';
      } else if (errMsg === 'access_denied') {
        errMsg = 'Google account permission was denied. Please accept the permission request to allow TestMaker to create the quiz.';
      } else if (errMsg.includes('origin_mismatch')) {
        errMsg = `Google OAuth Origin Mismatch: Please add ${window.location.origin} to 'Authorized JavaScript origins' under your OAuth Client ID in Google Cloud Console.`;
      }

      setError(errMsg);

      if (errMsg.includes('forms.googleapis.com') || errMsg.includes('Google Forms API is not enabled')) {
        setIsGcpLinkNeeded(true);
      }
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopyScript = async () => {
    try {
      let codeToCopy = appsScriptCode;
      if (uploadPromiseRef.current) {
        try {
          const completed = await uploadPromiseRef.current;
          codeToCopy = generateGoogleAppsScript(headerConfig, questions, completed.b64Map, completed.urlMap);
        } catch (e) {
          console.warn('Waiting for table upload for script failed:', e);
        }
      }
      await navigator.clipboard.writeText(codeToCopy);
      setCopiedScript(true);
      setTimeout(() => setCopiedScript(false), 2500);
    } catch (err) {
      console.warn('Clipboard write failed:', err);
    }
  };

  const handleCopyResponderLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch (err) {
      console.warn('Clipboard copy failed:', err);
    }
  };

  const handleDownloadCsv = () => {
    exportGoogleFormsQuiz(headerConfig, questions);
  };

  return (
    <div className="gf-modal-overlay" onClick={onClose}>
      <div className="gf-modal-container" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="gf-modal-header">
          <div className="gf-header-title-wrap">
            <div className="gf-header-icon">📝</div>
            <div>
              <h2 className="gf-header-title">Export to Google Forms</h2>
              <p className="gf-header-subtitle">
                Create an auto-graded Quiz in Google Forms or generate an Apps Script
              </p>
            </div>
          </div>
          <button type="button" className="gf-modal-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="gf-tabs-bar">
          <button
            type="button"
            className={`gf-tab-btn ${activeTab === 'api' ? 'gf-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('api')}
          >
            ⚡ 1-Click Native API
            <span className="gf-tab-badge gf-tab-badge--purple">Direct</span>
          </button>

          <button
            type="button"
            className={`gf-tab-btn ${activeTab === 'script' ? 'gf-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('script')}
          >
            📋 Google Apps Script
            <span className="gf-tab-badge gf-tab-badge--green">Zero Setup</span>
          </button>

          <button
            type="button"
            className={`gf-tab-btn ${activeTab === 'csv' ? 'gf-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('csv')}
          >
            📁 Form Builder CSV
            <span className="gf-tab-badge gf-tab-badge--blue">Add-on</span>
          </button>
        </div>

        {/* Body Content */}
        <div className="gf-modal-body">
          {/* Assessment Summary Strip */}
          <div className="gf-summary-strip">
            <div className="gf-summary-item">
              <span>📄 Total Items:</span>
              <strong>{summary.totalItems} Questions</strong>
            </div>
            <div className="gf-summary-item">
              <span>🎯 Auto-Graded:</span>
              <strong>{summary.mcqCount} MCQs</strong>
            </div>
            <div className="gf-summary-item">
              <span>✍️ Open-Ended:</span>
              <strong>{summary.openEndedCount} Text/Calc</strong>
            </div>
            <div className="gf-summary-item">
              <span>🏆 Total Marks:</span>
              <strong>{summary.totalMarks} Pts</strong>
            </div>
          </div>

          {/* TAB 1: 1-Click Native API */}
          {activeTab === 'api' && (
            <div>
              {!result && (
                <div className="gf-api-intro">
                  <h4>Create Google Form Quiz in Your Google Drive</h4>
                  <p>
                    Connects directly to the official <strong>Google Forms API v1</strong> using your
                    Google Account. Configures question points, auto-graded answer keys, feedback, and
                    images automatically.
                  </p>
                </div>
              )}

              {!result && (
                <button
                  type="button"
                  className="gf-primary-btn"
                  onClick={handleStartApiExport}
                  disabled={isExporting}
                >
                  {isExporting ? (
                    <>
                      <div className="gf-spinner" />
                      <span>Creating Google Form Quiz...</span>
                    </>
                  ) : isConvertingImages ? (
                    <>
                      <div className="gf-spinner" />
                      <span>⚡ Create Quiz in Google Drive (Syncing R2 Diagrams...)</span>
                    </>
                  ) : (
                    <>
                      <span>⚡</span>
                      <span>Create Quiz in Google Drive</span>
                    </>
                  )}
                </button>
              )}

              {/* Progress Indicator */}
              {isExporting && progress && (
                <div className="gf-progress-box">
                  <div className="gf-progress-header">
                    <div className="gf-progress-stage">
                      <div className="gf-spinner" />
                      <span>{progress.message}</span>
                    </div>
                    {progress.totalItems && (
                      <span className="gf-progress-count">
                        {progress.completedItems || 0} / {progress.totalItems} items
                      </span>
                    )}
                  </div>
                  {progress.totalItems && (
                    <div className="gf-progress-bar-track">
                      <div
                        className="gf-progress-bar-fill"
                        style={{
                          width: `${Math.round(
                            ((progress.completedItems || 0) / progress.totalItems) * 100
                          )}%`,
                        }}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Success Screen */}
              {result && (
                <div className="gf-success-box">
                  <div className="gf-success-icon">🎉</div>
                  <h3 className="gf-success-title">Google Form Quiz Created!</h3>
                  <p className="gf-success-desc">
                    Your assessment <strong>"{result.title}"</strong> was successfully created in your
                    Google Drive with {result.totalQuestions} questions ({result.mcqCount} auto-graded).
                  </p>

                  <div className="gf-success-actions">
                    <a
                      href={result.editUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="gf-btn-open-form"
                    >
                      ✏️ Open in Google Forms Editor
                    </a>

                    <button
                      type="button"
                      className="gf-btn-copy-link"
                      onClick={() => handleCopyResponderLink(result.responderUrl)}
                    >
                      {copiedLink ? '✓ Copied Student Link!' : '📋 Copy Student Quiz Link'}
                    </button>
                  </div>
                </div>
              )}

              {/* Error Message */}
              {error && (
                <div className="gf-error-box">
                  <div className="gf-error-title">
                    <span>⚠️</span>
                    <span>Export Failed</span>
                  </div>
                  <p className="gf-error-message">{error}</p>

                  {isGcpLinkNeeded && (
                    <a
                      href={FORMS_API_CONSOLE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="gf-error-action-btn"
                    >
                      🔗 Open Google Cloud Console to Enable Forms API
                    </a>
                  )}

                  <div style={{ marginTop: '0.5rem', fontSize: '0.84rem', color: '#64748b' }}>
                    💡 <strong>Tip:</strong> If you do not have Google Cloud Admin rights, switch to
                    the <strong>Google Apps Script tab</strong> above — it works on any Google account
                    with zero setup!
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: Google Apps Script (Zero Setup) */}
          {activeTab === 'script' && (
            <div>
              <div className="gf-script-steps">
                <div className="gf-script-step">
                  <div className="gf-step-num">1</div>
                  <div className="gf-step-text">
                    Click <strong>"Copy Apps Script"</strong> below to copy the custom form generator
                    code.
                  </div>
                </div>

                <div className="gf-script-step">
                  <div className="gf-step-num">2</div>
                  <div className="gf-step-text">
                    Click <strong>"Open script.new"</strong> to open a new Google Apps Script editor in
                    a new tab.
                  </div>
                </div>

                <div className="gf-script-step">
                  <div className="gf-step-num">3</div>
                  <div className="gf-step-text">
                    Delete any default placeholder code, <strong>paste this script</strong>, and click{' '}
                    <strong>Run (▶)</strong>. Your form is created instantly in your Drive!
                  </div>
                </div>
              </div>

              <div className="gf-script-actions">
                <button
                  type="button"
                  className="gf-script-btn gf-script-btn--copy"
                  onClick={handleCopyScript}
                >
                  {copiedScript ? '✓ Script Copied to Clipboard!' : isConvertingImages ? '⏳ Copy Apps Script (Syncing to R2...)' : '📋 Copy Apps Script'}
                </button>

                <a
                  href="https://script.new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gf-script-btn gf-script-btn--launch"
                >
                  🚀 Open script.new ↗
                </a>
              </div>

              {/* Code preview */}
              <div className="gf-code-preview-wrap">
                <div className="gf-code-preview-bar">
                  <span>Google Apps Script (FormApp)</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {isConvertingImages && (
                      <span style={{ fontSize: '0.75rem', color: '#60a5fa' }}>🔄 Optimizing diagrams (PNG)...</span>
                    )}
                    <span>{appsScriptCode.split('\n').length} lines</span>
                  </div>
                </div>
                <pre className="gf-code-preview">{appsScriptCode}</pre>
              </div>
            </div>
          )}

          {/* TAB 3: CSV for Form Builder Add-ons */}
          {activeTab === 'csv' && (
            <div>
              <div className="gf-csv-intro">
                <h4>Export Form Builder CSV</h4>
                <p>
                  Downloads a standardized CSV spreadsheet formatted for Google Forms add-ons such as{' '}
                  <strong>Form Builder Plus</strong>, <strong>Form Director</strong>, and{' '}
                  <strong>Form Publisher</strong>.
                </p>

                <div className="gf-csv-addon-list">
                  <div className="gf-csv-addon-item">
                    <span>✓</span>
                    <span>Includes all question stems, choices, and point values</span>
                  </div>
                  <div className="gf-csv-addon-item">
                    <span>✓</span>
                    <span>Includes answer keys and marking scheme feedback</span>
                  </div>
                  <div className="gf-csv-addon-item">
                    <span>✓</span>
                    <span>Compatible with Google Sheets import tools</span>
                  </div>
                </div>

                <button
                  type="button"
                  className="gf-primary-btn"
                  onClick={handleDownloadCsv}
                  style={{ background: '#2563eb' }}
                >
                  <span>📥</span>
                  <span>Download Form Builder CSV (.csv)</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="gf-modal-footer">
          <button type="button" className="gf-btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
export default GoogleFormsExportModal;
