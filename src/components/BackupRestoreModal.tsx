import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { saveAs } from 'file-saver';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import {
  createFullBackupArchive,
  getBackupEstimate,
  type BackupProgressCallback,
} from '../services/backupService';
import {
  inspectBackupArchive,
  executeRestore,
  type RestoreInspectionResult,
  type RestoreResult,
} from '../services/restoreService';
import {
  requestGoogleDriveTokenDetails,
  GoogleDriveAuthExpiredError,
  listGoogleDriveBackups,
  uploadBackupToGoogleDrive,
  downloadBackupFromGoogleDrive,
  deleteGoogleDriveBackup,
  type GoogleDriveBackupItem,
} from '../services/googleDriveService';
import {
  setSessionDriveToken,
  getSessionDriveToken,
} from '../services/autoBackupService';
import {
  getSavedSettings,
  saveSettings,
  syncGoogleDriveClientIdToCloud,
  loadAndSyncGoogleDriveClientId,
} from '../lib/settings';
import './BackupRestoreModal.css';

interface BackupRestoreModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ActiveTab = 'snapshot' | 'restore' | 'gdrive';

export function BackupRestoreModal({ isOpen, onClose }: BackupRestoreModalProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('snapshot');
  const backdropDismiss = useBackdropDismiss(onClose);

  // ─── Snapshot Backup State ───────────────────────────────────────────────
  const [stats, setStats] = useState<{
    questionsCount: number;
    syllabusesCount: number;
    customTestsCount: number;
  }>({ questionsCount: 0, syllabusesCount: 0, customTestsCount: 0 });

  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupProgress, setBackupProgress] = useState<{ status: string; pct: number }>({
    status: '',
    pct: 0,
  });
  const [lastDownloadedFile, setLastDownloadedFile] = useState<string | null>(null);

  // ─── Restore State ───────────────────────────────────────────────────────
  const [restoreFile, setRestoreFile] = useState<File | Blob | null>(null);
  const [inspection, setInspection] = useState<RestoreInspectionResult | null>(null);
  const [restoreMode, setRestoreMode] = useState<'merge' | 'replace'>('merge');
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<{ status: string; pct: number }>({
    status: '',
    pct: 0,
  });
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Google Drive State ──────────────────────────────────────────────────
  const [gdriveToken, setGdriveToken] = useState<string | null>(() => getSessionDriveToken());
  const [gdriveClientId, setGdriveClientId] = useState<string>(() => {
    return (
      getSavedSettings().googleDriveClientId ||
      (import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID as string) ||
      (import.meta.env.VITE_GOOGLE_CLIENT_ID as string) ||
      ''
    );
  });
  const [driveFiles, setDriveFiles] = useState<GoogleDriveBackupItem[]>([]);
  const [isLoadingDrive, setIsLoadingDrive] = useState(false);
  const [isUploadingToDrive, setIsUploadingToDrive] = useState(false);
  const [driveActionNotice, setDriveActionNotice] = useState<string | null>(null);

  // Auto-backup settings state
  const [autoBackupEnabled, setAutoBackupEnabled] = useState<boolean>(() => {
    return getSavedSettings().autoBackupEnabled || false;
  });
  const [autoBackupFrequency, setAutoBackupFrequency] = useState<'on_paper_upload' | 'daily' | 'weekly'>(() => {
    return getSavedSettings().autoBackupFrequency || 'on_paper_upload';
  });

  // Load estimate stats & sync client ID when opening
  useEffect(() => {
    if (isOpen) {
      getBackupEstimate().then((est) => setStats(est));
      setGdriveToken(getSessionDriveToken());
      loadAndSyncGoogleDriveClientId().then((id) => {
        if (id) {
          setGdriveClientId((prev) => prev || id);
        }
      });
    }
  }, [isOpen]);

  // Listen for background session expiration
  useEffect(() => {
    const handleAuthExpired = () => {
      setGdriveToken(null);
      setDriveActionNotice('Google Drive authorization expired. Please reconnect.');
    };
    window.addEventListener('testmaker_gdrive_auth_expired', handleAuthExpired);
    return () => window.removeEventListener('testmaker_gdrive_auth_expired', handleAuthExpired);
  }, []);

  // Load Google Drive files if token is active
  useEffect(() => {
    if (isOpen && gdriveToken && activeTab === 'gdrive') {
      refreshDriveFiles(gdriveToken);
    }
  }, [isOpen, gdriveToken, activeTab]);

  if (!isOpen) return null;

  // ─── Handle Snapshot Backup ──────────────────────────────────────────────

  const handleDownloadBackup = async () => {
    setIsBackingUp(true);
    setBackupProgress({ status: 'Initializing full backup snapshot…', pct: 2 });
    setLastDownloadedFile(null);

    const onProgress: BackupProgressCallback = (status, pct) => {
      setBackupProgress({ status, pct });
    };

    try {
      const archive = await createFullBackupArchive(onProgress);
      saveAs(archive.blob, archive.fileName);
      setLastDownloadedFile(archive.fileName);

      // Update settings with last backup info
      const s = getSavedSettings();
      saveSettings({
        ...s,
        lastBackupTimestamp: Date.now(),
        lastBackupFileName: archive.fileName,
      });
    } catch (err: any) {
      setBackupProgress({
        status: `Backup failed: ${err?.message || 'Unknown error'}`,
        pct: 0,
      });
    } finally {
      setIsBackingUp(false);
    }
  };

  // ─── Handle Restore Inspection & Execution ───────────────────────────────

  const handleFileDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) {
      await processSelectedRestoreFile(file);
    }
  };

  const processSelectedRestoreFile = async (file: File | Blob) => {
    setRestoreFile(file);
    setRestoreResult(null);
    setRestoreProgress({ status: 'Inspecting backup archive…', pct: 10 });
    const insp = await inspectBackupArchive(file);
    setInspection(insp);
    setRestoreProgress({ status: '', pct: 0 });
  };

  const handleExecuteRestore = async () => {
    if (!restoreFile) return;

    setIsRestoring(true);
    setRestoreResult(null);
    setRestoreProgress({ status: 'Starting restore…', pct: 5 });

    try {
      const res = await executeRestore(
        restoreFile,
        { mode: restoreMode },
        (status, pct) => {
          setRestoreProgress({ status, pct });
        }
      );
      setRestoreResult(res);
      // Refresh estimate stats
      getBackupEstimate().then((est) => setStats(est));
    } catch (err: any) {
      setRestoreResult({
        success: false,
        hasPartialSuccess: false,
        syllabusesRestored: 0,
        questionsRestored: 0,
        diagramsRestored: 0,
        customTestsRestored: 0,
        quizSubmissionsRestored: 0,
        appConfigRestored: 0,
        errors: [err?.message || 'Failed to restore archive.'],
      });
    } finally {
      setIsRestoring(false);
    }
  };

  // ─── Handle Google Drive ─────────────────────────────────────────────────

  const handleClientIdChange = (val: string) => {
    setGdriveClientId(val);
    const trimmed = val.trim();
    if (trimmed) {
      const s = getSavedSettings();
      saveSettings({ ...s, googleDriveClientId: trimmed });
      syncGoogleDriveClientIdToCloud(trimmed).catch(() => {});
    }
  };

  const handleSaveClientId = () => {
    const trimmed = gdriveClientId.trim();
    const s = getSavedSettings();
    saveSettings({ ...s, googleDriveClientId: trimmed });
    if (trimmed) {
      syncGoogleDriveClientIdToCloud(trimmed).catch(() => {});
    }
    setDriveActionNotice('Client ID saved & synced successfully.');
    setTimeout(() => setDriveActionNotice(null), 3000);
  };

  const handleConnectGoogleDrive = async () => {
    const trimmedId = gdriveClientId.trim();
    if (!trimmedId) {
      setDriveActionNotice('Please enter your Google OAuth Client ID first.');
      return;
    }

    // Always auto-save client ID to local storage & cloud so it never disappears!
    const s = getSavedSettings();
    saveSettings({ ...s, googleDriveClientId: trimmedId });
    syncGoogleDriveClientIdToCloud(trimmedId).catch(() => {});

    try {
      setIsLoadingDrive(true);
      const details = await requestGoogleDriveTokenDetails(trimmedId);
      setGdriveToken(details.accessToken);
      setSessionDriveToken(details.accessToken, details.expiresIn);
      await refreshDriveFiles(details.accessToken);
      setDriveActionNotice('Connected to Google Drive!');
      setTimeout(() => setDriveActionNotice(null), 3000);
    } catch (err: any) {
      setDriveActionNotice(`Google login error: ${err?.message || 'Unknown'}`);
    } finally {
      setIsLoadingDrive(false);
    }
  };

  const refreshDriveFiles = async (token: string) => {
    try {
      setIsLoadingDrive(true);
      const files = await listGoogleDriveBackups(token);
      setDriveFiles(files);
    } catch (err: any) {
      if (err instanceof GoogleDriveAuthExpiredError) {
        setGdriveToken(null);
        setSessionDriveToken(null);
        setDriveActionNotice('Google Drive session expired. Please reconnect.');
      } else {
        console.warn('Failed to list drive files:', err);
      }
    } finally {
      setIsLoadingDrive(false);
    }
  };

  const handleUploadCurrentToDrive = async () => {
    if (!gdriveToken) return;

    setIsUploadingToDrive(true);
    setDriveActionNotice('Generating snapshot and uploading to Google Drive…');

    try {
      const archive = await createFullBackupArchive();
      await uploadBackupToGoogleDrive(gdriveToken, archive.blob, archive.fileName);
      await refreshDriveFiles(gdriveToken);
      setDriveActionNotice(`Successfully uploaded ${archive.fileName} to Google Drive!`);
      setTimeout(() => setDriveActionNotice(null), 4000);
    } catch (err: any) {
      if (err instanceof GoogleDriveAuthExpiredError) {
        setGdriveToken(null);
        setSessionDriveToken(null);
        setDriveActionNotice('Google Drive session expired. Please reconnect.');
      } else {
        setDriveActionNotice(`Upload to Drive failed: ${err?.message || 'Unknown'}`);
      }
    } finally {
      setIsUploadingToDrive(false);
    }
  };

  const handleRestoreFromDrive = async (file: GoogleDriveBackupItem) => {
    if (!gdriveToken) return;

    // Switch to restore tab and display progress immediately (Issue #6 & #10)
    setActiveTab('restore');
    setIsRestoring(true);
    setRestoreProgress({ status: `Downloading ${file.name} from Google Drive…`, pct: 30 });
    setRestoreResult(null);

    try {
      const blob = await downloadBackupFromGoogleDrive(gdriveToken, file.id);
      setRestoreProgress({ status: 'Inspecting backup archive…', pct: 75 });
      await processSelectedRestoreFile(blob);
    } catch (err: any) {
      if (err instanceof GoogleDriveAuthExpiredError) {
        setGdriveToken(null);
        setSessionDriveToken(null);
        setDriveActionNotice('Google Drive session expired. Please reconnect.');
      } else {
        setDriveActionNotice(`Failed to fetch from Drive: ${err?.message}`);
      }
      setRestoreProgress({ status: '', pct: 0 });
    } finally {
      setIsRestoring(false);
    }
  };

  const handleDeleteFromDrive = async (file: GoogleDriveBackupItem) => {
    if (!gdriveToken) return;
    if (!confirm(`Delete ${file.name} from Google Drive?`)) return;

    try {
      await deleteGoogleDriveBackup(gdriveToken, file.id);
      await refreshDriveFiles(gdriveToken);
    } catch (err: any) {
      if (err instanceof GoogleDriveAuthExpiredError) {
        setGdriveToken(null);
        setSessionDriveToken(null);
        setDriveActionNotice('Google Drive session expired. Please reconnect.');
      } else {
        setDriveActionNotice(`Failed to delete: ${err?.message}`);
      }
    }
  };

  const handleToggleAutoBackup = (enabled: boolean) => {
    setAutoBackupEnabled(enabled);
    const s = getSavedSettings();
    saveSettings({ ...s, autoBackupEnabled: enabled });
  };

  const handleChangeFrequency = (freq: 'on_paper_upload' | 'daily' | 'weekly') => {
    setAutoBackupFrequency(freq);
    const s = getSavedSettings();
    saveSettings({ ...s, autoBackupFrequency: freq });
  };

  return createPortal(
    <div className="backup-overlay" {...backdropDismiss}>
      <div className="backup-modal animate-scale-in" onClick={(e) => e.stopPropagation()}>
        {/* ─── Modal Header ────────────────────────────────────────────── */}
        <div className="backup-header">
          <div className="backup-title-wrap">
            <div className="backup-title-icon">💾</div>
            <div>
              <h2 className="backup-title">Backup & Cloud Restore</h2>
              <p className="backup-subtitle">
                Protect Supabase SQL database records and diagram storage assets
              </p>
            </div>
          </div>
          <button
            type="button"
            className="backup-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* ─── Modal Navigation Tabs ──────────────────────────────────── */}
        <div className="backup-tabs">
          <button
            type="button"
            className={`backup-tab-btn ${activeTab === 'snapshot' ? 'backup-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('snapshot')}
          >
            <span>📦</span> Full Snapshot
          </button>
          <button
            type="button"
            className={`backup-tab-btn ${activeTab === 'restore' ? 'backup-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('restore')}
          >
            <span>📥</span> Restore Data
          </button>
          <button
            type="button"
            className={`backup-tab-btn ${activeTab === 'gdrive' ? 'backup-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('gdrive')}
          >
            <span>☁️</span> Google Drive Sync
          </button>
        </div>

        {/* Global Action / Notice Banner (Visible across all tabs) */}
        {driveActionNotice && (
          <div className="backup-success-alert animate-fade-in" style={{ margin: '12px 20px 0' }}>
            {driveActionNotice}
          </div>
        )}

        {/* ─── Modal Body ─────────────────────────────────────────────── */}
        <div className="backup-body">
          {/* ─── Tab 1: Snapshot Backup ───────────────────────────────── */}
          {activeTab === 'snapshot' && (
            <div>
              <p className="backup-section-desc">
                Export a self-contained archive containing all relational database tables, question mark schemes, and original binary diagrams from Supabase Storage.
              </p>

              <div className="backup-stats-grid">
                <div className="backup-stat-card">
                  <span className="backup-stat-val">{stats.questionsCount}</span>
                  <span className="backup-stat-lbl">Questions</span>
                </div>
                <div className="backup-stat-card">
                  <span className="backup-stat-val">{stats.syllabusesCount}</span>
                  <span className="backup-stat-lbl">Syllabuses</span>
                </div>
                <div className="backup-stat-card">
                  <span className="backup-stat-val">{stats.customTestsCount}</span>
                  <span className="backup-stat-lbl">Custom Tests</span>
                </div>
              </div>

              <div className="backup-action-card">
                <div className="backup-action-card-header">
                  <span style={{ fontSize: '1.25rem' }}>🗜️</span>
                  <div>
                    <div className="backup-action-card-title">Download Offline Archive (.zip)</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                      Zero external setup required. Safe to store anywhere (Hard drive, USB, Dropbox, Google Drive).
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  className="backup-btn-primary"
                  onClick={handleDownloadBackup}
                  disabled={isBackingUp}
                  id="download-backup-btn"
                >
                  {isBackingUp ? 'Generating Archive…' : '⚡ Download Full Backup (.zip)'}
                </button>

                {isBackingUp && (
                  <div className="backup-progress-wrap">
                    <div className="backup-progress-info">
                      <span>{backupProgress.status}</span>
                      <span>{backupProgress.pct}%</span>
                    </div>
                    <div className="backup-progress-track">
                      <div
                        className="backup-progress-fill"
                        style={{ width: `${backupProgress.pct}%` }}
                      />
                    </div>
                  </div>
                )}

                {lastDownloadedFile && !isBackingUp && (
                  <div className="backup-success-alert animate-fade-in">
                    ✓ Saved <strong>{lastDownloadedFile}</strong> to your computer!
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ─── Tab 2: Restore Data ──────────────────────────────────── */}
          {activeTab === 'restore' && (
            <div>
              <p className="backup-section-desc">
                Select or drop a previous TestMaker backup archive (.zip) to restore questions, custom tests, and re-upload diagrams into Supabase Storage.
              </p>

              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) processSelectedRestoreFile(file);
                }}
              />

              <div
                className="restore-dropzone"
                onDrop={handleFileDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="restore-dropzone-icon">📁</div>
                <div className="restore-dropzone-title">Drop TestMaker Backup (.zip) Here</div>
                <div className="restore-dropzone-desc">or click to browse files from your device</div>
              </div>

              {/* Inspection Preview Card */}
              {inspection && (
                <div className="restore-inspection-card animate-fade-in">
                  <div className="restore-inspection-header">
                    <span className="restore-inspection-title">Archive Details</span>
                    <span
                      style={{
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        color: inspection.isValid ? '#10b981' : '#f43f5e',
                      }}
                    >
                      {inspection.isValid ? '✓ Verified Valid' : '✕ Invalid Format'}
                    </span>
                  </div>

                  {inspection.isValid ? (
                    <>
                      <div className="backup-stats-grid" style={{ marginBottom: 12 }}>
                        <div className="backup-stat-card">
                          <span className="backup-stat-val">{inspection.questionsCount}</span>
                          <span className="backup-stat-lbl">Questions</span>
                        </div>
                        <div className="backup-stat-card">
                          <span className="backup-stat-val">{inspection.diagramsCount}</span>
                          <span className="backup-stat-lbl">Diagrams</span>
                        </div>
                        <div className="backup-stat-card">
                          <span className="backup-stat-val">{inspection.syllabusesCount}</span>
                          <span className="backup-stat-lbl">Syllabuses</span>
                        </div>
                        <div className="backup-stat-card">
                          <span className="backup-stat-val">{inspection.customTestsCount}</span>
                          <span className="backup-stat-lbl">Custom Tests</span>
                        </div>
                        <div className="backup-stat-card">
                          <span className="backup-stat-val">{inspection.quizSubmissionsCount}</span>
                          <span className="backup-stat-lbl">Submissions</span>
                        </div>
                        <div className="backup-stat-card">
                          <span className="backup-stat-val">{inspection.appConfigCount}</span>
                          <span className="backup-stat-lbl">App Settings</span>
                        </div>
                      </div>

                      <div className="restore-mode-toggle" style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '12px 0' }}>
                        <label className="restore-mode-label" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input
                            type="radio"
                            name="restoreMode"
                            checked={restoreMode === 'merge'}
                            onChange={() => setRestoreMode('merge')}
                          />
                          <span><strong>Merge & Update</strong> (Recommended — updates matching IDs and preserves existing questions)</span>
                        </label>
                        <label className="restore-mode-label" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input
                            type="radio"
                            name="restoreMode"
                            checked={restoreMode === 'replace'}
                            onChange={() => {
                              if (confirm('Clean Replace mode will wipe existing questions and tests before importing from this archive. Are you sure?')) {
                                setRestoreMode('replace');
                              }
                            }}
                          />
                          <span style={{ color: restoreMode === 'replace' ? '#f43f5e' : 'inherit' }}>
                            <strong>Clean Replace</strong> (Wipes existing questions and tests before importing)
                          </span>
                        </label>
                      </div>

                      <button
                        type="button"
                        className="backup-btn-primary"
                        onClick={handleExecuteRestore}
                        disabled={isRestoring}
                        id="execute-restore-btn"
                      >
                        {isRestoring ? 'Restoring Questions & Diagrams…' : '🚀 Confirm & Restore to Supabase'}
                      </button>

                      {isRestoring && (
                        <div className="backup-progress-wrap">
                          <div className="backup-progress-info">
                            <span>{restoreProgress.status}</span>
                            <span>{restoreProgress.pct}%</span>
                          </div>
                          <div className="backup-progress-track">
                            <div
                              className="backup-progress-fill"
                              style={{ width: `${restoreProgress.pct}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ color: '#f43f5e', fontSize: '0.8125rem' }}>
                      {inspection.error}
                    </div>
                  )}
                </div>
              )}

              {/* Restore Result Banner */}
              {restoreResult && (
                <div
                  className={`animate-fade-in ${
                    restoreResult.success
                      ? 'backup-success-alert'
                      : restoreResult.hasPartialSuccess
                      ? 'backup-success-alert'
                      : 'backup-success-alert'
                  }`}
                  style={{
                    background: restoreResult.success
                      ? 'rgba(16, 185, 129, 0.12)'
                      : restoreResult.hasPartialSuccess
                      ? 'rgba(245, 158, 11, 0.12)'
                      : 'rgba(244, 63, 94, 0.12)',
                    borderColor: restoreResult.success
                      ? 'rgba(16, 185, 129, 0.3)'
                      : restoreResult.hasPartialSuccess
                      ? 'rgba(245, 158, 11, 0.3)'
                      : 'rgba(244, 63, 94, 0.3)',
                    color: restoreResult.success
                      ? '#10b981'
                      : restoreResult.hasPartialSuccess
                      ? '#f59e0b'
                      : '#f43f5e',
                  }}
                >
                  <strong>
                    {restoreResult.success
                      ? '🎉 Restore Successful!'
                      : restoreResult.hasPartialSuccess
                      ? '⚠️ Restore Partially Completed with Notes:'
                      : '❌ Restore Failed:'}
                  </strong>
                  <div style={{ marginTop: 4 }}>
                    Restored {restoreResult.questionsRestored} questions, {restoreResult.diagramsRestored} storage diagrams, {restoreResult.syllabusesRestored} syllabuses, {restoreResult.customTestsRestored} custom tests, {restoreResult.quizSubmissionsRestored} submissions, and {restoreResult.appConfigRestored} app settings.
                  </div>

                  {/* Render error list if any error occurred */}
                  {restoreResult.errors && restoreResult.errors.length > 0 && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(244, 63, 94, 0.2)' }}>
                      <strong style={{ fontSize: '0.75rem', display: 'block', marginBottom: 4 }}>
                        Error Details ({restoreResult.errors.length}):
                      </strong>
                      <div
                        style={{
                          maxHeight: '120px',
                          overflowY: 'auto',
                          fontSize: '0.6875rem',
                          background: 'rgba(0,0,0,0.05)',
                          padding: '6px 8px',
                          borderRadius: '4px',
                        }}
                      >
                        {restoreResult.errors.map((err, i) => (
                          <div key={i} style={{ marginBottom: 2, fontFamily: 'monospace' }}>
                            • {err}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ─── Tab 3: Google Drive & Auto-Sync ──────────────────────── */}
          {activeTab === 'gdrive' && (
            <div>
              <p className="backup-section-desc">
                Sync backups directly to your private Google Drive in an isolated <code>TestMaker Backups</code> folder.
              </p>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <span
                  className={`gdrive-status-badge ${
                    gdriveToken ? 'gdrive-status-badge--connected' : 'gdrive-status-badge--disconnected'
                  }`}
                >
                  {gdriveToken ? '● Connected to Google Drive' : '○ Not Connected'}
                </span>

                {gdriveToken && (
                  <button
                    type="button"
                    className="gdrive-action-btn"
                    onClick={() => {
                      setGdriveToken(null);
                      setSessionDriveToken(null);
                      setDriveFiles([]);
                    }}
                  >
                    Disconnect
                  </button>
                )}
              </div>

              {!gdriveToken ? (
                <div className="backup-action-card">
                  <div className="gdrive-input-group">
                    <label className="gdrive-input-label">Google OAuth Client ID</label>
                    <input
                      type="text"
                      className="gdrive-input"
                      placeholder="e.g. 123456789-abcdef.apps.googleusercontent.com"
                      value={gdriveClientId}
                      onChange={(e) => handleClientIdChange(e.target.value)}
                      onBlur={() => {
                        const trimmed = gdriveClientId.trim();
                        if (trimmed) {
                          const s = getSavedSettings();
                          saveSettings({ ...s, googleDriveClientId: trimmed });
                          syncGoogleDriveClientIdToCloud(trimmed).catch(() => {});
                        }
                      }}
                    />
                    <span style={{ fontSize: '0.6875rem', color: 'var(--color-text-tertiary)', marginTop: 4, display: 'block' }}>
                      From your Google Cloud Console (APIs & Services → Credentials → OAuth Client ID).
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="gdrive-action-btn"
                      onClick={handleSaveClientId}
                    >
                      Save ID
                    </button>
                    <button
                      type="button"
                      className="backup-btn-primary"
                      onClick={handleConnectGoogleDrive}
                      disabled={isLoadingDrive}
                    >
                      {isLoadingDrive ? 'Connecting…' : '🔑 Sign in with Google Drive'}
                    </button>
                  </div>

                  {/* Authorized Origin Setup Box */}
                  <div style={{
                    padding: '12px',
                    borderRadius: '8px',
                    background: 'rgba(99, 102, 241, 0.08)',
                    border: '1px solid rgba(99, 102, 241, 0.25)',
                    fontSize: '0.75rem',
                    lineHeight: '1.45',
                    color: 'var(--color-text-secondary)',
                    marginTop: '14px',
                  }}>
                    <strong style={{ color: 'var(--color-text-primary)', display: 'block', marginBottom: '4px' }}>
                      ⚙️ Required Google Cloud Origin Setup:
                    </strong>
                    To prevent <em>"Error 401: invalid_client / no registered origin"</em>, add your current URL under <strong>Authorized JavaScript origins</strong> in Google Cloud Console:
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      background: 'var(--color-surface)',
                      padding: '6px 10px',
                      borderRadius: '6px',
                      border: '1px solid var(--color-border)',
                      marginTop: '6px',
                      fontFamily: 'monospace',
                      fontWeight: 600,
                      color: 'var(--color-primary-600)',
                    }}>
                      <span>{typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173'}</span>
                      <button
                        type="button"
                        className="gdrive-action-btn"
                        style={{ padding: '2px 8px', fontSize: '0.6875rem' }}
                        onClick={() => {
                          if (typeof window !== 'undefined') {
                            navigator.clipboard.writeText(window.location.origin);
                            setDriveActionNotice('Copied origin to clipboard!');
                            setTimeout(() => setDriveActionNotice(null), 3000);
                          }
                        }}
                      >
                        Copy Origin
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="backup-action-card">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span className="backup-action-card-title">Instant Cloud Backup</span>
                      <button
                        type="button"
                        className="backup-btn-primary"
                        style={{ width: 'auto', padding: '8px 16px' }}
                        onClick={handleUploadCurrentToDrive}
                        disabled={isUploadingToDrive}
                      >
                        {isUploadingToDrive ? 'Uploading…' : '☁️ Backup to Google Drive Now'}
                      </button>
                    </div>

                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>Automatic Cloud Sync</span>
                        <input
                          type="checkbox"
                          checked={autoBackupEnabled}
                          onChange={(e) => handleToggleAutoBackup(e.target.checked)}
                        />
                      </div>

                      {autoBackupEnabled && (
                        <div style={{ display: 'flex', gap: 8, fontSize: '0.8125rem' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input
                              type="radio"
                              name="autoFreq"
                              checked={autoBackupFrequency === 'on_paper_upload'}
                              onChange={() => handleChangeFrequency('on_paper_upload')}
                            />
                            <span>On paper upload</span>
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input
                              type="radio"
                              name="autoFreq"
                              checked={autoBackupFrequency === 'daily'}
                              onChange={() => handleChangeFrequency('daily')}
                            />
                            <span>Daily</span>
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input
                              type="radio"
                              name="autoFreq"
                              checked={autoBackupFrequency === 'weekly'}
                              onChange={() => handleChangeFrequency('weekly')}
                            />
                            <span>Weekly</span>
                          </label>
                        </div>
                      )}
                    </div>
                  </div>

                  <h3 style={{ fontSize: '0.875rem', fontWeight: 700, margin: '16px 0 8px' }}>
                    Available Backups in Google Drive ({driveFiles.length})
                  </h3>

                  {driveFiles.length === 0 ? (
                    <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-tertiary)', textAlign: 'center', padding: '16px 0' }}>
                      No backups found in <code>Google Drive / TestMaker Backups</code> yet.
                    </div>
                  ) : (
                    <div className="gdrive-file-list">
                      {driveFiles.map((file) => (
                        <div key={file.id} className="gdrive-file-row">
                          <div className="gdrive-file-info">
                            <span className="gdrive-file-name">{file.name}</span>
                            <span className="gdrive-file-meta">
                              {file.formattedSize} • {new Date(file.createdTime).toLocaleDateString()}
                            </span>
                          </div>
                          <div className="gdrive-file-actions">
                            <button
                              type="button"
                              className="gdrive-action-btn"
                              onClick={() => handleRestoreFromDrive(file)}
                            >
                              ⚡ Restore
                            </button>
                            <button
                              type="button"
                              className="gdrive-action-btn gdrive-action-btn--delete"
                              onClick={() => handleDeleteFromDrive(file)}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
