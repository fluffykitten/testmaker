// ─── Google Forms Export Modal Component ───────────────────────────────────────
// Modal offering 3 ways to export: 1-Click Native API, Google Apps Script, and Form Builder CSV.
// Addresses all 25 issues: deferred uploads, cancellation, security, preview,
// anti-cheat options, short answer grading, Classroom sharing, and offline resilience.

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
  revokeGoogleFormsToken,
  type GoogleFormResult,
  type GoogleFormsProgress,
  type SectionBreakMode,
  type GoogleFormsExportOptions,
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
import { GoogleFormsPreviewDrawer } from './GoogleFormsPreviewDrawer';
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
  const [isRevokingToken, setIsRevokingToken] = useState(false);
  const [revokedNotice, setRevokedNotice] = useState(false);

  // Export Settings & Anti-cheat Options (Fixes Issues #16, #17, #18, #19)
  const [isRequired, setIsRequired] = useState(true);
  const [shuffleOptions, setShuffleOptions] = useState(false);
  const [shuffleQuestions, setShuffleQuestions] = useState(false);
  const [sectionBreakMode, setSectionBreakMode] = useState<SectionBreakMode>('none');
  const [diagramMode, setDiagramMode] = useState<'cdn' | 'base64'>('cdn');

  // Offline status detection (Fixes Issue #25)
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);

  // Local synchronous base64 table figures
  const [imageBase64Map, setImageBase64Map] = useState<Record<string, string>>({});
  const [imageUrlMap, setImageUrlMap] = useState<Record<string, string>>({});
  const [isSyncingImages, setIsSyncingImages] = useState(false);

  // References for cancellation and background tasks (Fixes Issue #11)
  const abortControllerRef = useRef<AbortController | null>(null);
  const uploadPromiseRef = useRef<Promise<{ b64Map: Record<string, string>; urlMap: Record<string, string> }> | null>(null);

  // Monitor online / offline network status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Step A: Fast synchronous local canvas render of all tables (<5ms, zero network)
  // Defer external R2 uploads until export is actually triggered (Fixes Issue #10)
  useEffect(() => {
    if (!isOpen || !questions || questions.length === 0) return;

    const ordered = getOrderedQuestions(questions);
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
  }, [isOpen, questions]);

  // Clean up any ongoing requests on unmount or close (Fixes Issue #11)
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Pre-load Google Identity Services SDK on modal open
  useEffect(() => {
    if (isOpen) {
      loadGsiScript().catch(() => {});
    }
  }, [isOpen]);

  // Decoupled summary calculation: depends ONLY on questions (Fixes Issue #12)
  const summary = useMemo(() => {
    const items = flattenQuestionsForForms(questions);
    const mcqCount = items.filter((i) => i.type === 'RADIO' || i.type === 'CHECKBOX').length;
    const gridCount = items.filter((i) => i.type === 'GRID').length;
    const shortAnswerCount = items.filter((i) => i.type === 'SHORT_ANSWER').length;
    const totalMarks = items.reduce((sum, i) => sum + i.pointValue, 0);
    return {
      totalItems: items.length,
      mcqCount,
      gridCount,
      shortAnswerCount,
      totalMarks,
      openEndedCount: items.length - mcqCount - gridCount - shortAnswerCount,
    };
  }, [questions]);

  // Helper: Trigger parallel Cloudflare R2 uploads only when required (Fixes Issue #10)
  const ensureCloudDiagramsUploaded = async (): Promise<{
    b64Map: Record<string, string>;
    urlMap: Record<string, string>;
  }> => {
    if (uploadPromiseRef.current) {
      return uploadPromiseRef.current;
    }

    const ordered = getOrderedQuestions(questions);
    const b64Map: Record<string, string> = { ...imageBase64Map };
    const urlMap: Record<string, string> = { ...imageUrlMap };
    const uploadPromises: Promise<void>[] = [];

    setIsSyncingImages(true);

    const task = (async () => {
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
          } else if (tablePngDataUrl && !urlMap[qKey]) {
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
            } else if (existingDiagram.startsWith('data:image/')) {
              b64Map[qKey] = existingDiagram;
            }
          }

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
              } else if (sqTablePng && !urlMap[sqKey]) {
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
                } else if (sqDiagram.startsWith('data:image/')) {
                  b64Map[sqKey] = sqDiagram;
                }
              }
            }
          }
        }

        await Promise.all(uploadPromises);
      } catch (err) {
        console.warn('[GoogleFormsExport] Image upload note:', err);
      } finally {
        setIsSyncingImages(false);
      }

      setImageBase64Map({ ...b64Map });
      setImageUrlMap({ ...urlMap });
      return { b64Map, urlMap };
    })();

    uploadPromiseRef.current = task;
    return task;
  };

  // Lazy generation of Google Apps Script: only computed when on Script tab (Fixes Issue #13)
  const appsScriptCode = useMemo(() => {
    if (activeTab !== 'script') return '';
    const exportOpts: GoogleFormsExportOptions = {
      sectionBreakMode,
      shuffleOptions,
      shuffleQuestions,
      isRequired,
      diagramMode,
    };
    return generateGoogleAppsScript(headerConfig, questions, imageBase64Map, imageUrlMap, exportOpts);
  }, [activeTab, headerConfig, questions, imageBase64Map, imageUrlMap, sectionBreakMode, shuffleOptions, shuffleQuestions, isRequired, diagramMode]);

  if (!isOpen) return null;

  // Handle cancellation (Fixes Issue #11)
  const handleCancelExport = () => {
    abortControllerRef.current?.abort();
    setIsExporting(false);
    setProgress(null);
    setError('Export cancelled by user.');
  };

  // Start 1-Click Native API Export
  const handleStartApiExport = async () => {
    setError(null);
    setIsGcpLinkNeeded(false);
    setResult(null);

    const settings = getSavedSettings();
    const clientId =
      settings.googleDriveClientId ||
      (typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_GOOGLE_DRIVE_CLIENT_ID : '');

    if (!clientId) {
      setError(
        'Google Client ID is not configured. Please set your Google OAuth Client ID in Settings → Integrations, or use the Zero-Setup Google Apps Script tab!'
      );
      return;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setIsExporting(true);
    setProgress({ stage: 'creating', message: 'Preparing diagrams and cloud assets...' });

    let activeB64 = imageBase64Map;
    let activeUrl = imageUrlMap;

    try {
      const completed = await ensureCloudDiagramsUploaded();
      activeB64 = completed.b64Map;
      activeUrl = completed.urlMap;
    } catch (e) {
      console.warn('Waiting for table upload failed:', e);
    }

    if (abortController.signal.aborted) {
      setIsExporting(false);
      return;
    }

    const exportOptions: GoogleFormsExportOptions = {
      sectionBreakMode,
      shuffleOptions,
      shuffleQuestions,
      isRequired,
      signal: abortController.signal,
    };

    try {
      const res = await createGoogleFormQuiz(
        headerConfig,
        questions,
        clientId,
        (prog) => {
          setProgress(prog);
        },
        activeB64,
        activeUrl,
        exportOptions
      );
      setResult(res);
    } catch (err: any) {
      if (err?.name === 'AbortError' || abortController.signal.aborted) {
        setError('Export was cancelled.');
        return;
      }

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

  // Copy Apps Script code
  const handleCopyScript = async () => {
    try {
      let codeToCopy = appsScriptCode;
      if (diagramMode === 'cdn') {
        const completed = await ensureCloudDiagramsUploaded();
        codeToCopy = generateGoogleAppsScript(headerConfig, questions, completed.b64Map, completed.urlMap, {
          sectionBreakMode,
          shuffleOptions,
          shuffleQuestions,
          isRequired,
          diagramMode: 'cdn',
        });
      }
      await navigator.clipboard.writeText(codeToCopy);
      setCopiedScript(true);
      setTimeout(() => setCopiedScript(false), 2500);
    } catch (err) {
      console.warn('Clipboard write failed:', err);
    }
  };

  // Download .gs file directly
  const handleDownloadScript = async () => {
    let codeToDownload = appsScriptCode;
    if (diagramMode === 'cdn') {
      const completed = await ensureCloudDiagramsUploaded();
      codeToDownload = generateGoogleAppsScript(headerConfig, questions, completed.b64Map, completed.urlMap, {
        sectionBreakMode,
        shuffleOptions,
        shuffleQuestions,
        isRequired,
        diagramMode: 'cdn',
      });
    }
    const safeTitle = (headerConfig.title || 'Google_Forms_Quiz').replace(/[^a-zA-Z0-9_-]/g, '_');
    const blob = new Blob([codeToDownload], { type: 'application/javascript;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeTitle}_Google_Forms_Generator.gs`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Copy Student Quiz link
  const handleCopyResponderLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch (err) {
      console.warn('Clipboard copy failed:', err);
    }
  };

  // Download CSV
  const handleDownloadCsv = () => {
    exportGoogleFormsQuiz(headerConfig, questions);
  };

  // Handle Token Revocation / Sign out (Fixes Issue #15)
  const handleRevokeToken = async () => {
    setIsRevokingToken(true);
    try {
      await revokeGoogleFormsToken();
      setRevokedNotice(true);
      setTimeout(() => setRevokedNotice(false), 3500);
    } finally {
      setIsRevokingToken(false);
    }
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
                Create an auto-graded assessment quiz in Google Forms or export to Google Sheets &amp; Apps Script
              </p>
            </div>
          </div>
          <button type="button" className="gf-modal-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Offline Warning Banner (Fixes Issue #25) */}
        {!isOnline && (
          <div className="gf-offline-banner">
            <span>📡 You appear to be offline. The Native API export requires an internet connection. You can still use the <strong>Google Apps Script</strong> or <strong>CSV</strong> tab!</span>
          </div>
        )}

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
          {/* Assessment Summary Strip (Fixes Issue #12 & #20) */}
          <div className="gf-summary-strip">
            <div className="gf-summary-item">
              <span>📄 Total Items:</span>
              <strong>{summary.totalItems} Questions</strong>
            </div>
            <div className="gf-summary-item">
              <span>🎯 Auto-Graded:</span>
              <strong>{summary.mcqCount + summary.gridCount + summary.shortAnswerCount} Items</strong>
            </div>
            <div className="gf-summary-item">
              <span>✍️ Open-Ended:</span>
              <strong>{summary.openEndedCount} Items</strong>
            </div>
            <div className="gf-summary-item">
              <span>🏆 Total Marks:</span>
              <strong>{summary.totalMarks} Pts</strong>
            </div>
            {headerConfig.durationMinutes && (
              <div className="gf-summary-item gf-summary-item--duration">
                <span>⏱ Duration:</span>
                <strong>{headerConfig.durationMinutes} Min</strong>
              </div>
            )}
          </div>

          {/* Form Configuration Options Toolbar (Fixes Issues #16, #17, #18, #19) */}
          <div className="gf-options-panel">
            <div className="gf-options-row">
              <label className="gf-option-label" title="Force students to answer every question before submitting">
                <input
                  type="checkbox"
                  checked={isRequired}
                  onChange={(e) => setIsRequired(e.target.checked)}
                />
                <span>Make All Questions Required</span>
              </label>

              <label className="gf-option-label" title="Randomize choice options per student to prevent peeking">
                <input
                  type="checkbox"
                  checked={shuffleOptions}
                  onChange={(e) => setShuffleOptions(e.target.checked)}
                />
                <span>Shuffle Multiple Choice Options</span>
              </label>

              <label className="gf-option-label" title="Randomize question sequence">
                <input
                  type="checkbox"
                  checked={shuffleQuestions}
                  onChange={(e) => setShuffleQuestions(e.target.checked)}
                />
                <span>Shuffle Question Order</span>
              </label>
            </div>

            <div className="gf-options-row gf-options-row--secondary">
              <div className="gf-select-control">
                <span className="gf-select-label">Section Breaks:</span>
                <select
                  value={sectionBreakMode}
                  onChange={(e) => setSectionBreakMode(e.target.value as SectionBreakMode)}
                  className="gf-select-input"
                >
                  <option value="none">Single Page (No Breaks)</option>
                  <option value="by_question">Page Break per Question</option>
                  <option value="by_style">Separate MCQ &amp; Structured Sections</option>
                  <option value="chunk_10">Every 10 Questions</option>
                </select>
              </div>

              {activeTab === 'script' && (
                <div className="gf-select-control">
                  <span className="gf-select-label">Diagram Embedding:</span>
                  <select
                    value={diagramMode}
                    onChange={(e) => setDiagramMode(e.target.value as 'cdn' | 'base64')}
                    className="gf-select-input"
                  >
                    <option value="cdn">Cloudflare CDN (Recommended, Fast)</option>
                    <option value="base64">Self-Contained Base64 (Zero External URLs)</option>
                  </select>
                </div>
              )}
            </div>
          </div>

          {/* Pre-Export Question & Answer Key Preview (Fixes Issue #21) */}
          <GoogleFormsPreviewDrawer
            questions={questions}
            imageBase64Map={imageBase64Map}
            imageUrlMap={imageUrlMap}
          />

          {/* TAB 1: 1-Click Native API */}
          {activeTab === 'api' && (
            <div>
              {!result && (
                <div className="gf-api-intro">
                  <h4>Create Google Form Quiz in Your Google Drive</h4>
                  <p>
                    Connects directly to official <strong>Google Forms API v1</strong> using your Google account.
                    Automatically formats questions, point values, auto-grading answer keys, feedback, and table images.
                  </p>
                </div>
              )}

              {!result && (
                <div className="gf-action-row">
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
                    ) : isSyncingImages ? (
                      <>
                        <div className="gf-spinner" />
                        <span>⚡ Create Quiz in Drive (Syncing R2 Diagrams...)</span>
                      </>
                    ) : (
                      <>
                        <span>⚡</span>
                        <span>Create Quiz in Google Drive</span>
                      </>
                    )}
                  </button>

                  {isExporting && (
                    <button
                      type="button"
                      className="gf-cancel-btn"
                      onClick={handleCancelExport}
                      title="Cancel the active export"
                    >
                      Cancel
                    </button>
                  )}
                </div>
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

                    {/* 1-Click Share to Google Classroom (Fixes Issue #24) */}
                    <a
                      href={`https://classroom.google.com/share?url=${encodeURIComponent(
                        result.responderUrl
                      )}&title=${encodeURIComponent(result.title)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="gf-btn-classroom"
                      title="Share directly to Google Classroom as an assignment"
                    >
                      <span className="gf-classroom-icon">🏫</span>
                      <span>Share to Google Classroom</span>
                    </a>
                  </div>
                </div>
              )}

              {/* Error Message & Guidance (Fixes Issue #25) */}
              {error && (
                <div className="gf-error-box">
                  <div className="gf-error-title">
                    <span>⚠️</span>
                    <span>Export Encountered an Issue</span>
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

                  <div className="gf-error-tip">
                    💡 <strong>Pro-Tip:</strong> If your school or organization restricts Google Cloud API permissions, switch to the <strong>Google Apps Script tab</strong> above — it runs 100% inside Google's infrastructure with zero setup required!
                  </div>
                </div>
              )}

              {/* Security Disclosure & Token Management (Fixes Issue #14 & #15) */}
              <div className="gf-security-badge">
                <div className="gf-security-text">
                  <span className="gf-security-icon">🔒</span>
                  <span>
                    <strong>Privacy &amp; Security:</strong> TestMaker requests the standard Google Forms scope only to generate this specific quiz file in your Drive. We never read or modify your existing forms or files.
                  </span>
                </div>
                <div className="gf-revoke-action">
                  <button
                    type="button"
                    className="gf-revoke-link"
                    onClick={handleRevokeToken}
                    disabled={isRevokingToken}
                    title="Sign out and revoke Google Forms token on shared computers"
                  >
                    {isRevokingToken ? 'Disconnecting...' : revokedNotice ? '✓ Disconnected' : 'Sign out / Revoke Access'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: Google Apps Script (Zero Setup) */}
          {activeTab === 'script' && (
            <div>
              <div className="gf-script-steps">
                <div className="gf-script-step">
                  <div className="gf-step-num">1</div>
                  <div className="gf-step-text">
                    Click <strong>"Copy Apps Script"</strong> or <strong>"Download .gs"</strong> below.
                  </div>
                </div>

                <div className="gf-script-step">
                  <div className="gf-step-num">2</div>
                  <div className="gf-step-text">
                    Click <strong>"Open script.new"</strong> to launch Google's online editor.
                  </div>
                </div>

                <div className="gf-script-step">
                  <div className="gf-step-num">3</div>
                  <div className="gf-step-text">
                    Delete default boilerplate code, paste this script, and click{' '}
                    <strong>Run (▶)</strong>. Your form is created immediately!
                  </div>
                </div>
              </div>

              {summary.shortAnswerCount > 0 && (
                <div className="gf-warning-box" style={{ marginTop: '1rem', padding: '0.75rem', backgroundColor: '#fff3cd', color: '#856404', borderRadius: '4px', fontSize: '0.85rem' }}>
                  <strong>⚠️ Short Answer Limitation:</strong> Google Apps Script does not support setting correct answers for short answer items. 
                  Your {summary.shortAnswerCount} short answer question(s) will require manual grading, or you can use the <strong>1-Click Native API</strong> tab which supports full auto-grading!
                </div>
              )}

              <div className="gf-script-actions">
                <button
                  type="button"
                  className="gf-script-btn gf-script-btn--copy"
                  onClick={handleCopyScript}
                >
                  {copiedScript
                    ? '✓ Script Copied to Clipboard!'
                    : isSyncingImages
                    ? '⏳ Copy Apps Script (Syncing Diagrams...)'
                    : '📋 Copy Apps Script'}
                </button>

                <button
                  type="button"
                  className="gf-script-btn gf-script-btn--download"
                  onClick={handleDownloadScript}
                  title="Download .gs file"
                >
                  💾 Download .gs
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
                  <span>Google Apps Script (FormApp Generator)</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {isSyncingImages && (
                      <span style={{ fontSize: '0.75rem', color: '#60a5fa' }}>
                        🔄 Optimizing diagrams...
                      </span>
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
                <h4>Export Form Builder &amp; Spreadsheet CSV</h4>
                <p>
                  Downloads a comprehensive CSV spreadsheet with full Cambridge sub-questions, Unicode math symbols, dynamic option columns, and grading answer keys.
                </p>

                <div className="gf-csv-addon-list">
                  <div className="gf-csv-addon-item">
                    <span>✓</span>
                    <span>Includes all multi-part sub-questions with structured contexts</span>
                  </div>
                  <div className="gf-csv-addon-item">
                    <span>✓</span>
                    <span>Preserves chemical formulas, superscripts, and mathematical notations</span>
                  </div>
                  <div className="gf-csv-addon-item">
                    <span>✓</span>
                    <span>Includes dedicated <strong>Correct Answer</strong> and <strong>Mark Scheme</strong> columns</span>
                  </div>
                  <div className="gf-csv-addon-item">
                    <span>✓</span>
                    <span>Compatible with Google Sheets, Form Builder Plus, Form Director, and CSV Importers</span>
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
