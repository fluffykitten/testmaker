import { useState, useRef, useEffect, type ReactNode, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { TurnstileWidget } from './TurnstileWidget';
import { verifyTurnstileToken } from '../services/turnstileService';
import {
  loginTeacherAccount,
  registerOrClaimTeacherAccount,
  resetTeacherPasswordWithMasterPin,
  upsertAuthenticatedTeacherProfile,
} from '../services/teacherProfileService';
import { getSavedSettings, loadAndSyncTeacherAccountClaiming } from '../lib/settings';
import { ICM_LOGO_PATH, CAMBRIDGE_LOGO_PATH } from '../assets/logoConstants';
import './PinGate.css';

const SESSION_KEY = 'testmaker_pin_verified';
const LEGACY_PIN_CACHE_KEY = 'testmaker_cached_access_pin';
const ATTEMPTS_KEY = 'testmaker_pin_failed_attempts';
const LOCKOUT_KEY = 'testmaker_pin_lockout_until';

type AuthViewMode = 'signin' | 'register' | 'reset';

const TITLE_OPTIONS = ['Dr.', 'Mr.', 'Ms.', 'Ibu', 'Bapak', 'Ustadz', 'Ustadzah'];

const COMMON_SUBJECTS: Array<{ subject: string; code: string }> = [
  { subject: 'Chemistry', code: '0620' },
  { subject: 'Physics', code: '0625' },
  { subject: 'Biology', code: '0610' },
  { subject: 'Mathematics', code: '0580' },
  { subject: 'Additional Mathematics', code: '0606' },
  { subject: 'Combined Science', code: '0653' },
  { subject: 'English as a Second Language', code: '0510' },
  { subject: 'Computer Science', code: '0478' },
  { subject: 'Economics', code: '0455' },
  { subject: 'Business Studies', code: '0450' },
];

function getLockoutRemainingSeconds(): number {
  try {
    const until = parseInt(localStorage.getItem(LOCKOUT_KEY) || '0', 10);
    const now = Date.now();
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  } catch {
    return 0;
  }
}

function getFailedAttempts(): number {
  try {
    return parseInt(localStorage.getItem(ATTEMPTS_KEY) || '0', 10) || 0;
  } catch {
    return 0;
  }
}

function recordFailedAttempt(): { attempts: number; lockoutSeconds: number } {
  const attempts = getFailedAttempts() + 1;
  let lockoutSeconds = 0;

  if (attempts >= 10) {
    lockoutSeconds = 30 * 60; // 30 minutes
  } else if (attempts >= 5) {
    lockoutSeconds = 5 * 60; // 5 minutes
  } else if (attempts >= 3) {
    lockoutSeconds = 30; // 30 seconds
  }

  try {
    localStorage.setItem(ATTEMPTS_KEY, String(attempts));
    if (lockoutSeconds > 0) {
      localStorage.setItem(LOCKOUT_KEY, String(Date.now() + lockoutSeconds * 1000));
    }
  } catch {}

  return { attempts, lockoutSeconds };
}

function resetFailedAttempts() {
  try {
    localStorage.removeItem(ATTEMPTS_KEY);
    localStorage.removeItem(LOCKOUT_KEY);
  } catch {}
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

interface PinGateProps {
  children: ReactNode;
  onBackToPortal?: () => void;
}

export function PinGate({ children, onBackToPortal }: PinGateProps) {
  const [verified, setVerified] = useState(() => sessionStorage.getItem(SESSION_KEY) === 'true');
  const [viewMode, setViewMode] = useState<AuthViewMode>('signin');
  const [allowAccountClaiming, setAllowAccountClaiming] = useState<boolean>(() =>
    Boolean(getSavedSettings().allowTeacherAccountClaiming)
  );
  const [submitting, setSubmitting] = useState(false);
  const [lockoutRemaining, setLockoutRemaining] = useState<number>(() => getLockoutRemainingSeconds());
  const [error, setError] = useState('');
  const [infoBanner, setInfoBanner] = useState('');
  const [shaking, setShaking] = useState(false);
  const [success, setSuccess] = useState(false);
  const [successName, setSuccessName] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string>('');

  // Shared credentials state
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [masterPin, setMasterPin] = useState('');
  const [showMasterPin, setShowMasterPin] = useState(false);

  // Registration / Claim fields
  const [claimProfileId, setClaimProfileId] = useState<string | null>(null);
  const [fullName, setFullName] = useState('');
  const [title, setTitle] = useState('Dr.');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [subject, setSubject] = useState('Chemistry');
  const [subjectCode, setSubjectCode] = useState('0620');
  const [classesInput, setClassesInput] = useState('10-A, 10-B');

  const identifierInputRef = useRef<HTMLInputElement | null>(null);

  // Sync admin toggle for educator account claiming / self-registration
  useEffect(() => {
    loadAndSyncTeacherAccountClaiming()
      .then((enabled) => {
        setAllowAccountClaiming(enabled);
        if (!enabled) {
          setViewMode((prev) => (prev === 'register' ? 'signin' : prev));
        }
      })
      .catch(() => {});

    const handleClaimSettingUpdated = (e: Event) => {
      const custom = e as CustomEvent<{ allowTeacherAccountClaiming?: boolean }>;
      if (custom.detail?.allowTeacherAccountClaiming !== undefined) {
        const enabled = Boolean(custom.detail.allowTeacherAccountClaiming);
        setAllowAccountClaiming(enabled);
        if (!enabled) {
          setViewMode((prev) => (prev === 'register' ? 'signin' : prev));
        }
      }
    };

    window.addEventListener('teacher_account_claiming_updated', handleClaimSettingUpdated);
    return () => window.removeEventListener('teacher_account_claiming_updated', handleClaimSettingUpdated);
  }, []);

  // Lockout countdown timer
  useEffect(() => {
    if (lockoutRemaining <= 0) return;

    const interval = setInterval(() => {
      const remaining = getLockoutRemainingSeconds();
      setLockoutRemaining(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        setError('');
        setTimeout(() => identifierInputRef.current?.focus(), 100);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [lockoutRemaining]);

  // Scrub legacy cached PIN and auto-focus primary input
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_PIN_CACHE_KEY);
    } catch {}

    if (verified) return;

    if (lockoutRemaining <= 0) {
      const timer = setTimeout(() => {
        identifierInputRef.current?.focus();
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [verified, lockoutRemaining, viewMode]);

  if (verified) {
    return <>{children}</>;
  }

  const triggerShakeError = (msg: string, countAttempt = false) => {
    if (countAttempt) {
      const { attempts, lockoutSeconds } = recordFailedAttempt();
      if (lockoutSeconds > 0) {
        setLockoutRemaining(lockoutSeconds);
        setError(`Too many failed attempts. Device locked for ${formatDuration(lockoutSeconds)}.`);
      } else {
        const remainingBeforeLockout = 3 - attempts;
        setError(
          remainingBeforeLockout > 0
            ? `${msg} (${remainingBeforeLockout} attempt${remainingBeforeLockout === 1 ? '' : 's'} remaining before cooldown)`
            : msg
        );
      }
    } else {
      setError(msg);
    }
    setShaking(true);
    setTimeout(() => setShaking(false), 500);
  };

  const completeUnlock = (displayName?: string) => {
    resetFailedAttempts();
    setError('');
    setSuccessName(displayName || 'Educator');
    setSuccess(true);
    sessionStorage.setItem(SESSION_KEY, 'true');
    setTimeout(() => setVerified(true), 700);
  };

  const switchMode = (nextMode: AuthViewMode) => {
    setViewMode(nextMode);
    setError('');
    if (nextMode !== 'register') {
      setClaimProfileId(null);
      setInfoBanner('');
    } else if (!claimProfileId) {
      setInfoBanner('');
    }
  };

  const verifyBotChallenge = async (): Promise<boolean> => {
    const botCheck = await verifyTurnstileToken(turnstileToken, 'pin_gate');
    if (!botCheck.success) {
      triggerShakeError('Security verification failed. Please try again.');
      return false;
    }
    return true;
  };

  const tryLegacyMasterPinFallback = async (candidatePin: string): Promise<boolean> => {
    const cleanPin = candidatePin.trim();
    if (!/^\d{6}$/.test(cleanPin)) return false;

    const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 6000)
    );
    const rpcPromise = (supabase as any).rpc('verify_teacher_access_pin', { p_pin: cleanPin });
    const res = (await Promise.race([rpcPromise, timeoutPromise])) as {
      data: boolean | null;
      error: any;
    };
    return !res.error && res.data === true;
  };

  const handleSignInSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (lockoutRemaining > 0 || submitting) return;

    const cleanIdentifier = identifier.trim();
    if (!cleanIdentifier || !password) {
      triggerShakeError('Please enter your email or username and password.');
      return;
    }

    setSubmitting(true);
    setError('');

    if (!(await verifyBotChallenge())) {
      setSubmitting(false);
      return;
    }

    try {
      const res = await loginTeacherAccount(cleanIdentifier, password);

      if (res.status === 'ok' && res.profile) {
        upsertAuthenticatedTeacherProfile(res.profile, res.token);
        completeUnlock(`${res.profile.title ? `${res.profile.title} ` : ''}${res.profile.name}`);
        return;
      }

      if (res.status === 'setup_required' && res.profile) {
        if (!allowAccountClaiming) {
          triggerShakeError('Legacy profile claiming is currently disabled by your administrator.');
          return;
        }
        setClaimProfileId(res.profile.id);
        setFullName(res.profile.name || '');
        setTitle(res.profile.title || 'Dr.');
        setEmail(res.profile.email || (cleanIdentifier.includes('@') ? cleanIdentifier : ''));
        setUsername(res.profile.username || (!cleanIdentifier.includes('@') ? cleanIdentifier : ''));
        setSubject(res.profile.subject || 'Chemistry');
        setSubjectCode(res.profile.subject_code || '0620');
        setClassesInput(
          Array.isArray(res.profile.default_classes) && res.profile.default_classes.length > 0
            ? res.profile.default_classes.join(', ')
            : '10-A, 10-B'
        );
        setInfoBanner(
          res.message ||
            'Legacy educator profile found. Enter your School Master PIN and set a personal password to claim it.'
        );
        setViewMode('register');
        setError('');
        return;
      }

      // Pre-migration 021 compatibility: allow 6-digit School Master PIN if Phase 2 RPCs aren't applied yet
      if (res.status === 'rpc_unavailable') {
        const pinCandidate = /^\d{6}$/.test(password.trim())
          ? password.trim()
          : /^\d{6}$/.test(cleanIdentifier)
            ? cleanIdentifier
            : '';
        if (pinCandidate) {
          const legacyMatched = await tryLegacyMasterPinFallback(pinCandidate);
          if (legacyMatched) {
            completeUnlock('Educator');
            return;
          }
          triggerShakeError('Invalid School Master PIN.', true);
          return;
        }
        triggerShakeError(
          'Educator login service is initializing on the server. Apply Migration 021 or enter the 6-digit School Master PIN.',
          false
        );
        return;
      }

      triggerShakeError(res.error || 'Invalid username/email or password.', true);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegisterSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (lockoutRemaining > 0 || submitting) return;

    if (!fullName.trim()) {
      triggerShakeError('Please enter your full display name.');
      return;
    }
    if (!username.trim() && !email.trim()) {
      triggerShakeError('Please provide an email address or username.');
      return;
    }
    if (password.trim().length < 6) {
      triggerShakeError('Password must be at least 6 characters.');
      return;
    }
    if (!/^\d{6}$/.test(masterPin.trim())) {
      triggerShakeError('Enter the 6-digit School Master PIN to authorize educator onboarding.');
      return;
    }

    setSubmitting(true);
    setError('');

    if (!(await verifyBotChallenge())) {
      setSubmitting(false);
      return;
    }

    try {
      const parsedClasses = classesInput
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);

      const res = await registerOrClaimTeacherAccount({
        masterPin: masterPin.trim(),
        email: email.trim(),
        username: username.trim(),
        password,
        name: fullName.trim(),
        title,
        subject: subject.trim() || 'Chemistry',
        subjectCode: subjectCode.trim() || '0620',
        defaultClasses: parsedClasses.length > 0 ? parsedClasses : ['10-A', '10-B'],
        claimProfileId,
      });

      if (res.status === 'ok' && res.profile) {
        upsertAuthenticatedTeacherProfile(res.profile, res.token);
        completeUnlock(`${res.profile.title ? `${res.profile.title} ` : ''}${res.profile.name}`);
        return;
      }

      const isPinError = /master pin/i.test(res.error || '');
      triggerShakeError(res.error || 'Could not create educator account.', isPinError);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (lockoutRemaining > 0 || submitting) return;

    if (!identifier.trim()) {
      triggerShakeError('Enter your registered email, username, or name.');
      return;
    }
    if (password.trim().length < 6) {
      triggerShakeError('New password must be at least 6 characters.');
      return;
    }
    if (!/^\d{6}$/.test(masterPin.trim())) {
      triggerShakeError('Enter the 6-digit School Master PIN to reset your password.');
      return;
    }

    setSubmitting(true);
    setError('');

    if (!(await verifyBotChallenge())) {
      setSubmitting(false);
      return;
    }

    try {
      const res = await resetTeacherPasswordWithMasterPin(identifier.trim(), password, masterPin.trim());
      if (res.status === 'ok' && res.profile) {
        upsertAuthenticatedTeacherProfile(res.profile, res.token);
        completeUnlock(`${res.profile.title ? `${res.profile.title} ` : ''}${res.profile.name}`);
        return;
      }

      const isPinError = /master pin/i.test(res.error || '');
      triggerShakeError(res.error || 'Could not reset password.', isPinError);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubjectPresetChange = (selectedSubject: string) => {
    setSubject(selectedSubject);
    const preset = COMMON_SUBJECTS.find((s) => s.subject === selectedSubject);
    if (preset) {
      setSubjectCode(preset.code);
    }
  };

  const subtitleText =
    viewMode === 'signin'
      ? 'Sign in with your educator email or username'
      : viewMode === 'register'
        ? claimProfileId
          ? 'Claim your existing educator profile with School Master PIN'
          : 'Create a new educator workspace (School Master PIN required)'
        : 'Reset your educator password using the School Master PIN';

  return (
    <div className={`pin-gate-overlay ${success ? 'pin-gate--success' : ''}`}>
      <div
        className={`pin-gate-card ${viewMode === 'register' ? 'pin-gate-card--wide' : ''} ${
          shaking ? 'pin-shake' : ''
        }`}
      >
        {success ? (
          <>
            <div className="pin-success-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M5 13l4 4L19 7" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="pin-success-text">Welcome back, {successName}!</p>
          </>
        ) : (
          <>
            {/* Logos & Branding */}
            <div className="pin-gate-brand-wrapper">
              <div className="pin-gate-logo-card" title="Insan Cendekia Madani">
                <img src={ICM_LOGO_PATH} alt="ICM" className="pin-gate-logo-img" />
              </div>
              <div className="pin-gate-logo-card" title="Cambridge Assessment International Education">
                <img src={CAMBRIDGE_LOGO_PATH} alt="Cambridge Assessment" className="pin-gate-logo-img" />
              </div>
            </div>

            <h2 className="pin-gate-title">Educator Portal</h2>
            <p className="pin-gate-subtitle">{subtitleText}</p>

            {/* Lockout Banner */}
            {lockoutRemaining > 0 && (
              <div className="pin-lockout-banner animate-fade-in">
                <span className="pin-lockout-icon">⏳</span>
                <div className="pin-lockout-text">
                  <strong>Cooldown Active</strong>
                  <span>
                    Please wait <span className="pin-lockout-timer">{formatDuration(lockoutRemaining)}</span> before
                    trying again.
                  </span>
                </div>
              </div>
            )}

            {/* Legacy Profile Claim Banner */}
            {infoBanner && viewMode === 'register' && (
              <div className="teacher-auth-claim-banner">{infoBanner}</div>
            )}

            {/* Invisible Anti-Bot Security Widget */}
            <TurnstileWidget action="pin_gate" onVerify={setTurnstileToken} />

            {viewMode === 'signin' && (
              <form className="teacher-auth-form" onSubmit={handleSignInSubmit}>
                <div className="teacher-auth-field">
                  <label htmlFor="teacher-login-identifier">Email, Username, or Educator Name</label>
                  <input
                    id="teacher-login-identifier"
                    ref={identifierInputRef}
                    type="text"
                    className="teacher-auth-input"
                    placeholder="e.g. budi@icm.sch.id or dr.budi"
                    value={identifier}
                    disabled={lockoutRemaining > 0 || submitting}
                    onChange={(e) => {
                      setIdentifier(e.target.value);
                      setError('');
                    }}
                    autoComplete="username"
                  />
                </div>

                <div className="teacher-auth-field">
                  <label htmlFor="teacher-login-password">Password</label>
                  <div className="teacher-auth-password-wrap">
                    <input
                      id="teacher-login-password"
                      type={showPassword ? 'text' : 'password'}
                      className="teacher-auth-input"
                      placeholder="Enter your password"
                      value={password}
                      disabled={lockoutRemaining > 0 || submitting}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setError('');
                      }}
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      className="teacher-auth-eye-btn"
                      onClick={() => setShowPassword(!showPassword)}
                      tabIndex={-1}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>

                <div className="pin-error-msg">
                  {error && (
                    <>
                      <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                        <path
                          fillRule="evenodd"
                          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                          clipRule="evenodd"
                        />
                      </svg>
                      {error}
                    </>
                  )}
                </div>

                <button
                  type="submit"
                  className="pin-submit-btn"
                  disabled={!identifier.trim() || !password || submitting || lockoutRemaining > 0}
                  id="pin-submit-btn"
                >
                  {lockoutRemaining > 0
                    ? `Cooldown (${formatDuration(lockoutRemaining)})`
                    : submitting
                      ? 'Signing In…'
                      : 'Sign In to Workspace'}
                </button>

                <div className={`teacher-auth-links ${allowAccountClaiming ? '' : 'teacher-auth-links--center'}`}>
                  {allowAccountClaiming && (
                    <button
                      type="button"
                      className="teacher-auth-link-btn"
                      onClick={() => switchMode('register')}
                      disabled={submitting}
                    >
                      New Educator? Create / Claim Account
                    </button>
                  )}
                  <button
                    type="button"
                    className="teacher-auth-link-btn"
                    onClick={() => switchMode('reset')}
                    disabled={submitting}
                  >
                    Forgot Password?
                  </button>
                </div>
              </form>
            )}

            {viewMode === 'register' && (
              <form className="teacher-auth-form" onSubmit={handleRegisterSubmit}>
                <div className="teacher-auth-row teacher-auth-row--title-name">
                  <div className="teacher-auth-field">
                    <label htmlFor="teacher-reg-title">Title</label>
                    <select
                      id="teacher-reg-title"
                      className="teacher-auth-input teacher-auth-select"
                      value={title}
                      disabled={submitting || lockoutRemaining > 0}
                      onChange={(e) => setTitle(e.target.value)}
                    >
                      {TITLE_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="teacher-auth-field">
                    <label htmlFor="teacher-reg-name">Full Name</label>
                    <input
                      id="teacher-reg-name"
                      ref={identifierInputRef}
                      type="text"
                      className="teacher-auth-input"
                      placeholder="e.g. Budi Santoso"
                      value={fullName}
                      disabled={submitting || lockoutRemaining > 0}
                      onChange={(e) => {
                        setFullName(e.target.value);
                        setError('');
                      }}
                    />
                  </div>
                </div>

                <div className="teacher-auth-row">
                  <div className="teacher-auth-field">
                    <label htmlFor="teacher-reg-email">School Email</label>
                    <input
                      id="teacher-reg-email"
                      type="email"
                      className="teacher-auth-input"
                      placeholder="name@icm.sch.id"
                      value={email}
                      disabled={submitting || lockoutRemaining > 0}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setError('');
                      }}
                    />
                  </div>
                  <div className="teacher-auth-field">
                    <label htmlFor="teacher-reg-username">Username</label>
                    <input
                      id="teacher-reg-username"
                      type="text"
                      className="teacher-auth-input"
                      placeholder="e.g. budi.chem"
                      value={username}
                      disabled={submitting || lockoutRemaining > 0}
                      onChange={(e) => {
                        setUsername(e.target.value);
                        setError('');
                      }}
                    />
                  </div>
                </div>

                <div className="teacher-auth-row teacher-auth-row--subject">
                  <div className="teacher-auth-field">
                    <label htmlFor="teacher-reg-subject">Primary Subject</label>
                    <select
                      id="teacher-reg-subject"
                      className="teacher-auth-input teacher-auth-select"
                      value={COMMON_SUBJECTS.some((s) => s.subject === subject) ? subject : '__custom__'}
                      disabled={submitting || lockoutRemaining > 0}
                      onChange={(e) => {
                        if (e.target.value !== '__custom__') {
                          handleSubjectPresetChange(e.target.value);
                        } else {
                          setSubject('');
                          setSubjectCode('');
                        }
                      }}
                    >
                      {COMMON_SUBJECTS.map((s) => (
                        <option key={s.code} value={s.subject}>
                          {s.subject} ({s.code})
                        </option>
                      ))}
                      <option value="__custom__">Other Subject...</option>
                    </select>
                  </div>
                  <div className="teacher-auth-field">
                    <label htmlFor="teacher-reg-code">Syllabus Code</label>
                    <input
                      id="teacher-reg-code"
                      type="text"
                      className="teacher-auth-input"
                      placeholder="0620"
                      value={subjectCode}
                      disabled={submitting || lockoutRemaining > 0}
                      onChange={(e) => setSubjectCode(e.target.value)}
                    />
                  </div>
                </div>

                {!COMMON_SUBJECTS.some((s) => s.subject === subject) && (
                  <div className="teacher-auth-field">
                    <label htmlFor="teacher-reg-custom-subject">Custom Subject Name</label>
                    <input
                      id="teacher-reg-custom-subject"
                      type="text"
                      className="teacher-auth-input"
                      placeholder="e.g. Environmental Management"
                      value={subject}
                      disabled={submitting || lockoutRemaining > 0}
                      onChange={(e) => setSubject(e.target.value)}
                    />
                  </div>
                )}

                <div className="teacher-auth-field">
                  <label htmlFor="teacher-reg-classes">Default Classes (comma-separated)</label>
                  <input
                    id="teacher-reg-classes"
                    type="text"
                    className="teacher-auth-input"
                    placeholder="10-A, 10-B, 11-A"
                    value={classesInput}
                    disabled={submitting || lockoutRemaining > 0}
                    onChange={(e) => setClassesInput(e.target.value)}
                  />
                </div>

                <div className="teacher-auth-row">
                  <div className="teacher-auth-field">
                    <label htmlFor="teacher-reg-password">Password (min 6 chars)</label>
                    <div className="teacher-auth-password-wrap">
                      <input
                        id="teacher-reg-password"
                        type={showPassword ? 'text' : 'password'}
                        className="teacher-auth-input"
                        placeholder="Create password"
                        value={password}
                        disabled={submitting || lockoutRemaining > 0}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          setError('');
                        }}
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        className="teacher-auth-eye-btn"
                        onClick={() => setShowPassword(!showPassword)}
                        tabIndex={-1}
                      >
                        {showPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </div>
                  <div className="teacher-auth-field">
                    <label htmlFor="teacher-reg-master-pin">6-Digit School Master PIN</label>
                    <div className="teacher-auth-password-wrap">
                      <input
                        id="teacher-reg-master-pin"
                        type={showMasterPin ? 'text' : 'password'}
                        inputMode="numeric"
                        maxLength={6}
                        className="teacher-auth-input"
                        placeholder="••••••"
                        value={masterPin}
                        disabled={submitting || lockoutRemaining > 0}
                        onChange={(e) => {
                          setMasterPin(e.target.value.replace(/\D/g, '').slice(0, 6));
                          setError('');
                        }}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="teacher-auth-eye-btn"
                        onClick={() => setShowMasterPin(!showMasterPin)}
                        tabIndex={-1}
                      >
                        {showMasterPin ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="pin-error-msg">
                  {error && (
                    <>
                      <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                        <path
                          fillRule="evenodd"
                          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                          clipRule="evenodd"
                        />
                      </svg>
                      {error}
                    </>
                  )}
                </div>

                <button
                  type="submit"
                  className="pin-submit-btn"
                  disabled={submitting || lockoutRemaining > 0}
                  id="pin-submit-btn"
                >
                  {lockoutRemaining > 0
                    ? `Cooldown (${formatDuration(lockoutRemaining)})`
                    : submitting
                      ? 'Saving Account…'
                      : claimProfileId
                        ? 'Claim Profile & Sign In'
                        : 'Create Account & Sign In'}
                </button>

                <div className="teacher-auth-links teacher-auth-links--center">
                  <button
                    type="button"
                    className="teacher-auth-link-btn"
                    onClick={() => switchMode('signin')}
                    disabled={submitting}
                  >
                    ← Back to Sign In
                  </button>
                </div>
              </form>
            )}

            {viewMode === 'reset' && (
              <form className="teacher-auth-form" onSubmit={handleResetSubmit}>
                <div className="teacher-auth-field">
                  <label htmlFor="teacher-reset-identifier">Email, Username, or Educator Name</label>
                  <input
                    id="teacher-reset-identifier"
                    ref={identifierInputRef}
                    type="text"
                    className="teacher-auth-input"
                    placeholder="e.g. budi@icm.sch.id or Dr. Budi Santoso"
                    value={identifier}
                    disabled={submitting || lockoutRemaining > 0}
                    onChange={(e) => {
                      setIdentifier(e.target.value);
                      setError('');
                    }}
                  />
                </div>

                <div className="teacher-auth-field">
                  <label htmlFor="teacher-reset-password">New Password (min 6 chars)</label>
                  <div className="teacher-auth-password-wrap">
                    <input
                      id="teacher-reset-password"
                      type={showPassword ? 'text' : 'password'}
                      className="teacher-auth-input"
                      placeholder="Enter new password"
                      value={password}
                      disabled={submitting || lockoutRemaining > 0}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setError('');
                      }}
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      className="teacher-auth-eye-btn"
                      onClick={() => setShowPassword(!showPassword)}
                      tabIndex={-1}
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>

                <div className="teacher-auth-field">
                  <label htmlFor="teacher-reset-master-pin">6-Digit School Master PIN</label>
                  <div className="teacher-auth-password-wrap">
                    <input
                      id="teacher-reset-master-pin"
                      type={showMasterPin ? 'text' : 'password'}
                      inputMode="numeric"
                      maxLength={6}
                      className="teacher-auth-input"
                      placeholder="••••••"
                      value={masterPin}
                      disabled={submitting || lockoutRemaining > 0}
                      onChange={(e) => {
                        setMasterPin(e.target.value.replace(/\D/g, '').slice(0, 6));
                        setError('');
                      }}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="teacher-auth-eye-btn"
                      onClick={() => setShowMasterPin(!showMasterPin)}
                      tabIndex={-1}
                    >
                      {showMasterPin ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>

                <div className="pin-error-msg">
                  {error && (
                    <>
                      <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                        <path
                          fillRule="evenodd"
                          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                          clipRule="evenodd"
                        />
                      </svg>
                      {error}
                    </>
                  )}
                </div>

                <button
                  type="submit"
                  className="pin-submit-btn"
                  disabled={submitting || lockoutRemaining > 0}
                  id="pin-submit-btn"
                >
                  {lockoutRemaining > 0
                    ? `Cooldown (${formatDuration(lockoutRemaining)})`
                    : submitting
                      ? 'Resetting Password…'
                      : 'Reset Password & Sign In'}
                </button>

                <div className="teacher-auth-links teacher-auth-links--center">
                  <button
                    type="button"
                    className="teacher-auth-link-btn"
                    onClick={() => switchMode('signin')}
                    disabled={submitting}
                  >
                    ← Back to Sign In
                  </button>
                </div>
              </form>
            )}

            {onBackToPortal && (
              <button
                type="button"
                className="pin-back-portal-btn"
                onClick={onBackToPortal}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--color-text-secondary)',
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  marginTop: '14px',
                }}
              >
                ← Back to Portal Landing Page
              </button>
            )}

            <div className="pin-gate-creator-link">
              Insan Cendekia Madani • Cambridge International School
            </div>
          </>
        )}
      </div>
    </div>
  );
}
