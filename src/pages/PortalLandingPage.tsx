import { useState, useEffect, useCallback } from 'react';
import {
  getDeviceReceipts,
  getPendingOutboxSubmissions,
  flushSubmissionOutbox,
  exportSubmissionToFile,
  type DeviceExamReceipt,
  type SubmissionOutboxItem,
} from '../services/quizSubmissionService';
import { StudentResultModal } from '../components/StudentResultModal';
import { prefetchAccessPin } from '../components/PinGate';
import { TurnstileWidget } from '../components/TurnstileWidget';
import { verifyTurnstileToken } from '../services/turnstileService';
import { ICM_LOGO_PATH, CAMBRIDGE_LOGO_PATH } from '../assets/logoConstants';
import './PortalLandingPage.css';

interface PortalLandingPageProps {
  onJoinQuiz: (code: string) => void;
  onEnterTeacherSuite: () => void;
}

export function PortalLandingPage({
  onJoinQuiz,
  onEnterTeacherSuite,
}: PortalLandingPageProps) {
  // Student Portal Tabs: 'take_quiz' | 'check_results'
  const [studentTab, setStudentTab] = useState<'take_quiz' | 'check_results'>('take_quiz');

  // View Filter: 'all' | 'students' | 'teachers'
  const [portalViewFilter, setPortalViewFilter] = useState<'all' | 'students' | 'teachers'>('all');

  // Take Quiz Form State
  const [quizCodeInput, setQuizCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');

  // Check Results Form State
  const [resultCodeInput, setResultCodeInput] = useState('');
  const [resultCandidateInput, setResultCandidateInput] = useState('');
  const [resultPinInput, setResultPinInput] = useState('');
  const [resultError, setResultError] = useState('');

  // Result Modal State
  const [isResultModalOpen, setIsResultModalOpen] = useState(false);
  const [activeResultLookup, setActiveResultLookup] = useState<{ quizCode: string; candidateId: string; pin: string }>({
    quizCode: '',
    candidateId: '',
    pin: '',
  });

  // Recent Device Receipts
  const [recentReceipts, setRecentReceipts] = useState<DeviceExamReceipt[]>([]);

  // Outbox Recovery State
  const [pendingOutbox, setPendingOutbox] = useState<SubmissionOutboxItem[]>(() => getPendingOutboxSubmissions());
  const [isFlushingOutbox, setIsFlushingOutbox] = useState<boolean>(false);
  const [outboxSyncMsg, setOutboxSyncMsg] = useState<string | null>(null);

  const refreshPendingOutbox = useCallback(() => {
    const pending = getPendingOutboxSubmissions();
    setPendingOutbox(pending);
  }, []);

  const handleFlushPendingOutbox = useCallback(async () => {
    if (isFlushingOutbox) return;
    setIsFlushingOutbox(true);
    setOutboxSyncMsg('Syncing pending exam submissions...');
    try {
      const res = await flushSubmissionOutbox();
      if (res.syncedCount > 0) {
        setOutboxSyncMsg(`Successfully synced ${res.syncedCount} exam submission(s).`);
        setTimeout(() => setOutboxSyncMsg(null), 4000);
      } else if (res.failedCount > 0) {
        setOutboxSyncMsg('Sync attempt failed. Will retry automatically.');
      } else {
        setOutboxSyncMsg(null);
      }
    } catch {
      setOutboxSyncMsg('Network issue during sync. Will retry automatically.');
    } finally {
      setIsFlushingOutbox(false);
      refreshPendingOutbox();
    }
  }, [isFlushingOutbox, refreshPendingOutbox]);

  useEffect(() => {
    prefetchAccessPin();
    const receipts = getDeviceReceipts();
    setRecentReceipts(receipts);
    if (receipts.length > 0) {
      setResultCodeInput(receipts[0].quizCode);
      setResultCandidateInput(receipts[0].studentName || receipts[0].candidateNumber || '');
      setResultPinInput(receipts[0].resultPin || '');
    }

    refreshPendingOutbox();

    if (navigator.onLine && getPendingOutboxSubmissions().length > 0) {
      handleFlushPendingOutbox();
    }

    const handleOnline = () => {
      if (getPendingOutboxSubmissions().length > 0) {
        handleFlushPendingOutbox();
      }
    };

    const handleSubmissionsUpdated = () => {
      refreshPendingOutbox();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('submissions_updated', handleSubmissionsUpdated);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('submissions_updated', handleSubmissionsUpdated);
    };
  }, [handleFlushPendingOutbox, refreshPendingOutbox]);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = quizCodeInput.trim().toUpperCase();
    if (!clean) {
      setCodeError('Please enter an Exam Code.');
      return;
    }

    const check = await verifyTurnstileToken(turnstileToken, 'portal_join');
    if (!check.success) {
      setCodeError('Verification check failed. Please refresh and try again.');
      return;
    }

    setCodeError('');
    onJoinQuiz(clean);
  };

  const handleLookupResults = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = resultCodeInput.trim().toUpperCase();
    const cleanId = resultCandidateInput.trim();

    if (!cleanCode) {
      setResultError('Please enter the Exam Code.');
      return;
    }
    if (!cleanId) {
      setResultError('Please enter your Candidate Name or Seat #.');
      return;
    }
    if (!resultPinInput.trim()) {
      setResultError('Please enter your 3-digit Access PIN.');
      return;
    }

    setResultError('');
    setActiveResultLookup({ quizCode: cleanCode, candidateId: cleanId, pin: resultPinInput.trim() });
    setIsResultModalOpen(true);
  };

  const handleOpenReceiptResult = (receipt: DeviceExamReceipt) => {
    setActiveResultLookup({
      quizCode: receipt.quizCode,
      candidateId: receipt.studentName || receipt.candidateNumber || '',
      pin: receipt.resultPin || '',
    });
    setIsResultModalOpen(true);
  };

  return (
    <div className="portal-root">
      {/* Subtle Green Ambient Auras */}
      <div className="portal-glow portal-glow--1" />
      <div className="portal-glow portal-glow--2" />

      {/* Main Container */}
      <div className="portal-content">
        {/* Minimalist Institutional Header */}
        <header className="portal-brand-header">
          <div className="portal-brand-logos">
            <div className="portal-logo-card" title="Insan Cendekia Madani">
              <img src={ICM_LOGO_PATH} alt="ICM" className="portal-logo-img" />
            </div>
            <div className="portal-logo-divider" />
            <div className="portal-logo-card" title="Cambridge Assessment International Education">
              <img src={CAMBRIDGE_LOGO_PATH} alt="Cambridge Assessment" className="portal-logo-img" />
            </div>
          </div>

          <div className="portal-meta-badge">
            <span className="portal-live-dot" />
            <span>Cambridge International School ID395 • Insan Cendekia Madani</span>
          </div>

          <h1 className="portal-title">
            ICM <span className="portal-title-accent">Exam Platform</span>
          </h1>
          <p className="portal-subtitle">
            Secure digital examination and Cambridge assessment management system.
          </p>
        </header>

        {/* Pending Offline Exam Submissions Banner (Shown only when pending local items exist) */}
        {pendingOutbox.length > 0 && (
          <div className="portal-outbox-banner">
            <div className="portal-outbox-info">
              <span className="portal-outbox-icon">⚠️</span>
              <div>
                <strong>
                  {pendingOutbox.length} Pending Exam Submission{pendingOutbox.length > 1 ? 's' : ''} Stored Locally
                </strong>
                <span className="portal-outbox-codes">
                  {pendingOutbox.map((i) => `${i.submission.quizCode} (${i.submission.studentName})`).join(' • ')}
                </span>
                {outboxSyncMsg && (
                  <div className="portal-outbox-msg">{outboxSyncMsg}</div>
                )}
              </div>
            </div>

            <div className="portal-outbox-actions">
              <button
                type="button"
                onClick={handleFlushPendingOutbox}
                disabled={isFlushingOutbox}
                className="portal-btn-sync"
              >
                {isFlushingOutbox ? 'Syncing...' : 'Sync Now'}
              </button>

              <button
                type="button"
                onClick={() => exportSubmissionToFile(pendingOutbox[0].submission)}
                className="portal-btn-backup"
              >
                Export Backup
              </button>
            </div>
          </div>
        )}

        {/* Split View Switcher */}
        <div className="portal-split-toggle" role="tablist" aria-label="Portal Navigation View">
          <button
            type="button"
            className={`portal-split-toggle-btn ${portalViewFilter === 'all' ? 'portal-split-toggle-btn--active' : ''}`}
            onClick={() => setPortalViewFilter('all')}
          >
            Split View
          </button>
          <button
            type="button"
            className={`portal-split-toggle-btn ${portalViewFilter === 'students' ? 'portal-split-toggle-btn--active' : ''}`}
            onClick={() => setPortalViewFilter('students')}
          >
            Students
          </button>
          <button
            type="button"
            className={`portal-split-toggle-btn ${portalViewFilter === 'teachers' ? 'portal-split-toggle-btn--active' : ''}`}
            onClick={() => setPortalViewFilter('teachers')}
          >
            Teachers
          </button>
        </div>

        {/* Dual Split Cards: Students vs Teachers */}
        <div className={`portal-cards-grid ${portalViewFilter === 'students' ? 'portal-cards-grid--students-only' : ''} ${portalViewFilter === 'teachers' ? 'portal-cards-grid--teachers-only' : ''}`}>
          
          {/* Card 1: Student Section */}
          {(portalViewFilter === 'all' || portalViewFilter === 'students') && (
            <div className="portal-card portal-card--student">
              <div className="portal-card-header">
                <span className="portal-card-tag portal-card-tag--student">STUDENT PORTAL</span>
                <span className="portal-card-status">Active Session</span>
              </div>

              <h2 className="portal-card-title">Take Exam or View Results</h2>
              <p className="portal-card-description">
                Enter your test token to start your scheduled assessment, or check previously submitted scripts.
              </p>

              {/* Sub-Tabs: Take Exam / Check Results */}
              <div className="portal-mode-tabs" role="tablist">
                <button
                  type="button"
                  className={`portal-mode-tab ${studentTab === 'take_quiz' ? 'portal-mode-tab--active' : ''}`}
                  onClick={() => {
                    setStudentTab('take_quiz');
                    setCodeError('');
                  }}
                >
                  Enter Exam
                </button>
                <button
                  type="button"
                  className={`portal-mode-tab ${studentTab === 'check_results' ? 'portal-mode-tab--active' : ''}`}
                  onClick={() => {
                    setStudentTab('check_results');
                    setResultError('');
                  }}
                >
                  Check Results
                </button>
              </div>

              {/* Tab 1: Enter Exam */}
              {studentTab === 'take_quiz' ? (
                <form onSubmit={handleJoin} className="portal-form">
                  <div className="portal-field">
                    <label htmlFor="portal-exam-code" className="portal-label">
                      Exam Access Code
                    </label>
                    <div className="portal-input-container">
                      <input
                        id="portal-exam-code"
                        type="text"
                        className="portal-input portal-input--code"
                        placeholder="e.g. CHEM-2026-T1"
                        value={quizCodeInput}
                        onChange={(e) => {
                          setQuizCodeInput(e.target.value.toUpperCase());
                          if (codeError) setCodeError('');
                        }}
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck="false"
                        autoFocus
                      />
                    </div>
                    {codeError && <span className="portal-error-msg">{codeError}</span>}
                  </div>

                  {/* Invisible Security Challenge */}
                  <TurnstileWidget
                    action="portal_join"
                    onVerify={(token) => setTurnstileToken(token)}
                  />

                  <button type="submit" className="portal-action-btn portal-action-btn--student">
                    Start Examination →
                  </button>

                  {/* Device Receipts (if student completed an exam on this browser) */}
                  {recentReceipts.length > 0 && (
                    <div className="portal-receipts-section">
                      <span className="portal-receipts-title">Recent Device Submissions:</span>
                      <div className="portal-receipts-list">
                        {recentReceipts.slice(0, 2).map((r, i) => (
                          <button
                            key={i}
                            type="button"
                            className="portal-receipt-item"
                            onClick={() => handleOpenReceiptResult(r)}
                          >
                            <span className="portal-receipt-code">{r.quizCode}</span>
                            <span className="portal-receipt-name">{r.studentName || 'Candidate'}</span>
                            <span className="portal-receipt-date">
                              {new Date(r.submittedAt).toLocaleDateString()}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </form>
              ) : (
                /* Tab 2: Check Results */
                <form onSubmit={handleLookupResults} className="portal-form">
                  <div className="portal-field">
                    <label className="portal-label">Exam Code</label>
                    <input
                      type="text"
                      className="portal-input portal-input--code"
                      placeholder="e.g. CHEM-2026-T1"
                      value={resultCodeInput}
                      onChange={(e) => {
                        setResultCodeInput(e.target.value.toUpperCase());
                        if (resultError) setResultError('');
                      }}
                      autoCapitalize="characters"
                    />
                  </div>

                  <div className="portal-field">
                    <label className="portal-label">Candidate Name or Seat #</label>
                    <input
                      type="text"
                      className="portal-input"
                      placeholder="Candidate Name"
                      value={resultCandidateInput}
                      onChange={(e) => {
                        setResultCandidateInput(e.target.value);
                        if (resultError) setResultError('');
                      }}
                    />
                  </div>

                  <div className="portal-field">
                    <label className="portal-label">Access PIN (3-digit)</label>
                    <input
                      type="text"
                      className="portal-input portal-input--pin"
                      placeholder="PIN"
                      value={resultPinInput}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, '').slice(0, 3);
                        setResultPinInput(v);
                        if (resultError) setResultError('');
                      }}
                      maxLength={3}
                      inputMode="numeric"
                    />
                    <span className="portal-field-hint">
                      Found on your examination submission receipt.
                    </span>
                    {resultError && <span className="portal-error-msg">{resultError}</span>}
                  </div>

                  <button type="submit" className="portal-action-btn portal-action-btn--student">
                    Retrieve Marked Paper →
                  </button>
                </form>
              )}

              {/* Minimalist Exam Highlights */}
              <div className="portal-card-footer-chips">
                <span className="portal-chip">Fullscreen Lockdown</span>
                <span className="portal-chip">Scientific Formula Rendering</span>
                <span className="portal-chip">Offline Autosave</span>
              </div>
            </div>
          )}

          {/* Card 2: Teacher Section */}
          {(portalViewFilter === 'all' || portalViewFilter === 'teachers') && (
            <div
              className="portal-card portal-card--teacher"
              onClick={onEnterTeacherSuite}
              onMouseEnter={() => prefetchAccessPin()}
              onFocus={() => prefetchAccessPin()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onEnterTeacherSuite();
                }
              }}
            >
              <div className="portal-card-header">
                <span className="portal-card-tag portal-card-tag--teacher">TEACHER SUITE</span>
                <span className="portal-card-status">PIN Protected</span>
              </div>

              <h2 className="portal-card-title">Assessment Studio</h2>
              <p className="portal-card-description">
                Comprehensive authoring tools to construct Cambridge test papers, manage question repositories, and monitor active sessions.
              </p>

              {/* Minimalist Module List (Zero AI mentions) */}
              <div className="portal-teacher-items">
                <div className="portal-teacher-item">
                  <span className="portal-item-bullet">•</span>
                  <div className="portal-item-content">
                    <strong>Question Bank & Formulas</strong>
                    <span>Curate syllabus-aligned items with KaTeX chemical and mathematical formatting</span>
                  </div>
                </div>

                <div className="portal-teacher-item">
                  <span className="portal-item-bullet">•</span>
                  <div className="portal-item-content">
                    <strong>Standardized Test Builder</strong>
                    <span>Assemble balanced papers with AO1/AO2/AO3 marks and authentic Cambridge cover sheets</span>
                  </div>
                </div>

                <div className="portal-teacher-item">
                  <span className="portal-item-bullet">•</span>
                  <div className="portal-item-content">
                    <strong>Live Invigilation & Integrity</strong>
                    <span>Real-time proctoring with full-screen enforcement, blur strike logs, and time alerts</span>
                  </div>
                </div>

                <div className="portal-teacher-item">
                  <span className="portal-item-bullet">•</span>
                  <div className="portal-item-content">
                    <strong>Word, PDF & Gradebook Exports</strong>
                    <span>Download camera-ready printable test papers, mark schemes, and class gradebooks</span>
                  </div>
                </div>
              </div>

              <div className="portal-teacher-btn-wrapper">
                <button type="button" className="portal-action-btn portal-action-btn--teacher">
                  Enter Teacher Suite →
                </button>
              </div>

              <div className="portal-teacher-footer-note">
                Secured by invigilator PIN • Automatic inactivity lock
              </div>
            </div>
          )}
        </div>

        {/* Minimalist Institutional Footer */}
        <footer className="portal-minimal-footer">
          <div className="portal-footer-copy">
            <span>ICM Exam Platform</span>
            <span className="portal-footer-sep">•</span>
            <span>Insan Cendekia Madani</span>
            <span className="portal-footer-sep">•</span>
            <span>Cambridge International School ID395</span>
          </div>
          <div className="portal-footer-meta">
            Academic Year 2026/2027 • All Systems Operational
          </div>
        </footer>
      </div>

      {/* Student Attempt History & Result Modal */}
      <StudentResultModal
        isOpen={isResultModalOpen}
        quizCode={activeResultLookup.quizCode}
        candidateIdentifier={activeResultLookup.candidateId}
        pin={activeResultLookup.pin}
        onClose={() => setIsResultModalOpen(false)}
      />
    </div>
  );
}
