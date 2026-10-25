import { useState, useEffect, useCallback, useRef } from 'react';
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
import { SchoolDoodlesBackground } from '../components/SchoolDoodlesBackground';
import { APP_VERSION, DEVELOPER_NAME, DEVELOPER_EMAIL } from '../config/version';
import '../components/PinGate.css';
import './PortalLandingPage.css';

interface PortalLandingPageProps {
  onJoinQuiz: (code: string) => void;
  onEnterTeacherSuite: () => void;
}

// ─── Decoy PIN Gate (visually identical to real PinGate, always rejects) ────
function DecoyPinGate({ onClose }: { onClose: () => void }) {
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const [error, setError] = useState('');
  const [shaking, setShaking] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [attempts, setAttempts] = useState(() => {
    try {
      return parseInt(sessionStorage.getItem('decoy_pin_failed_attempts') || '0', 10) || 0;
    } catch {
      return 0;
    }
  });
  const [lockoutRemaining, setLockoutRemaining] = useState<number>(() => {
    try {
      const until = parseInt(sessionStorage.getItem('decoy_pin_lockout_until') || '0', 10);
      const now = Date.now();
      return until > now ? Math.ceil((until - now) / 1000) : 0;
    } catch {
      return 0;
    }
  });
  const [showPin, setShowPin] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (lockoutRemaining <= 0) {
      const t = setTimeout(() => inputRefs.current[0]?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [lockoutRemaining]);

  useEffect(() => {
    if (lockoutRemaining <= 0) return;
    const interval = setInterval(() => {
      setLockoutRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          setError('');
          setTimeout(() => inputRefs.current[0]?.focus(), 100);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [lockoutRemaining]);

  const formatDuration = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const validatePin = (_pin?: string) => {
    if (lockoutRemaining > 0 || verifying) return;
    setVerifying(true);

    const delay = 400 + Math.random() * 350;
    setTimeout(() => {
      setVerifying(false);
      const nextAttempts = attempts + 1;
      setAttempts(nextAttempts);

      let lockoutSeconds = 0;
      if (nextAttempts >= 10) {
        lockoutSeconds = 30 * 60; // 30 minutes
      } else if (nextAttempts >= 5) {
        lockoutSeconds = 5 * 60; // 5 minutes
      } else if (nextAttempts >= 3) {
        lockoutSeconds = 30; // 30 seconds
      }

      try {
        sessionStorage.setItem('decoy_pin_failed_attempts', String(nextAttempts));
        if (lockoutSeconds > 0) {
          sessionStorage.setItem('decoy_pin_lockout_until', String(Date.now() + lockoutSeconds * 1000));
        }
      } catch {}

      if (lockoutSeconds > 0) {
        setLockoutRemaining(lockoutSeconds);
        setError(`Too many failed attempts. Device locked for ${formatDuration(lockoutSeconds)}.`);
      } else {
        const remaining = 3 - nextAttempts;
        setError(
          remaining > 0
            ? `Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before cooldown.`
            : 'Incorrect PIN. Please try again.'
        );
      }

      setShaking(true);
      setTimeout(() => {
        setShaking(false);
        setDigits(Array(6).fill(''));
        if (lockoutSeconds <= 0) {
          inputRefs.current[0]?.focus();
        }
      }, 600);
    }, delay);
  };

  const handleDigitChange = (index: number, value: string) => {
    if (lockoutRemaining > 0 || verifying) return;
    const digit = value.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[index] = digit;
    setDigits(next);
    setError('');

    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    if (digit && index === 5) {
      const full = next.join('');
      if (full.length === 6) {
        validatePin(full);
      }
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (lockoutRemaining > 0 || verifying) return;
    if (e.key === 'Backspace') {
      if (!digits[index] && index > 0) {
        const next = [...digits];
        next[index - 1] = '';
        setDigits(next);
        inputRefs.current[index - 1]?.focus();
        e.preventDefault();
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < 5) {
      inputRefs.current[index + 1]?.focus();
    } else if (e.key === 'Enter') {
      const full = digits.join('');
      if (full.length === 6) {
        validatePin(full);
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (lockoutRemaining > 0 || verifying) return;
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length > 0) {
      const next = Array(6).fill('');
      for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
      setDigits(next);
      setError('');
      const focusIdx = Math.min(pasted.length, 5);
      inputRefs.current[focusIdx]?.focus();
      if (pasted.length === 6) {
        validatePin(pasted);
      }
    }
  };

  const allFilled = digits.every((d) => d !== '');

  return (
    <div className="pin-gate-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`pin-gate-card ${shaking ? 'pin-shake' : ''}`}>
        {/* Logos & Branding */}
        <div className="pin-gate-brand-wrapper">
          <div className="pin-gate-logo-card" title="Insan Cendekia Madani">
            <img src={ICM_LOGO_PATH} alt="ICM" className="pin-gate-logo-img" />
          </div>
          <div className="pin-gate-logo-card" title="Cambridge Assessment International Education">
            <img src={CAMBRIDGE_LOGO_PATH} alt="Cambridge Assessment" className="pin-gate-logo-img" />
          </div>
        </div>

        <h2 className="pin-gate-title">ICM Exam Platform</h2>
        <p className="pin-gate-subtitle">
          Insan Cendekia Madani • Enter your 6-digit access PIN
        </p>

        {/* Lockout Banner */}
        {lockoutRemaining > 0 && (
          <div className="pin-lockout-banner animate-fade-in">
            <span className="pin-lockout-icon">⏳</span>
            <div className="pin-lockout-text">
              <strong>Cooldown Active</strong>
              <span>Please wait <span className="pin-lockout-timer">{formatDuration(lockoutRemaining)}</span> before trying again.</span>
            </div>
          </div>
        )}

        {/* Invisible Anti-Bot Security Widget */}
        <TurnstileWidget action="pin_gate" onVerify={() => {}} />

        {/* Digit inputs */}
        <div className="pin-digits-row">
          {digits.map((digit, i) => (
            <input
              key={i}
              ref={(el) => { inputRefs.current[i] = el; }}
              type={showPin ? 'text' : 'password'}
              inputMode="numeric"
              maxLength={1}
              value={digit}
              disabled={lockoutRemaining > 0 || verifying}
              onChange={(e) => handleDigitChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              onPaste={i === 0 ? handlePaste : undefined}
              className={`pin-digit-input ${digit ? 'pin-digit--filled' : ''} ${error ? 'pin-digit--error' : ''}`}
              autoComplete="off"
              aria-label={`PIN digit ${i + 1}`}
            />
          ))}
        </div>

        {/* Visibility Mask Toggle */}
        <div className="pin-mask-toggle-wrap">
          <button
            type="button"
            className="pin-mask-toggle-btn"
            onClick={() => setShowPin(!showPin)}
            title={showPin ? 'Hide PIN numbers' : 'Show PIN numbers'}
          >
            {showPin ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
                <span>Hide Numbers</span>
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span>Show Numbers</span>
              </>
            )}
          </button>
        </div>

        {/* Error */}
        <div className="pin-error-msg">
          {error && (
            <>
              <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              {error}
            </>
          )}
        </div>

        {/* Submit */}
        <button
          className="pin-submit-btn"
          onClick={() => {
            const fullPin = digits.join('');
            if (fullPin.length === 6) validatePin(fullPin);
          }}
          disabled={!allFilled || verifying || lockoutRemaining > 0}
          id="pin-submit-btn"
        >
          {lockoutRemaining > 0
            ? `Cooldown (${formatDuration(lockoutRemaining)})`
            : verifying
              ? 'Verifying…'
              : 'Unlock'}
        </button>

        <button
          type="button"
          className="pin-back-portal-btn"
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(148, 163, 184, 0.8)',
            fontSize: '0.8125rem',
            fontWeight: 600,
            cursor: 'pointer',
            marginTop: '10px',
          }}
        >
          ← Back to Portal Landing Page
        </button>

        <div className="pin-gate-creator-link">
          Insan Cendekia Madani • Cambridge International School
        </div>
      </div>
    </div>
  );
}

// ─── Main Portal Landing Page ──────────────────────────────────────────────
export function PortalLandingPage({
  onJoinQuiz,
  onEnterTeacherSuite,
}: PortalLandingPageProps) {
  // Take Quiz Form State
  const [quizCodeInput, setQuizCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');

  // Check Results Form State
  const [resultCodeInput, setResultCodeInput] = useState('');
  const [resultCandidateInput, setResultCandidateInput] = useState('');
  const [resultPinInput, setResultPinInput] = useState('');
  const [resultError, setResultError] = useState('');
  const [showResultsForm, setShowResultsForm] = useState(false);

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

  // Secret teacher access: 3x ICM logo click
  const logoClickCount = useRef(0);
  const logoClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Decoy PIN gate visibility
  const [showDecoyPin, setShowDecoyPin] = useState(false);

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

  const handleLogoClick = () => {
    logoClickCount.current += 1;

    if (logoClickTimer.current) clearTimeout(logoClickTimer.current);

    if (logoClickCount.current >= 3) {
      logoClickCount.current = 0;
      onEnterTeacherSuite();
      return;
    }

    logoClickTimer.current = setTimeout(() => {
      logoClickCount.current = 0;
    }, 1200);
  };

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
      {/* Ambient auras & doodles */}
      <div className="portal-glow portal-glow--1" />
      <div className="portal-glow portal-glow--2" />
      <SchoolDoodlesBackground />

      {/* Decoy PIN Overlay */}
      {showDecoyPin && <DecoyPinGate onClose={() => setShowDecoyPin(false)} />}

      {/* Main Container */}
      <div className="portal-content">
        {/* ─── Hero Header ─── */}
        <header className="portal-hero">
          <div className="portal-brand-logos">
            <div
              className="portal-logo-card"
              title="Insan Cendekia Madani"
              onClick={handleLogoClick}
              style={{ cursor: 'default' }}
            >
              <img src={ICM_LOGO_PATH} alt="ICM" className="portal-logo-img" />
            </div>
            <div className="portal-logo-divider" />
            <div className="portal-logo-card" title="Cambridge Assessment International Education">
              <img src={CAMBRIDGE_LOGO_PATH} alt="Cambridge Assessment" className="portal-logo-img" />
            </div>
          </div>

          <h1 className="portal-hero-title">
            ICM <span className="portal-hero-accent">Exam Platform</span>
          </h1>
        </header>

        {/* Pending Offline Exam Submissions Banner */}
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

        {/* ─── Main Action Area ─── */}
        <div className="portal-main-section">
          {/* Primary: Exam Code Entry */}
          <div className="portal-exam-card">
            <div className="portal-exam-card-header">
              <div className="portal-exam-icon-wrap">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
              </div>
              <div>
                <h2 className="portal-exam-card-title">Enter Examination</h2>
                <p className="portal-exam-card-sub">Enter your exam access code to begin</p>
              </div>
            </div>

            <form onSubmit={handleJoin} className="portal-exam-form">
              <div className="portal-code-input-wrap">
                <input
                  id="portal-exam-code"
                  type="text"
                  className="portal-code-input"
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
                <button type="submit" className="portal-code-submit">
                  Start Exam
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </button>
              </div>
              {codeError && <span className="portal-error-msg">{codeError}</span>}

              <TurnstileWidget
                action="portal_join"
                onVerify={(token) => setTurnstileToken(token)}
              />
            </form>

            {/* Recent device submissions */}
            {recentReceipts.length > 0 && (
              <div className="portal-receipts-section">
                <span className="portal-receipts-title">Recent Submissions on This Device:</span>
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
          </div>

          {/* Secondary: Check Results (hidden first before student clicks to fill in) */}
          <div className="portal-results-card">
            <button
              type="button"
              className="portal-results-toggle-btn"
              onClick={() => setShowResultsForm((prev) => !prev)}
              aria-expanded={showResultsForm}
            >
              <div className="portal-results-header">
                <div className="portal-results-icon-wrap">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                  </svg>
                </div>
                <div>
                  <h3 className="portal-results-title">Check Exam Results</h3>
                  <p className="portal-results-desc">Have a submission receipt? Look up your marked paper and score</p>
                </div>
              </div>
              <div className="portal-results-action-pill">
                <span>{showResultsForm ? 'Hide Form' : 'Click to fill in'}</span>
                <svg
                  className={`portal-results-chevron ${showResultsForm ? 'open' : ''}`}
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>
            </button>

            {showResultsForm && (
              <form onSubmit={handleLookupResults} className="portal-results-form animate-fade-in">
                <div className="portal-results-fields">
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
                  </div>
                </div>

                {resultError && <span className="portal-error-msg">{resultError}</span>}

                <button type="submit" className="portal-results-submit">
                  Retrieve Marked Paper →
                </button>
              </form>
            )}
          </div>
        </div>

        {/* ─── Decoy Teacher Portal (Honeypot) ─── */}
        <div className="portal-teacher-decoy">
          <button
            type="button"
            className="portal-teacher-decoy-btn"
            onClick={() => setShowDecoyPin(true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Teacher Portal
          </button>
        </div>

        {/* Footer */}
        <footer className="portal-minimal-footer">
          <div className="portal-footer-copy">
            <span>
              Created by{' '}
              <a href={`mailto:${DEVELOPER_EMAIL}`} className="portal-footer-link">
                {DEVELOPER_NAME}
              </a>{' '}
              | All Rights Reserved | {APP_VERSION}
            </span>
          </div>
        </footer>
      </div>

      {/* Student Result Modal */}
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
